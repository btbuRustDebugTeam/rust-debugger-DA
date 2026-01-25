import * as vscode from 'vscode';
import { GDBDebugSession } from './gdbDebugSession';

/**
 * Factory for managing GDB debug session instances.
 * This is a simplified implementation that works with VS Code's debug session API.
 */
export class ARDDebugAdapterFactory {
    private gdbSession: GDBDebugSession;
    private context: vscode.ExtensionContext;
    private debugSessionListener: vscode.Disposable | undefined;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.gdbSession = new GDBDebugSession(context);

        // Listen for debug session changes
        this.debugSessionListener = vscode.debug.onDidStartDebugSession((session) => {
            if (session.type === 'ardb') {
                this.gdbSession.setDebugSession(session);
            }
        });
    }

    /**
     * Get the active GDB debug session for sending commands.
     */
    getActiveSession(): GDBDebugSession {
        return this.gdbSession;
    }

    dispose() {
        if (this.debugSessionListener) {
            this.debugSessionListener.dispose();
        }
        this.gdbSession.dispose();
    }
}
