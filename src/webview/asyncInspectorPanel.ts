import * as vscode from 'vscode';
import { ARDDebugAdapterFactory } from '../debugAdapter';
import {
    SnapshotData,
    SnapshotPathData,
    HistoryTreeData,
    HistoryTreeNode,
    TransitionChainData,
    TransitionPathNode,
} from '../gdbDebugSession';
import * as path from 'path';
import * as fs from 'fs';

type SnapshotNode = SnapshotPathData['path'][0];

interface NodeRef {
    cid: number | null;
    func?: string;
    addr?: string;
    file?: string;
    fullname?: string;
    line?: number;
}

interface SourceResolution {
    uri: vscode.Uri;
    line: number;
    reason: string;
    matches?: string[];
}

interface SourceMapConfig {
    sourceRoots?: unknown;
    sourceWorkspace?: unknown;
    rel4Kernel?: unknown;
    rootTaskDemo?: unknown;
    [key: string]: unknown;
}

interface HistorySnapshotRecord {
    id: number;
    timestamp: number;
    path: SnapshotNode[];
    raw: {
        thread_id: number;
        pathLength: number;
        privilege?: string;
        transition_event?: string;
    };
}

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
    private _currentSnapshotTreeRoots: Map<number, TreeNode> = new Map(); // root CID -> current snapshot tree node
    private _historyTreeRoots: TreeNode[] = [];
    private _historySnapshots: HistorySnapshotRecord[] = [];
    private _observedPathRoots: TreeNode[] = [];
    private _nextSnapshotId = 1;
    /** Cache of the last snapshot, used by selectNode to find frame indices. */
    private _lastSnapshot: SnapshotPathData | undefined;
    private _lastTransitionPath: TransitionPathNode[] = [];
    private readonly _outputChannel = vscode.window.createOutputChannel('ARD Inspector');

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
                    case 'refreshHistory':
                        await this.handleRefreshHistory();
                        break;
                    case 'clearHistory':
                        await this.handleClearHistory();
                        break;
                    case 'chain':
                        await this.handleChainSnapshot();
                        break;
                    case 'connectRemote':
                        await this.handleConnectRemote();
                        break;
                    case 'selectNode':
                        await this.handleSelectNode(message);
                        break;
                    case 'locate':
                        await this.handleLocate(message.symbol);
                        break;
                    case 'refreshCandidates':
                        await this.handleRefreshCandidates();
                        break;
                    case 'scanTransitionCandidates':
                        await this.handleScanTransitionCandidates();
                        break;
                    case 'generateTransitionProbeDraft':
                        await this.handleGenerateTransitionProbeDraft();
                        break;
                    case 'reloadTransitionCandidates':
                        await this.handleReloadTransitionCandidates();
                        break;
                    case 'reloadTransitionProbeDraft':
                        await this.handleReloadTransitionProbeDraft();
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
    }

    public static createOrShow(extensionUri: vscode.Uri, debugAdapterFactory: ARDDebugAdapterFactory): AsyncInspectorPanel {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn ?? vscode.ViewColumn.Active
            : vscode.ViewColumn.Active;

        // If we already have a panel, show it
        if (AsyncInspectorPanel.currentPanel) {
            AsyncInspectorPanel.currentPanel._panel.reveal(column);
            return AsyncInspectorPanel.currentPanel;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            'asyncInspector',
            'Async Inspector',
            column,
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

    /** Refresh the runtime call graph whenever GDB reports a real stop. */
    public onDebugStopped(session: vscode.DebugSession, stoppedBody: any): void {
        this._debugSession = session;
        const isEntry = stoppedBody?.reason === 'entry';
        console.log(`[AsyncInspector] onDebugStopped reason=${stoppedBody?.reason} isEntry=${isEntry} hasSession=${!!this._debugSession}`);

        if (!isEntry) {
            this.handleStoppedAutoRefresh().catch((e) => {
                console.error('[AsyncInspector] onDebugStopped handlers failed:', e);
            });
        }
    }

    private async handleReset(): Promise<void> {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (session) {
            await session.reset();
            this._currentSnapshotTreeRoots.clear();
            this.resetHistoryState();
            this._lastTransitionPath = [];
            this._update();
            vscode.window.showInformationMessage('ARD reset completed');
        }
    }

    private async handleConnectRemote(): Promise<void> {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (!session) {
            const message = '[ARD] failed to connect remote target :1234: no active debug session';
            this.inspectorLog('error', message);
            vscode.window.showErrorMessage(message);
            this._panel.webview.postMessage({
                command: 'connectRemoteResult',
                status: 'failed',
                message,
            });
            return;
        }

        const result = await session.connectRemote(':1234');
        const level = result.status === 'failed' ? 'error' : 'info';
        this.inspectorLog(level, result.message);
        if (result.status === 'failed') {
            vscode.window.showErrorMessage(result.message);
        } else {
            vscode.window.showInformationMessage(result.message);
        }
        this._panel.webview.postMessage({
            command: 'connectRemoteResult',
            status: result.status,
            message: result.message,
        });
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

    private async fetchSnapshot(suppressOutput: boolean = false): Promise<SnapshotData | undefined> {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (!session) {
            console.warn('[AsyncInspector] fetchSnapshot: no GDB session from factory');
            return undefined;
        }

        const snapshot = await session.getSnapshot(suppressOutput);
        if (!suppressOutput) {
            console.log(
                '[AsyncInspector] fetchSnapshot: result =',
                snapshot ? `thread_id=${snapshot.thread_id}, path.length=${snapshot.path.length}` : 'null'
            );
        }
        return snapshot;
    }

    private async fetchSnapshotPath(suppressOutput: boolean = false): Promise<SnapshotPathData | undefined> {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (!session) {
            console.warn('[AsyncInspector] fetchSnapshotPath: no GDB session from factory');
            return undefined;
        }
        return session.getSnapshotPath(suppressOutput);
    }

    private async fetchTransitionChain(suppressOutput: boolean = false): Promise<TransitionChainData | undefined> {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (!session) {
            console.warn('[AsyncInspector] fetchTransitionChain: no GDB session from factory');
            return undefined;
        }
        return session.getTransitionChain(suppressOutput);
    }

    private async fetchHistoryTree(suppressOutput: boolean = false): Promise<HistoryTreeData | undefined> {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (!session) {
            console.warn('[AsyncInspector] fetchHistoryTree: no GDB session from factory');
            return undefined;
        }
        return session.refreshHistoryTree(suppressOutput);
    }

    private async clearBackendHistoryTree(suppressOutput: boolean = false): Promise<void> {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (!session) {
            return;
        }
        await session.clearHistoryTree(suppressOutput);
    }

    private renderAsyncTreeFromSnapshot(snapshot: SnapshotPathData): void {
        this._lastSnapshot = snapshot;
        this.updateTreeFromSnapshot(snapshot);
        this.recordHistorySnapshot(snapshot);
        this._observedPathRoots = this.buildObservedPathsTree();
        this._historyTreeRoots = this.getHistoryTreeData();
        this._panel.webview.postMessage({
            command: 'updateTree',
            treeData: this._historyTreeRoots,
        });
    }

    private renderRuntimeHistoryTree(historyTree: HistoryTreeData): void {
        const runtimeRoots = this.normalizeRuntimeHistoryNodes(historyTree.roots || []);
        // The graph header is static webview UI. Render only the actual
        // runtime roots so the old virtual call-graph node does not
        // become a second title above the execution graph.
        this._historyTreeRoots = runtimeRoots;
        this._panel.webview.postMessage({
            command: 'updateTree',
            treeData: this._historyTreeRoots,
        });
    }

    private renderCrossPrivilegeChainFromSnapshot(snapshot: TransitionChainData): void {
        this._lastTransitionPath = Array.isArray(snapshot.transition_path)
            ? snapshot.transition_path
            : [];
        this._panel.webview.postMessage({
            command: 'updateTransitionPath',
            transitionPath: this._lastTransitionPath,
        });
    }

    private async handleClearHistory(): Promise<void> {
        await this.clearBackendHistoryTree(false);
        this.clearHistory();
    }

    private clearHistory(): void {
        this.resetHistoryState();
        this._panel.webview.postMessage({
            command: 'updateTree',
            treeData: this._historyTreeRoots,
        });
    }

    private resetHistoryState(): void {
        this._historySnapshots = [];
        this._observedPathRoots = [];
        this._nextSnapshotId = 1;
        this._historyTreeRoots = [];
    }

    private async handleSnapshot(): Promise<void> {
        await this.fetchSnapshot(false);
    }

    private async handleRefreshHistory(): Promise<void> {
        const historyTree = await this.fetchHistoryTree(false);
        if (historyTree) {
            this.renderRuntimeHistoryTree(historyTree);
            const currentSnapshot = await this.fetchSnapshotPath(true);
            if (currentSnapshot) {
                this._lastSnapshot = currentSnapshot;
                this.updateTreeFromSnapshot(currentSnapshot);
            }
        }
    }

    private async handleChainSnapshot(): Promise<void> {
        const snapshot = await this.fetchTransitionChain(false);
        if (snapshot) {
            this.renderCrossPrivilegeChainFromSnapshot(snapshot);
        }
    }

    private async handleStoppedAutoRefresh(): Promise<void> {
        const historyTree = await this.fetchHistoryTree(true);
        if (historyTree) {
            this.renderRuntimeHistoryTree(historyTree);
        }

        // Keep current snapshot data available for source/frame selection and
        // transition rendering without using it as a History Tree data source.
        const snapshot = await this.fetchSnapshot(true);
        if (snapshot) {
            this._lastSnapshot = snapshot;
            this.updateTreeFromSnapshot(snapshot);
            this.renderCrossPrivilegeChainFromSnapshot(snapshot);
        }
    }

    private async handleSelectNode(nodeRef: NodeRef): Promise<void> {
        console.log('[AsyncInspector] selectNode cid=', nodeRef.cid, 'typeof=', typeof nodeRef.cid);
        const snapshot = this._lastSnapshot;
        const target = snapshot ? this.findSnapshotNode(snapshot, nodeRef) : undefined;
        const symbol = target?.func || nodeRef.func || '<unknown>';

        const resolution = await this.resolveNodeSourceLocation(target, nodeRef);
        if (resolution) {
            this.inspectorLog(
                'info',
                `[Inspector] Node click: ${symbol} -> ${resolution.uri.fsPath}:${resolution.line}`
            );
            if (resolution.matches && resolution.matches.length > 1) {
                this.inspectorLog(
                    'warn',
                    `[Inspector] Warning: multiple matches for ${symbol}, selected ${resolution.uri.fsPath}:${resolution.line}`
                );
            }
            await this.openSourceAt(resolution.uri, resolution.line);
        } else {
            this.inspectorLog('error', `[Inspector] Error: ${symbol} file not found`);
            vscode.window.showWarningMessage(`Cannot locate source for: ${symbol}`);
        }

        if (snapshot && nodeRef.cid !== null) {
            await this.trySelectDebugFrame(snapshot, Number(nodeRef.cid));
        }
    }

    private async handleLocate(symbol: string): Promise<void> {
        // Use GDB's "info line" command to find the source location of the symbol.
        // The candidate symbols are fully-qualified GDB names (e.g.
        // "my_crate::my_module::my_async_fn") that workspace symbol providers
        // cannot resolve, but GDB can map them to source files directly.
        const session = this._debugAdapterFactory?.getActiveSession();
        if (!session) {
            vscode.window.showWarningMessage('No active debug session');
            return;
        }

        try {
            const output = await session.executeGDBCommand(`info line '${symbol}'`);
            // GDB output format: "Line 42 of \"src/main.rs\" starts at address ..."
            const match = output.match(/Line\s+(\d+)\s+of\s+"([^"]+)"/);
            if (match) {
                const line = parseInt(match[1], 10);
                const filePath = match[2];
                await this.handleSelectFrame(filePath, line);
            } else {
                vscode.window.showWarningMessage(`Cannot locate source for: ${symbol}`);
            }
        } catch (error) {
            console.error('Failed to locate symbol:', error);
            vscode.window.showWarningMessage(`Failed to locate: ${symbol}`);
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

    private async handleScanTransitionCandidates(): Promise<void> {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (!session) {
            this.postTransitionCandidates({
                path: '',
                candidates: [],
                error: 'No active debug session. Start debugging before scanning.',
            });
            return;
        }
        this.postTransitionCandidates(await session.scanTransitionCandidates());
    }

    private async handleGenerateTransitionProbeDraft(): Promise<void> {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (!session) {
            this.postTransitionProbeDraft({
                path: '',
                probes: [],
                error: 'No active debug session. Start debugging before generating a draft.',
            });
            return;
        }
        this.postTransitionProbeDraft(await session.generateTransitionProbeDraft());
    }

    private async handleReloadTransitionCandidates(): Promise<void> {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (!session) {
            this.postTransitionCandidates({
                path: '',
                candidates: [],
                error: 'Transition candidates are unavailable.',
            });
            return;
        }
        this.postTransitionCandidates(await session.loadTransitionCandidates());
    }

    private async handleReloadTransitionProbeDraft(): Promise<void> {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (!session) {
            this.postTransitionProbeDraft({
                path: '',
                probes: [],
                error: 'Probe draft is unavailable.',
            });
            return;
        }
        this.postTransitionProbeDraft(await session.loadTransitionProbeDraft());
    }

    private postTransitionCandidates(result: {
        path: string;
        candidates: unknown[];
        candidateCount?: number;
        generatedAt?: string;
        error?: string;
    }): void {
        this._panel.webview.postMessage({
            command: 'updateTransitionCandidates',
            ...result,
        });
    }

    private postTransitionProbeDraft(result: {
        path: string;
        probes: unknown[];
        candidateCount?: number;
        selectedCount?: number;
        generatedAt?: string;
        error?: string;
    }): void {
        this._panel.webview.postMessage({
            command: 'updateTransitionProbeDraft',
            ...result,
        });
    }

    private inspectorLog(level: 'info' | 'warn' | 'error', message: string): void {
        this._outputChannel.appendLine(message);
        if (level === 'warn') {
            console.warn(message);
        } else if (level === 'error') {
            console.error(message);
        } else {
            console.log(message);
        }
    }

    private findSnapshotNode(snapshot: SnapshotPathData, nodeRef: NodeRef): SnapshotNode | undefined {
        if (nodeRef.cid !== null && nodeRef.cid !== undefined) {
            const targetCid = Number(nodeRef.cid);
            const cidMatches = snapshot.path.filter(
                n => n.type === 'async' && Number(n.cid) === targetCid
            );
            if (cidMatches.length > 0) {
                return cidMatches[cidMatches.length - 1];
            }
        }

        const exactMatches = snapshot.path.filter(
            n =>
                n.func === nodeRef.func &&
                (!nodeRef.addr || n.addr === nodeRef.addr)
        );
        if (exactMatches.length > 0) {
            return exactMatches[exactMatches.length - 1];
        }

        return undefined;
    }

    private async trySelectDebugFrame(snapshot: SnapshotPathData, targetCid: number): Promise<void> {
        if (!this._debugSession) {
            return;
        }

        let targetFrameIndex = -1;
        for (let i = 0; i < snapshot.path.length; i++) {
            const node = snapshot.path[i];
            if (node.type === 'async' && Number(node.cid) === targetCid) {
                targetFrameIndex = snapshot.path.length - 1 - i;
                break;
            }
        }

        if (targetFrameIndex < 0) {
            return;
        }

        try {
            await this._debugSession.customRequest('stackTrace', {
                threadId: snapshot.thread_id,
                startFrame: 0,
                levels: 200,
            });

            await this._debugSession.customRequest('evaluate', {
                expression: `frame ${targetFrameIndex}`,
                context: 'repl',
            });
        } catch (error) {
            console.error('Failed to switch frame:', error);
        }
    }

    private buildSearchRoots(initialRoots: string[]): string[] {
        const roots: string[] = [];
        const seen = new Set<string>();

        for (const start of initialRoots) {
            let current = path.resolve(start);

            // 向上爬几层，避免 workspace 开在过深子目录时找不到真正源码根
            for (let i = 0; i < 8; i++) {
                if (!seen.has(current)) {
                    seen.add(current);
                    roots.push(current);
                }

                const parent = path.dirname(current);
                if (parent === current) {
                    break;
                }
                current = parent;
            }
        }

        return roots;
    }

    private addPathRoot(roots: string[], seen: Set<string>, candidate: unknown): void {
        if (typeof candidate !== 'string' || !candidate.trim()) {
            return;
        }

        const expanded = this.expandPathVariables(candidate.trim());
        const resolved = path.isAbsolute(expanded)
            ? path.resolve(expanded)
            : path.resolve(this.getPrimaryWorkspaceRoot() || process.cwd(), expanded);

        if (!seen.has(resolved) && fs.existsSync(resolved)) {
            seen.add(resolved);
            roots.push(resolved);
        }
    }

    private expandPathVariables(value: string): string {
        const workspaceRoot = this.getPrimaryWorkspaceRoot() || '';
        const sessionCwd = this.getSessionCwd() || workspaceRoot;
        return value
            .replace(/\$\{workspaceFolder\}/g, workspaceRoot)
            .replace(/\$\{cwd\}/g, sessionCwd);
    }

    private getPrimaryWorkspaceRoot(): string | undefined {
        return (
            this._debugSession?.workspaceFolder?.uri.fsPath ||
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
        );
    }

    private getSessionCwd(): string | undefined {
        const config = this._debugSession?.configuration;
        const workspaceRoot = this.getPrimaryWorkspaceRoot();
        if (typeof config?.cwd === 'string' && config.cwd.trim()) {
            const expanded = this.expandPathVariablesWithoutCwd(config.cwd, workspaceRoot);
            return path.isAbsolute(expanded)
                ? path.resolve(expanded)
                : path.resolve(workspaceRoot || process.cwd(), expanded);
        }
        return workspaceRoot;
    }

    private expandPathVariablesWithoutCwd(value: string, workspaceRoot?: string): string {
        return workspaceRoot
            ? value.replace(/\$\{workspaceFolder\}/g, workspaceRoot)
            : value;
    }

    private sourceMapCandidates(): string[] {
        const candidates: string[] = [];
        const seen = new Set<string>();

        const add = (candidate: string | undefined) => {
            if (!candidate) {
                return;
            }
            const resolved = path.resolve(candidate);
            if (!seen.has(resolved) && fs.existsSync(resolved)) {
                seen.add(resolved);
                candidates.push(resolved);
            }
        };

        const workspaceRoots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [];
        for (const root of workspaceRoots) {
            add(path.join(root, 'source-map.json'));
            const testcaseRoot = path.join(root, 'testcases');
            try {
                const entries = fs.readdirSync(testcaseRoot, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        add(path.join(testcaseRoot, entry.name, 'source-map.json'));
                    }
                }
            } catch {
                // No testcase source maps in this workspace.
            }
        }

        const config = this._debugSession?.configuration;
        if (typeof config?.sourceMap === 'string') {
            add(this.expandPathVariables(config.sourceMap));
        }

        return candidates;
    }

    private sourceRootsFromSourceMaps(): string[] {
        const roots: string[] = [];
        const seen = new Set<string>();

        for (const mapPath of this.sourceMapCandidates()) {
            try {
                const parsed = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as SourceMapConfig;
                this.addSourceMapRootFields(roots, seen, parsed);
            } catch (error) {
                this.inspectorLog('warn', `[Inspector] Warning: cannot read source map ${mapPath}: ${error}`);
            }
        }

        return roots;
    }

    private addSourceMapRootFields(roots: string[], seen: Set<string>, parsed: SourceMapConfig): void {
        if (Array.isArray(parsed.sourceRoots)) {
            for (const root of parsed.sourceRoots) {
                this.addPathRoot(roots, seen, root);
            }
        }

        // Prefer concrete source subtrees before broad workspaces.
        this.addPathRoot(roots, seen, parsed.rel4Kernel);
        this.addPathRoot(roots, seen, parsed.rootTaskDemo);

        for (const [key, value] of Object.entries(parsed)) {
            if (
                key === 'sourceRoots' ||
                key === 'sourceWorkspace' ||
                key === 'rel4Kernel' ||
                key === 'rootTaskDemo'
            ) {
                continue;
            }
            if (/(source|root|project|kernel|demo)/i.test(key)) {
                this.addPathRoot(roots, seen, value);
            }
        }

        this.addPathRoot(roots, seen, parsed.sourceWorkspace);
    }

    private configuredSourceRoots(): string[] {
        const roots: string[] = [];
        const seen = new Set<string>();
        const config = this._debugSession?.configuration;

        if (Array.isArray(config?.sourceRoots)) {
            for (const root of config.sourceRoots) {
                this.addPathRoot(roots, seen, root);
            }
        }

        if (typeof config?.cwd === 'string') {
            this.addPathRoot(roots, seen, config.cwd);
        }

        if (typeof config?.program === 'string') {
            const expanded = this.expandPathVariables(config.program);
            this.addPathRoot(roots, seen, path.dirname(expanded));
        }

        return roots;
    }

    private sourceSearchRoots(): string[] {
        const roots: string[] = [];
        const seen = new Set<string>();

        const addExisting = (candidate: string) => this.addPathRoot(roots, seen, candidate);

        for (const root of this.configuredSourceRoots()) {
            addExisting(root);
        }

        for (const root of this.sourceRootsFromSourceMaps()) {
            addExisting(root);
        }

        const workspaceRoots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [];
        for (const root of this.buildSearchRoots(workspaceRoots)) {
            addExisting(root);
        }

        return roots;
    }

    private async findFilesBySuffix(
        roots: string[],
        suffix: string,
        limit = 8,
    ): Promise<string[]> {
        const normalizedSuffix = suffix.replace(/\\/g, '/').toLowerCase();
        const matches: string[] = [];
        const seen = new Set<string>();

        const walk = async (dir: string): Promise<void> => {
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(dir, { withFileTypes: true });
            } catch {
                return;
            }

            for (const entry of entries) {
                if (matches.length >= limit) {
                    return;
                }

                // 跳过常见无关目录，避免搜索太慢
                if (entry.isDirectory()) {
                    if (
                        entry.name === '.git' ||
                        entry.name === 'node_modules' ||
                        entry.name === 'target' ||
                        entry.name === 'out' ||
                        entry.name === 'build' ||
                        entry.name.startsWith('build-') ||
                        entry.name === '.vscode'
                    ) {
                        continue;
                    }
                }

                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    await walk(fullPath);
                } else if (entry.isFile()) {
                    const normalizedFull = fullPath.replace(/\\/g, '/').toLowerCase();
                    if (normalizedFull.endsWith(normalizedSuffix)) {
                        console.log('[AsyncInspector] findFileBySuffix hit=' + fullPath);
                        const resolved = path.resolve(fullPath);
                        if (!seen.has(resolved)) {
                            seen.add(resolved);
                            matches.push(resolved);
                        }
                    }
                }
            }
        };

        for (const root of roots) {
            if (matches.length >= limit) {
                break;
            }
            if (this.isBroadRecursiveSearchRoot(root)) {
                continue;
            }
            await walk(root);
        }

        return matches;
    }

    private isBroadRecursiveSearchRoot(root: string): boolean {
        const resolved = path.resolve(root);
        const parsed = path.parse(resolved);
        const home = process.env.HOME ? path.resolve(process.env.HOME) : '';
        return resolved === parsed.root || resolved === home || resolved === path.dirname(home);
    }

    private sourceTailsFromFile(file: string): string[] {
        const normalizedInput = file.replace(/\\/g, '/');
        const tails: string[] = [];
        const seen = new Set<string>();
        const add = (tail: string) => {
            const normalized = tail.replace(/\\/g, '/').replace(/^\/+/, '');
            if (normalized && !seen.has(normalized)) {
                seen.add(normalized);
                tails.push(normalized);
            }
        };

        if (!path.isAbsolute(file)) {
            add(normalizedInput);
        }

        const parts = normalizedInput.split('/').filter(Boolean);
        const markers = ['projects', 'rel4_kernel', 'kernel', 'crates', 'src', 'testsuite', 'tests', 'test', 'examples', 'os'];
        for (let i = 0; i < parts.length; i++) {
            if (markers.includes(parts[i])) {
                add(parts.slice(i).join('/'));
            }
        }

        add(parts.slice(-4).join('/'));
        add(parts.slice(-3).join('/'));
        add(parts.slice(-2).join('/'));
        add(parts.slice(-1).join('/'));

        return tails;
    }

    private sourceTailsFromSymbol(symbol: string): string[] {
        const stripped = symbol
            .replace(/\{async_fn#[^}]+}/g, '')
            .replace(/<[^>]*>/g, '')
            .replace(/::h[0-9a-fA-F]+$/g, '');
        const parts = stripped
            .split('::')
            .map(p => p.trim())
            .filter(p => p && !p.startsWith('{') && !p.includes('$'));

        const tails: string[] = [];
        const seen = new Set<string>();
        const add = (tail: string) => {
            const normalized = tail.replace(/\\/g, '/').replace(/^\/+/, '');
            if (normalized && !seen.has(normalized)) {
                seen.add(normalized);
                tails.push(normalized);
            }
        };

        for (let i = parts.length - 1; i >= 0; i--) {
            const part = parts[i];
            if (/^[A-Z]/.test(part) || part === 'execute' || part === 'poll') {
                continue;
            }

            add(`${part}.rs`);
            if (i > 0) {
                add(`${parts[i - 1]}/${part}.rs`);
            }
            if (i > 1) {
                add(`${parts[i - 2]}/${parts[i - 1]}/${part}.rs`);
            }
        }

        return tails;
    }

    private async resolveSourceFile(file: string, symbol?: string): Promise<{ uri: vscode.Uri; matches?: string[] } | undefined> {
        const searchRoots = this.sourceSearchRoots();

        console.log(
            '[AsyncInspector] resolveSourceUri input file=' + file +
            ' isAbsolute=' + String(path.isAbsolute(file)) +
            ' searchRoots=' + JSON.stringify(searchRoots)
        );

        // 1) 绝对路径且真实存在
        if (path.isAbsolute(file) && fs.existsSync(file)) {
            console.log('[AsyncInspector] resolveSourceUri absolute-hit=' + file);
            this.inspectorLog('info', '[Inspector] Selected file found in workspace');
            return { uri: vscode.Uri.file(file) };
        }

        const tails = [
            ...this.sourceTailsFromFile(file),
            ...(symbol ? this.sourceTailsFromSymbol(symbol) : []),
        ];
        const seenTails = new Set<string>();

        for (const searchTail of tails) {
            if (!searchTail || seenTails.has(searchTail)) {
                continue;
            }
            seenTails.add(searchTail);

            // 2) 用所有 searchRoots 直接拼接尝试
            for (const root of searchRoots) {
                const candidate = path.join(root, searchTail);
                console.log('[AsyncInspector] resolveSourceUri candidate=' + candidate);
                if (fs.existsSync(candidate)) {
                    console.log('[AsyncInspector] resolveSourceUri candidate-hit=' + candidate);
                    this.inspectorLog('info', '[Inspector] Selected file found in workspace');
                    return { uri: vscode.Uri.file(candidate) };
                }
            }

            // 3) 递归后缀搜索
            const matches = await this.findFilesBySuffix(searchRoots, searchTail);
            console.log('[AsyncInspector] resolveSourceUri recursive-found=' + JSON.stringify(matches));
            if (matches.length > 0) {
                this.inspectorLog('info', '[Inspector] Selected file found in workspace');
                return { uri: vscode.Uri.file(matches[0]), matches };
            }
        }

        console.log('[AsyncInspector] resolveSourceUri failed', {
            file,
            tails,
            searchRoots,
        });

        return undefined;
    }

    private parseInfoLine(output: string): { file: string; line: number } | undefined {
        const match = output.match(/Line\s+(\d+)\s+of\s+"([^"]+)"/);
        if (!match) {
            return undefined;
        }
        return {
            line: parseInt(match[1], 10),
            file: match[2],
        };
    }

    private async querySymbolSourceLocation(symbol: string): Promise<{ file: string; line: number } | undefined> {
        const session = this._debugAdapterFactory?.getActiveSession();
        if (!session || !symbol || symbol === '<unknown>') {
            return undefined;
        }

        try {
            const escaped = symbol.replace(/'/g, "\\'");
            const output = await session.executeGDBCommand(`info line '${escaped}'`);
            return this.parseInfoLine(output);
        } catch (error) {
            console.error('Failed to locate symbol:', error);
            return undefined;
        }
    }

    private validLine(line: unknown): number | undefined {
        if (typeof line !== 'number' || !Number.isFinite(line) || line <= 0) {
            return undefined;
        }
        return Math.floor(line);
    }

    private async resolveNodeSourceLocation(
        node: SnapshotNode | undefined,
        nodeRef: NodeRef,
    ): Promise<SourceResolution | undefined> {
        const symbol = node?.func || nodeRef.func || '';
        const snapshotFile = node?.file || node?.fullname || nodeRef.file || nodeRef.fullname || '';
        const snapshotLine = this.validLine(node?.line) || this.validLine(nodeRef.line);

        if (snapshotFile) {
            const resolved = await this.resolveSourceFile(snapshotFile, symbol);
            if (resolved) {
                return {
                    uri: resolved.uri,
                    line: snapshotLine || 1,
                    reason: 'snapshot',
                    matches: resolved.matches,
                };
            }
        }

        const gdbLocation = await this.querySymbolSourceLocation(symbol);
        if (gdbLocation) {
            const resolved = await this.resolveSourceFile(gdbLocation.file, symbol);
            if (resolved) {
                return {
                    uri: resolved.uri,
                    line: gdbLocation.line,
                    reason: 'gdb-info-line',
                    matches: resolved.matches,
                };
            }
        }

        for (const tail of this.sourceTailsFromSymbol(symbol)) {
            const matches = await this.findFilesBySuffix(this.sourceSearchRoots(), tail);
            if (matches.length > 0) {
                return {
                    uri: vscode.Uri.file(matches[0]),
                    line: snapshotLine || 1,
                    reason: 'symbol-source-roots',
                    matches,
                };
            }
        }

        return undefined;
    }

    private async openSourceAt(uri: vscode.Uri, line: number): Promise<void> {
        const doc = await vscode.workspace.openTextDocument(uri);
        let targetLine = Math.max(0, line - 1);
        if (targetLine >= doc.lineCount) {
            this.inspectorLog(
                'warn',
                `[Inspector] Warning: line ${line} is outside ${uri.fsPath} (${doc.lineCount} lines), opening last line`
            );
            targetLine = Math.max(0, doc.lineCount - 1);
        }
        await vscode.window.showTextDocument(doc, {
            selection: new vscode.Range(targetLine, 0, targetLine, 0),
            preserveFocus: false,
            viewColumn: vscode.ViewColumn.One,
        });
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
            const resolved = await this.resolveSourceFile(file);
            if (!resolved) {
                vscode.window.showWarningMessage(`Cannot resolve file: ${file}`);
                return;
            }

            await this.openSourceAt(resolved.uri, line || 1);
        } catch (error) {
            console.error('Failed to open source file:', error);
            vscode.window.showWarningMessage(`Cannot open file: ${file}`);
        }
    }

    private getSnapshotNodeOrigin(node: SnapshotPathData['path'][0]): string | undefined {
        const origin = node.origin;
        return typeof origin === 'string' && origin ? origin : undefined;
    }

    private copySnapshotMetadata(target: TreeNode, source: SnapshotPathData['path'][0]): void {
        target.state_read_status = source.state_read_status;
        target.state_read_error = source.state_read_error;
        target.child_hit_match = source.child_hit_match;
        target.child_hit_thread_id = source.child_hit_thread_id;
        target.child_hit_parent_cid = source.child_hit_parent_cid;
        target.child_hit_parent_symbol = source.child_hit_parent_symbol;
        target.child_hit_child_symbol = source.child_hit_child_symbol;
        target.child_hit_env_addr = source.child_hit_env_addr;
        target.privilege = source.privilege;
        target.transition_event = source.transition_event;
    }

    private normalizeRuntimeHistoryNodes(nodes: HistoryTreeNode[]): TreeNode[] {
        return nodes.map(node => {
            const nodeType = node.type === 'sync' || node.type === 'transition'
                ? node.type
                : 'async';
            // Runtime displayLabel is intentionally ignored here: the backend
            // may append transient calls/active diagnostics to it, while the
            // History Tree title should stay the canonical function symbol.
            const func = String(node.func || node.displayLabel || '<unknown>');
            const treeNode: TreeNode = {
                type: nodeType,
                cid: typeof node.cid === 'number' ? node.cid : null,
                func,
                displayLabel: func,
                addr: typeof node.addr === 'string' ? node.addr : '',
                poll: typeof node.poll === 'number' ? node.poll : 0,
                state: typeof node.state === 'number' || typeof node.state === 'string'
                    ? node.state
                    : 'N/A',
                state_read_status: typeof node.state_read_status === 'string' ? node.state_read_status : undefined,
                state_read_error: typeof node.state_read_error === 'string' ? node.state_read_error : undefined,
                origin: typeof node.origin === 'string' ? node.origin : 'runtime-history',
                historyKind: typeof node.historyKind === 'string' ? node.historyKind : 'call-graph',
                thread_id: node.thread_id,
                parent_cid: node.parent_cid,
                enter_count: typeof node.enter_count === 'number' ? node.enter_count : 0,
                exit_count: typeof node.exit_count === 'number' ? node.exit_count : 0,
                seenCount: typeof node.seenCount === 'number' ? node.seenCount : node.enter_count,
                active: typeof node.active === 'boolean' ? node.active : false,
                currentlyInLatestSnapshot: typeof node.currentlyInLatestSnapshot === 'boolean'
                    ? node.currentlyInLatestSnapshot
                    : node.active,
                privilege: typeof node.privilege === 'string' ? node.privilege : undefined,
                transition_event: typeof node.transition_event === 'string' ? node.transition_event : undefined,
                children: this.normalizeRuntimeHistoryNodes(Array.isArray(node.children) ? node.children : []),
            };
            return treeNode;
        });
    }

    private recordHistorySnapshot(snapshot: SnapshotPathData): void {
        const id = this._nextSnapshotId++;
        this._historySnapshots.push({
            id,
            timestamp: Date.now(),
            path: snapshot.path.map(node => ({ ...node })),
            raw: {
                thread_id: snapshot.thread_id,
                pathLength: snapshot.path.length,
                privilege: snapshot.privilege,
                transition_event: snapshot.transition_event,
            },
        });
    }

    private getSnapshotHistoryTreeData(): TreeNode[] {
        return this._historySnapshots.map(record => ({
            type: 'transition',
            cid: null,
            func: `Snapshot #${record.id}`,
            displayLabel: `Snapshot #${record.id}`,
            addr: '',
            poll: 0,
            state: new Date(record.timestamp).toISOString(),
            historyKind: 'snapshot',
            snapshotId: record.id,
            timestamp: record.timestamp,
            origin: 'observed-history',
            raw: record.raw,
            children: this.buildSnapshotPathTree(record.path),
        }));
    }

    private getHistoryTreeData(): TreeNode[] {
        if (this._historySnapshots.length === 0) {
            return [];
        }

        return [
            {
                type: 'transition',
                cid: null,
                func: 'Observed Async Paths',
                displayLabel: 'Observed Async Paths (observed / seen before)',
                addr: '',
                poll: 0,
                state: `snapshots=${this._historySnapshots.length}`,
                historyKind: 'observed-root',
                origin: 'observed-history',
                children: this._observedPathRoots,
            },
            {
                type: 'transition',
                cid: null,
                func: 'Snapshots',
                displayLabel: 'Snapshots',
                addr: '',
                poll: 0,
                state: `count=${this._historySnapshots.length}`,
                historyKind: 'snapshot-root',
                origin: 'observed-history',
                children: this.getSnapshotHistoryTreeData(),
            },
        ];
    }

    private buildObservedPathsTree(): TreeNode[] {
        const roots: TreeNode[] = [];
        const latestSnapshotId = this._historySnapshots[this._historySnapshots.length - 1]?.id;

        for (const record of this._historySnapshots) {
            const pathNodes = this.getSnapshotPathSegment(record.path);
            let siblings = roots;

            for (const pathNode of pathNodes) {
                const key = this.getObservedNodeKey(pathNode);
                let observedNode = siblings.find(node => node.observedKey === key);
                if (!observedNode) {
                    observedNode = this.createTreeNodeFromSnapshotNode(pathNode);
                    observedNode.historyKind = 'observed';
                    observedNode.observedKey = key;
                    observedNode.seenCount = 0;
                    observedNode.firstSeenSnapshot = record.id;
                    observedNode.currentlyInLatestSnapshot = false;
                    siblings.push(observedNode);
                }

                if (observedNode.lastSeenSnapshot !== record.id) {
                    observedNode.seenCount = (observedNode.seenCount ?? 0) + 1;
                    observedNode.firstSeenSnapshot = Math.min(
                        observedNode.firstSeenSnapshot ?? record.id,
                        record.id
                    );
                    observedNode.lastSeenSnapshot = record.id;
                }

                if (record.id === latestSnapshotId) {
                    observedNode.currentlyInLatestSnapshot = true;
                    observedNode.cid = pathNode.cid;
                    observedNode.addr = pathNode.addr;
                    observedNode.poll = pathNode.poll ?? 0;
                    observedNode.state = pathNode.state ?? (pathNode.type === 'sync' ? 'NON-ASYNC' : 'N/A');
                    observedNode.origin = this.getSnapshotNodeOrigin(pathNode);
                    observedNode.file = pathNode.file;
                    observedNode.fullname = pathNode.fullname;
                    observedNode.line = pathNode.line;
                    this.copySnapshotMetadata(observedNode, pathNode);
                }

                siblings = observedNode.children;
            }
        }

        roots.forEach(root => this.finalizeObservedNodeLabels(root));
        return roots;
    }

    private getSnapshotPathSegment(pathNodes: SnapshotNode[]): SnapshotNode[] {
        const rootIndex = pathNodes.findIndex(node => node.type === 'async');
        return rootIndex >= 0 ? pathNodes.slice(rootIndex) : [];
    }

    private getObservedNodeKey(node: SnapshotNode): string {
        const name = node.func || node.addr || '<unknown>';
        return `${node.type}:${name}`;
    }

    private finalizeObservedNodeLabels(node: TreeNode): void {
        if (node.historyKind === 'observed') {
            const latest = node.currentlyInLatestSnapshot ? 'yes' : 'no';
            node.displayLabel = `${node.func} [seen=${node.seenCount ?? 0} latest=${latest}]`;
        }
        node.children.forEach(child => this.finalizeObservedNodeLabels(child));
    }

    private buildSnapshotPathTree(pathNodes: SnapshotNode[]): TreeNode[] {
        if (pathNodes.length === 0) {
            return [];
        }

        let rootIndex = -1;
        for (let i = 0; i < pathNodes.length; i++) {
            if (pathNodes[i].type === 'async') {
                rootIndex = i;
                break;
            }
        }

        if (rootIndex < 0) {
            return [];
        }

        const root = this.createTreeNodeFromSnapshotNode(pathNodes[rootIndex]);
        let current = root;
        for (let i = rootIndex + 1; i < pathNodes.length; i++) {
            const child = this.createTreeNodeFromSnapshotNode(pathNodes[i]);
            current.children.push(child);
            current = child;
        }

        return [root];
    }

    private createTreeNodeFromSnapshotNode(node: SnapshotNode): TreeNode {
        const treeNode: TreeNode = {
            type: node.type,
            cid: node.cid,
            func: node.func,
            addr: node.addr,
            poll: node.poll ?? 0,
            state: node.state ?? (node.type === 'sync' ? 'NON-ASYNC' : 'N/A'),
            origin: this.getSnapshotNodeOrigin(node),
            file: node.file,
            fullname: node.fullname,
            line: node.line,
            children: [],
        };
        this.copySnapshotMetadata(treeNode, node);
        return treeNode;
    }

    private updateTreeFromSnapshot(snapshot: SnapshotPathData): void {
        // The Inspector is a view of the current snapshot, not accumulated
        // trace history. Rebuild so nodes absent from this path disappear.
        this._currentSnapshotTreeRoots.clear();

        if (snapshot.path.length === 0) {
            return;
        }

        let rootIndex = -1;
        for (let i = 0; i < snapshot.path.length; i++) {
            if (snapshot.path[i].type === 'async') {
                rootIndex = i;
                break;
            }
        }

        if (rootIndex < 0) {
            return;
        }

        const rootNode = snapshot.path[rootIndex];
        if (rootNode.cid === null) {
            return;
        }

        let root = this._currentSnapshotTreeRoots.get(rootNode.cid);
        if (!root) {
            root = {
                type: 'async',
                cid: rootNode.cid,
                func: rootNode.func,
                addr: rootNode.addr,
                poll: rootNode.poll,
                state: rootNode.state,
                origin: this.getSnapshotNodeOrigin(rootNode),
                file: rootNode.file,
                fullname: rootNode.fullname,
                line: rootNode.line,
                children: []
            };
            this._currentSnapshotTreeRoots.set(rootNode.cid, root);
        } else {
            root.poll = rootNode.poll;
            root.state = rootNode.state;
            root.origin = this.getSnapshotNodeOrigin(rootNode);
            root.file = rootNode.file;
            root.fullname = rootNode.fullname;
            root.line = rootNode.line;
        }
        this.copySnapshotMetadata(root, rootNode);

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
        path: Array<SnapshotPathData['path'][0]>,
        startIndex: number,
    ): void {
        let current = parent;

        for (let i = startIndex; i < path.length; i++) {
            const node = path[i];

            if (node.type === 'async') {
                let child: TreeNode | undefined;

                if (node.cid !== null) {
                    // 1) 先按真实 CID 找
                    child = current.children.find(
                        c => c.type === 'async' && c.cid === node.cid
                    );

                    // 2) 如果没找到，再找“同 func 的旧占位节点”并升级
                    if (!child) {
                        const placeholder = current.children.find(
                            c =>
                                c.type === 'async' &&
                                c.cid === null &&
                                c.func === node.func
                        );

                        if (placeholder) {
                            placeholder.cid = node.cid;
                            placeholder.addr = node.addr;
                            placeholder.poll = node.poll;
                            placeholder.state = node.state;
                            placeholder.origin = this.getSnapshotNodeOrigin(node);
                            placeholder.file = node.file;
                            placeholder.fullname = node.fullname;
                            placeholder.line = node.line;
                            this.copySnapshotMetadata(placeholder, node);
                            child = placeholder;
                        }
                    }

                    // 3) 不管 child 是按 CID 找到的，还是由 placeholder 升级来的，
                    //    都清理掉同 func 的旧 placeholder，避免树里长期残留重复节点
                    current.children = current.children.filter(
                        c =>
                            !(
                                c !== child &&
                                c.type === 'async' &&
                                c.cid === null &&
                                c.func === node.func
                            )
                    );
                } else {
                    child = current.children.find(
                        c =>
                            c.type === 'async' &&
                            c.cid === null &&
                            c.func === node.func &&
                            c.addr === node.addr
                    );
                }

                const nextChild: TreeNode = child ?? {
                    type: 'async',
                    cid: node.cid,
                    func: node.func,
                    addr: node.addr,
                    poll: node.poll,
                    state: node.state,
                    origin: this.getSnapshotNodeOrigin(node),
                    children: [],
                    file: node.file,
                    fullname: node.fullname,
                    line: node.line,
                };
                this.copySnapshotMetadata(nextChild, node);

                if (!child) {
                    current.children.push(nextChild);
                } else {
                    nextChild.poll = node.poll;
                    nextChild.state = node.state;
                    nextChild.addr = node.addr;
                    nextChild.origin = this.getSnapshotNodeOrigin(node);
                    nextChild.file = node.file;
                    nextChild.fullname = node.fullname;
                    nextChild.line = node.line;
                    this.copySnapshotMetadata(nextChild, node);
                }

                current = nextChild;
            } else if (node.type === 'sync') {
                // Dedup sync nodes by func + addr
                let syncChild = current.children.find(
                    c => c.type === 'sync' && c.func === node.func && c.addr === node.addr
                );
                if (!syncChild) {
                    syncChild = {
                        type: 'sync',
                        cid: null,
                        func: node.func,
                        addr: node.addr,
                        poll: node.poll ?? 0,
                        state: node.state ?? 'NON-ASYNC',
                        origin: this.getSnapshotNodeOrigin(node),
                        file: node.file,
                        fullname: node.fullname,
                        line: node.line,
                        children: [],
                    };
                    this.copySnapshotMetadata(syncChild, node);
                    current.children.push(syncChild);
                } else {
                    syncChild.poll = node.poll ?? 0;
                    syncChild.state = node.state ?? 'NON-ASYNC';
                    syncChild.origin = this.getSnapshotNodeOrigin(node);
                    syncChild.file = node.file;
                    syncChild.fullname = node.fullname;
                    syncChild.line = node.line;
                    this.copySnapshotMetadata(syncChild, node);
                }

                // snapshot.path is one logical chain, so consecutive physical
                // frames must be nested rather than flattened as siblings.
                current = syncChild;
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
                <style>
                    .node-badges {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 4px;
                        margin-bottom: 2px;
                    }
                    .ard-badge {
                        display: inline-block;
                        padding: 1px 5px;
                        border-radius: 3px;
                        border: 1px solid var(--vscode-panel-border);
                        font-size: 10px;
                        font-weight: 600;
                        line-height: 1.4;
                        color: var(--vscode-descriptionForeground);
                    }
                    .ard-badge.async { color: #ff8a8a; }
                    .ard-badge.sync { color: #69db7c; }
                    .ard-badge.kernel { color: #74c0fc; }
                    .ard-badge.user { color: #ffd43b; }
                    .ard-badge.trace { color: #b197fc; }
                    .ard-badge.state-ok { color: #69db7c; }
                    .ard-badge.state-unsupported { color: #ffa94d; }
                    .ard-badge.transition { color: #ff8787; }
                    .node-detail-line {
                        font-size: 11px;
                        color: var(--vscode-descriptionForeground);
                        margin-top: 2px;
                        overflow-wrap: anywhere;
                    }
                    .node-detail-note {
                        color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground));
                    }
                    .transition-chain {
                        display: block;
                        height: 100%;
                        min-height: 0;
                        margin: 0;
                        padding: 8px;
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 4px;
                        background: var(--vscode-editorWidget-background);
                        overflow-y: auto;
                    }
                    .transition-chain-title {
                        font-weight: 600;
                        font-size: 12px;
                        margin-bottom: 6px;
                    }
                    .transition-chain-node {
                        cursor: pointer;
                        padding: 3px 4px;
                        border-radius: 3px;
                        font-size: 11px;
                        overflow-wrap: anywhere;
                    }
                    .transition-chain-node:hover {
                        background-color: var(--vscode-list-hoverBackground);
                    }
                    .transition-chain-arrow {
                        color: var(--vscode-descriptionForeground);
                        font-size: 11px;
                        padding-left: 10px;
                    }
                    .candidates-section {
                        flex: 1;
                        min-height: 0;
                        overflow-y: auto;
                    }
                    #candidatesList {
                        max-height: none;
                        overflow-y: visible;
                    }
                    .async-trace-candidates {
                        min-width: 0;
                    }
                    .async-trace-candidates-scroll {
                        max-width: 100%;
                        max-height: 300px;
                        overflow-x: auto;
                        overflow-y: auto;
                    }
                    .async-trace-candidates-scroll #candidatesList {
                        min-width: max-content;
                        max-height: none;
                        overflow: visible;
                    }
                    .async-trace-candidates-scroll .candidate-item {
                        min-width: max-content;
                    }
                    .async-trace-candidates-scroll .candidate-symbol {
                        white-space: nowrap;
                    }
                    .execution-graph-header {
                        margin-bottom: 10px;
                    }
                    .execution-graph-header h3 {
                        margin-bottom: 4px;
                    }
                    .execution-graph-description {
                        color: var(--vscode-descriptionForeground);
                        font-size: 11px;
                        line-height: 1.4;
                        overflow-wrap: anywhere;
                    }
                </style>
                <title>Async Inspector</title>
            </head>
            <body>
                <div class="container">
                    <div class="toolbar">
                        <button id="connectRemoteBtn" class="btn">Connect :1234</button>
                        <button id="resetBtn" class="btn">Reset</button>
                        <button id="genWhitelistBtn" class="btn">Gen Whitelist</button>
                        <button id="snapshotBtn" class="btn">Snapshot</button>
                        <button id="historyBtn" class="btn">History</button>
                        <button id="clearHistoryBtn" class="btn">Clear History</button>
                        <button id="chainBtn" class="btn">Chain</button>
                    </div>
                    <div class="main-content">
                        <div class="tree-panel">
                            <div class="execution-graph-header">
                                <h3>Async Execution Graph</h3>
                                <div class="execution-graph-description">Runtime call graph from whitelist-admitted runtime events. Snapshot only prints the current snapshot. Trace only selects the observation root; graph nodes are built from whitelist-admitted runtime events.</div>
                            </div>
                            <div id="treeContainer"></div>
                        </div>
                        <div class="transition-panel">
                            <div id="transitionChain" class="transition-chain"></div>
                        </div>
                        <div class="candidates-panel">
                            <div class="candidates-section">
                                <div class="candidate-block async-trace-candidates">
                                    <h3>Async Trace Candidates</h3>
                                    <div class="async-trace-candidates-scroll">
                                        <div id="candidatesList"></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <script>
                    window.ardInspectorVscode = window.ardInspectorVscode || acquireVsCodeApi();
                    window.acquireVsCodeApi = function() { return window.ardInspectorVscode; };
                    window.treeData = ${JSON.stringify(this._historyTreeRoots)};
                    window.transitionPath = ${JSON.stringify(this._lastTransitionPath)};
                </script>
                <script src="${scriptUri}"></script>
                <script>
                    (function() {
                        var patchScheduled = false;
                        var isPatching = false;

                        function flattenTree(nodes, out) {
                            out = out || [];
                            if (!Array.isArray(nodes)) {
                                return out;
                            }
                            nodes.forEach(function(node) {
                                out.push(node);
                                flattenTree(node.children, out);
                            });
                            return out;
                        }

                        function valueOrNA(value) {
                            return value === undefined || value === null || value === '' ? 'N/A' : String(value);
                        }

                        function addBadge(container, text, extraClass) {
                            var badge = document.createElement('span');
                            badge.className = 'ard-badge ' + (extraClass || '');
                            badge.textContent = text;
                            container.appendChild(badge);
                        }

                        function transitionNodeText(node) {
                            var privilege = valueOrNA(node && node.privilege).toUpperCase();
                            var type = valueOrNA(node && node.type);
                            var label = (node && (node.label || node.func || node.event || node.symbol)) || 'unknown';
                            if (node && node.type === 'transition') {
                                return '[TRANSITION] ' + valueOrNA(node.event || node.label);
                            }
                            return '[' + privilege + '][' + type + '] ' + label;
                        }

                        function renderTransitionPath(path) {
                            var container = document.getElementById('transitionChain');
                            if (!container) {
                                return;
                            }
                            container.innerHTML = '';
                            container.style.display = 'block';
                            var title = document.createElement('div');
                            title.className = 'transition-chain-title';
                            title.textContent = 'Cross Privilege Chain';
                            container.appendChild(title);

                            if (!Array.isArray(path) || path.length === 0) {
                                var empty = document.createElement('div');
                                empty.className = 'placeholder-text';
                                empty.textContent = 'No cross privilege chain available.';
                                container.appendChild(empty);
                                return;
                            }

                            path.forEach(function(node, index) {
                                if (index > 0) {
                                    var arrow = document.createElement('div');
                                    arrow.className = 'transition-chain-arrow';
                                    arrow.textContent = '↓';
                                    container.appendChild(arrow);
                                }

                                var row = document.createElement('div');
                                row.className = 'transition-chain-node';
                                row.textContent = transitionNodeText(node);
                                row.addEventListener('click', function(event) {
                                    event.stopPropagation();
                                    if (window.ardInspectorVscode) {
                                        window.ardInspectorVscode.postMessage({
                                            command: 'selectNode',
                                            cid: null,
                                            func: node.func || node.label || node.event || '',
                                            addr: node.pc || '',
                                            file: node.file,
                                            fullname: node.fullname,
                                            line: node.line,
                                        });
                                    }
                                });
                                container.appendChild(row);
                            });
                        }

                        function patchNode(node, treeNodeElement) {
                            var info = treeNodeElement.querySelector(':scope > .node-content .node-info');
                            var func = treeNodeElement.querySelector(':scope > .node-content .node-func');
                            var meta = treeNodeElement.querySelector(':scope > .node-content .node-meta');
                            var oldType = treeNodeElement.querySelector(':scope > .node-content .node-type');

                            if (!info || !func || !meta) {
                                return;
                            }

                            if (oldType) {
                                oldType.style.display = 'none';
                            }

                            var oldBadges = info.querySelector(':scope > .node-badges');
                            if (oldBadges) {
                                oldBadges.remove();
                            }
                            var oldDetails = info.querySelectorAll(':scope > .node-detail-line');
                            oldDetails.forEach(function(detail) { detail.remove(); });

                            // Prefer the canonical function field over backend
                            // displayLabel diagnostics such as [calls=...].
                            func.textContent = node.func || node.displayLabel || '<unknown>';

                            if (node.historyKind !== 'call-graph-root' && node.type !== 'transition') {
                                var badges = document.createElement('div');
                                badges.className = 'node-badges';
                                var typeText = node.type === 'async' ? 'ASYNC' : 'SYNC';
                                addBadge(badges, typeText, node.type === 'async' ? 'async' : 'sync');

                                var privilege = node.privilege;
                                if (privilege === 'kernel') {
                                    addBadge(badges, 'KERNEL', 'kernel');
                                } else if (privilege === 'user') {
                                    addBadge(badges, 'USER', 'user');
                                }
                                info.insertBefore(badges, func);
                            }

                            if (node.historyKind === 'observed-root') {
                                meta.textContent = 'Observed paths accumulated across snapshots; latest=yes marks membership in the newest snapshot.path.';
                            } else if (node.historyKind === 'call-graph-root') {
                                meta.textContent = 'Runtime call graph from whitelist-admitted runtime events. Snapshot only prints the current snapshot. Trace only selects the observation root; graph nodes are built from whitelist-admitted runtime events.';
                            } else if (node.historyKind === 'call-graph') {
                                meta.textContent =
                                    'CallGraph: calls=' + valueOrNA(node.enter_count) +
                                    ' | exit=' + valueOrNA(node.exit_count) +
                                    ' | active=' + (node.active ? 'yes' : 'no') +
                                    ' | thread=' + valueOrNA(node.thread_id);
                            } else if (node.historyKind === 'snapshot-root') {
                                meta.textContent = 'Recorded snapshot.path samples, grouped by snapshot id.';
                            } else if (node.historyKind === 'snapshot') {
                                meta.textContent = 'Snapshot #' + valueOrNA(node.snapshotId);
                            } else if (node.historyKind === 'observed') {
                                meta.textContent =
                                    'Observed: seen=' + valueOrNA(node.seenCount) +
                                    ' | first=#' + valueOrNA(node.firstSeenSnapshot) +
                                    ' | last=#' + valueOrNA(node.lastSeenSnapshot) +
                                    ' | latest=' + (node.currentlyInLatestSnapshot ? 'yes' : 'no');
                            } else if (node.type === 'async') {
                                meta.textContent =
                                    'CID: ' + valueOrNA(node.cid) +
                                    ' | Poll: ' + valueOrNA(node.poll);
                            } else {
                                meta.textContent = 'Addr: ' + valueOrNA(node.addr);
                            }
                        }

                        function patchTreeMetadata(nodes) {
                            var flat = flattenTree(nodes || []);
                            var treeNodes = document.querySelectorAll('#treeContainer .tree-node');
                            treeNodes.forEach(function(treeNode, index) {
                                var node = flat[index];
                                if (!node) {
                                    return;
                                }
                                patchNode(node, treeNode);
                            });
                        }

                        function scheduleInspectorPatch(nodes) {
                            window.treeData = nodes || window.treeData || [];
                            if (patchScheduled) {
                                return;
                            }
                            patchScheduled = true;
                            setTimeout(function() {
                                patchScheduled = false;
                                isPatching = true;
                                try {
                                    patchTreeMetadata(window.treeData || []);
                                } finally {
                                    isPatching = false;
                                }
                            }, 0);
                        }

                        window.addEventListener('message', function(event) {
                            var message = event.data;
                            if (message && message.command === 'updateTree') {
                                scheduleInspectorPatch(message.treeData);
                            } else if (message && message.command === 'updateTransitionPath') {
                                window.transitionPath = message.transitionPath || [];
                                renderTransitionPath(window.transitionPath);
                            } else if (message && message.command === 'connectRemoteResult') {
                                var button = document.getElementById('connectRemoteBtn');
                                if (button) {
                                    button.disabled = false;
                                    button.textContent = 'Connect :1234';
                                    button.title = message.message || '';
                                }
                            }
                        });

                        var connectRemoteBtn = document.getElementById('connectRemoteBtn');
                        if (connectRemoteBtn) {
                            connectRemoteBtn.addEventListener('click', function() {
                                connectRemoteBtn.disabled = true;
                                connectRemoteBtn.textContent = 'Connecting...';
                                window.ardInspectorVscode.postMessage({
                                    command: 'connectRemote',
                                    host: '127.0.0.1',
                                    port: 1234,
                                });
                            });
                        }

                        var treeContainer = document.getElementById('treeContainer');
                        if (treeContainer && typeof MutationObserver !== 'undefined') {
                            var observer = new MutationObserver(function() {
                                if (!isPatching) {
                                    scheduleInspectorPatch(window.treeData || []);
                                }
                            });
                            observer.observe(treeContainer, { childList: true, subtree: true });
                        }

                        renderTransitionPath(window.transitionPath || []);
                        scheduleInspectorPatch(window.treeData || []);
                    })();
                </script>
            </body>
            </html>`;
    }

    public dispose(): void {
        AsyncInspectorPanel.currentPanel = undefined;
        this._panel.dispose();
        this._outputChannel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}

interface TreeNode {
    type: 'async' | 'sync' | 'transition';
    cid: number | null;
    func: string;
    displayLabel?: string;
    addr: string;
    poll: number;
    state: number | string;
    state_read_status?: string;
    state_read_error?: string;
    child_hit_match?: string;
    child_hit_thread_id?: number | string | null;
    child_hit_parent_cid?: number | string | null;
    child_hit_parent_symbol?: string;
    child_hit_child_symbol?: string;
    child_hit_env_addr?: string;
    privilege?: string;
    transition_event?: string;
    origin?: string;
    historyKind?: string;
    observedKey?: string;
    seenCount?: number;
    firstSeenSnapshot?: number;
    lastSeenSnapshot?: number;
    currentlyInLatestSnapshot?: boolean;
    thread_id?: number | string | null;
    parent_cid?: number | string | null;
    enter_count?: number;
    exit_count?: number;
    active?: boolean;
    snapshotId?: number;
    timestamp?: number;
    raw?: unknown;
    file?: string;
    fullname?: string;
    line?: number;
    children: TreeNode[];
}
