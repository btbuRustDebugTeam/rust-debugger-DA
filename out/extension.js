"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
//src/extension.ts
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const debugAdapter_1 = require("./debugAdapter");
const asyncInspectorPanel_1 = require("./webview/asyncInspectorPanel");
let debugAdapterFactory;
let inspectorPanel;
let lastAutoReveal;
function resolveSessionCwd(context, session) {
    const workspaceRoot = session?.workspaceFolder?.uri.fsPath
        || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        || context.extensionPath;
    const configuredCwd = session?.configuration?.cwd;
    if (typeof configuredCwd === 'string' && configuredCwd.trim()) {
        const expanded = configuredCwd
            .replace(/\$\{workspaceFolder\}/g, workspaceRoot)
            .replace(/\$\{workspaceRoot\}/g, workspaceRoot)
            .replace(/\$\{cwd\}/g, workspaceRoot);
        return path.isAbsolute(expanded) ? expanded : path.resolve(workspaceRoot, expanded);
    }
    return workspaceRoot;
}
function logRevealStopLocation(context, message, data = {}, session) {
    const logFile = path.join(resolveSessionCwd(context, session), 'temp', 'logs', 'reveal_stop_location_helper.log');
    try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        const timestamp = new Date().toISOString();
        fs.appendFileSync(logFile, `${timestamp} ${message} ${JSON.stringify(data)}\n`, 'utf8');
    }
    catch { }
}
function logAutoRevealStopLocation(context, message, data = {}, session) {
    const logFile = path.join(resolveSessionCwd(context, session), 'temp', 'logs', 'auto_reveal_stop_location.log');
    try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        const timestamp = new Date().toISOString();
        fs.appendFileSync(logFile, `${timestamp} ${message} ${JSON.stringify(data)}\n`, 'utf8');
    }
    catch { }
}
function isValidRevealResponse(response) {
    return !!response?.ok
        && typeof response.path === 'string'
        && response.path.length > 0
        && Number(response.line) > 0;
}
async function revealStopLocationInEditor(response) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(response.path));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const line = Math.max(0, (Number(response.line) || 1) - 1);
    const position = new vscode.Position(line, 0);
    const range = new vscode.Range(position, position);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}
