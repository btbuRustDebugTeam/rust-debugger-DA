import { MINode } from './backend/mi_parse';

export interface RuntimeTraceErrorV1 {
    code: string;
    message: string;
    recoverable: boolean;
}

export interface RuntimeTraceEnvelopeV1<T> {
    protocol: 'ardb.async';
    schema: string;
    version: 1;
    ok: boolean;
    data: T | null;
    error: RuntimeTraceErrorV1 | null;
}

export interface RuntimeTraceCapabilitiesV1 {
    protocol: 'ardb.async';
    versions: {
        snapshot: number;
        history: number;
        execution_history?: number;
        observer_tree?: number;
    };
    deprecated_versions?: {
        history?: number;
    };
    features: string[];
    trace?: {
        enabled: boolean;
        capture_history?: boolean;
    };
    implementation?: string;
}

export interface TraceEnableOptionsV1 {
    root?: string;
    whitelist_path?: string;
    capture_history?: boolean;
}

export interface TraceStatusV1 {
    enabled: boolean;
    roots: string[];
    runtime_probe_count: number;
    run_scoped_probe_count: number;
    capture_history: boolean;
    history: {
        nodes: number;
        edges: number;
        events: number;
        cleared: boolean;
    };
}

export type AsyncPrivilegeV1 = 'user' | 'kernel' | 'transition' | 'unknown';

export interface SnapshotPollV1 {
    sequence: number;
    state: string | number | null;
    status: string;
    error: string | null;
    source: 'runtime' | 'dwarf' | 'unknown';
}

export type RelationKindV1 = 'root' | 'await' | 'call' | 'transition' | 'physical' | 'unknown';
export type RelationConfidenceV1 = 'observed' | 'structured' | 'inferred' | 'physical' | 'unknown';

export interface RelationFromParentV1 {
    kind: RelationKindV1;
    confidence: RelationConfidenceV1;
    parent_cid: number | null;
    child_cid: number | null;
    child_future_address: string | null;
    evidence: string[];
}

export interface AwaiteeCandidateV1 {
    address: string | null;
    type: string | null;
    source: string;
    confidence: string;
}

export interface SnapshotPathNodeV1 {
    node_id: string;
    cid: number | null;
    kind: string;
    function: string;
    future_address: string | null;
    future_type: string | null;
    future_type_source: 'dwarf' | 'unknown';
    poll: SnapshotPollV1;
    edge_from_parent: string | null;
    relation_from_parent?: RelationFromParentV1;
    awaitee_candidate?: AwaiteeCandidateV1;
    active: boolean;
    privilege: AsyncPrivilegeV1;
    origin: string;
    source: {
        name: string | null;
        path: string | null;
        line: number | null;
    } | null;
    physical: boolean;
}

export interface SnapshotV1 {
    session_id: string;
    generation: number;
    thread_id: number;
    empty: boolean;
    privilege: AsyncPrivilegeV1;
    transition: {
        kind: string;
        symbol: string | null;
        pc: string | null;
        path: unknown[];
    };
    async_path: SnapshotPathNodeV1[];
}

/**
 * @deprecated Legacy CID History V1 node. Current execution history is
 * provided by RuntimeEventGraph through ardb-get-history-tree.
 */
export interface HistoryNodeV1 {
    id: string;
    function: string;
    kind: string;
    active: boolean;
    currently_in_snapshot: boolean;
    poll_count: number;
    last_cid: number | null;
    privilege: AsyncPrivilegeV1;
    source?: {
        name: string | null;
        path: string | null;
        line: number | null;
    } | null;
}

/**
 * @deprecated Legacy CID History V1 edge. Current execution topology is
 * provided by RuntimeEventGraph.
 */
export interface HistoryEdgeV1 {
    id: string;
    from: string;
    to: string;
    kind: string;
    count: number;
    active: boolean;
    relation_id?: number;
    confidence?: RelationConfidenceV1;
    evidence?: string[];
    first_event_id?: number;
    last_event_id?: number;
}

/**
 * @deprecated Legacy CID History V1 payload. Use the RuntimeEventGraph
 * History/Observer custom requests for current execution history.
 */
export interface HistoryTreeV1 {
    session_id: string;
    generation: number;
    roots: string[];
    nodes: HistoryNodeV1[];
    edges: HistoryEdgeV1[];
    active: {
        root: string | null;
        path: string[];
    };
    stats: {
        nodes: number;
        edges: number;
        events: number;
        truncated: boolean;
    };
    cleared: boolean;
    validation: {
        valid: boolean;
        errors: string[];
        warnings: string[];
    };
}

export type RuntimeTraceCommandExecutor = (command: string) => Promise<MINode>;

