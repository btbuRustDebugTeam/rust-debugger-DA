#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const child_process_1 = require("child_process");
const miParser_1 = require("./miParser");
// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------
const program = process.env.ARDB_PROGRAM;
const argsStr = process.env.ARDB_ARGS || '[]';
const cwd = process.env.ARDB_CWD || process.cwd();
const pythonPath = process.env.PYTHONPATH || '';
if (!program) {
    console.error('Error: ARDB_PROGRAM environment variable not set');
    process.exit(1);
}
// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let gdbProcess;
let rawData = Buffer.alloc(0);
/** Auto-incrementing token for MI commands. */
let nextToken = 1;
/** Pending MI command callbacks keyed by token. */
const pendingCommands = new Map();
/** Buffer for accumulating partial GDB output lines. */
let gdbOutputBuffer = '';
/**
 * Whether the inferior (target program) has been started with -exec-run.
 * Before this is true, the first "continue" must use -exec-run instead.
 */
let inferiorStarted = false;
// ---------------------------------------------------------------------------
// DAP message parsing (stdin)
// ---------------------------------------------------------------------------
process.stdin.on('data', (data) => {
    rawData = Buffer.concat([rawData, data]);
    while (true) {
        const contentStartIndex = rawData.indexOf('\r\n\r\n');
        if (contentStartIndex === -1)
            break;
        const header = rawData.toString('utf8', 0, contentStartIndex);
        const match = header.match(/Content-Length: (\d+)/);
        if (!match)
            break;
        const contentLength = parseInt(match[1], 10);
        const totalLength = contentStartIndex + 4 + contentLength;
        if (rawData.length < totalLength)
            break;
        const messageStr = rawData.toString('utf8', contentStartIndex + 4, totalLength);
        rawData = rawData.slice(totalLength);
        try {
            const request = JSON.parse(messageStr);
            handleRequest(request);
        }
        catch (e) {
            console.error("DAP Parse Error:", e);
        }
    }
});
// ---------------------------------------------------------------------------
// DAP request handler
// ---------------------------------------------------------------------------
function handleRequest(request) {
    process.stderr.write(`[Adapter] Received: ${request.command}\n`);
    switch (request.command) {
        case 'initialize':
            sendResponse(request, {
                supportsConfigurationDoneRequest: true,
                supportsEvaluateForHovers: false,
            });
            sendEvent('initialized');
            break;
        case 'launch':
            handleLaunch(request);
            break;
        case 'configurationDone':
            handleConfigurationDone(request);
            break;
        case 'continue':
            handleContinue(request);
            break;
        case 'next':
            handleNext(request);
            break;
        case 'stepIn':
            handleStepIn(request);
            break;
        case 'stepOut':
            handleStepOut(request);
            break;
        case 'pause':
            handlePause(request);
            break;
        case 'threads':
            handleThreads(request);
            break;
        case 'stackTrace':
            handleStackTrace(request);
            break;
        case 'evaluate':
            if (gdbProcess && request.arguments?.expression) {
                const expr = request.arguments.expression;
                sendMICommand(`-interpreter-exec console "${expr}"`)
                    .then((record) => {
                    const result = record.cls === 'done'
                        ? (record.data?.msg || 'OK')
                        : (record.data?.msg || record.cls || 'error');
                    sendResponse(request, { result, variablesReference: 0 });
                })
                    .catch(() => {
                    sendResponse(request, { result: 'Command failed', variablesReference: 0 });
                });
            }
            else {
                sendResponse(request, { result: '', variablesReference: 0 });
            }
            break;
        case 'disconnect':
            if (gdbProcess)
                gdbProcess.kill();
            sendResponse(request);
            process.exit(0);
            break;
        default:
            // Acknowledge unknown requests so VS Code doesn't hang
            sendResponse(request);
    }
}
// ---------------------------------------------------------------------------
// DAP request handlers
// ---------------------------------------------------------------------------
/**
 * Handle "launch" request.
 * Starts GDB and loads the program symbols, but does NOT run the inferior.
 * The user is expected to configure ARD (whitelist, trace points) before
 * pressing Continue to actually start execution.
 */
function handleLaunch(request) {
    launchGDB();
    inferiorStarted = false;
    sendResponse(request);
}
/**
 * Handle "configurationDone" request.
 * VS Code sends this after all initial breakpoints / config are set.
 * We emit a synthetic "stopped" event so VS Code enters paused state,
 * giving the user time to configure ARD before running the program.
 */
