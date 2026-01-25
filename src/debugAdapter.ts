import * as vscode from 'vscode';
import * as path from 'path';
import { GDBDebugSession } from './gdbDebugSession';

/**
 * Factory for creating ARD debug adapter instances.
 * Implements DebugAdapterDescriptorFactory to register with VS Code.
 */
export class ARDDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
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
     * Create a debug adapter descriptor for the given debug session.
     * This method is called by VS Code when a debug session starts.
     * 
     * This implementation provides a minimal DAP server that launches GDB.
     * For a full-featured debug adapter, a complete DAP protocol implementation
     * would be needed.
     */
    createDebugAdapterDescriptor(
        session: vscode.DebugSession,
        executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        const config = session.configuration;
        const program = config.program;
        const args = config.args || [];
        const cwd = config.cwd || session.workspaceFolder?.uri.fsPath || process.cwd();
        const env = config.env || {};

        // Get workspace folder path for Python module
        const workspaceFolder = session.workspaceFolder?.uri.fsPath || process.cwd();
        const pythonPath = path.join(workspaceFolder, 'async_rust_debugger');
        const tempDir = path.join(workspaceFolder, 'temp');

        // Set up environment variables
        const envVars = {
            ...process.env,
            ...env,
            PYTHONPATH: pythonPath,
            ASYNC_RUST_DEBUGGER_TEMP_DIR: tempDir
        };

        // Create a debug adapter executable that runs our minimal DAP server
        const adapterScript = path.join(this.context.extensionPath, 'out', 'gdbAdapter.js');
        
        // Return an executable that runs our adapter script
        // The adapter script will implement a minimal DAP server
        return new vscode.DebugAdapterExecutable(
            'node',
            [adapterScript],
            {
                cwd: cwd,
                // Pass configuration as environment variables for the adapter
                env: {
                    ...envVars,
                    ARDB_PROGRAM: program,
                    ARDB_ARGS: JSON.stringify(args),
                    ARDB_CWD: cwd
                }
            }
        );
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