const RELATION_KINDS: RelationKindV1[] = [
    'root', 'await', 'call', 'transition', 'physical', 'unknown',
];
const RELATION_CONFIDENCES: RelationConfidenceV1[] = [
    'observed', 'structured', 'inferred', 'physical', 'unknown',
];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableCid(value: unknown): value is number | null {
    return value === null
        || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === 'string';
}

function unknownRelation(): RelationFromParentV1 {
    return {
        kind: 'unknown',
        confidence: 'unknown',
        parent_cid: null,
        child_cid: null,
        child_future_address: null,
        evidence: [],
    };
}

function normalizeRelation(value: unknown): RelationFromParentV1 {
    if (!isRecord(value)
        || !RELATION_KINDS.includes(value.kind as RelationKindV1)
        || !RELATION_CONFIDENCES.includes(value.confidence as RelationConfidenceV1)
        || !isNullableCid(value.parent_cid)
        || !isNullableCid(value.child_cid)
        || !isNullableString(value.child_future_address)
        || !Array.isArray(value.evidence)
        || !value.evidence.every(item => typeof item === 'string')) {
        return unknownRelation();
    }

    const relation = {
        kind: value.kind as RelationKindV1,
        confidence: value.confidence as RelationConfidenceV1,
        parent_cid: value.parent_cid,
        child_cid: value.child_cid,
        child_future_address: value.child_future_address,
        evidence: [...value.evidence] as string[],
    };

    const validRoot = relation.kind === 'root'
        && relation.confidence === 'observed'
        && relation.parent_cid === null
        && relation.child_cid === null
        && relation.child_future_address === null;
    const validObservedAwait = relation.kind === 'await'
        && relation.confidence === 'observed'
        && relation.parent_cid !== null
        && relation.child_cid !== null
        && relation.child_future_address !== null;
    const validUnknown = relation.kind === 'unknown'
        && relation.confidence === 'unknown';

    return validRoot || validObservedAwait || validUnknown
        ? relation
        : unknownRelation();
}

function normalizeAwaiteeCandidate(value: unknown): AwaiteeCandidateV1 | undefined {
    if (!isRecord(value)
        || !isNullableString(value.address)
        || !isNullableString(value.type)
        || typeof value.source !== 'string'
        || typeof value.confidence !== 'string') {
        return undefined;
    }
    return {
        address: value.address,
        type: value.type,
        source: value.source,
        confidence: value.confidence,
    };
}

function normalizeSnapshotNode(value: unknown): SnapshotPathNodeV1 | undefined {
    if (!isRecord(value)
        || typeof value.node_id !== 'string'
        || !isNullableCid(value.cid)
        || typeof value.kind !== 'string'
        || typeof value.function !== 'string'
        || !isNullableString(value.future_address)
        || !isNullableString(value.future_type)
        || !isRecord(value.poll)) {
        return undefined;
    }

    const node = { ...value } as unknown as SnapshotPathNodeV1;
    node.poll = { ...value.poll } as unknown as SnapshotPollV1;
    if (Object.prototype.hasOwnProperty.call(value, 'relation_from_parent')) {
        node.relation_from_parent = normalizeRelation(value.relation_from_parent);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'awaitee_candidate')) {
        node.awaitee_candidate = normalizeAwaiteeCandidate(value.awaitee_candidate);
    }
    if (isRecord(value.source)) {
        node.source = { ...value.source } as SnapshotPathNodeV1['source'];
    }
    return node;
}

/** Normalize detached Snapshot data without inferring any relation. */
export function normalizeSnapshotDataV1(value: unknown): SnapshotV1 | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    // The pre-v1 producer exposed an empty `path`. It remains a valid empty
    // optional-async result; non-empty legacy paths are not upgraded to v1 facts.
    if (!Object.prototype.hasOwnProperty.call(value, 'async_path')) {
        if (Array.isArray(value.path) && value.path.length === 0) {
            return {
                session_id: 'legacy',
                generation: 0,
                thread_id: typeof value.thread_id === 'number' ? value.thread_id : 0,
                empty: true,
                privilege: 'unknown',
                transition: { kind: 'none', symbol: null, pc: null, path: [] },
                async_path: [],
            };
        }
        return undefined;
    }

    if (!Array.isArray(value.async_path)
        || typeof value.thread_id !== 'number'
        || typeof value.empty !== 'boolean') {
        return undefined;
    }
    const asyncPath = value.async_path.map(normalizeSnapshotNode);
    if (asyncPath.some(node => node === undefined)) {
        return undefined;
    }
    return {
        ...(value as unknown as SnapshotV1),
        transition: isRecord(value.transition)
            ? { ...value.transition } as SnapshotV1['transition']
            : value.transition as SnapshotV1['transition'],
        async_path: asyncPath as SnapshotPathNodeV1[],
    };
}