function handleConfigurationDone(request) {
    sendResponse(request);
    // Emit a synthetic stopped event with reason "entry".
    // This puts VS Code into paused UI so the user can use the
    // Async Inspector panel to set up whitelist and trace points.
    // threadId 1 is a placeholder — GDB has not started threads yet.
    sendEvent('stopped', {
        reason: 'entry',
        description: 'Program loaded. Configure ARD, then press Continue to run.',
        threadId: 1,
        allThreadsStopped: true,
    });
}
/**
 * Handle "threads" request.
 * Queries GDB for thread list and returns DAP Thread objects.
 * Before the inferior starts, returns a synthetic placeholder thread.
 */
function handleThreads(request) {
    if (!inferiorStarted) {
        // Before -exec-run, there are no real threads yet.
        // Return a placeholder so VS Code doesn't error out.
        sendResponse(request, {
            threads: [{ id: 1, name: 'main (not started)' }],
        });
        return;
    }
    sendMICommand('-thread-info')
        .then((record) => {
        const threads = [];
        const miThreads = record.data?.threads;
        if (Array.isArray(miThreads)) {
            for (const t of miThreads) {
                const id = parseInt(t.id || '1', 10);
                const targetId = t['target-id'] || '';
                const name = t.name || targetId || `Thread ${id}`;
                threads.push({ id, name });
            }
        }
        if (threads.length === 0) {
            threads.push({ id: 1, name: 'main' });
        }
        sendResponse(request, { threads });
    })
        .catch(() => {
        sendResponse(request, {
            threads: [{ id: 1, name: 'main' }],
        });
    });
}
/**
 * Handle "stackTrace" request.
 * Queries GDB for the call stack of the given thread and returns
 * DAP StackFrame objects with source location info.
 */
function handleStackTrace(request) {
    const threadId = request.arguments?.threadId || 1;
    if (!inferiorStarted) {
        // Before -exec-run, no real stack exists.
        sendResponse(request, { stackFrames: [], totalFrames: 0 });
        return;
    }
    // Switch to the requested thread, then list frames
    sendMICommand(`-thread-select ${threadId}`)
        .then(() => sendMICommand('-stack-list-frames'))
        .then((record) => {
        const stackFrames = [];
        const miStack = record.data?.stack;
        if (Array.isArray(miStack)) {
            for (const entry of miStack) {
                // MI returns: frame={level="0",addr="0x...",func="main",file="main.rs",fullname="/path/main.rs",line="10"}
                // In result-list form, each element is the frame object directly
                const f = entry.level !== undefined ? entry : (entry.frame || entry);
                const level = parseInt(f.level || '0', 10);
                const frameId = threadId * 10000 + level; // Unique ID encoding
                const frame = {
                    id: frameId,
                    name: f.func || '<unknown>',
                    line: parseInt(f.line || '0', 10),
                    column: 0,
                };
                if (f.fullname || f.file) {
                    frame.source = {
                        name: f.file || '',
                        path: f.fullname || f.file || '',
                    };
                }
                if (f.addr) {
                    frame.instructionPointerReference = f.addr;
                }
                stackFrames.push(frame);
            }
        }
        sendResponse(request, {
            stackFrames,
            totalFrames: stackFrames.length,
        });
    })
        .catch((err) => {
        process.stderr.write(`[Adapter] stackTrace failed: ${err.message}\n`);
        sendResponse(request, { stackFrames: [], totalFrames: 0 });
    });
}
/**
 * Handle "continue" request.
 * First continue: execute -exec-run to start the inferior.
 * Subsequent continues: execute -exec-continue to resume.
 */
function handleContinue(request) {
    if (!inferiorStarted) {
        // First time: actually start the program
        inferiorStarted = true;
        sendMICommand('-exec-run')
            .then(() => {
            sendResponse(request, { allThreadsContinued: true });
        })
            .catch((err) => {
            process.stderr.write(`[Adapter] -exec-run failed: ${err.message}\n`);
            sendErrorResponse(request, err.message);
        });
    }
    else {
        // Program already running, just resume
        sendMICommand('-exec-continue')
            .then(() => {
            sendResponse(request, { allThreadsContinued: true });
        })
            .catch((err) => {
            process.stderr.write(`[Adapter] -exec-continue failed: ${err.message}\n`);
            sendErrorResponse(request, err.message);
        });
    }
}
/**
 * Handle "next" request (step over).
 * Executes -exec-next to step to the next source line, stepping over calls.
 */
function handleNext(request) {
    if (!inferiorStarted) {
        sendErrorResponse(request, 'Program has not started yet. Press Continue first.');
        return;
    }
    sendMICommand('-exec-next')
        .then(() => {
        sendResponse(request);
    })
        .catch((err) => {
        process.stderr.write(`[Adapter] -exec-next failed: ${err.message}\n`);
        sendErrorResponse(request, err.message);
    });
}
/**
 * Handle "stepIn" request.
 * Executes -exec-step to step into the next function call.
 */
