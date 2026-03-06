(function() {
    const vscode = acquireVsCodeApi();
    let treeData = window.treeData || [];
    let selectedNode = null;
    let candidates = [];
    let callStackData = [];
    let selectedFrameId = null;

    // Initialize UI
    function init() {
        renderTree(treeData);
        renderCallStack(callStackData);
        setupEventListeners();
        requestCandidates();
    }

    function setupEventListeners() {
        document.getElementById('resetBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'reset' });
        });

        document.getElementById('genWhitelistBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'genWhitelist' });
        });

        document.getElementById('snapshotBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'snapshot' });
        });
    }

    function renderTree(roots) {
        const container = document.getElementById('treeContainer');
        container.innerHTML = '';

        if (roots.length === 0) {
            container.innerHTML = '<div class="placeholder-text">No async execution tree available. Start debugging and set a trace point.</div>';
            return;
        }

        roots.forEach(root => {
            const rootElement = createTreeNode(root, 0);
            container.appendChild(rootElement);
        });
    }

    function createTreeNode(node, depth) {
        const div = document.createElement('div');
        div.className = `tree-node ${node.type} ${selectedNode === node.cid ? 'selected' : ''}`;
        div.style.marginLeft = `${depth * 20}px`;

        const content = document.createElement('div');
        content.className = 'node-content';

        const typeBadge = document.createElement('span');
        typeBadge.className = 'node-type';
        typeBadge.textContent = node.type === 'async' ? 'ASYNC' : 'SYNC';
        typeBadge.style.color = node.type === 'async' ? '#ff6b6b' : '#51cf66';

        const info = document.createElement('div');
        info.className = 'node-info';

        const func = document.createElement('div');
        func.className = 'node-func';
        func.textContent = node.func;

        const meta = document.createElement('div');
        meta.className = 'node-meta';
        if (node.type === 'async') {
            meta.textContent = `CID: ${node.cid} | Poll: ${node.poll} | State: ${node.state}`;
        } else {
            meta.textContent = `Addr: ${node.addr}`;
        }

        info.appendChild(func);
        info.appendChild(meta);
        content.appendChild(typeBadge);
        content.appendChild(info);
        div.appendChild(content);

        // Add click handler
        div.addEventListener('click', (e) => {
            e.stopPropagation();
            selectNode(node.cid);
            vscode.postMessage({ command: 'selectNode', cid: node.cid });
        });

        // Render children
        if (node.children && node.children.length > 0) {
            const childrenContainer = document.createElement('div');
            childrenContainer.className = 'node-children';
            node.children.forEach(child => {
                childrenContainer.appendChild(createTreeNode(child, depth + 1));
            });
            div.appendChild(childrenContainer);
        }

        return div;
    }

    function selectNode(cid) {
        selectedNode = cid;
        renderTree(treeData);
    }

    function requestCandidates() {
        vscode.postMessage({ command: 'refreshCandidates' });
    }

    // -----------------------------------------------------------------------
    // Call Stack rendering
    // -----------------------------------------------------------------------

    function renderCallStack(threadStacks) {
        const container = document.getElementById('callStackContainer');
        container.innerHTML = '';

        if (!threadStacks || threadStacks.length === 0) {
            container.innerHTML = '<div class="placeholder-text">No call stack available.</div>';
            return;
        }

        threadStacks.forEach(threadInfo => {
            // Thread header
            const threadHeader = document.createElement('div');
            threadHeader.className = 'callstack-thread-header';
            threadHeader.textContent = `Thread ${threadInfo.threadId}: ${threadInfo.threadName}`;
            container.appendChild(threadHeader);

            // Frames
            if (threadInfo.frames.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'placeholder-text';
                empty.textContent = 'No frames.';
                container.appendChild(empty);
                return;
            }

            threadInfo.frames.forEach((frame, index) => {
                const frameEl = document.createElement('div');
                frameEl.className = 'callstack-frame' + (selectedFrameId === frame.id ? ' selected' : '');

                const indexSpan = document.createElement('span');
                indexSpan.className = 'callstack-frame-index';
                indexSpan.textContent = `#${index}`;

                const nameSpan = document.createElement('span');
                nameSpan.className = 'callstack-frame-name';
                nameSpan.textContent = frame.name;

                const locSpan = document.createElement('span');
                locSpan.className = 'callstack-frame-location';
                if (frame.file && frame.line > 0) {
                    locSpan.textContent = `${frame.file}:${frame.line}`;
                } else if (frame.addr) {
                    locSpan.textContent = frame.addr;
                }

                frameEl.appendChild(indexSpan);
                frameEl.appendChild(nameSpan);
                frameEl.appendChild(locSpan);

                // Click to jump to source
                frameEl.addEventListener('click', () => {
                    selectedFrameId = frame.id;
                    renderCallStack(callStackData);
                    if (frame.path && frame.line > 0) {
                        vscode.postMessage({
                            command: 'selectFrame',
                            file: frame.path,
                            line: frame.line,
                        });
                    }
                });

                container.appendChild(frameEl);
            });
        });
    }

    // -----------------------------------------------------------------------
    // Candidates rendering
    // -----------------------------------------------------------------------

    function renderCandidates(candidatesList) {
        const container = document.getElementById('candidatesList');
        container.innerHTML = '';

        if (candidatesList.length === 0) {
            container.innerHTML = '<div class="placeholder-text">No candidates. Generate whitelist first.</div>';
            return;
        }

        candidatesList.forEach(symbol => {
            const item = document.createElement('div');
            item.className = 'candidate-item';

            const symbolSpan = document.createElement('span');
            symbolSpan.className = 'candidate-symbol';
            symbolSpan.textContent = symbol;

            const actions = document.createElement('div');
            actions.className = 'candidate-actions';

            const traceBtn = document.createElement('button');
            traceBtn.className = 'candidate-btn';
            traceBtn.textContent = 'Trace';
            traceBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'trace', symbol: symbol });
            });

            const locateBtn = document.createElement('button');
            locateBtn.className = 'candidate-btn';
            locateBtn.textContent = 'Locate';
            locateBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'locate', symbol: symbol });
            });

            actions.appendChild(traceBtn);
            actions.appendChild(locateBtn);
            item.appendChild(symbolSpan);
            item.appendChild(actions);
            container.appendChild(item);
        });
    }

    // -----------------------------------------------------------------------
    // Log rendering
    // -----------------------------------------------------------------------

    function renderLogs(logs, cid) {
        const container = document.getElementById('logContainer');
        if (!logs || logs.length === 0) {
            container.textContent = 'No log entries for selected CID.';
            return;
        }

        container.innerHTML = '';
        logs.forEach(log => {
            const entry = document.createElement('div');
            entry.className = 'log-entry';
            if (cid && log.includes(`coro#${cid}`)) {
                entry.classList.add('highlight');
            }
            entry.textContent = log;
            container.appendChild(entry);
        });
    }

    // -----------------------------------------------------------------------
    // Message listener
    // -----------------------------------------------------------------------

    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.command) {
            case 'updateTree':
                treeData = message.treeData;
                renderTree(treeData);
                break;
            case 'updateCandidates':
                candidates = message.candidates;
                renderCandidates(candidates);
                break;
            case 'updateLogs':
                renderLogs(message.logs, message.cid);
                break;
            case 'updateCallStack':
                callStackData = message.threadStacks;
                renderCallStack(callStackData);
                break;
        }
    });

    // Initialize on load
    init();
})();