/** @deprecated Internal normalizer for the legacy CID History V1 API. */
function normalizeHistoryEdge(value: unknown): HistoryEdgeV1 | undefined {
    if (!isRecord(value)
        || typeof value.id !== 'string'
        || typeof value.from !== 'string'
        || typeof value.to !== 'string'
        || typeof value.kind !== 'string'
        || typeof value.count !== 'number'
        || typeof value.active !== 'boolean') {
        return undefined;
    }
    const edge = { ...value } as unknown as HistoryEdgeV1;
    const hasRelationFields = ['relation_id', 'confidence', 'evidence', 'first_event_id', 'last_event_id']
        .some(key => Object.prototype.hasOwnProperty.call(value, key));
    if (!hasRelationFields) {
        return edge;
    }
    const valid = typeof value.relation_id === 'number'
        && Number.isSafeInteger(value.relation_id) && value.relation_id > 0
        && value.confidence === 'observed'
        && Array.isArray(value.evidence)
        && value.evidence.every(item => typeof item === 'string')
        && typeof value.first_event_id === 'number'
        && Number.isSafeInteger(value.first_event_id) && value.first_event_id > 0
        && typeof value.last_event_id === 'number'
        && Number.isSafeInteger(value.last_event_id)
        && value.last_event_id >= value.first_event_id;
    if (valid) {
        edge.evidence = [...(value.evidence as string[])];
        return edge;
    }
    delete edge.relation_id;
    delete edge.first_event_id;
    delete edge.last_event_id;
    edge.confidence = 'unknown';
    edge.evidence = [];
    return edge;
}

/**
 * Normalize detached legacy CID History data while preserving base edge fields.
 * @deprecated Current execution history is provided by RuntimeEventGraph.
 */
export function normalizeHistoryDataV1(value: unknown): HistoryTreeV1 | undefined {
    if (!isRecord(value)
        || !Array.isArray(value.nodes)
        || !Array.isArray(value.edges)
        || !Array.isArray(value.roots)
        || !isRecord(value.active)
        || !isRecord(value.stats)
        || !isRecord(value.validation)) {
        return undefined;
    }
    const edges = value.edges.map(normalizeHistoryEdge);
    if (edges.some(edge => edge === undefined)) {
        return undefined;
    }
    return {
        ...(value as unknown as HistoryTreeV1),
        roots: [...value.roots] as string[],
        nodes: value.nodes.map(node => isRecord(node) ? { ...node } : node) as HistoryNodeV1[],
        edges: edges as HistoryEdgeV1[],
        active: { ...value.active } as HistoryTreeV1['active'],
        stats: { ...value.stats } as HistoryTreeV1['stats'],
        validation: {
            ...value.validation,
            errors: Array.isArray(value.validation.errors) ? [...value.validation.errors] : [],
            warnings: Array.isArray(value.validation.warnings) ? [...value.validation.warnings] : [],
        } as HistoryTreeV1['validation'],
    };
}

/**
 * Optional, failure-contained bridge to the versioned runtime_trace GDB commands.
 * It never owns inferior execution. Versioned commands require an envelope;
 * Snapshot also accepts the old empty `{path: []}` result fail-closed.
 */
export class RuntimeTraceBridge {
    private commandQueue: Promise<void> = Promise.resolve();

    constructor(private readonly executeCommand: RuntimeTraceCommandExecutor) {}

    async probeCapabilities(): Promise<RuntimeTraceCapabilitiesV1 | undefined> {
        const envelope = await this.executeEnvelope<RuntimeTraceCapabilitiesV1>(
            'ardb-async-capabilities',
            'capabilities',
        );
        const data = envelope?.data;
        if (!data || data.protocol !== 'ardb.async') {
            return undefined;
        }
        if (!data.versions || !Array.isArray(data.features)) {
            return undefined;
        }
        return data;
    }

    async getSnapshot(): Promise<SnapshotV1 | undefined> {
        return this.enqueueCommand(async () => {
            try {
                const record = await this.executeCommand('ardb-get-snapshot');
                const output = this.consoleOutput(record);
                const envelope = this.parseEnvelope<unknown>(output);
                if (envelope) {
                    if (envelope.schema !== 'snapshot' || !envelope.ok) {
                        return undefined;
                    }
                    return normalizeSnapshotDataV1(envelope.data);
                }

                const legacy = this.parseSingleJson(output);
                return normalizeSnapshotDataV1(legacy);
            } catch {
                return undefined;
            }
        });
    }

