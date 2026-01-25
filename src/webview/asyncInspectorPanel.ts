import * as vscode from 'vscode';
import * as path from 'path';
import { ARDDebugAdapterFactory } from '../debugAdapter';
import { GDBDebugSession, SnapshotData } from '../gdbDebugSession';

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
    private _refreshInterval: NodeJS.Timeout | undefined;
    private _treeRoots: Map<number, TreeNode> = new Map(); // root CID -> tree node

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
                vscode.window.showInformationMessage(`Webview 呼叫插件: ${message.command}`);
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
                }
            },
            null,
            this._disposables
        );

        // Listen for debug session events
        vscode.debug.onDidChangeActiveDebugSession((session) => {
            this._debugSession = session?.type === 'ardb' ? session : undefined;
            if (this._debugSession) {
                this.startAutoRefresh();
            } else {
                this.stopAutoRefresh();
            }
        }, null, this._disposables);

        vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
            if (event.session.type === 'ardb' && event.event === 'stopped') {
                this.handleSnapshot();
            }
        }, null, this._disposables);
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

    private startAutoRefresh(): void {
        this.stopAutoRefresh();
        // Refresh every 500ms when debug session is active
        this._refreshInterval = setInterval(() => {
            this.handleSnapshot();
        }, 500);
    }

    private stopAutoRefresh(): void {
        if (this._refreshInterval) {
            clearInterval(this._refreshInterval);
            this._refreshInterval = undefined;
        }
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
            this.updateTreeFromSnapshot(snapshot);

            const treeData = Array.from(this._treeRoots.values());
            this._panel.webview.postMessage({
                command: 'updateTree',
                treeData: treeData
            });
        }
    }

    private async handleSelectNode(cid: number | null): Promise<void> {
        if (cid === null || !this._debugSession) {
            return;
        }

        // Find the frame corresponding to this CID
        const snapshot = await this._debugAdapterFactory?.getActiveSession()?.getSnapshot();
        if (!snapshot) {
            return;
        }

        // Find the frame index for this CID in the snapshot path
        // Note: The snapshot path is ordered from root to leaf
        // We need to find the physical frame that corresponds to this async frame
        let targetFrameIndex = -1;
        for (let i = 0; i < snapshot.path.length; i++) {
            const node = snapshot.path[i];
            if (node.type === 'async' && node.cid === cid) {
                // For async nodes, we need to find the corresponding physical frame
                // The sync tail after this async node represents the physical frames
                // Count backwards from the end to find the right frame
                targetFrameIndex = snapshot.path.length - 1 - i;
                break;
            }
        }

        if (targetFrameIndex >= 0 && this._debugSession) {
            // Request stack trace to get frame IDs
            try {
                const stackTrace = await this._debugSession.customRequest('stackTrace', {
                    threadId: snapshot.thread_id
                }) as any;

                if (stackTrace && stackTrace.stackFrames && stackTrace.stackFrames.length > targetFrameIndex) {
                    const frameId = stackTrace.stackFrames[targetFrameIndex].id;
                    // Select the frame
                    await this._debugSession.customRequest('scopes', {
                        frameId: frameId
                    });
                    // VS Code will automatically update the variables view
                }
            } catch (error) {
                console.error('Failed to switch frame:', error);
                // Fallback: try to use evaluate to change frame
                try {
                    await this._debugSession.customRequest('evaluate', {
                        expression: `frame ${targetFrameIndex}`,
                        context: 'repl'
                    });
                } catch (e) {
                    console.error('Fallback frame switch also failed:', e);
                }
            }
        }

        // Get log entries for this CID
        const session = this._debugAdapterFactory?.getActiveSession();
        if (session && cid !== null) {
            const logEntries = await session.getLogEntriesForCID(cid);
            this._panel.webview.postMessage({
                command: 'updateLogs',
                cid: cid,
                logs: logEntries
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

        // Check if we already have this root
        if (!this._treeRoots.has(rootNode.cid)) {
            // Create new root
            const treeNode: TreeNode = {
                type: 'async',
                cid: rootNode.cid,
                func: rootNode.func,
                addr: rootNode.addr,
                poll: rootNode.poll,
                state: rootNode.state,
                children: []
            };
            this._treeRoots.set(rootNode.cid, treeNode);
        }

        // Build tree from snapshot path
        // This is a simplified version - in reality, we'd need to track
        // the tree structure more carefully based on the execution history
        const root = this._treeRoots.get(rootNode.cid)!;
        this.buildTreeFromPath(root, snapshot.path, rootIndex);
    }

    private buildTreeFromPath(parent: TreeNode, path: Array<SnapshotData['path'][0]>, startIndex: number): void {
        // Simplified tree building - in practice, this would need to track
        // the actual call hierarchy from the log
        for (let i = startIndex + 1; i < path.length; i++) {
            const node = path[i];
            if (node.type === 'async' && node.cid !== null) {
                // Check if child already exists
                let child = parent.children.find(c => c.cid === node.cid);
                if (!child) {
                    child = {
                        type: 'async',
                        cid: node.cid,
                        func: node.func,
                        addr: node.addr,
                        poll: node.poll,
                        state: node.state,
                        children: []
                    };
                    parent.children.push(child);
                } else {
                    // Update existing child
                    child.poll = node.poll;
                    child.state = node.state;
                }
                // Recursively build children
                this.buildTreeFromPath(child, path, i);
            } else if (node.type === 'sync') {
                // Add sync node as child
                const syncChild: TreeNode = {
                    type: 'sync',
                    cid: null,
                    func: node.func,
                    addr: node.addr,
                    poll: 0,
                    state: 'NON-ASYNC',
                    children: []
                };
                parent.children.push(syncChild);
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

        const treeData = Array.from(this._treeRoots.values());

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
        this.stopAutoRefresh();
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
