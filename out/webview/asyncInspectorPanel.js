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
exports.AsyncInspectorPanel = void 0;
const vscode = __importStar(require("vscode"));
/**
 * Async Inspector Panel - Webview for displaying async execution trees
 */
class AsyncInspectorPanel {
    constructor(panel, extensionUri, debugAdapterFactory) {
        this._disposables = [];
        this._treeRoots = new Map(); // root CID -> tree node
        this._panel = panel;
        this._extensionUri = extensionUri;
        this._debugAdapterFactory = debugAdapterFactory;
        // Set the webview's initial html content
        this._update();
        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(async (message) => {
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
        }, null, this._disposables);
        // Listen for debug session events
        vscode.debug.onDidChangeActiveDebugSession((session) => {
            this._debugSession = session?.type === 'ardb' ? session : undefined;
            if (this._debugSession) {
                this.startAutoRefresh();
            }
            else {
                this.stopAutoRefresh();
            }
        }, null, this._disposables);
        vscode.debug.onDidReceiveDebugSessionCustomEvent((event) => {
            if (event.session.type === 'ardb' && event.event === 'stopped') {
                this.handleSnapshot();
            }
        }, null, this._disposables);
    }
    static createOrShow(extensionUri, debugAdapterFactory) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;
        // If we already have a panel, show it
        if (AsyncInspectorPanel.currentPanel) {
            AsyncInspectorPanel.currentPanel._panel.reveal(column);
            return AsyncInspectorPanel.currentPanel;
        }
        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel('asyncInspector', 'Async Inspector', column || vscode.ViewColumn.Two, {
            enableScripts: true,
            localResourceRoots: [extensionUri],
            retainContextWhenHidden: true
        });
        AsyncInspectorPanel.currentPanel = new AsyncInspectorPanel(panel, extensionUri, debugAdapterFactory);
        return AsyncInspectorPanel.currentPanel;
    }
    reveal() {
        this._panel.reveal();
    }
    startAutoRefresh() {
        this.stopAutoRefresh();
        // Refresh every 500ms when debug session is active
        this._refreshInterval = setInterval(() => {
            this.handleSnapshot();
        }, 500);
    }
    stopAutoRefresh() {
        if (this._refreshInterval) {
            clearInterval(this._refreshInterval);
            this._refreshInterval = undefined;
        }
    }
    async handleReset() {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (session) {
            await session.reset();
            this._treeRoots.clear();
            this._update();
            vscode.window.showInformationMessage('ARD reset completed');
        }
    }
    async handleGenWhitelist() {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (session) {
            await session.genWhitelist();
            // Refresh candidates after generating
            await this.handleRefreshCandidates();
        }
    }
    async handleTrace(symbol) {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (session) {
            await session.traceFunction(symbol);
            vscode.window.showInformationMessage(`Tracing: ${symbol}`);
        }
    }
    async handleSnapshot() {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (!session) {
            return;
        }
        const snapshot = await session.getSnapshot();
        if (snapshot) {
            this.updateTreeFromSnapshot(snapshot);
            this._update();
        }
    }
    async handleSelectNode(cid) {
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
                });
                if (stackTrace && stackTrace.stackFrames && stackTrace.stackFrames.length > targetFrameIndex) {
                    const frameId = stackTrace.stackFrames[targetFrameIndex].id;
                    // Select the frame
                    await this._debugSession.customRequest('scopes', {
                        frameId: frameId
                    });
                    // VS Code will automatically update the variables view
                }
            }
            catch (error) {
                console.error('Failed to switch frame:', error);
                // Fallback: try to use evaluate to change frame
                try {
                    await this._debugSession.customRequest('evaluate', {
                        expression: `frame ${targetFrameIndex}`,
                        context: 'repl'
                    });
                }
                catch (e) {
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
    async handleLocate(symbol) {
        // Use VS Code's symbol search to locate the function
        const symbols = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', symbol);
        if (symbols && symbols.length > 0) {
            const symbolInfo = symbols[0];
            const doc = await vscode.workspace.openTextDocument(symbolInfo.location.uri);
            await vscode.window.showTextDocument(doc, {
                selection: symbolInfo.location.range
            });
        }
        else {
            vscode.window.showWarningMessage(`Symbol not found: ${symbol}`);
        }
    }
    async handleRefreshCandidates() {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (session) {
            const candidates = await session.getWhitelistCandidates();
            this._panel.webview.postMessage({
                command: 'updateCandidates',
                candidates: candidates
            });
        }
    }
    updateTreeFromSnapshot(snapshot) {
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
            const treeNode = {
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
        const root = this._treeRoots.get(rootNode.cid);
        this.buildTreeFromPath(root, snapshot.path, rootIndex);
    }
    buildTreeFromPath(parent, path, startIndex) {
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
                }
                else {
                    // Update existing child
                    child.poll = node.poll;
                    child.state = node.state;
                }
                // Recursively build children
                this.buildTreeFromPath(child, path, i);
            }
            else if (node.type === 'sync') {
                // Add sync node as child
                const syncChild = {
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
    _update() {
        const webview = this._panel.webview;
        this._panel.webview.html = this._getHtmlForWebview(webview);
    }
    _getHtmlForWebview(webview) {
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
                    const vscode = acquireVsCodeApi();
                    const treeData = ${JSON.stringify(treeData)};
                </script>
                <script src="${scriptUri}"></script>
            </body>
            </html>`;
    }
    dispose() {
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
exports.AsyncInspectorPanel = AsyncInspectorPanel;
//# sourceMappingURL=asyncInspectorPanel.js.map