function isDuplicateAutoReveal(response) {
    const key = `${response.path}:${response.line}:${response.addr || ''}`;
    const now = Date.now();
    if (lastAutoReveal?.key === key && now - lastAutoReveal.timestamp < 500) {
        return true;
    }
    lastAutoReveal = { key, timestamp: now };
    return false;
}
async function autoRevealStopLocation(context, session, stoppedBody) {
    const reason = stoppedBody?.reason;
    if (reason !== 'breakpoint' && reason !== 'pause') {
        return;
    }
    let response;
    try {
        response = await session.customRequest('ardbRevealStopLocation', {
            autoReveal: true,
            reason,
        });
    }
    catch (error) {
        logAutoRevealStopLocation(context, '[extension] auto reveal skipped: invalid frame', {
            reason,
            error: String(error),
        }, session);
        return;
    }
    if (!isValidRevealResponse(response)) {
        logAutoRevealStopLocation(context, '[extension] auto reveal skipped: invalid frame', {
            reason,
            message: response?.message || 'No stopped frame source location available',
            path: response?.path,
            line: response?.line,
            func: response?.func,
            addr: response?.addr,
            threadId: response?.threadId,
        }, session);
        return;
    }
    if (isDuplicateAutoReveal(response)) {
        logAutoRevealStopLocation(context, '[extension] auto reveal skipped: duplicate location', {
            reason,
            path: response.path,
            line: response.line,
            addr: response.addr,
        }, session);
        return;
    }
    logAutoRevealStopLocation(context, '[extension] auto reveal triggered', {
        reason,
        path: response.path,
        line: response.line,
        func: response.func,
        addr: response.addr,
        threadId: response.threadId,
    }, session);
    try {
        await revealStopLocationInEditor(response);
        logAutoRevealStopLocation(context, '[extension] auto reveal success', {
            path: response.path,
            line: response.line,
            func: response.func,
            addr: response.addr,
            threadId: response.threadId,
        }, session);
    }
    catch (error) {
        logAutoRevealStopLocation(context, '[extension] auto reveal skipped: invalid frame', {
            reason,
            path: response.path,
            line: response.line,
            error: String(error),
        }, session);
    }
}
function ensureInspectorPanel(context) {
    if (!debugAdapterFactory) {
        return undefined;
    }
    if (asyncInspectorPanel_1.AsyncInspectorPanel.currentPanel) {
        inspectorPanel = asyncInspectorPanel_1.AsyncInspectorPanel.currentPanel;
        inspectorPanel.reveal();
        return inspectorPanel;
    }
    inspectorPanel = asyncInspectorPanel_1.AsyncInspectorPanel.createOrShow(context.extensionUri, debugAdapterFactory);
    return inspectorPanel;
}
async function showInspectorForTestcaseLaunch(context, reason) {
    console.log(`[ARD] showing Async Inspector for ${reason}`);
    ensureInspectorPanel(context);
    await vscode.commands.executeCommand('workbench.view.debug');
    await vscode.commands.executeCommand('workbench.panel.repl.view.focus');
}
function activate(context) {
    console.log('ARD Debug Adapter extension is now active');
    // Create and register debug adapter factory
    debugAdapterFactory = new debugAdapter_1.ARDDebugAdapterFactory(context);
    const disposable = vscode.debug.registerDebugAdapterDescriptorFactory('ardb', debugAdapterFactory);
    context.subscriptions.push(disposable, debugAdapterFactory);
    // Register DebugAdapterTracker EARLY — before any session starts —
    // so that stopped events from the very first session are captured.
    const trackerDisposable = vscode.debug.registerDebugAdapterTrackerFactory('ardb', {
        createDebugAdapterTracker: (_session) => {
            return {
                onDidSendMessage: (message) => {
                    if (message.type === 'event' && message.event === 'stopped') {
                        if (inspectorPanel) {
                            inspectorPanel.onDebugStopped(_session, message.body);
                        }
                        autoRevealStopLocation(context, _session, message.body).catch((error) => {
                            logAutoRevealStopLocation(context, '[extension] auto reveal skipped: invalid frame', {
                                reason: message.body?.reason,
                                error: String(error),
                            }, _session);
                        });
                    }
                }
            };
        }
    });
    context.subscriptions.push(trackerDisposable);
    // Register command to open async inspector
    const openInspectorCommand = vscode.commands.registerCommand('ardb.openInspector', () => {
        if (!debugAdapterFactory) {
            vscode.window.showErrorMessage('Debug adapter factory not initialized');
            return;
        }
        ensureInspectorPanel(context);
    });
    // Register command to trace function from editor
    const traceFunctionCommand = vscode.commands.registerCommand('ardb.traceFunction', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No active editor');
            return;
        }
        const selection = editor.selection;
        const document = editor.document;
        const wordRange = document.getWordRangeAtPosition(selection.active);
        if (!wordRange) {
            vscode.window.showWarningMessage('No symbol at cursor');
            return;
        }
        const symbol = document.getText(wordRange);
        const debugSession = vscode.debug.activeDebugSession;
        if (!debugSession || debugSession.type !== 'ardb') {
            vscode.window.showWarningMessage('No active ARD debug session');
            return;
        }
        // Send custom request to trace function
        try {
            await debugSession.customRequest('ardb-trace', { symbol });
            vscode.window.showInformationMessage(`Tracing function: ${symbol}`);
        }
        catch (error) {
            vscode.window.showErrorMessage(`Failed to trace function: ${error}`);
        }
    });
    const revealStopLocationCommand = vscode.commands.registerCommand('async-rust-debugger.revealStopLocation', async () => {
        const debugSession = vscode.debug.activeDebugSession;
        if (!debugSession || debugSession.type !== 'ardb') {
            const message = 'No active ARD debug session';
            logRevealStopLocation(context, '[extension] reveal failed', { reason: message });
            vscode.window.showWarningMessage(message);
            return;
        }
        logRevealStopLocation(context, '[extension] reveal request received', {}, debugSession);
        try {
            const response = await debugSession.customRequest('ardbRevealStopLocation');
            if (!response?.ok) {
                const message = response?.message || 'No stopped frame available';
                logRevealStopLocation(context, '[extension] reveal failed', { reason: message }, debugSession);
                vscode.window.showWarningMessage(message);
                return;
            }
            await revealStopLocationInEditor(response);
            logRevealStopLocation(context, '[extension] reveal success', {
                path: response.path,
                line: response.line,
                func: response.func,
                addr: response.addr,
                threadId: response.threadId,
            }, debugSession);
        }
        catch (error) {
            const message = `Failed to reveal stop location: ${error}`;
            logRevealStopLocation(context, '[extension] reveal failed', { reason: message }, debugSession);
            vscode.window.showErrorMessage(message);
        }
    });
    context.subscriptions.push(openInspectorCommand, traceFunctionCommand, revealStopLocationCommand);
    // Match the rel4 testcase flow: when an ARD debug session starts, show the
    // Inspector in the main editor area and keep the normal debug UI visible.
    const onDidStartDebugSession = vscode.debug.onDidStartDebugSession((session) => {
        if (session.type === 'ardb' && debugAdapterFactory) {
            showInspectorForTestcaseLaunch(context, session.name).catch((error) => {
                console.error('[ARD] failed to show Async Inspector for debug session:', error);
            });
        }
    });
    context.subscriptions.push(onDidStartDebugSession);
    // Clean up when debug session ends
    const onDidTerminateDebugSession = vscode.debug.onDidTerminateDebugSession((session) => {
        if (session.type === 'ardb' && inspectorPanel) {
            inspectorPanel.dispose();
            inspectorPanel = undefined;
        }
    });
    context.subscriptions.push(onDidTerminateDebugSession);
}
function deactivate() {
    if (inspectorPanel) {
        inspectorPanel.dispose();
        inspectorPanel = undefined;
    }
    if (debugAdapterFactory) {
        debugAdapterFactory.dispose();
        debugAdapterFactory = undefined;
    }
}
//# sourceMappingURL=extension.js.map