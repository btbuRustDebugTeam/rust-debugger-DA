(function() {
    const vscode = acquireVsCodeApi();
    let treeData = window.treeData || [];
    let selectedNode = null;

    // Grouped whitelist state
    let groupedWhitelist = null;
    let enabledCrates = new Set();

    // Trace root state
    let currentTraceRoot = null;
    let inferredTraceRoot = null;

    // Flat candidates fallback
    let candidates = [];

    // Initialize UI
    function init() {
        renderTree(treeData);
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

        document.getElementById('inferTraceRootBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'inferTraceRoot' });
        });
    }

    // -----------------------------------------------------------------------
    // Tree rendering
    // -----------------------------------------------------------------------

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
    // Trace Root section
    // -----------------------------------------------------------------------

    function renderTraceRootSection() {
        const display = document.getElementById('traceRootDisplay');
        const dropdown = document.getElementById('traceRootDropdown');
        if (!display || !dropdown) return;

        // Show current or inferred trace root
        if (currentTraceRoot) {
            display.innerHTML = '';
            const label = document.createElement('div');
            label.className = 'trace-root-active';
            label.textContent = currentTraceRoot;
            display.appendChild(label);
        } else if (inferredTraceRoot && inferredTraceRoot.trace_root) {
            display.innerHTML = '';

            const suggestion = document.createElement('div');
            suggestion.className = 'trace-root-suggestion';

            const label = document.createElement('span');
            label.textContent = inferredTraceRoot.trace_root;
            label.className = 'trace-root-symbol';

            const traceBtn = document.createElement('button');
            traceBtn.className = 'candidate-btn';
            traceBtn.textContent = 'Trace';
            traceBtn.addEventListener('click', () => {
                currentTraceRoot = inferredTraceRoot.trace_root;
                vscode.postMessage({ command: 'trace', symbol: inferredTraceRoot.trace_root });
                renderTraceRootSection();
            });

            suggestion.appendChild(label);
            suggestion.appendChild(traceBtn);
            display.appendChild(suggestion);
        } else {
            display.textContent = 'No trace root set. Click "Infer from Breakpoint" or select from whitelist.';
        }

        // Dropdown: show user-crate async symbols for manual selection
        dropdown.innerHTML = '';
        if (groupedWhitelist && groupedWhitelist.crates) {
            const userSymbols = [];
            for (const [crateName, crateData] of Object.entries(groupedWhitelist.crates)) {
                if (crateData.is_user_crate) {
                    for (const sym of crateData.symbols) {
                        // Only show async functions (not manual poll implementations)
                        if (sym.name.includes('{async_fn#') || sym.name.includes('{async_block#')) {
                            userSymbols.push(sym.name);
                        }
                    }
                }
            }

            if (userSymbols.length > 0) {
                const select = document.createElement('select');
                select.className = 'trace-root-select';
                select.id = 'traceRootSelect';

                const defaultOpt = document.createElement('option');
                defaultOpt.value = '';
                defaultOpt.textContent = '-- Select async function --';
                select.appendChild(defaultOpt);

                userSymbols.forEach(sym => {
                    const opt = document.createElement('option');
                    opt.value = sym;
                    // Show shortened name for readability
                    opt.textContent = sym;
                    select.appendChild(opt);
                });

                select.addEventListener('change', () => {
                    if (select.value) {
                        currentTraceRoot = select.value;
                        vscode.postMessage({ command: 'trace', symbol: select.value });
                        renderTraceRootSection();
                    }
                });

                dropdown.appendChild(select);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Grouped Whitelist rendering
    // -----------------------------------------------------------------------

    function renderGroupedWhitelist(grouped) {
        const container = document.getElementById('whitelistContainer');
        if (!container) return;
        container.innerHTML = '';

        if (!grouped || !grouped.crates || Object.keys(grouped.crates).length === 0) {
            container.innerHTML = '<div class="placeholder-text">No whitelist generated. Click "Gen Whitelist" first.</div>';
            return;
        }

        // Sort: user crates first, then framework crates, alphabetical within each group
        const crateNames = Object.keys(grouped.crates);
        const userCrates = crateNames.filter(c => grouped.crates[c].is_user_crate).sort();
        const frameworkCrates = crateNames.filter(c => !grouped.crates[c].is_user_crate).sort();

        // User crates section
        if (userCrates.length > 0) {
            const header = document.createElement('div');
            header.className = 'section-label';
            header.textContent = 'Your Crates';
            container.appendChild(header);
            userCrates.forEach(name => renderCrateGroup(container, name, grouped.crates[name], true));
        }

        // Framework crates section
        if (frameworkCrates.length > 0) {
            const header = document.createElement('div');
            header.className = 'section-label';
            header.textContent = 'Framework / Library';
            container.appendChild(header);
            frameworkCrates.forEach(name => renderCrateGroup(container, name, grouped.crates[name], false));
        }

        // Apply button
        const applyBtn = document.createElement('button');
        applyBtn.className = 'btn apply-btn';
        applyBtn.textContent = 'Apply Whitelist';
        applyBtn.addEventListener('click', () => {
            vscode.postMessage({
                command: 'updateWhitelistCrates',
                enabledCrates: Array.from(enabledCrates)
            });
        });
        container.appendChild(applyBtn);
    }

    function renderCrateGroup(container, crateName, crateData, defaultExpanded) {
        const group = document.createElement('div');
        group.className = `crate-group ${crateData.is_user_crate ? 'user-crate' : ''}`;

        const isEnabled = enabledCrates.has(crateName);
        const isExpanded = defaultExpanded;

        // Header
        const header = document.createElement('div');
        header.className = 'crate-group-header';

        const chevron = document.createElement('span');
        chevron.className = `crate-chevron ${isExpanded ? '' : 'collapsed'}`;
        chevron.textContent = '\u25BC'; // ▼

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = isEnabled;
        checkbox.addEventListener('change', (e) => {
            e.stopPropagation();
            if (checkbox.checked) {
                enabledCrates.add(crateName);
            } else {
                enabledCrates.delete(crateName);
            }
            // Update all child checkboxes
            const childCheckboxes = body.querySelectorAll('input[type="checkbox"]');
            childCheckboxes.forEach(cb => { cb.checked = checkbox.checked; });
        });
        checkbox.addEventListener('click', (e) => e.stopPropagation());

        const nameSpan = document.createElement('span');
        nameSpan.className = 'crate-name';
        nameSpan.textContent = crateName;

        const badge = document.createElement('span');
        badge.className = 'crate-badge';
        badge.textContent = `${crateData.symbols.length}`;

        header.appendChild(chevron);
        header.appendChild(checkbox);
        header.appendChild(nameSpan);
        header.appendChild(badge);

        // Body (collapsible)
        const body = document.createElement('div');
        body.className = `crate-group-body ${isExpanded ? '' : 'collapsed'}`;

        // Toggle expand/collapse on header click
        header.addEventListener('click', () => {
            const isCollapsed = body.classList.contains('collapsed');
            body.classList.toggle('collapsed');
            chevron.classList.toggle('collapsed', !isCollapsed);
        });

        // Render symbols
        crateData.symbols.forEach(sym => {
            const item = document.createElement('div');
            item.className = 'symbol-item';

            const label = document.createElement('label');
            label.textContent = sym.name;
            label.title = sym.file ? `${sym.file}:${sym.line || '?'}` : sym.name;

            const actions = document.createElement('div');
            actions.className = 'symbol-actions';

            const traceBtn = document.createElement('button');
            traceBtn.className = 'candidate-btn';
            traceBtn.textContent = 'Trace';
            traceBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                currentTraceRoot = sym.name;
                vscode.postMessage({ command: 'trace', symbol: sym.name });
                renderTraceRootSection();
            });

            const locateBtn = document.createElement('button');
            locateBtn.className = 'candidate-btn';
            locateBtn.textContent = 'Locate';
            locateBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                vscode.postMessage({ command: 'locate', symbol: sym.name });
            });

            actions.appendChild(traceBtn);
            actions.appendChild(locateBtn);
            item.appendChild(label);
            item.appendChild(actions);
            body.appendChild(item);
        });

        group.appendChild(header);
        group.appendChild(body);
        container.appendChild(group);
    }

    // -----------------------------------------------------------------------
    // Flat candidates rendering (fallback for old whitelist format)
    // -----------------------------------------------------------------------

    function renderCandidates(candidatesList) {
        const container = document.getElementById('whitelistContainer');
        if (!container) return;
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
                currentTraceRoot = symbol;
                vscode.postMessage({ command: 'trace', symbol: symbol });
                renderTraceRootSection();
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
            case 'updateGroupedWhitelist':
                groupedWhitelist = message.groupedWhitelist;
                // Initialize enabledCrates with user crates by default
                enabledCrates = new Set();
                if (groupedWhitelist && groupedWhitelist.crates) {
                    for (const [name, data] of Object.entries(groupedWhitelist.crates)) {
                        if (data.is_user_crate) {
                            enabledCrates.add(name);
                        }
                    }
                }
                renderGroupedWhitelist(groupedWhitelist);
                renderTraceRootSection();
                break;
            case 'updateInferredTraceRoot':
                inferredTraceRoot = message.traceRoot;
                renderTraceRootSection();
                break;
        }
    });

    // Initialize on load
    init();
})();
