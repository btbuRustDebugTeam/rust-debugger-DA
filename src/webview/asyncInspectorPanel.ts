import * as vscode from 'vscode';
import { ARDDebugAdapterFactory } from '../debugAdapter';
import { SnapshotData } from '../gdbDebugSession';

/**
 * Async Inspector Panel - Webview for displaying async execution trees
 */
export class AsyncInspectorPanel {
    public static currentPanel: AsyncInspectorPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _debugAdapterFactory: ARDDebugAdapterFactory | undefined;
    private _debugSession: vscode.DebugSession | undefined;
    private _treeRoots: Map<number, TreeNode> = new Map(); // root CID -> tree node
    /** Cache of the last snapshot, used by selectNode to find frame indices. */
    private _lastSnapshot: SnapshotData | undefined;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, debugAdapterFactory: ARDDebugAdapterFactory) {
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._debugAdapterFactory = debugAdapterFactory;

        // Set the webview's initial html content
        this._update();

        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'reset':
                        await this.handleReset();
                        break;
                    case 'genWhitelist':
                        await this.handleGenWhitelist();
                        break;
                    case 'trace':
                        await this.handleTrace(message.symbol);
                        break;
                    case 'snapshot':
                        await this.handleSnapshot();
                        break;
                    case 'selectNode':
                        await this.handleSelectNode(message.cid);
                        break;
                    case 'locate':
                        await this.handleLocate(message.symbol);
                        break;
                    case 'refreshCandidates':
                        await this.handleRefreshCandidates();
                        break;
                    case 'selectFrame':
                        await this.handleSelectFrame(message.file, message.line);
                        break;
                }
            },
            null,
            this._disposables
        );

        // Listen for debug session changes
        vscode.debug.onDidChangeActiveDebugSession((session) => {
            this._debugSession = session?.type === 'ardb' ? session : undefined;
        }, null, this._disposables);

        // Register a DebugAdapterTracker to intercept stopped events from the adapter.
        // This replaces the 500ms polling timer with event-driven updates.
        const trackerDisposable = vscode.debug.registerDebugAdapterTrackerFactory('ardb', {
            createDebugAdapterTracker: (_session: vscode.DebugSession) => {
                return {
                    onDidSendMessage: (message: any) => {
                        if (message.type === 'event' && message.event === 'stopped') {
                            this._debugSession = _session;
                            this.onDebugStopped();
                        }
                    }
                };
            }
        });
        this._disposables.push(trackerDisposable);
    }

    public static createOrShow(extensionUri: vscode.Uri, debugAdapterFactory: ARDDebugAdapterFactory): AsyncInspectorPanel {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        // If we already have a panel, show it
        if (AsyncInspectorPanel.currentPanel) {
            AsyncInspectorPanel.currentPanel._panel.reveal(column);
            return AsyncInspectorPanel.currentPanel;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            'asyncInspector',
            'Async Inspector',
            column || vscode.ViewColumn.Two,
            {
                enableScripts: true,
                localResourceRoots: [extensionUri],
                retainContextWhenHidden: true
            }
        );

        AsyncInspectorPanel.currentPanel = new AsyncInspectorPanel(panel, extensionUri, debugAdapterFactory);
        return AsyncInspectorPanel.currentPanel;
    }

    public reveal(): void {
        this._panel.reveal();
    }

    /**
     * Called when the debug adapter sends a "stopped" event.
     * Triggers snapshot + call stack refresh automatically.
     */
    private async onDebugStopped(): Promise<void> {
        await Promise.all([
            this.handleSnapshot(),
            this.handleCallStack(),
        ]);
    }

    private async handleReset(): Promise<void> {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (session) {
            await session.reset();
            this._treeRoots.clear();
            this._update();
            vscode.window.showInformationMessage('ARD reset completed');
        }
    }

    private async handleGenWhitelist(): Promise<void> {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (session) {
            await session.genWhitelist();
            // Refresh candidates after generating
            await this.handleRefreshCandidates();
        }
    }

    private async handleTrace(symbol: string): Promise<void> {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (session) {
            await session.traceFunction(symbol);
            vscode.window.showInformationMessage(`Tracing: ${symbol}`);
        }
    }

    private async handleSnapshot(): Promise<void> {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (!session) return;

        const snapshot = await session.getSnapshot();
        if (snapshot) {
            this._lastSnapshot = snapshot;
            this.updateTreeFromSnapshot(snapshot);

            this._panel.webview.postMessage({
                command: 'updateTree',
                treeData: Array.from(this._treeRoots.values()),
            });
        }
    }

    private async handleSelectNode(cid: number | null): Promise<void> {
        if (cid === null || !this._debugSession) {
            return;
        }

        const snapshot = this._lastSnapshot;
        if (!snapshot) {
            return;
        }

        // Find the frame index for this CID in the snapshot path.
        // The snapshot path is ordered root → leaf (async chain).
        // We map this to the physical GDB stack frame index.
        let targetFrameIndex = -1;
        for (let i = 0; i < snapshot.path.length; i++) {
            const node = snapshot.path[i];
            if (node.type === 'async' && node.cid === cid) {
                targetFrameIndex = snapshot.path.length - 1 - i;
                break;
            }
        }

        if (targetFrameIndex >= 0) {
            try {
                // Get real frame IDs from the stack trace
                const stackTrace = await this._debugSession.customRequest('stackTrace', {
                    threadId: snapshot.thread_id,
                    startFrame: 0,
                    levels: 200,
                });

                const frames = stackTrace?.stackFrames || [];
                if (frames.length > targetFrameIndex) {
                    const frame = frames[targetFrameIndex];

                    // Use evaluate to switch GDB to this frame, which updates
                    // the variables view via the debug session
                    await this._debugSession.customRequest('evaluate', {
                        expression: `frame ${targetFrameIndex}`,
                        context: 'repl',
                    });

                    // Also open the source file at the frame location
                    if (frame.source?.path) {
                        await this.handleSelectFrame(frame.source.path, frame.line || 0);
                    }
                }
            } catch (error) {
                console.error('Failed to switch frame:', error);
            }
        }

        // Get log entries for this CID
        const session = this._debugAdapterFactory?.getActiveSession();
        if (session) {
            const logEntries = await session.getLogEntriesForCID(cid);
            this._panel.webview.postMessage({
                command: 'updateLogs',
                cid,
                logs: logEntries,
            });
        }
    }

    private async handleLocate(symbol: string): Promise<void> {
        // Use VS Code's symbol search to locate the function
        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider',
            symbol
        );
        if (symbols && symbols.length > 0) {
            const symbolInfo = symbols[0];
            const doc = await vscode.workspace.openTextDocument(symbolInfo.location.uri);
            await vscode.window.showTextDocument(doc, {
                selection: symbolInfo.location.range
            });
        } else {
            vscode.window.showWarningMessage(`Symbol not found: ${symbol}`);
        }
    }

    private async handleRefreshCandidates(): Promise<void> {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (session) {
            const candidates = await session.getWhitelistCandidates();
            this._panel.webview.postMessage({
                command: 'updateCandidates',
                candidates: candidates
            });
        }
    }

    /**
     * Fetch thread list and call stack from GDB via the debug session,
     * then send the data to the webview for rendering.
     */
    private async handleCallStack(): Promise<void> {
        if (!this._debugSession) {
            return;
        }

        try {
            // 1. Get threads
            const threadsResponse = await this._debugSession.customRequest('threads');
            const threads: Array<{ id: number; name: string }> = threadsResponse?.threads || [];

            // 2. For each thread, get stack trace
            const threadStacks: Array<{
                threadId: number;
                threadName: string;
                frames: Array<{
                    id: number;
                    name: string;
                    file: string;
                    path: string;
                    line: number;
                    addr: string;
                }>;
            }> = [];

            for (const thread of threads) {
                try {
                    const stackResponse = await this._debugSession.customRequest('stackTrace', {
                        threadId: thread.id,
                        startFrame: 0,
                        levels: 100,
                    });

                    const frames = (stackResponse?.stackFrames || []).map((f: any) => ({
                        id: f.id,
                        name: f.name || '<unknown>',
                        file: f.source?.name || '',
                        path: f.source?.path || '',
                        line: f.line || 0,
                        addr: f.instructionPointerReference || '',
                    }));

                    threadStacks.push({
                        threadId: thread.id,
                        threadName: thread.name,
                        frames,
                    });
                } catch (e) {
                    // Thread might have exited between listing and stack query
                    console.warn(`Failed to get stack for thread ${thread.id}:`, e);
                }
            }

            this._panel.webview.postMessage({
                command: 'updateCallStack',
                threadStacks,
            });
        } catch (error) {
            console.error('Failed to fetch call stack:', error);
        }
    }

    /**
     * Handle frame selection from the webview.
     * Opens the source file at the given line in VS Code editor.
     */
    private async handleSelectFrame(file: string, line: number): Promise<void> {
        if (!file) {
            return;
        }

        try {
            const uri = vscode.Uri.file(file);
            const doc = await vscode.workspace.openTextDocument(uri);
            const targetLine = Math.max(0, line - 1); // VS Code lines are 0-based
            await vscode.window.showTextDocument(doc, {
                selection: new vscode.Range(targetLine, 0, targetLine, 0),
                preserveFocus: false,
                viewColumn: vscode.ViewColumn.One,
            });
        } catch (error) {
            console.error('Failed to open source file:', error);
            vscode.window.showWarningMessage(`Cannot open file: ${file}`);
        }
    }

    private updateTreeFromSnapshot(snapshot: SnapshotData): void {
        if (snapshot.path.length === 0) {
            return;
        }

        // Find the root async node (first async node in path)
        let rootIndex = -1;
        for (let i = 0; i < snapshot.path.length; i++) {
            if (snapshot.path[i].type === 'async') {
                rootIndex = i;
                break;
            }
        }

        if (rootIndex < 0) {
            return; // No async nodes
        }

        const rootNode = snapshot.path[rootIndex];
        if (rootNode.cid === null) {
            return;
        }

        // Get or create root tree node
        let root = this._treeRoots.get(rootNode.cid);
        if (!root) {
            root = {
                type: 'async',
                cid: rootNode.cid,
                func: rootNode.func,
                addr: rootNode.addr,
                poll: rootNode.poll,
                state: rootNode.state,
                children: []
            };
            this._treeRoots.set(rootNode.cid, root);
        } else {
            root.poll = rootNode.poll;
            root.state = rootNode.state;
        }

        // Build the child chain from the snapshot path
        this.mergePathIntoTree(root, snapshot.path, rootIndex + 1);
    }

    /**
     * Merge the snapshot path (from startIndex onward) into the tree under `parent`.
     * - Async nodes are matched by CID and updated or created.
     * - Sync nodes are deduplicated by func+addr to avoid duplicates on re-snapshot.
     * - The path represents a single chain (not a fan-out), so each level
     *   has at most one "current" child being walked.
     */
    private mergePathIntoTree(
        parent: TreeNode,
        path: Array<SnapshotData['path'][0]>,
        startIndex: number,
    ): void {
        let current = parent;

        for (let i = startIndex; i < path.length; i++) {
            const node = path[i];

            if (node.type === 'async' && node.cid !== null) {
                // Find existing async child by CID
                let child = current.children.find(c => c.type === 'async' && c.cid === node.cid);
                if (!child) {
                    child = {
                        type: 'async',
                        cid: node.cid,
                        func: node.func,
                        addr: node.addr,
                        poll: node.poll,
                        state: node.state,
                        children: [],
                    };
                    current.children.push(child);
                } else {
                    // Update mutable fields
                    child.poll = node.poll;
                    child.state = node.state;
                }
                // Continue deeper into this child
                current = child;
            } else if (node.type === 'sync') {
                // Dedup sync nodes by func + addr
                const existing = current.children.find(
                    c => c.type === 'sync' && c.func === node.func && c.addr === node.addr
                );
                if (!existing) {
                    const syncChild: TreeNode = {
                        type: 'sync',
                        cid: null,
                        func: node.func,
                        addr: node.addr,
                        poll: 0,
                        state: 'NON-ASYNC',
                        children: [],
                    };
                    current.children.push(syncChild);
                    // Sync nodes are leaf-like, don't descend into them
                }
            }
        }
    }

    private _update(): void {
        const webview = this._panel.webview;
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        // Get paths to webview resources
        const scriptPath = vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'asyncInspector.js');
        const stylePath = vscode.Uri.joinPath(this._extensionUri, 'src', 'webview', 'asyncInspector.css');

        const scriptUri = webview.asWebviewUri(scriptPath);
        const styleUri = webview.asWebviewUri(stylePath);

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleUri}" rel="stylesheet">
                <title>Async Inspector</title>
            </head>
            <body>
                <div class="container">
                    <div class="toolbar">
                        <button id="resetBtn" class="btn">Reset</button>
                        <button id="genWhitelistBtn" class="btn">Gen Whitelist</button>
                        <button id="snapshotBtn" class="btn">Snapshot</button>
                    </div>
                    <div class="main-content">
                        <div class="tree-panel">
                            <h3>Async Execution Tree</h3>
                            <div id="treeContainer"></div>
                            <div class="callstack-section">
                                <h3>Call Stack</h3>
                                <div id="callStackContainer"></div>
                            </div>
                        </div>
                        <div class="side-panel">
                            <div class="candidates-section">
                                <h3>Candidates</h3>
                                <div id="candidatesList"></div>
                            </div>
                            <div class="log-section">
                                <h3>Log Preview</h3>
                                <div id="logContainer"></div>
                            </div>
                        </div>
                    </div>
                </div>
                <script>
                    window.treeData = ${JSON.stringify(Array.from(this._treeRoots.values()))};
                </script>
                <script src="${scriptUri}"></script>
            </body>
            </html>`;
    }

    public dispose(): void {
        AsyncInspectorPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}

interface TreeNode {
    type: 'async' | 'sync';
    cid: number | null;
    func: string;
    addr: string;
    poll: number;
    state: number | string;
    children: TreeNode[];
}
