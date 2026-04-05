import * as vscode from 'vscode';
import * as path from 'path';
import { ARDDebugAdapterFactory } from './debugAdapter';
import { AsyncInspectorPanel } from './webview/asyncInspectorPanel';
import { Border } from './breakpointGroups';

let inspectorPanel: AsyncInspectorPanel | undefined;
let whitelistWatcher: vscode.FileSystemWatcher | undefined;

// Substitute common VS Code variables in a string from launch.json.
// VS Code does not substitute variables when you read launch.json via the API.
function variablesSubstitution(str: string): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspace = workspaceFolders?.length ? workspaceFolders[0] : undefined;
    str = str.replace(/\${workspaceFolder}/g, workspace?.uri.fsPath ?? '');
    str = str.replace(/\${workspaceFolderBasename}/g, workspace?.name ?? '');
    str = str.replace(/\${userHome}/g, process.env.HOME ?? process.env.USERPROFILE ?? '');
    str = str.replace(/\${env:(.*?)}/g, (_, key) => process.env[key] ?? '');
    return str;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('ARD Debug Adapter extension is now active');

    // Create and register debug adapter factory
    const debugAdapterFactory = new ARDDebugAdapterFactory(context);
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
                    }
                    if (message.type === 'event' && message.event === 'showInformationMessage') {
                        vscode.window.showInformationMessage(message.body);
                    }
                    if (message.type === 'event' && message.event === 'showErrorMessage') {
                        vscode.window.showErrorMessage(message.body);
                    }
                }
            };
        }
    });
    context.subscriptions.push(trackerDisposable);

    // Register command to open async inspector
    const openInspectorCommand = vscode.commands.registerCommand('ardb.openInspector', () => {
        if (!inspectorPanel) {
            inspectorPanel = AsyncInspectorPanel.createOrShow(context.extensionUri);
        } else {
            inspectorPanel.reveal();
        }
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

        try {
            await debugSession.customRequest('ardb-trace', { symbol });
            vscode.window.showInformationMessage(`Tracing function: ${symbol}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to trace function: ${error}`);
        }
    });

    // -----------------------------------------------------------------------
    // OS debug commands
    // -----------------------------------------------------------------------

    // Read border_breakpoints from launch.json and set them in the debug session
    const setBorderBreakpointsCmd = vscode.commands.registerCommand(
        'ardb.setBorderBreakpointsFromLaunchJSON',
        () => {
            const config = vscode.workspace.getConfiguration('launch', vscode.workspace.workspaceFolders?.[0].uri);
            const configurations: any[] = config.get('configurations') ?? [];
            const borders: Array<{ filepath: string; line: number }> = configurations[0]?.border_breakpoints ?? [];
            for (const b of borders) {
                const border = new Border(variablesSubstitution(b.filepath), b.line);
                const bp = new vscode.SourceBreakpoint(
                    new vscode.Location(vscode.Uri.file(border.filepath), new vscode.Position(border.line - 1, 0)),
                    true
                );
                vscode.debug.addBreakpoints([bp]);
                vscode.debug.activeDebugSession?.customRequest('setBorder', border);
            }
            vscode.window.showInformationMessage('Border breakpoints from launch.json set.');
        }
    );

    // Read hook_breakpoints from launch.json and set them in the debug session
    const setHookBreakpointsCmd = vscode.commands.registerCommand(
        'ardb.setHookBreakpointsFromLaunchJSON',
        () => {
            const config = vscode.workspace.getConfiguration('launch', vscode.workspace.workspaceFolders?.[0].uri);
            const configurations: any[] = config.get('configurations') ?? [];
            const hooks: any[] = configurations[0]?.hook_breakpoints ?? [];
            for (const h of hooks) {
                const hook = {
                    breakpoint: {
                        file: variablesSubstitution(h.breakpoint.file),
                        line: h.breakpoint.line,
                    },
                    behavior: {
                        functionArguments: variablesSubstitution(h.behavior.functionArguments ?? ''),
                        functionBody: variablesSubstitution(h.behavior.functionBody ?? ''),
                        isAsync: h.behavior.isAsync ?? false,
                    },
                };
                const bp = new vscode.SourceBreakpoint(
                    new vscode.Location(vscode.Uri.file(hook.breakpoint.file), new vscode.Position(hook.breakpoint.line - 1, 0)),
                    true
                );
                vscode.debug.addBreakpoints([bp]);
                vscode.debug.activeDebugSession?.customRequest('setHookBreakpoint', hook);
            }
            vscode.window.showInformationMessage('Hook breakpoints from launch.json set.');
        }
    );

    // Right-click a breakpoint in the editor gutter → set it as a border
    const setBreakpointAsBorderCmd = vscode.commands.registerCommand(
        'ardb.setBreakpointAsBorder',
        (...args: any[]) => {
            const fullpath: string = args[0]?.uri?.fsPath;
            const lineNumber: number = args[0]?.lineNumber;
            if (!fullpath || !lineNumber) return;
            vscode.debug.activeDebugSession?.customRequest('setBorder', new Border(fullpath, lineNumber));
        }
    );

    // Disable a border (breakpoint stays, just no longer acts as a border)
    const disableBorderCmd = vscode.commands.registerCommand(
        'ardb.disableBorderOfThisBreakpointGroup',
        (...args: any[]) => {
            const fullpath: string = args[0]?.uri?.fsPath;
            const lineNumber: number = args[0]?.lineNumber;
            if (!fullpath || !lineNumber) return;
            vscode.debug.activeDebugSession?.customRequest('disableBorder', new Border(fullpath, lineNumber));
        }
    );

    // Remove all breakpoints from both VS Code UI and GDB
    const removeAllBreakpointsCmd = vscode.commands.registerCommand(
        'ardb.removeAllCliBreakpoints',
        () => {
            vscode.commands.executeCommand('workbench.debug.viewlet.action.removeAllBreakpoints');
            vscode.debug.activeDebugSession?.customRequest('removeAllCliBreakpoints');
            vscode.window.showInformationMessage('All breakpoints removed.');
        }
    );

    context.subscriptions.push(
        openInspectorCommand,
        traceFunctionCommand,
        setBorderBreakpointsCmd,
        setHookBreakpointsCmd,
        setBreakpointAsBorderCmd,
        disableBorderCmd,
        removeAllBreakpointsCmd,
    );

    // Open inspector automatically when debug session starts + setup whitelist watcher
    const onDidStartDebugSession = vscode.debug.onDidStartDebugSession((session) => {
        if (session.type === 'ardb') {
            if (!inspectorPanel) {
                inspectorPanel = AsyncInspectorPanel.createOrShow(context.extensionUri);
            }

            // Setup whitelist file watcher
            const workspaceFolder = session.workspaceFolder?.uri.fsPath;
            if (workspaceFolder) {
                const whitelistPath = path.join(workspaceFolder, 'temp', 'poll_functions.txt');
                whitelistWatcher = vscode.workspace.createFileSystemWatcher(
                    new vscode.RelativePattern(
                        path.dirname(whitelistPath),
                        path.basename(whitelistPath),
                    ),
                );
                whitelistWatcher.onDidChange(async () => {
                    try {
                        await session.customRequest('ardb-execute-command', {
                            command: 'ardb-load-whitelist',
                        });
                    } catch (error) {
                        console.error('Failed to reload whitelist:', error);
                    }
                });
            }
        }
    });

    context.subscriptions.push(onDidStartDebugSession);

    // Clean up when debug session ends
    const onDidTerminateDebugSession = vscode.debug.onDidTerminateDebugSession((session) => {
        if (session.type === 'ardb') {
            if (whitelistWatcher) {
                whitelistWatcher.dispose();
                whitelistWatcher = undefined;
            }
            if (inspectorPanel) {
                inspectorPanel.dispose();
                inspectorPanel = undefined;
            }
        }
    });

    context.subscriptions.push(onDidTerminateDebugSession);
}

export function deactivate() {
    if (whitelistWatcher) {
        whitelistWatcher.dispose();
        whitelistWatcher = undefined;
    }
    if (inspectorPanel) {
        inspectorPanel.dispose();
        inspectorPanel = undefined;
    }
}