    async enable(options: TraceEnableOptionsV1 = {}): Promise<TraceStatusV1 | undefined> {
        return this.executeTraceStatusCommand(
            `ardb-trace-enable ${JSON.stringify(options)}`,
        );
    }

    async disable(): Promise<TraceStatusV1 | undefined> {
        return this.executeTraceStatusCommand('ardb-trace-disable');
    }

    async getStatus(): Promise<TraceStatusV1 | undefined> {
        return this.executeTraceStatusCommand('ardb-trace-status');
    }

    /**
     * @deprecated Legacy CID History V1 API. Current execution history is
     * queried through the RuntimeEventGraph ardb-get-history-tree command.
     */
    async getHistory(): Promise<HistoryTreeV1 | undefined> {
        return this.executeHistoryCommand('ardb-get-history-tree');
    }

    /**
     * @deprecated Legacy CID History V1 API. Current history clearing is
     * handled by the RuntimeEventGraph ardb-clear-history-tree command.
     */
    async clearHistory(): Promise<HistoryTreeV1 | undefined> {
        return this.executeHistoryCommand('ardb-clear-history-tree');
    }

    private async executeTraceStatusCommand(command: string): Promise<TraceStatusV1 | undefined> {
        return this.enqueueCommand(async () => {
            const envelope = await this.executeEnvelopeNow<TraceStatusV1>(command, 'trace-status');
            const data = envelope?.data;
            if (!data || typeof data.enabled !== 'boolean' || !Array.isArray(data.roots)) {
                return undefined;
            }
            if (typeof data.runtime_probe_count !== 'number'
                || typeof data.run_scoped_probe_count !== 'number'
                || typeof data.capture_history !== 'boolean'
                || !data.history) {
                return undefined;
            }
            return data;
        });
    }

    /** @deprecated Command path for the legacy CID History V1 envelope. */
    private async executeHistoryCommand(command: string): Promise<HistoryTreeV1 | undefined> {
        return this.enqueueCommand(async () => {
            const envelope = await this.executeEnvelopeNow<HistoryTreeV1>(command, 'history');
            const data = envelope?.data;
            if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
                return undefined;
            }
            if (!Array.isArray(data.roots) || !data.active || !data.stats || !data.validation) {
                return undefined;
            }
            return normalizeHistoryDataV1(data);
        });
    }

    private async executeEnvelope<T>(
        command: string,
        expectedSchema: string,
    ): Promise<RuntimeTraceEnvelopeV1<T> | undefined> {
        return this.enqueueCommand(
            () => this.executeEnvelopeNow<T>(command, expectedSchema),
        );
    }

    private async executeEnvelopeNow<T>(
        command: string,
        expectedSchema: string,
    ): Promise<RuntimeTraceEnvelopeV1<T> | undefined> {
        try {
            const record = await this.executeCommand(command);
            const output = this.consoleOutput(record);
            const envelope = this.parseEnvelope<T>(output);
            if (!envelope || envelope.schema !== expectedSchema || !envelope.ok) {
                return undefined;
            }
            return envelope;
        } catch {
            // Missing command, running inferior, MI failure, and time-of-query races
            // are all optional-async failures and must not escape into the OS debugger.
            return undefined;
        }
    }

    private enqueueCommand<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.commandQueue.then(operation);
        this.commandQueue = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    private consoleOutput(record: MINode): string {
        const buffered = (record as any)?._consoleOutput;
        if (typeof buffered === 'string' && buffered.length > 0) {
            return buffered;
        }

        return (record?.outOfBandRecord || [])
            .filter(item => item.isStream && item.type === 'console')
            .map(item => item.content || '')
            .join('');
    }

    private parseEnvelope<T>(output: string): RuntimeTraceEnvelopeV1<T> | undefined {
        const lines = output
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);

        // The frozen machine protocol is exactly one JSON line. Rejecting extra
        // output prevents diagnostics or legacy JSON from being mistaken for data.
        if (lines.length !== 1) {
            return undefined;
        }

        try {
            const value = JSON.parse(lines[0]) as Partial<RuntimeTraceEnvelopeV1<T>>;
            if (value.protocol !== 'ardb.async' || value.version !== 1) {
                return undefined;
            }
            if (typeof value.schema !== 'string' || typeof value.ok !== 'boolean') {
                return undefined;
            }
            if (!Object.prototype.hasOwnProperty.call(value, 'data')
                || !Object.prototype.hasOwnProperty.call(value, 'error')) {
                return undefined;
            }
            return value as RuntimeTraceEnvelopeV1<T>;
        } catch {
            return undefined;
        }
    }

    private parseSingleJson(output: string): unknown {
        const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (lines.length !== 1) {
            return undefined;
        }
        try {
            return JSON.parse(lines[0]);
        } catch {
            return undefined;
        }
    }
}
