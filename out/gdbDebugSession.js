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
exports.GDBDebugSession = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
/**
 * GDB Debug Session that communicates with GDB via VS Code debug session API
 * and executes ARD-specific commands.
 */
class GDBDebugSession {
    constructor(context) {
        this.context = context;
        // Determine temp directory
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const envTempDir = process.env.ASYNC_RUST_DEBUGGER_TEMP_DIR;
        this.tempDir = envTempDir || (workspaceFolder ? path.join(workspaceFolder, 'temp') : './temp');
        this.logPath = path.join(this.tempDir, 'ardb.log');
        this.whitelistPath = path.join(this.tempDir, 'poll_functions.txt');
        this.snapshotOutputPath = path.join(this.tempDir, 'ardb_snapshot.json');
        // Ensure temp directory exists
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
        // Setup file watcher for whitelist
        this.setupWhitelistWatcher();
        // Listen for debug session changes
        vscode.debug.onDidStartDebugSession((session) => {
            if (session.type === 'ardb') {
                this.debugSession = session;
            }
        });
        vscode.debug.onDidTerminateDebugSession((session) => {
            if (session === this.debugSession) {
                this.debugSession = undefined;
            }
        });
    }
    /**
     * Set the active debug session.
     */
    setDebugSession(session) {
        this.debugSession = session;
    }
    setupWhitelistWatcher() {
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(path.dirname(this.whitelistPath), path.basename(this.whitelistPath)));
        this.fileWatcher.onDidChange(async (uri) => {
            if (uri.fsPath === this.whitelistPath && this.debugSession) {
                // Auto-reload whitelist when file is saved
                try {
                    await this.executeGDBCommand('ardb-load-whitelist');
                    const count = await this.getWhitelistSymbolCount();
                    vscode.window.showInformationMessage(`Whitelist reloaded (${count} symbols found)`);
                }
                catch (error) {
                    console.error('Failed to reload whitelist:', error);
                }
            }
        });
    }
    async getWhitelistSymbolCount() {
        try {
            if (fs.existsSync(this.whitelistPath)) {
                const content = fs.readFileSync(this.whitelistPath, 'utf-8');
                const lines = content.split('\n').filter(line => {
                    const trimmed = line.trim();
                    return trimmed && !trimmed.startsWith('#');
                });
                return lines.length;
            }
        }
        catch (error) {
            console.error('Failed to read whitelist:', error);
        }
        return 0;
    }
    /**
     * Execute a GDB command via the debug session.
     * Note: This requires the debug adapter to support custom requests.
     */
    async executeGDBCommand(command) {
        if (!this.debugSession) {
            throw new Error('No active debug session');
        }
        try {
            const response = await this.debugSession.customRequest('evaluate', {
                expression: command,
                context: 'repl'
            });
            return response?.result || '';
        }
        catch (error) {
            console.error('GDB Command Failed:', command, error);
            return '';
        }
    }
    /**
     * Get snapshot from GDB using ardb-get-snapshot command.
     * The Python script now writes the snapshot to a file automatically.
     */
    async getSnapshot() {
        if (!this.debugSession) {
            return undefined;
        }
        try {
            // Execute the command - the Python script will write to file automatically
            // We try to execute it via the debug session, but if that fails,
            // we can still read the file if it was written by a previous command execution
            try {
                // Try to execute the command through the debug session
                // Note: This may not work depending on the debug adapter implementation
                await this.executeGDBCommand('ardb-get-snapshot');
            }
            catch (e) {
                // Command execution may fail, but the file might still be updated
                // if the command was executed elsewhere (e.g., manually in GDB console)
                console.warn('Command execution may have failed, but checking file anyway:', e);
            }
            // Wait a bit for file to be written (Python script writes it asynchronously)
            await new Promise(resolve => setTimeout(resolve, 100));
            // Read the snapshot file (Python script writes it automatically)
            if (fs.existsSync(this.snapshotOutputPath)) {
                const content = fs.readFileSync(this.snapshotOutputPath, 'utf-8').trim();
                if (content) {
                    try {
                        const snapshot = JSON.parse(content);
                        if (snapshot.thread_id !== undefined && snapshot.path) {
                            this.lastSnapshot = snapshot;
                            return snapshot;
                        }
                    }
                    catch (e) {
                        console.error('Failed to parse snapshot JSON:', e, content.substring(0, 100));
                    }
                }
            }
            // Return last known snapshot if available
            return this.lastSnapshot;
        }
        catch (error) {
            console.error('Failed to get snapshot:', error);
            return this.lastSnapshot;
        }
    }
    /**
     * Execute ardb-reset command.
     */
    async reset() {
        await this.executeGDBCommand('ardb-reset');
        // Clear log file
        if (fs.existsSync(this.logPath)) {
            fs.writeFileSync(this.logPath, '');
        }
    }
    /**
     * Execute ardb-gen-whitelist command and open the file.
     */
    async genWhitelist() {
        await this.executeGDBCommand('ardb-gen-whitelist');
        // Open the generated file
        if (fs.existsSync(this.whitelistPath)) {
            const doc = await vscode.workspace.openTextDocument(this.whitelistPath);
            await vscode.window.showTextDocument(doc);
        }
    }
    /**
     * Execute ardb-trace command.
     */
    async traceFunction(symbol) {
        await this.executeGDBCommand(`ardb-trace ${symbol}`);
    }
    /**
     * Get log entries for a specific CID.
     */
    async getLogEntriesForCID(cid) {
        try {
            if (!fs.existsSync(this.logPath)) {
                return [];
            }
            const content = fs.readFileSync(this.logPath, 'utf-8');
            const lines = content.split('\n');
            const cidPattern = new RegExp(`coro#${cid}`);
            return lines.filter(line => cidPattern.test(line)).slice(-10); // Last 10 entries
        }
        catch (error) {
            console.error('Failed to read log:', error);
            return [];
        }
    }
    /**
     * Get whitelist candidates from poll_functions.txt.
     */
    async getWhitelistCandidates() {
        try {
            if (!fs.existsSync(this.whitelistPath)) {
                return [];
            }
            const content = fs.readFileSync(this.whitelistPath, 'utf-8');
            const candidates = [];
            for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    const parts = trimmed.split(/\s+/);
                    const symbol = parts.length >= 2 ? parts[1] : trimmed;
                    if (symbol) {
                        candidates.push(symbol);
                    }
                }
            }
            return candidates;
        }
        catch (error) {
            console.error('Failed to read whitelist:', error);
            return [];
        }
    }
    dispose() {
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
        }
    }
}
exports.GDBDebugSession = GDBDebugSession;
//# sourceMappingURL=gdbDebugSession.js.map