function handleStepIn(request) {
    if (!inferiorStarted) {
        sendErrorResponse(request, 'Program has not started yet. Press Continue first.');
        return;
    }
    sendMICommand('-exec-step')
        .then(() => {
        sendResponse(request);
    })
        .catch((err) => {
        process.stderr.write(`[Adapter] -exec-step failed: ${err.message}\n`);
        sendErrorResponse(request, err.message);
    });
}
/**
 * Handle "stepOut" request.
 * Executes -exec-finish to run until the current function returns.
 */
function handleStepOut(request) {
    if (!inferiorStarted) {
        sendErrorResponse(request, 'Program has not started yet. Press Continue first.');
        return;
    }
    sendMICommand('-exec-finish')
        .then(() => {
        sendResponse(request);
    })
        .catch((err) => {
        process.stderr.write(`[Adapter] -exec-finish failed: ${err.message}\n`);
        sendErrorResponse(request, err.message);
    });
}
/**
 * Handle "pause" request.
 * Executes -exec-interrupt to suspend the running inferior.
 */
function handlePause(request) {
    if (!inferiorStarted) {
        sendErrorResponse(request, 'Program has not started yet.');
        return;
    }
    sendMICommand('-exec-interrupt')
        .then(() => {
        sendResponse(request);
    })
        .catch((err) => {
        process.stderr.write(`[Adapter] -exec-interrupt failed: ${err.message}\n`);
        sendErrorResponse(request, err.message);
    });
}
// ---------------------------------------------------------------------------
// Send MI command to GDB with token-based response tracking
// ---------------------------------------------------------------------------
/**
 * Send an MI command to GDB and return a promise that resolves with the
 * result record (^done / ^error / ^running).
 */
function sendMICommand(command) {
    return new Promise((resolve, reject) => {
        if (!gdbProcess || !gdbProcess.stdin) {
            reject(new Error('GDB process not available'));
            return;
        }
        const token = nextToken++;
        pendingCommands.set(token, { resolve, reject });
        const fullCommand = `${token}${command}\n`;
        process.stderr.write(`[Adapter -> GDB] ${fullCommand.trim()}\n`);
        gdbProcess.stdin.write(fullCommand);
    });
}
/**
 * Send a raw string to GDB stdin without token tracking.
 * Use this only for commands where you don't need the response.
 */
function sendGDBRaw(command) {
    if (gdbProcess && gdbProcess.stdin) {
        process.stderr.write(`[Adapter -> GDB (raw)] ${command.trim()}\n`);
        gdbProcess.stdin.write(command);
    }
}
// ---------------------------------------------------------------------------
// DAP message helpers
// ---------------------------------------------------------------------------
function sendResponse(request, body = {}) {
    const response = {
        type: 'response',
        request_seq: request.seq,
        success: true,
        command: request.command,
        body: body,
    };
    const json = JSON.stringify(response);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}
function sendErrorResponse(request, message) {
    const response = {
        type: 'response',
        request_seq: request.seq,
        success: false,
        command: request.command,
        message: message,
        body: {},
    };
    const json = JSON.stringify(response);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}
function sendEvent(event, body = {}) {
    const message = JSON.stringify({
        type: 'event',
        event: event,
        body: body,
    });
    process.stdout.write(`Content-Length: ${Buffer.byteLength(message, 'utf8')}\r\n\r\n${message}`);
}
// ---------------------------------------------------------------------------
// GDB MI2 output processing
// ---------------------------------------------------------------------------
/**
 * Feed raw bytes from GDB stdout into the line buffer, then parse
 * each complete line through the MI2 parser.
 */
function handleGDBOutput(data) {
    gdbOutputBuffer += data.toString('utf8');
    // Process complete lines
    let newlineIdx;
    while ((newlineIdx = gdbOutputBuffer.indexOf('\n')) !== -1) {
        const line = gdbOutputBuffer.substring(0, newlineIdx).replace(/\r$/, '');
        gdbOutputBuffer = gdbOutputBuffer.substring(newlineIdx + 1);
        if (!line)
            continue;
        const record = (0, miParser_1.parseMILine)(line);
        if (!record) {
            process.stderr.write(`[GDB ?] ${line}\n`);
            continue;
        }
        process.stderr.write(`[GDB ${record.type}] ${line}\n`);
        dispatchMIRecord(record);
    }
}
/**
 * Accumulated console-stream output lines between commands,
 * used to capture output from `-interpreter-exec console "..."`.
 */
