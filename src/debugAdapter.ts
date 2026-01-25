// src/debugAdapter.ts
import * as vscode from 'vscode';
import * as path from 'path';
import { GDBDebugSession } from './gdbDebugSession';

export class ARDDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    private gdbSession: GDBDebugSession;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.gdbSession = new GDBDebugSession(context);
    }

    createDebugAdapterDescriptor(
        session: vscode.DebugSession,
        executable: vscode.DebugAdapterExecutable | undefined
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        const config = session.configuration;
        const workspaceFolder = session.workspaceFolder?.uri.fsPath || process.cwd();

        const extensionPath = this.context.extensionPath;
        
        const pythonPath = extensionPath; 
    
        const tempDir = path.join(workspaceFolder, 'temp');

        const adapterScript = path.join(extensionPath, 'out', 'gdbAdapter.js');
        
        return new vscode.DebugAdapterExecutable(
            'node',
            [adapterScript],
            {
                cwd: config.cwd || workspaceFolder,
                env: {
                    ...process.env,
                    ARDB_PROGRAM: config.program,
                    ARDB_ARGS: JSON.stringify(config.args || []),
                    ARDB_CWD: workspaceFolder,
                    PYTHONPATH: pythonPath, 
                    ASYNC_RUST_DEBUGGER_TEMP_DIR: tempDir 
                }
            }
        );
    }

    getActiveSession(): GDBDebugSession {
        return this.gdbSession;
    }

    dispose() {
        this.gdbSession.dispose();
    }
}