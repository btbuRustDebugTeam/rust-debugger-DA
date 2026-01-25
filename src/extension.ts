import * as vscode from 'vscode';
import { ARDDebugAdapterFactory } from './debugAdapter';
import { AsyncInspectorPanel } from './webview/asyncInspectorPanel';

let debugAdapterFactory: ARDDebugAdapterFactory | undefined;
let inspectorPanel: AsyncInspectorPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('ARD Debug Adapter extension is now active');

    // Create debug adapter factory (simplified - doesn't need DAP registration for now)
    debugAdapterFactory = new ARDDebugAdapterFactory(context);
    context.subscriptions.push(debugAdapterFactory);

    // Register command to open async inspector
    const openInspectorCommand = vscode.commands.registerCommand('ardb.openInspector', () => {
        if (!inspectorPanel) {
            inspectorPanel = AsyncInspectorPanel.createOrShow(context.extensionUri, debugAdapterFactory);
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

        // Send custom request to trace function
        try {
            await debugSession.customRequest('ardb-trace', { symbol });
            vscode.window.showInformationMessage(`Tracing function: ${symbol}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to trace function: ${error}`);
        }
    });

    context.subscriptions.push(openInspectorCommand, traceFunctionCommand);

    // Open inspector automatically when debug session starts
    const onDidStartDebugSession = vscode.debug.onDidStartDebugSession((session) => {
        if (session.type === 'ardb') {
            if (!inspectorPanel) {
                inspectorPanel = AsyncInspectorPanel.createOrShow(context.extensionUri, debugAdapterFactory!);
            }
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