let consoleStreamBuffer = [];
/**
 * Route a parsed MI record to the appropriate handler.
 */
function dispatchMIRecord(record) {
    switch (record.type) {
        case 'result':
            handleResultRecord(record);
            break;
        case 'exec-async':
            handleExecAsync(record);
            break;
        case 'notify-async':
            handleNotifyAsync(record);
            break;
        case 'console-stream':
            // Accumulate console output for pending evaluate commands
            if (record.data?.msg) {
                consoleStreamBuffer.push(record.data.msg);
            }
            break;
        case 'target-stream':
        case 'log-stream':
            // Log for debugging, no action needed
            break;
        case 'status-async':
            // Rarely used, log only
            break;
        case 'prompt':
            // (gdb) prompt — MI is ready for next command
            break;
    }
}
/**
 * Handle result records (^done, ^error, ^running).
 * Resolves the pending command promise if a matching token exists.
 */
function handleResultRecord(record) {
    if (record.token !== undefined) {
        const pending = pendingCommands.get(record.token);
        if (pending) {
            pendingCommands.delete(record.token);
            // Attach accumulated console stream output to the result
            if (consoleStreamBuffer.length > 0) {
                record.data.msg = consoleStreamBuffer.join('');
                consoleStreamBuffer = [];
            }
            if (record.cls === 'error') {
                pending.reject(new Error(record.data?.msg || 'GDB error'));
            }
            else {
                pending.resolve(record);
            }
            return;
        }
    }
    // No matching token — clear stream buffer
    consoleStreamBuffer = [];
}
/**
 * Handle exec-async records (*stopped, *running).
 * Translates GDB async notifications into DAP events.
 */
function handleExecAsync(record) {
    process.stderr.write(`[GDB exec-async] class=${record.cls} data=${JSON.stringify(record.data)}\n`);
    if (record.cls === 'stopped') {
        // Map GDB stop reason to DAP stop reason
        const gdbReason = record.data?.reason || '';
        let dapReason = 'pause';
        let description = '';
        switch (gdbReason) {
            case 'breakpoint-hit':
                dapReason = 'breakpoint';
                description = `Breakpoint ${record.data?.bkptno || ''} hit`;
                break;
            case 'end-stepping-range':
                dapReason = 'step';
                description = 'Step completed';
                break;
            case 'function-finished':
                dapReason = 'step';
                description = 'Function finished';
                break;
            case 'signal-received':
                dapReason = 'exception';
                description = `Signal: ${record.data?.['signal-name'] || 'unknown'}`;
                break;
            case 'exited':
            case 'exited-normally':
            case 'exited-signalled':
                sendEvent('terminated');
                return;
            default:
                dapReason = 'pause';
                description = gdbReason || 'Paused';
                break;
        }
        // Extract thread ID from GDB data
        const threadId = parseInt(record.data?.['thread-id'] || '1', 10);
        sendEvent('stopped', {
            reason: dapReason,
            description,
            threadId,
            allThreadsStopped: record.data?.['stopped-threads'] === 'all' || true,
        });
    }
    else if (record.cls === 'running') {
        const threadId = parseInt(record.data?.['thread-id'] || '1', 10);
        sendEvent('continued', {
            threadId,
            allThreadsContinued: true,
        });
    }
}
/**
 * Handle notify-async records (=thread-created, =breakpoint-modified, etc.).
 */
function handleNotifyAsync(record) {
    process.stderr.write(`[GDB notify] ${record.cls}: ${JSON.stringify(record.data)}\n`);
    // Placeholder: will be expanded in future tasks
}
// ---------------------------------------------------------------------------
// Launch GDB
// ---------------------------------------------------------------------------
function launchGDB() {
    const args = JSON.parse(argsStr);
    const gdbArgs = [
        '--interpreter=mi2',
        '-ex', `python import sys; sys.path.insert(0, '${pythonPath}'); import async_rust_debugger`,
        '-ex', 'set pagination off',
        program,
        ...args,
    ];
    gdbProcess = (0, child_process_1.spawn)('gdb', gdbArgs, { cwd });
    // Route GDB stdout through the MI2 parser
    gdbProcess.stdout?.on('data', (data) => {
        handleGDBOutput(data);
    });
    gdbProcess.stderr?.on('data', (data) => {
        process.stderr.write(`[GDB Error]: ${data.toString()}`);
    });
    gdbProcess.on('exit', (code) => {
        process.stderr.write(`[GDB] Process exited with code ${code}\n`);
        sendEvent('terminated');
    });
}
//# sourceMappingURL=gdbAdapter.js.map