//src/extension.ts
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ARDDebugAdapterFactory } from './debugAdapter';
import { AsyncInspectorPanel } from './webview/asyncInspectorPanel';

let debugAdapterFactory: ARDDebugAdapterFactory | undefined;
let inspectorPanel: AsyncInspectorPanel | undefined;
let lastAutoReveal:
    | { key: string; timestamp: number }
    | undefined;

type RevealStopLocationResponse = {
    ok?: boolean;
    path?: string;
    line?: number;
    func?: string;
    addr?: string;
    threadId?: number;
    message?: string;
};

function resolveSessionCwd(context: vscode.ExtensionContext, session?: vscode.DebugSession): string {
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

function logRevealStopLocation(
    context: vscode.ExtensionContext,
    message: string,
    data: Record<string, unknown> = {},
    session?: vscode.DebugSession,
): void {
    const logFile = path.join(resolveSessionCwd(context, session), 'temp', 'logs', 'reveal_stop_location_helper.log');
    try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        const timestamp = new Date().toISOString();
        fs.appendFileSync(logFile, `${timestamp} ${message} ${JSON.stringify(data)}\n`, 'utf8');
    } catch {}
}

function logAutoRevealStopLocation(
    context: vscode.ExtensionContext,
    message: string,
    data: Record<string, unknown> = {},
    session?: vscode.DebugSession,
): void {
    const logFile = path.join(resolveSessionCwd(context, session), 'temp', 'logs', 'auto_reveal_stop_location.log');
    try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        const timestamp = new Date().toISOString();
        fs.appendFileSync(logFile, `${timestamp} ${message} ${JSON.stringify(data)}\n`, 'utf8');
    } catch {}
}

function isValidRevealResponse(response: RevealStopLocationResponse | undefined): response is RevealStopLocationResponse & { path: string; line: number } {
    return !!response?.ok
        && typeof response.path === 'string'
        && response.path.length > 0
        && Number(response.line) > 0;
}

async function revealStopLocationInEditor(response: RevealStopLocationResponse & { path: string; line: number }): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(response.path));
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const line = Math.max(0, (Number(response.line) || 1) - 1);
    const position = new vscode.Position(line, 0);
    const range = new vscode.Range(position, position);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

function isDuplicateAutoReveal(response: RevealStopLocationResponse & { path: string; line: number }): boolean {
    const key = `${response.path}:${response.line}:${response.addr || ''}`;
    const now = Date.now();
    if (lastAutoReveal?.key === key && now - lastAutoReveal.timestamp < 500) {
        return true;
    }

    lastAutoReveal = { key, timestamp: now };
    return false;
}

async function autoRevealStopLocation(
    context: vscode.ExtensionContext,
    session: vscode.DebugSession,
    stoppedBody: any,
): Promise<void> {
    const reason = stoppedBody?.reason;
    if (reason !== 'breakpoint' && reason !== 'pause') {
        return;
    }

    let response: RevealStopLocationResponse | undefined;
    try {
        response = await session.customRequest('ardbRevealStopLocation', {
            autoReveal: true,
            reason,
        });
    } catch (error) {
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
    } catch (error) {
        logAutoRevealStopLocation(context, '[extension] auto reveal skipped: invalid frame', {
            reason,
            path: response.path,
            line: response.line,
            error: String(error),
        }, session);
    }
}

function ensureInspectorPanel(context: vscode.ExtensionContext): AsyncInspectorPanel | undefined {
    if (!debugAdapterFactory) {
        return undefined;
    }

    if (AsyncInspectorPanel.currentPanel) {
        inspectorPanel = AsyncInspectorPanel.currentPanel;
        inspectorPanel.reveal();
        return inspectorPanel;
    }

    inspectorPanel = AsyncInspectorPanel.createOrShow(context.extensionUri, debugAdapterFactory);
    return inspectorPanel;
}

async function showInspectorForTestcaseLaunch(context: vscode.ExtensionContext, reason: string): Promise<void> {
    console.log(`[ARD] showing Async Inspector for ${reason}`);
    ensureInspectorPanel(context);
    await vscode.commands.executeCommand('workbench.view.debug');
    await vscode.commands.executeCommand('workbench.panel.repl.view.focus');
}

export function activate(context: vscode.ExtensionContext) {
    console.log('ARD Debug Adapter extension is now active');

    // Create and register debug adapter factory
    debugAdapterFactory = new ARDDebugAdapterFactory(context);
    const disposable = vscode.debug.registerDebugAdapterDescriptorFactory('ardb', debugAdapterFactory);
    context.subscriptions.push(disposable, debugAdapterFactory);

    // Register DebugAdapterTracker EARLY — before any session starts —
    // so that stopped events from the very first session are captured.
    const trackerDisposable = vscode.debug.registerDebugAdapterTrackerFactory('ardb', {
        createDebugAdapterTracker: (_session: vscode.DebugSession) => {
            return {
                onDidSendMessage: (message: any) => {
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
        } catch (error) {
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
        } catch (error) {
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

export function deactivate() {
    if (inspectorPanel) {
        inspectorPanel.dispose();
        inspectorPanel = undefined;
    }
    if (debugAdapterFactory) {
        debugAdapterFactory.dispose();
        debugAdapterFactory = undefined;
    }
}
