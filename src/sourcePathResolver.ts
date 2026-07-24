import * as fs from 'fs';
import * as path from 'path';

export type SourceResolverLog = (message: string) => void;

function isDirectory(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}

function isFile(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

export function collectTestcaseSourceRoots(
    workspaceRoots: string[],
    extensionRoot: string,
): string[] {
    const roots: string[] = [];
    const seen = new Set<string>();
    const addRoot = (candidate: string | undefined) => {
        if (!candidate) {
            return;
        }
        const resolved = path.resolve(candidate);
        if (!seen.has(resolved) && isDirectory(resolved)) {
            seen.add(resolved);
            roots.push(resolved);
        }
    };

    for (const root of workspaceRoots) {
        addRoot(root);
    }
    addRoot(extensionRoot);

    const testcasesRoot = path.join(extensionRoot, 'testcases');
    try {
        const entries = fs.readdirSync(testcasesRoot, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            addRoot(path.join(testcasesRoot, entry.name));
        }
    } catch {
        // An installed extension may not ship testcase sources.
    }

    return roots;
}

function candidateWithinRoot(root: string, relativePath: string): string | undefined {
    const normalizedRelative = relativePath
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');
    if (!normalizedRelative) {
        return undefined;
    }

    const candidate = path.resolve(root, normalizedRelative);
    const relativeToRoot = path.relative(root, candidate);
    if (
        relativeToRoot === '..'
        || relativeToRoot.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativeToRoot)
    ) {
        return undefined;
    }
    return candidate;
}

function selectUniqueExistingCandidate(
    candidates: string[],
    log: SourceResolverLog,
): string | null | undefined {
    const matches: string[] = [];
    const seen = new Set<string>();

    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        if (seen.has(resolved)) {
            continue;
        }
        seen.add(resolved);
        log(`[ARD] source candidate: ${resolved}`);
        if (isFile(resolved)) {
            matches.push(resolved);
        }
    }

    if (matches.length === 1) {
        log(`[ARD] source resolved: ${matches[0]}`);
        return matches[0];
    }
    if (matches.length > 1) {
        log(`[ARD] source resolve ambiguous: ${JSON.stringify(matches)}`);
        return null;
    }
    return undefined;
}

export function resolveTestcaseSourcePath(
    dwarfPath: string,
    roots: string[],
    log: SourceResolverLog = () => undefined,
): string | undefined {
    log(`[ARD] source resolve input: ${dwarfPath}`);

    if (path.isAbsolute(dwarfPath)) {
        const exact = path.resolve(dwarfPath);
        log(`[ARD] source candidate: ${exact}`);
        if (isFile(exact)) {
            log(`[ARD] source resolved: ${exact}`);
            return exact;
        }
    }

    if (!path.isAbsolute(dwarfPath)) {
        const directCandidates = roots
            .map(root => candidateWithinRoot(root, dwarfPath))
            .filter((candidate): candidate is string => typeof candidate === 'string');
        const directMatch = selectUniqueExistingCandidate(directCandidates, log);
        if (directMatch !== undefined) {
            return directMatch || undefined;
        }
    }

    const pathParts = dwarfPath.replace(/\\/g, '/').split('/').filter(Boolean);
    const markerCandidates: string[] = [];
    for (const root of roots) {
        const markerIndex = pathParts.lastIndexOf(path.basename(root));
        if (markerIndex < 0 || markerIndex >= pathParts.length - 1) {
            continue;
        }
        const candidate = candidateWithinRoot(
            root,
            pathParts.slice(markerIndex + 1).join('/'),
        );
        if (candidate) {
            markerCandidates.push(candidate);
        }
    }
    const markerMatch = selectUniqueExistingCandidate(markerCandidates, log);
    if (markerMatch !== undefined) {
        return markerMatch || undefined;
    }

    const suffixCandidates: string[] = [];
    for (let index = 0; index < pathParts.length - 1; index++) {
        const suffix = pathParts.slice(index).join('/');
        for (const root of roots) {
            const candidate = candidateWithinRoot(root, suffix);
            if (candidate) {
                suffixCandidates.push(candidate);
            }
        }
    }
    const suffixMatch = selectUniqueExistingCandidate(suffixCandidates, log);
    return suffixMatch || undefined;
}

function lexicalSourceIdentity(sourcePath: string): string {
    const normalized = path.normalize(sourcePath).split(path.sep).join('/');
    return normalized.replace(/^\.\//, '');
}

export function normalizeSourceIdentity(
    sourcePath: string | null | undefined,
    roots: string[],
): string | undefined {
    if (!sourcePath) {
        return undefined;
    }

    const resolved = resolveTestcaseSourcePath(sourcePath, roots);
    if (resolved) {
        return lexicalSourceIdentity(path.resolve(resolved));
    }

    return path.isAbsolute(sourcePath)
        ? lexicalSourceIdentity(path.resolve(sourcePath))
        : lexicalSourceIdentity(sourcePath);
}

export function sourcePathsEqual(
    left: string | null | undefined,
    right: string | null | undefined,
    roots: string[],
): boolean {
    if (!left || !right) {
        return false;
    }

    // Preserve exact/lexically equivalent comparisons even when a relative
    // path is intentionally ambiguous across multiple testcase roots.
    if (lexicalSourceIdentity(left) === lexicalSourceIdentity(right)) {
        return true;
    }

    const leftIdentity = normalizeSourceIdentity(left, roots);
    const rightIdentity = normalizeSourceIdentity(right, roots);
    return leftIdentity !== undefined && leftIdentity === rightIdentity;
}

function isWithinRoot(filePath: string, root: string): string | undefined {
    const relative = path.relative(root, filePath);
    if (
        !relative
        || relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
    ) {
        return undefined;
    }
    return relative.split(path.sep).join('/');
}

function componentCount(candidate: string): number {
    return candidate.split('/').filter(Boolean).length;
}

export function gdbSourcePathCandidates(
    localPath: string,
    roots: string[],
    extensionRoot: string,
): string[] {
    const candidates: string[] = [];
    const seen = new Set<string>();
    const add = (candidate: string | undefined) => {
        if (!candidate || seen.has(candidate)) {
            return;
        }
        seen.add(candidate);
        candidates.push(candidate);
    };

    // DAP identity and the first GDB attempt always use the original local path.
    add(localPath);
    if (!path.isAbsolute(localPath)) {
        return candidates;
    }

    const resolvedLocalPath = path.resolve(localPath);
    const relativeCandidates = roots
        .map(root => isWithinRoot(resolvedLocalPath, root))
        .filter((candidate): candidate is string => (
            typeof candidate === 'string' && componentCount(candidate) >= 2
        ))
        .sort((left, right) => (
            componentCount(left) - componentCount(right)
            || left.localeCompare(right)
        ));

    const shortestCount = relativeCandidates.length > 0
        ? componentCount(relativeCandidates[0])
        : 0;
    for (const candidate of relativeCandidates) {
        if (componentCount(candidate) === shortestCount) {
            add(candidate);
        }
    }

    const testcasesRoot = path.join(path.resolve(extensionRoot), 'testcases');
    for (const root of roots) {
        if (path.dirname(path.resolve(root)) !== testcasesRoot) {
            continue;
        }
        const relative = isWithinRoot(resolvedLocalPath, root);
        if (relative) {
            add(`${path.basename(root)}/${relative}`);
        }
    }

    for (const candidate of relativeCandidates) {
        add(candidate);
    }

    return candidates;
}
