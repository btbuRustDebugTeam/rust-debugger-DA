#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const child_process_1 = require("child_process");
const program = process.env.ARDB_PROGRAM;
const argsStr = process.env.ARDB_ARGS || '[]';
const cwd = process.env.ARDB_CWD || process.cwd();
const pythonPath = process.env.PYTHONPATH || '';
if (!program) {
    console.error('Error: ARDB_PROGRAM environment variable not set');
    process.exit(1);
}
let gdbProcess;
let rawData = Buffer.alloc(0);
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
function handleRequest(request) {
    process.stderr.write(`[Adapter] Received: ${request.command}\n`);
    switch (request.command) {
        case 'initialize':
            sendResponse(request, {
                supportsConfigurationDoneRequest: true,
                supportsEvaluateForHovers: false
            });
            sendEvent('initialized');
            break;
        case 'launch':
            launchGDB();
            sendResponse(request);
            break;
        case 'evaluate':
            if (gdbProcess && request.arguments.expression) {
                gdbProcess.stdin?.write(`-interpreter-exec console "${request.arguments.expression}"\n`);
            }
            sendResponse(request, { result: "Command sent to GDB", variablesReference: 0 });
            break;
        case 'disconnect':
            if (gdbProcess)
                gdbProcess.kill();
            sendResponse(request);
            process.exit(0);
            break;
        default:
            sendResponse(request);
    }
}
function sendResponse(request, body = {}) {
    const response = {
        type: 'response',
        request_seq: request.seq,
        success: true,
        command: request.command,
        body: body
    };
    const json = JSON.stringify(response);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}
function sendEvent(event, body = {}) {
    const message = JSON.stringify({
        type: 'event',
        event: event,
        body: body
    });
    process.stdout.write(`Content-Length: ${Buffer.byteLength(message, 'utf8')}\r\n\r\n${message}`);
}
function launchGDB() {
    const args = JSON.parse(argsStr);
    const gdbArgs = [
        '--interpreter=mi2',
        '-ex', `python import sys; sys.path.insert(0, '${pythonPath}'); import async_rust_debugger`,
        '-ex', 'set pagination off',
        program,
        ...args
    ];
    gdbProcess = (0, child_process_1.spawn)('gdb', gdbArgs, { cwd });
    gdbProcess.stdout?.on('data', (data) => {
        process.stderr.write(`[GDB Output]: ${data.toString()}`);
    });
    gdbProcess.stderr?.on('data', (data) => {
        process.stderr.write(`[GDB Error]: ${data.toString()}`);
    });
    gdbProcess.on('exit', () => {
        sendEvent('terminated');
    });
}
//# sourceMappingURL=gdbAdapter.js.map