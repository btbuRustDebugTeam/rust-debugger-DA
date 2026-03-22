import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Snapshot data structure from ardb-get-snapshot command
 */
export interface SnapshotData {
    thread_id: number;
    path: Array<{
        type: 'async' | 'sync';
        cid: number | null;
        func: string;
        addr: string;
        poll: number;
        state: number | string;
        file?: string;
        fullname?: string;
        line?: number;
    }>;
}

/**
 * Grouped whitelist data structure (crate-level grouping)
 */
export interface GroupedWhitelist {
    version: number;
    crates: {
        [crateName: string]: {
            is_user_crate: boolean;
            symbols: Array<{
                name: string;
                file: string | null;
                line: number | null;
                kind: 'async' | 'sync';
            }>;
        };
    };
}

/**
 * Inferred trace root from breakpoint position
 */
export interface InferredTraceRoot {
    trace_root: string | null;
    all_async_frames: string[];
}

/**
 * GDB Debug Session that communicates with GDB via VS Code debug session API
 * and executes ARD-specific commands.
 */
export class GDBDebugSession {
    private debugSession: vscode.DebugSession | undefined;
    private context: vscode.ExtensionContext;
    private tempDir: string;
    private logPath: string;
    private whitelistPath: string;
    private groupedWhitelistPath: string;
    private fileWatcher: vscode.FileSystemWatcher | undefined;
    private lastSnapshot: SnapshotData | undefined;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;

        // Determine temp directory
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const envTempDir = process.env.ASYNC_RUST_DEBUGGER_TEMP_DIR;
        this.tempDir = envTempDir || (workspaceFolder ? path.join(workspaceFolder, 'temp') : './temp');
        this.logPath = path.join(this.tempDir, 'ardb.log');
        this.whitelistPath = path.join(this.tempDir, 'poll_functions.txt');
        this.groupedWhitelistPath = path.join(this.tempDir, 'poll_functions_grouped.json');

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
    setDebugSession(session: vscode.DebugSession): void {
        this.debugSession = session;
    }

    private setupWhitelistWatcher(): void {
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(path.dirname(this.whitelistPath), path.basename(this.whitelistPath))
        );

        this.fileWatcher.onDidChange(async (uri) => {
            if (uri.fsPath === this.whitelistPath && this.debugSession) {
                // Auto-reload whitelist when file is saved
                try {
                    await this.executeGDBCommand('ardb-load-whitelist');
                    const count = await this.getWhitelistSymbolCount();
                    vscode.window.showInformationMessage(`Whitelist reloaded (${count} symbols found)`);
                } catch (error) {
                    console.error('Failed to reload whitelist:', error);
                }
            }
        });
    }

    private async getWhitelistSymbolCount(): Promise<number> {
        try {
            if (fs.existsSync(this.whitelistPath)) {
                const content = fs.readFileSync(this.whitelistPath, 'utf-8');
                const lines = content.split('\n').filter(line => {
                    const trimmed = line.trim();
                    return trimmed && !trimmed.startsWith('#');
                });
                return lines.length;
            }
        } catch (error) {
            console.error('Failed to read whitelist:', error);
        }
        return 0;
    }

    /**
     * Execute a GDB command via the debug session.
     * Note: This requires the debug adapter to support custom requests.
     */
    async executeGDBCommand(command: string): Promise<string> {
        if (!this.debugSession) {
            throw new Error('No active debug session');
        }

        try {
            const response = await this.debugSession.customRequest('evaluate', {
                expression: command,
                context: 'repl'
            });
            return response?.result || '';
        } catch (error) {
            console.error('GDB Command Failed:', command, error);
            return '';
        }
    }

    /**
     * Get snapshot from GDB using ardb-get-snapshot command.
     * Parses the JSON directly from the evaluate response.
     */
    async getSnapshot(): Promise<SnapshotData | undefined> {
        if (!this.debugSession) {
            console.warn('[GDBDebugSession] getSnapshot: no debug session');
            return undefined;
        }

        try {
            const output = await this.executeGDBCommand('ardb-get-snapshot');
            console.log('[GDBDebugSession] ardb-get-snapshot raw output length:', output.length, 'first 200 chars:', output.substring(0, 200));
            if (!output) {
                return this.lastSnapshot;
            }

            // The output may contain non-JSON lines before/after the JSON object.
            // Find the first '{' and last '}' to extract the JSON payload.
            const jsonStart = output.indexOf('{');
            const jsonEnd = output.lastIndexOf('}');
            if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
                return this.lastSnapshot;
            }

            const jsonStr = output.substring(jsonStart, jsonEnd + 1);
            const snapshot = JSON.parse(jsonStr) as SnapshotData;
            if (snapshot.thread_id !== undefined && snapshot.path) {
                this.lastSnapshot = snapshot;
                return snapshot;
            }

            return this.lastSnapshot;
        } catch (error) {
            console.error('Failed to get snapshot:', error);
            return this.lastSnapshot;
        }
    }

    /**
     * Execute ardb-reset command.
     */
    async reset(): Promise<void> {
        await this.executeGDBCommand('ardb-reset');
        // Clear log file
        if (fs.existsSync(this.logPath)) {
            fs.writeFileSync(this.logPath, '');
        }
    }

    /**
     * Execute ardb-gen-whitelist command and return grouped whitelist.
     * No longer opens the flat file in editor — the webview handles display.
     */
    async genWhitelist(): Promise<GroupedWhitelist | undefined> {
        await this.executeGDBCommand('ardb-gen-whitelist');
        return this.getGroupedWhitelist();
    }

    /**
     * Execute ardb-trace command.
     */
    async traceFunction(symbol: string): Promise<void> {
        await this.executeGDBCommand(`ardb-trace ${symbol}`);
    }

    /**
     * Get log entries for a specific CID.
     */
    async getLogEntriesForCID(cid: number): Promise<string[]> {
        try {
            if (!fs.existsSync(this.logPath)) {
                return [];
            }
            const content = fs.readFileSync(this.logPath, 'utf-8');
            const lines = content.split('\n');
            const cidPattern = new RegExp(`coro#${cid}`);
            return lines.filter(line => cidPattern.test(line)).slice(-10); // Last 10 entries
        } catch (error) {
            console.error('Failed to read log:', error);
            return [];
        }
    }

    /**
     * Get whitelist candidates from poll_functions.txt (flat format, backward compat).
     */
    async getWhitelistCandidates(): Promise<string[]> {
        try {
            if (!fs.existsSync(this.whitelistPath)) {
                return [];
            }
            const content = fs.readFileSync(this.whitelistPath, 'utf-8');
            const candidates: string[] = [];
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
        } catch (error) {
            console.error('Failed to read whitelist:', error);
            return [];
        }
    }

    /**
     * Get grouped whitelist (crate-level grouping).
     * Reads from disk first (fast path), falls back to GDB command.
     */
    async getGroupedWhitelist(): Promise<GroupedWhitelist | undefined> {
        // Fast path: read from disk
        try {
            if (fs.existsSync(this.groupedWhitelistPath)) {
                const content = fs.readFileSync(this.groupedWhitelistPath, 'utf-8');
                const grouped = JSON.parse(content) as GroupedWhitelist;
                if (grouped.version !== undefined && grouped.crates) {
                    return grouped;
                }
            }
        } catch (error) {
            console.error('Failed to read grouped whitelist from disk:', error);
        }

        // Fallback: ask GDB
        if (!this.debugSession) {
            return undefined;
        }

        try {
            const output = await this.executeGDBCommand('ardb-get-whitelist-grouped');
            if (!output) {
                return undefined;
            }
            const jsonStart = output.indexOf('{');
            const jsonEnd = output.lastIndexOf('}');
            if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
                return undefined;
            }
            const jsonStr = output.substring(jsonStart, jsonEnd + 1);
            const grouped = JSON.parse(jsonStr) as GroupedWhitelist;
            if (grouped.version !== undefined && grouped.crates) {
                return grouped;
            }
        } catch (error) {
            console.error('Failed to get grouped whitelist from GDB:', error);
        }

        return undefined;
    }

    /**
     * Update whitelist selection by specifying which crates are enabled.
     * Sends ardb-update-whitelist to GDB which rewrites poll_functions.txt and reloads.
     */
    async updateWhitelistSelection(enabledCrates: string[]): Promise<void> {
        const payload = JSON.stringify({ enabled_crates: enabledCrates });
        await this.executeGDBCommand(`ardb-update-whitelist ${payload}`);
    }

    /**
     * Infer trace root from current breakpoint position.
     * Walks the GDB stack to find the outermost user-crate async function.
     */
    async inferTraceRoot(): Promise<InferredTraceRoot | undefined> {
        if (!this.debugSession) {
            return undefined;
        }

        try {
            const output = await this.executeGDBCommand('ardb-infer-trace-root');
            if (!output) {
                return undefined;
            }
            const jsonStart = output.indexOf('{');
            const jsonEnd = output.lastIndexOf('}');
            if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
                return undefined;
            }
            const jsonStr = output.substring(jsonStart, jsonEnd + 1);
            return JSON.parse(jsonStr) as InferredTraceRoot;
        } catch (error) {
            console.error('Failed to infer trace root:', error);
            return undefined;
        }
    }

    dispose(): void {
        if (this.fileWatcher) {
            this.fileWatcher.dispose();
        }
    }
}
