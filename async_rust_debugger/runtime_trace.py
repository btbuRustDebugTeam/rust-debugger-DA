import os
import re
import struct
import gdb
import json
from datetime import datetime, timezone
# -------------------------
# Debug runtime_trace.py
# -------------------------
# import sys

# if os.environ.get("ARDB_PY_DEBUG") == "1":
#     preferred = os.environ.get("ARDB_DEBUGPY_PYTHON")

#     if preferred and os.path.exists(preferred):
#         sys.executable = preferred
#     elif (not sys.executable) or (not os.path.exists(sys.executable)) or sys.executable == "/usr/bin/python":
#         if os.path.exists("/usr/bin/python3"):
#             sys.executable = "/usr/bin/python3"

#     import debugpy
#     debugpy.listen(("127.0.0.1", 5678))
#     print(f"[runtime_trace] sys.executable = {sys.executable}")
#     print("[runtime_trace] waiting for debugger on 5678...")
#     debugpy.wait_for_client()
#     print("[runtime_trace] debugger attached.")

# -------------------------
# User-facing knobs
# -------------------------

MAX_CALLSITES_PER_FN = 1000

# True => 打印所有内部 future / poll 的实时输出（更完整，但更吵）
PRINT_INTERNAL_POLL_HITS = True

# True => 第一次进入用户可见 poll 时，打印 whitelist 地址解析统计
PRINT_WHITELIST_ADDR_STATS = True


# Regex to parse GDB's "info line" output:
# e.g. 'Line 42 of "src/main.rs" starts at address ...'
_re_info_line = re.compile(r'Line\s+(\d+)\s+of\s+"([^"]+)"')

# -------------------------
# Coroutine instance tracking (runtime)
# -------------------------
# 目标：
# - 每个 (poll_symbol, env_ptr) 视作一个“协程实例”
# - 每次 poll 打印 poll#seq（第几轮 poll）
# - 实时打印 call / awa（不做输出去重）
# - 通过栈维护缩进，让父子 future 关系可读

_CO_NEXT_ID = 1
_CO_BY_KEY = {}        # (poll_sym, this_ptr) -> coro_id
_CO_META = {}          # coro_id -> (poll_sym, this_ptr)
_CO_POLL_SEQ = {}      # coro_id -> poll_count
# Snapshot still uses this coroutine stack to reconstruct the current path.
# It is intentionally not used by the runtime History Tree.
_TLS_STACK = {}        # thread_num -> [coro_id, ...]

# Runtime History Tree: cumulative call graph for whitelist-admitted runtime
# events. Each thread owns an independent dynamic call stack; the graph itself
# merges repeated calls by function symbol and never removes historical nodes/edges.
_CALL_GRAPH_NODES = {}
_CALL_GRAPH_ROOTS = []
_STABLE_CALL_ROOTS = {}  # node key -> first entry event; never removed by edges
_CALL_GRAPH_EDGES = set()
_CALL_GRAPH_EVENTS = []
_CALL_GRAPH_NEXT_EVENT_ID = 1
_CALL_GRAPH_MAX_EVENTS = 5000
# DISPATCH HOOK SOFT DISABLED FOR GRAPH STABILITY - DO NOT REMOVE
DISPATCH_HOOK_ENABLED = False
_CALL_STACK = {}       # thread_num -> [{key, func, cid}, ...]
_RECENT_CALL_ROOT_BY_THREAD = {}  # thread_num -> {key, cid, event_id}
_RECENT_CALL_ROOT_GLOBAL = None
_RECENT_CALL_ROOT_MAX_EVENT_GAP = 64
_RECENT_CALL_PARENT_BY_THREAD = {}  # thread_num -> most recent non-root admitted function
_RECENT_CALL_PARENT_GLOBAL = None
_RECENT_CALL_PARENT_MAX_EVENT_GAP = 64
# parent poll symbol -> last observed direct child poll hit
_LAST_CHILD_HIT_BY_PARENT = {}
_LAST_CHILD_HIT_BY_CALLER_FRAME = {}
_LAST_CHILD_HIT_BY_FUNC_ADDR = {}
_LAST_CHILD_HIT_BY_STRUCTURED = {}
_CHILD_KEY_MISS_LOGGED = set()
_PRIVILEGE_STATE = "unknown"
_PRIVILEGE_TRANSITION_EVENT = "none"
_PRIVILEGE_LAST_SYMBOL = ""
_PRIVILEGE_LAST_PC = ""
_PRIVILEGE_ACTIVE_GROUP = "user"
_PRIVILEGE_BPS = {
    "user": [],
    "kernel": [],
}
_TRANSITION_PATH = []
_TRANSITION_SEQ = 0
_TRANSITION_PROBE_BPS = []
_TRANSITION_PROBE_CONFIG_NAME = ""
_TRANSITION_PROBE_CONFIG_PATH = ""
_TRANSITION_PROBE_CONFIG_COUNT = 0

_REL4_TRANSITION_PROBE_CONFIG = os.path.join(
    "testcases", "rel4-async", "transition-probe.json"
)

_TRANSITION_CANDIDATE_KEYWORDS = (
    "trap",
    "syscall",
    "user_to_kernel",
    "kernel_to_user",
    "decode_invocation",
    "decode",
    "invocation",
    "handle_syscall",
    "async_syscall",
    "async_syscall_handler",
    "switch_to_user",
    "restore",
    "entry",
    "exception",
    "interrupt",
    "ecall",
    "sret",
)

_TRANSITION_DRAFT_KEYWORD_PRIORITY = (
    "user_to_kernel",
    "kernel_to_user",
    "syscall",
    "handle_syscall",
    "decode_invocation",
    "decode",
    "invocation",
    "async_syscall",
    "async_syscall_handler",
    "trap",
    "entry",
    "restore",
    "interrupt",
    "exception",
)
_TRANSITION_DRAFT_CONFIDENCE = ("high", "medium-high")
_TRANSITION_DRAFT_MAX_PROBES = 20

def _thread_id() -> int:
    t = gdb.selected_thread()
    return t.num if t is not None else 0


def _call_graph_now():
    try:
        return datetime.now(timezone.utc).isoformat()
    except Exception:
        return ""


def _json_safe(value):
    try:
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, (list, tuple, set)):
            return [_json_safe(v) for v in value]
        if isinstance(value, dict):
            return {str(k): _json_safe(v) for k, v in value.items()}
        return str(value)
    except Exception:
        return "<unserializable>"


_DISPATCH_QUEUE_STATE_NAMES = {
    0: "queue_empty",
    1: "item_found",
    2: "decode_error",
}
_DISPATCH_BRANCH_NAMES = {
    0: "queue_empty",
    1: "Unknown",
    2: "UntypedRetype",
    3: "PageTableMap",
    4: "PageMap",
    5: "PageUnmap",
    6: "PageGetAddress",
    7: "CNode",
    8: "TCBBindNotification",
    9: "TCBUnbindNotification",
    10: "PutChar",
    11: "PutString",
    12: "PageTableUnmap",
}
_DISPATCH_RAW_LABEL_NONE = (1 << 64) - 1


def _is_async_dispatch_observe_symbol(func):
    return "ardb_async_dispatch_observe" in str(func or "")


def _dispatch_queue_state_name(value):
    return _DISPATCH_QUEUE_STATE_NAMES.get(value, f"queue_state_{value}")


def _dispatch_branch_name(value):
    return _DISPATCH_BRANCH_NAMES.get(value, f"branch_{value}")


def _read_async_dispatch_observe_args():
    """Best-effort RISC-V ABI read for ardb_async_dispatch_observe(a0..a3)."""
    fields = {
        "dispatch_observe": True,
        "dispatch_read_status": "error",
        "dispatch_read_error": "",
        "dispatch_queue_state": None,
        "dispatch_queue_state_name": "unknown",
        "dispatch_raw_label": None,
        "dispatch_branch_id": None,
        "dispatch_branch_name": "unknown",
        "dispatch_sender": None,
        # The hook currently passes the kernel handler process_id here because
        # IPCItem does not carry the original user-side sender id.
        "dispatch_sender_kind": "process_id",
    }
    try:
        arch = _arch_name_or_empty()
        if arch and "riscv" not in arch:
            fields["dispatch_read_status"] = "unsupported_arch"
            fields["dispatch_read_error"] = arch
            return fields

        values = []
        for reg in ("a0", "a1", "a2", "a3"):
            value = _normalize_addr(gdb.parse_and_eval(f"${reg}"))
            if value is None:
                raise ValueError(f"cannot normalize ${reg}")
            values.append(value)

        queue_state, raw_label, branch_id, sender = values
        fields.update({
            "dispatch_read_status": "ok",
            "dispatch_queue_state": queue_state,
            "dispatch_queue_state_name": _dispatch_queue_state_name(queue_state),
            "dispatch_raw_label": raw_label,
            "dispatch_branch_id": branch_id,
            "dispatch_branch_name": _dispatch_branch_name(branch_id),
            "dispatch_sender": sender,
        })
        return fields
    except Exception as e:
        fields["dispatch_read_error"] = _short_error(e)
        return fields


def _refresh_call_graph_display_label(key, node):
    try:
        if node.get("dispatch_observe"):
            queue_name = node.get("dispatch_queue_state_name", "unknown")
            branch_name = node.get("dispatch_branch_name", "unknown")
            raw_label = node.get("dispatch_raw_label")
            raw_text = "none" if raw_label == _DISPATCH_RAW_LABEL_NONE else str(raw_label)
            node["displayLabel"] = (
                f"{key} [dispatch={branch_name} label={raw_text} queue={queue_name}]"
            )
        else:
            latest = "yes" if node.get("active") else "no"
            node["displayLabel"] = f"{key} [calls={node.get('enter_count', 0)} active={latest}]"
    except Exception:
        pass


def _record_call_dispatch_observe(func, tid, cid, fields):
    """Attach dispatch ABI data to the graph node and append a timeline event."""
    if not DISPATCH_HOOK_ENABLED:
        return
    try:
        key = _call_graph_node_key(func)
        node = _CALL_GRAPH_NODES.get(key)
        if node:
            for field, value in fields.items():
                node[field] = _json_safe(value)
            _refresh_call_graph_display_label(key, node)
        _record_call_event(
            "call_dispatch_observe",
            thread_id=tid,
            cid=cid if cid else None,
            func=key,
            parent_func=node.get("parent_func") if node else None,
            parent_cid=node.get("parent_cid") if node else None,
            queue_state=fields.get("dispatch_queue_state"),
            queue_state_name=fields.get("dispatch_queue_state_name"),
            raw_label=fields.get("dispatch_raw_label"),
            branch_id=fields.get("dispatch_branch_id"),
            branch_name=fields.get("dispatch_branch_name"),
            sender=fields.get("dispatch_sender"),
            sender_kind=fields.get("dispatch_sender_kind"),
            read_status=fields.get("dispatch_read_status"),
            read_error=fields.get("dispatch_read_error"),
        )
    except Exception as e:
        _record_call_event(
            "call_graph_error",
            where="_record_call_dispatch_observe",
            error=_short_error(e),
        )


def _record_call_event(event, **fields):
    global _CALL_GRAPH_NEXT_EVENT_ID
    try:
        rec = {
            "event_id": _CALL_GRAPH_NEXT_EVENT_ID,
            "event": str(event),
            "timestamp": _call_graph_now(),
        }
        _CALL_GRAPH_NEXT_EVENT_ID += 1
        for k, v in fields.items():
            rec[str(k)] = _json_safe(v)
        _CALL_GRAPH_EVENTS.append(rec)
        overflow = len(_CALL_GRAPH_EVENTS) - _CALL_GRAPH_MAX_EVENTS
        if overflow > 0:
            del _CALL_GRAPH_EVENTS[:overflow]
    except Exception:
        pass


def _call_graph_node_key(func):
    try:
        value = str(func or "").strip()
        return value or "<unknown>"
    except Exception:
        return "<unknown>"


def _mark_stable_call_root(key, first_enter_event=None):
    """Remember a session entry point independently from later graph edges."""
    try:
        if key not in _CALL_GRAPH_NODES:
            return False
        node = _CALL_GRAPH_NODES[key]
        event_id = first_enter_event or node.get("first_enter_event") or _CALL_GRAPH_NEXT_EVENT_ID
        existing = _STABLE_CALL_ROOTS.get(key)
        if existing is None or event_id < existing:
            _STABLE_CALL_ROOTS[key] = event_id
        if key not in _CALL_GRAPH_ROOTS:
            _CALL_GRAPH_ROOTS.append(key)
        return True
    except Exception as e:
        _record_call_event("call_graph_error", where="_mark_stable_call_root", error=_short_error(e))
        return False


def _remember_recent_call_root(tid, key, cid=None):
    global _RECENT_CALL_ROOT_GLOBAL
    try:
        if key not in _STABLE_CALL_ROOTS or key not in _CALL_GRAPH_NODES:
            return
        record = {
            "key": key,
            "cid": cid,
            "event_id": _CALL_GRAPH_NEXT_EVENT_ID,
            "func": key,
            "thread_id": tid,
        }
        _RECENT_CALL_ROOT_BY_THREAD[tid] = record
        _RECENT_CALL_ROOT_GLOBAL = record
    except Exception as e:
        _record_call_event("call_graph_error", where="_remember_recent_call_root", error=_short_error(e))


def _remember_recent_call_parent(tid, key, cid=None):
    global _RECENT_CALL_PARENT_GLOBAL
    try:
        if key in _STABLE_CALL_ROOTS or key not in _CALL_GRAPH_NODES:
            return
        record = {
            "key": key,
            "cid": cid,
            "event_id": _CALL_GRAPH_NEXT_EVENT_ID,
            "func": key,
            "thread_id": tid,
        }
        _RECENT_CALL_PARENT_BY_THREAD[tid] = record
        _RECENT_CALL_PARENT_GLOBAL = record
    except Exception as e:
        _record_call_event("call_graph_error", where="_remember_recent_call_parent", error=_short_error(e))


def _recent_parent_candidates(tid, child_key):
    """Return ordered, validated fallback parent candidates for an empty call stack."""
    try:
        if child_key in _STABLE_CALL_ROOTS:
            return []

        candidates = []
        seen = set()

        def add_candidate(source, record, order, require_stable, max_gap):
            if not record:
                return
            key = record.get("key")
            if not key or key == child_key or key in seen:
                return
            if key not in _CALL_GRAPH_NODES:
                return
            is_stable = key in _STABLE_CALL_ROOTS
            if is_stable != require_stable:
                return
            event_id = int(record.get("event_id") or 0)
            event_gap = _CALL_GRAPH_NEXT_EVENT_ID - event_id if event_id else 0
            if event_id and event_gap > max_gap:
                return
            seen.add(key)
            candidates.append({
                "key": key,
                "cid": record.get("cid"),
                "source": source,
                "order": order,
                "func": record.get("func") or key,
                "thread_id": record.get("thread_id"),
                "event_gap": event_gap,
            })

        add_candidate(
            "recent_parent_thread",
            _RECENT_CALL_PARENT_BY_THREAD.get(tid),
            1,
            False,
            _RECENT_CALL_PARENT_MAX_EVENT_GAP,
        )
        add_candidate(
            "recent_parent_global",
            _RECENT_CALL_PARENT_GLOBAL,
            2,
            False,
            _RECENT_CALL_PARENT_MAX_EVENT_GAP,
        )

        stable_keys = [key for key in _STABLE_CALL_ROOTS if key in _CALL_GRAPH_NODES]
        if len(stable_keys) == 1:
            stable_key = stable_keys[0]
            root_thread = _RECENT_CALL_ROOT_BY_THREAD.get(tid)
            if root_thread and root_thread.get("key") != stable_key:
                root_thread = None
            root_global = _RECENT_CALL_ROOT_GLOBAL
            if root_global and root_global.get("key") != stable_key:
                root_global = None
            add_candidate(
                "recent_root_thread",
                root_thread,
                3,
                True,
                _RECENT_CALL_ROOT_MAX_EVENT_GAP,
            )
            add_candidate(
                "recent_root_global",
                root_global,
                4,
                True,
                _RECENT_CALL_ROOT_MAX_EVENT_GAP,
            )
        return candidates
    except Exception as e:
        _record_call_event("call_graph_error", where="_recent_parent_candidates", error=_short_error(e))
        return []


def _ensure_call_graph_node(func, cid=None, **meta):
    try:
        key = _call_graph_node_key(func)
        node = _CALL_GRAPH_NODES.get(key)
        if node is None:
            node = {
                "type": "async",
                "cid": cid if cid else None,
                "func": key,
                "displayLabel": key,
                "addr": meta.get("addr", ""),
                "state": meta.get("state", "N/A"),
                "origin": meta.get("origin", "runtime-call-graph"),
                "historyKind": "call-graph",
                "thread_id": meta.get("thread_id"),
                # Parent metadata is only written after an edge is accepted.
                "parent_cid": None,
                "enter_count": 0,
                "exit_count": 0,
                "active_count": 0,
                "active": False,
                "first_enter_event": None,
                "last_enter_event": None,
                "last_exit_event": None,
                "children": [],
            }
            _CALL_GRAPH_NODES[key] = node
        for field in (
            "addr", "state", "state_read_status", "state_read_error",
            "origin", "privilege", "transition_event", "thread_id",
            "depth", "depth_before", "depth_after", "parent_func",
            "matched_top", "error", "last_seen",
            "semantic_kind", "node_kind", "edge_kind",
            "admission_action", "admission_reason",
            "dispatch_observe", "dispatch_queue_state",
            "dispatch_queue_state_name", "dispatch_raw_label",
            "dispatch_branch_id", "dispatch_branch_name", "dispatch_sender",
            "dispatch_sender_kind", "dispatch_read_status",
            "dispatch_read_error",
        ):
            if field in meta:
                node[field] = _json_safe(meta.get(field))
        if cid:
            node["cid"] = cid
        _refresh_call_graph_display_label(key, node)
        return key, node
    except Exception as e:
        _record_call_event("call_graph_error", where="_ensure_call_graph_node", error=_short_error(e))
        return None, None


def _call_graph_has_path(start_key, target_key):
    try:
        if start_key == target_key:
            return True
        visited = set()
        stack = [start_key]
        while stack:
            key = stack.pop()
            if key in visited:
                continue
            visited.add(key)
            node = _CALL_GRAPH_NODES.get(key)
            children = list(node.get("children", [])) if node else []
            children.extend(child for parent, child in _CALL_GRAPH_EDGES if parent == key)
            for child_key in children:
                if child_key == target_key:
                    return True
                if child_key not in visited:
                    stack.append(child_key)
        return False
    except Exception as e:
        _record_call_event("call_graph_error", where="_call_graph_has_path", error=_short_error(e))
        return False


def _call_graph_find_parents(child_key):
    """Return every currently recorded parent for a call graph node."""
    try:
        parents = set()
        for parent_key, edge_child_key in _CALL_GRAPH_EDGES:
            if edge_child_key == child_key and parent_key in _CALL_GRAPH_NODES:
                parents.add(parent_key)
        # Keep the graph repair tolerant of a stale children list from an older
        # session or an interrupted edge update.
        for parent_key, node in _CALL_GRAPH_NODES.items():
            if child_key in node.get("children", []):
                parents.add(parent_key)
        return sorted(
            parents,
            key=lambda key: (
                _CALL_GRAPH_NODES.get(key, {}).get("first_enter_event") or 0,
                key,
            ),
        )
    except Exception as e:
        _record_call_event("call_graph_error", where="_call_graph_find_parents", error=_short_error(e))
        return []


def _call_graph_remove_edge(parent_key, child_key, reason="", **meta):
    """Remove one historical edge when a more precise parent supersedes it."""
    try:
        edge = (parent_key, child_key)
        parent = _CALL_GRAPH_NODES.get(parent_key)
        had_edge = edge in _CALL_GRAPH_EDGES
        had_child = bool(parent and child_key in parent.get("children", []))
        if not had_edge and not had_child:
            return False

        _CALL_GRAPH_EDGES.discard(edge)
        if parent:
            parent["children"] = [
                key for key in parent.get("children", []) if key != child_key
            ]

        child = _CALL_GRAPH_NODES.get(child_key)
        if child and child.get("parent_func") == parent_key and not _call_graph_find_parents(child_key):
            child["parent_func"] = None
            child["parent_cid"] = None

        _record_call_event(
            "call_edge_removed",
            reason=reason or "edge_removed",
            parent_key=parent_key,
            child_key=child_key,
            new_parent_key=meta.get("new_parent_key"),
            parent_source=meta.get("parent_source", "call_stack"),
            candidate_order=meta.get("candidate_order"),
            candidate_func=meta.get("candidate_func"),
            candidate_thread_id=meta.get("candidate_thread_id"),
            event_gap=meta.get("event_gap"),
        )
        return True
    except Exception as e:
        _record_call_event("call_graph_error", where="_call_graph_remove_edge", error=_short_error(e))
        return False


def _record_call_edge(parent_key, child_key, parent_cid=None, child_cid=None, **meta):
    try:
        if child_key not in _CALL_GRAPH_NODES:
            return "missing_child"
        if not parent_key or parent_key not in _CALL_GRAPH_NODES:
            _mark_stable_call_root(child_key)
            return "root"
        if parent_key == child_key:
            _record_call_event(
                "call_edge_skipped",
                reason="self_edge",
                parent_cid=parent_cid,
                child_cid=child_cid,
                parent_key=parent_key,
                child_key=child_key,
                parent_source=meta.get("parent_source", "call_stack"),
                candidate_order=meta.get("candidate_order"),
                candidate_func=meta.get("candidate_func", parent_key),
                candidate_thread_id=meta.get("candidate_thread_id"),
                event_gap=meta.get("event_gap"),
            )
            return "self_edge"
        if _call_graph_has_path(child_key, parent_key):
            _record_call_event(
                "call_edge_skipped",
                reason="would_form_cycle",
                parent_cid=parent_cid,
                child_cid=child_cid,
                parent_key=parent_key,
                child_key=child_key,
                parent_source=meta.get("parent_source", "call_stack"),
                candidate_order=meta.get("candidate_order"),
                candidate_func=meta.get("candidate_func", parent_key),
                candidate_thread_id=meta.get("candidate_thread_id"),
                event_gap=meta.get("event_gap"),
            )
            return "would_form_cycle"
        if child_key in _STABLE_CALL_ROOTS and parent_key not in _STABLE_CALL_ROOTS:
            child_first = _CALL_GRAPH_NODES[child_key].get("first_enter_event") or _CALL_GRAPH_NODES[child_key].get("last_enter_event") or 0
            parent_first = _CALL_GRAPH_NODES[parent_key].get("first_enter_event") or _CALL_GRAPH_NODES[parent_key].get("last_enter_event") or 0
            if child_first and parent_first and child_first <= parent_first:
                _record_call_event(
                    "call_edge_skipped",
                    reason="root_parent_protected",
                    parent_cid=parent_cid,
                    child_cid=child_cid,
                    parent_key=parent_key,
                    child_key=child_key,
                    parent_source=meta.get("parent_source", "call_stack"),
                    candidate_order=meta.get("candidate_order"),
                    candidate_func=meta.get("candidate_func", parent_key),
                    candidate_thread_id=meta.get("candidate_thread_id"),
                    event_gap=meta.get("event_gap"),
                )
                return "root_parent_protected"

        existing_parents = [
            key for key in _call_graph_find_parents(child_key) if key != parent_key
        ]
        coarse_parents = []
        for old_parent_key in existing_parents:
            if _call_graph_has_path(old_parent_key, parent_key):
                # old_parent -> ... -> parent -> child is less precise than the
                # newly observed parent -> child edge.
                coarse_parents.append(old_parent_key)
                continue
            if _call_graph_has_path(parent_key, old_parent_key):
                _record_call_event(
                    "call_edge_skipped",
                    reason="less_precise_parent_existing",
                    parent_cid=parent_cid,
                    child_cid=child_cid,
                    parent_key=parent_key,
                    child_key=child_key,
                    existing_parent_key=old_parent_key,
                    parent_source=meta.get("parent_source", "call_stack"),
                    candidate_order=meta.get("candidate_order"),
                    candidate_func=meta.get("candidate_func", parent_key),
                    candidate_thread_id=meta.get("candidate_thread_id"),
                    event_gap=meta.get("event_gap"),
                )
                return "less_precise_parent_existing"
            # A call graph node is rendered under one best-known parent. When
            # neither relation proves that the new parent is more precise,
            # retain the existing edge rather than inventing a duplicate path.
            _record_call_event(
                "call_edge_skipped",
                reason="unrelated_parent_existing",
                parent_cid=parent_cid,
                child_cid=child_cid,
                parent_key=parent_key,
                child_key=child_key,
                existing_parent_key=old_parent_key,
                parent_source=meta.get("parent_source", "call_stack"),
                candidate_order=meta.get("candidate_order"),
                candidate_func=meta.get("candidate_func", parent_key),
                candidate_thread_id=meta.get("candidate_thread_id"),
                event_gap=meta.get("event_gap"),
            )
            return "unrelated_parent_existing"

        for old_parent_key in coarse_parents:
            _call_graph_remove_edge(
                old_parent_key,
                child_key,
                reason="reparent_to_more_precise_parent",
                new_parent_key=parent_key,
                **meta,
            )

        edge = (parent_key, child_key)
        if edge not in _CALL_GRAPH_EDGES:
            _CALL_GRAPH_EDGES.add(edge)
            children = _CALL_GRAPH_NODES[parent_key].setdefault("children", [])
            if child_key not in children:
                children.append(child_key)
        if child_key not in _STABLE_CALL_ROOTS:
            child = _CALL_GRAPH_NODES[child_key]
            child["parent_cid"] = parent_cid
            child["parent_func"] = parent_key
        # Stable roots remain stable even if a later observation has a parent.
        _record_call_event(
            "call_edge_accepted",
            parent_key=parent_key,
            child_key=child_key,
            parent_cid=parent_cid,
            child_cid=child_cid,
            parent_source=meta.get("parent_source", "call_stack"),
            candidate_order=meta.get("candidate_order"),
            candidate_func=meta.get("candidate_func", parent_key),
            candidate_thread_id=meta.get("candidate_thread_id"),
            event_gap=meta.get("event_gap"),
        )
        return "accepted"
    except Exception as e:
        _record_call_event("call_graph_error", where="_record_call_edge", error=_short_error(e))
        return "error"


def _record_call_enter(func, cid=None, parent_cid=None, **meta):
    # Hard graph boundary: RuntimeEventBP supplies this admission marker only
    # after a real execution hit passes the loaded whitelist. Do not add a
    # trace-root or breakpoint bypass here.
    if (
        meta.get("admission_action") != "ALLOW"
        or meta.get("admission_reason") != "whitelist_runtime_execution_hit"
    ):
        _log_diag(
            f"[NODE_ADMISSION] action=REJECT reason=missing_runtime_whitelist_admission "
            f"symbol={func}"
        )
        return None
    try:
        tid = meta.get("thread_id")
        if tid is None:
            tid = _thread_id()
        stack = _CALL_STACK.setdefault(tid, [])
        parent_frame = stack[-1] if stack else None
        parent_key = parent_frame.get("key") if parent_frame else None
        parent_source = "call_stack" if parent_frame else "none"
        candidate_order = 0
        candidate_func = parent_key or ""
        candidate_thread_id = tid if parent_frame else None
        candidate_event_gap = 0 if parent_frame else None
        if parent_cid is None and parent_frame:
            parent_cid = parent_frame.get("cid")
        key, node = _ensure_call_graph_node(func, cid, **meta)
        if not node:
            return None
        is_first_enter = node.get("first_enter_event") is None
        node["enter_count"] = int(node.get("enter_count", 0)) + 1
        node["seenCount"] = node["enter_count"]
        node["active_count"] = int(node.get("active_count", 0)) + 1
        node["active"] = node["active_count"] > 0
        node["currentlyInLatestSnapshot"] = True
        node["last_seen"] = _call_graph_now()
        node["last_enter_event"] = _CALL_GRAPH_NEXT_EVENT_ID
        if is_first_enter:
            node["first_enter_event"] = _CALL_GRAPH_NEXT_EVENT_ID
        _refresh_call_graph_display_label(key, node)
        edge_status = None
        if parent_key:
            edge_status = _record_call_edge(
                parent_key,
                key,
                parent_cid=parent_cid,
                child_cid=cid,
                thread_id=tid,
                parent_source=parent_source,
                candidate_order=candidate_order,
                candidate_func=candidate_func,
                candidate_thread_id=candidate_thread_id,
                event_gap=candidate_event_gap,
            )
        else:
            for candidate in _recent_parent_candidates(tid, key):
                candidate_order = candidate["order"]
                candidate_func = candidate["func"]
                candidate_thread_id = candidate["thread_id"]
                candidate_event_gap = candidate["event_gap"]
                candidate_status = _record_call_edge(
                    candidate["key"],
                    key,
                    parent_cid=candidate["cid"],
                    child_cid=cid,
                    thread_id=tid,
                    parent_source=candidate["source"],
                    candidate_order=candidate_order,
                    candidate_func=candidate_func,
                    candidate_thread_id=candidate_thread_id,
                    event_gap=candidate_event_gap,
                )
                if candidate_status == "accepted":
                    parent_key = candidate["key"]
                    parent_cid = candidate["cid"]
                    parent_source = candidate["source"]
                    edge_status = candidate_status
                    break
                if candidate_status in (
                    "less_precise_parent_existing",
                    "unrelated_parent_existing",
                ):
                    # The candidate was rejected because the child already has
                    # a better parent. Retain that relationship; do not turn a
                    # known child into a new stable root merely because this
                    # empty-stack fallback was less precise.
                    parent_key = node.get("parent_func")
                    parent_cid = node.get("parent_cid")
                    parent_source = "existing_parent"
                    edge_status = candidate_status
                    break
            if edge_status not in (
                "accepted",
                "less_precise_parent_existing",
                "unrelated_parent_existing",
            ):
                parent_key = None
                parent_cid = None
                parent_source = "none"
                candidate_func = ""
                candidate_thread_id = None
                candidate_event_gap = None
                _mark_stable_call_root(key, node.get("first_enter_event"))
                edge_status = _record_call_edge(None, key, child_cid=cid, thread_id=tid)
        if edge_status == "accepted" and key not in _STABLE_CALL_ROOTS:
            node["parent_cid"] = parent_cid
            node["parent_func"] = parent_key
        event_fields = dict(meta)
        event_fields.update({
            "cid": cid,
            "parent_cid": parent_cid,
            "func": key,
            "parent_func": parent_key,
            "parent_source": parent_source,
            "candidate_order": candidate_order,
            "candidate_func": candidate_func,
            "candidate_thread_id": candidate_thread_id,
            "event_gap": candidate_event_gap,
            "edge_status": edge_status,
        })
        _record_call_event("call_enter", **event_fields)
        if key in _STABLE_CALL_ROOTS:
            _remember_recent_call_root(tid, key, cid)
        elif edge_status == "accepted":
            _remember_recent_call_parent(tid, key, cid)
        frame = {"key": key, "func": key, "cid": cid, "thread_id": tid}
        stack.append(frame)
        return frame
    except Exception as e:
        _record_call_event("call_graph_error", where="_record_call_enter", error=_short_error(e))
        return None


def _record_call_exit(func, cid=None, **meta):
    try:
        tid = meta.get("thread_id")
        if tid is None:
            tid = _thread_id()
        key = _call_graph_node_key(meta.get("call_key") or func)
        stack = _CALL_STACK.setdefault(tid, [])
        depth_before = len(stack)
        matched_top = bool(stack and stack[-1].get("key") == key)
        if matched_top:
            stack.pop()
        else:
            for index in range(len(stack) - 1, -1, -1):
                if stack[index].get("key") == key:
                    del stack[index]
                    break
        node = _CALL_GRAPH_NODES.get(key)
        if node:
            node["exit_count"] = int(node.get("exit_count", 0)) + 1
            node["active_count"] = max(0, int(node.get("active_count", 0)) - 1)
            node["active"] = node["active_count"] > 0
            node["currentlyInLatestSnapshot"] = node["active"]
            node["last_seen"] = _call_graph_now()
            node["last_exit_event"] = _CALL_GRAPH_NEXT_EVENT_ID
            _refresh_call_graph_display_label(key, node)
        event_fields = dict(meta)
        event_fields.update({
            "cid": cid,
            "func": key,
            "depth_before": depth_before,
            "depth_after": len(stack),
            "matched_top": matched_top,
        })
        _record_call_event("call_exit", **event_fields)
    except Exception as e:
        _record_call_event("call_graph_error", where="_record_call_exit", cid=cid, error=_short_error(e))


def _export_call_graph():
    try:
        exported_keys = set()

        def clone_node(key, path_seen=None):
            if path_seen is None:
                path_seen = set()
            if key in path_seen or key in exported_keys:
                return None
            src = _CALL_GRAPH_NODES.get(key)
            if not src:
                return None
            exported_keys.add(key)
            path_seen = set(path_seen)
            path_seen.add(key)
            out = {}
            for k, v in src.items():
                if k == "children":
                    continue
                out[k] = _json_safe(v)
            out["children"] = []
            for child_key in src.get("children", []):
                child = clone_node(child_key, path_seen)
                if child is not None:
                    out["children"].append(child)
            return out

        roots = []
        root_keys = [
            key for key, _event_id in sorted(
                _STABLE_CALL_ROOTS.items(), key=lambda item: item[1]
            )
            if key in _CALL_GRAPH_NODES
        ]
        if not root_keys and _CALL_GRAPH_NODES:
            root_keys = [min(
                _CALL_GRAPH_NODES.keys(),
                key=lambda k: _CALL_GRAPH_NODES[k].get("first_enter_event") or _CALL_GRAPH_NODES[k].get("last_enter_event") or 0,
            )]
            _mark_stable_call_root(root_keys[0])
        for key in root_keys:
            root = clone_node(key)
            if root is not None:
                roots.append(root)
        if not roots and _CALL_GRAPH_NODES:
            first_key = min(
                _CALL_GRAPH_NODES.keys(),
                key=lambda k: _CALL_GRAPH_NODES[k].get("first_enter_event") or _CALL_GRAPH_NODES[k].get("last_enter_event") or 0,
            )
            root = clone_node(first_key)
            if root is not None:
                roots.append(root)
                _mark_stable_call_root(first_key)
        return {
            "type": "history_tree",
            "roots": roots,
            "events_count": len(_CALL_GRAPH_EVENTS),
            "nodes_count": len(_CALL_GRAPH_NODES),
            "roots_count": len(roots),
            "stable_roots_count": len(root_keys),
            "edges_count": len(_CALL_GRAPH_EDGES),
            "graph_kind": "call_graph",
        }
    except Exception as e:
        return {
            "type": "history_tree",
            "roots": [],
            "events_count": len(_CALL_GRAPH_EVENTS),
            "nodes_count": len(_CALL_GRAPH_NODES),
            "roots_count": 0,
            "stable_roots_count": 0,
            "edges_count": len(_CALL_GRAPH_EDGES),
            "graph_kind": "call_graph",
            "error": _short_error(e),
        }


def _validate_call_graph():
    """Validate the filtered execution graph without changing runtime state.

    This intentionally only inspects the graph built from whitelist-admitted
    runtime execution hits.  Raw runtime events (including rejected and
    redirected dispatch observations) are not validation targets.
    """
    errors = []
    warnings = []

    def add_error(kind, detail):
        errors.append(f"{kind}: {detail}")

    def add_warning(kind, detail):
        warnings.append(f"{kind}: {detail}")

    try:
        nodes = _CALL_GRAPH_NODES
        node_keys = set(nodes.keys())
        # _CALL_GRAPH_EDGES is the authoritative edge registry, while each
        # node's children list is the representation exported to History Tree.
        # Validate both views without treating their normal overlap as a
        # duplicate semantic edge.
        adjacency = {key: set() for key in node_keys}
        incoming = {key: set() for key in node_keys}
        seen_registry_edges = set()

        try:
            registry_edges = list(_CALL_GRAPH_EDGES)
        except Exception as e:
            registry_edges = []
            add_error("invalid_edge_registry", _short_error(e))

        for raw_edge in registry_edges:
            try:
                parent_key, child_key = raw_edge
                edge = (parent_key, child_key)
            except Exception:
                add_error("invalid_edge", repr(raw_edge))
                continue
            if edge in seen_registry_edges:
                add_warning("duplicate_edge", f"{parent_key} -> {child_key}")
            seen_registry_edges.add(edge)
            if parent_key not in node_keys:
                add_error("missing_node_reference", f"parent {parent_key}")
            if child_key not in node_keys:
                add_error("missing_node_reference", f"child {child_key}")
            if parent_key == child_key:
                add_error("self_loop", f"{parent_key} -> {child_key}")
            if parent_key in node_keys and child_key in node_keys:
                adjacency[parent_key].add(child_key)
                incoming[child_key].add(parent_key)

        for parent_key, node in nodes.items():
            try:
                children = node.get("children", [])
                if children is None:
                    children = []
                child_items = list(children)
            except Exception as e:
                add_warning("invalid_children", f"{parent_key}: {_short_error(e)}")
                continue
            seen_children = set()
            for child_key in child_items:
                if child_key in seen_children:
                    add_warning("duplicate_edge", f"{parent_key} -> {child_key}")
                seen_children.add(child_key)
                if child_key not in node_keys:
                    add_error("missing_node_reference", f"child {child_key}")
                    continue
                if parent_key == child_key:
                    add_error("self_loop", f"{parent_key} -> {child_key}")
                adjacency[parent_key].add(child_key)
                incoming[child_key].add(parent_key)

        root_keys = set(_CALL_GRAPH_ROOTS)
        root_keys.update(_STABLE_CALL_ROOTS.keys())
        for root_key in root_keys:
            if root_key not in node_keys:
                add_error("missing_root_node", str(root_key))

        for node_key in node_keys:
            if node_key not in root_keys and not incoming[node_key]:
                add_warning("orphan_node", str(node_key))

        # A DFS colour map (0=unseen, 1=on stack, 2=done) exposes every
        # back-edge while leaving the graph entirely untouched.
        colour = {key: 0 for key in node_keys}
        reported_cycles = set()

        def visit(node_key, path):
            colour[node_key] = 1
            for child_key in adjacency.get(node_key, ()):
                if colour[child_key] == 1:
                    try:
                        start = path.index(child_key)
                        cycle = tuple(path[start:] + [child_key])
                    except ValueError:
                        cycle = (node_key, child_key)
                    if cycle not in reported_cycles:
                        reported_cycles.add(cycle)
                        add_error("cycle", " -> ".join(str(key) for key in cycle))
                elif colour[child_key] == 0:
                    visit(child_key, path + [child_key])
            colour[node_key] = 2

        for node_key in node_keys:
            if colour[node_key] == 0:
                visit(node_key, [node_key])

        for node_key, node in nodes.items():
            admission_action = node.get("admission_action")
            admission_reason = node.get("admission_reason")
            if admission_action is None:
                add_warning("missing_admission_action", str(node_key))
            elif admission_action != "ALLOW":
                add_error(
                    "invalid_admission_action",
                    f"{node_key} action={admission_action}",
                )
            if admission_reason is None:
                add_warning("missing_admission_reason", str(node_key))
            elif admission_reason != "whitelist_runtime_execution_hit":
                add_error(
                    "invalid_admission_reason",
                    f"{node_key} reason={admission_reason}",
                )

            symbol = str(node.get("func") or node_key)
            dispatch_observe = node.get("dispatch_observe")
            is_dispatch = (
                _is_async_dispatch_observe_symbol(symbol)
                or dispatch_observe is True
                or str(dispatch_observe).lower() == "true"
                or node.get("semantic_kind") == "dispatch_observation"
                or node.get("node_kind") == "dispatch_observation"
            )
            if is_dispatch:
                add_error("dispatch_node", symbol)
    except Exception as e:
        add_error("validator_failure", _short_error(e))

    result = {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "stats": {
            "nodes_count": len(_CALL_GRAPH_NODES),
            "edges_count": len(_CALL_GRAPH_EDGES),
            "roots_count": len(set(_CALL_GRAPH_ROOTS) | set(_STABLE_CALL_ROOTS)),
            "events_count": len(_CALL_GRAPH_EVENTS),
        },
    }
    _log_diag(
        f"[GRAPH_VALIDATOR] ok={str(result['ok']).lower()} "
        f"errors={len(errors)} warnings={len(warnings)}"
    )
    return result


def _clear_call_graph():
    global _CALL_GRAPH_NEXT_EVENT_ID, _RECENT_CALL_ROOT_GLOBAL, _RECENT_CALL_PARENT_GLOBAL
    try:
        _CALL_GRAPH_NODES.clear()
        _CALL_GRAPH_ROOTS.clear()
        _STABLE_CALL_ROOTS.clear()
        _CALL_GRAPH_EDGES.clear()
        _CALL_GRAPH_EVENTS.clear()
        _CALL_STACK.clear()
        _RECENT_CALL_ROOT_BY_THREAD.clear()
        _RECENT_CALL_ROOT_GLOBAL = None
        _RECENT_CALL_PARENT_BY_THREAD.clear()
        _RECENT_CALL_PARENT_GLOBAL = None
        _CALL_GRAPH_NEXT_EVENT_ID = 1
    except Exception:
        pass

def _get_or_make_coro_id(poll_sym: str, this_ptr: int):
    """
    Returns: (cid, is_new)
    """
    global _CO_NEXT_ID
    key = (poll_sym, int(this_ptr))
    cid = _CO_BY_KEY.get(key)
    if cid is None:
        cid = _CO_NEXT_ID
        _CO_NEXT_ID += 1
        _CO_BY_KEY[key] = cid
        _CO_META[cid] = key
        _CO_POLL_SEQ[cid] = 0
        return cid, True
    return cid, False


def _find_nearby_coro(poll_sym: str, this_ptr: int, max_offset: int = 128) -> int | None:
    """
    Search for an existing CID whose (poll_sym, stored_ptr) has the same
    poll_sym and a stored_ptr within ±max_offset of this_ptr.

    This handles the case where Pin/reference wrapping introduces a small
    pointer offset for the same underlying coroutine instance.

    Returns the matching CID, or None if no nearby match is found.
    """
    if not this_ptr:
        return None
    for (sym, stored_ptr), cid in _CO_BY_KEY.items():
        if sym == poll_sym and abs(int(stored_ptr) - int(this_ptr)) <= max_offset:
            return cid
    return None

def _push_coro(cid: int) -> int:
    tid = _thread_id()
    st = _TLS_STACK.setdefault(tid, [])
    st.append(cid)
    return len(st) - 1  # depth

def _current_coro():
    tid = _thread_id()
    st = _TLS_STACK.get(tid, [])
    return (st[-1], len(st) - 1) if st else (0, -1)


def _is_valid_state_value(value) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        s = value.strip()
        return s not in ("", "N/A", "unknown", "UNKNOWN", "<unknown>")
    return True


def _state_or_fallback(value, fallback):
    return value if _is_valid_state_value(value) else fallback


def _short_error(e, default: str = "") -> str:
    if e is None:
        return default
    cls = e.__class__.__name__
    mod = getattr(e.__class__, "__module__", "")
    if mod == "gdb":
        cls = f"gdb.{cls}"
    msg = str(e).strip()
    out = f"{cls}: {msg}" if msg else cls
    return out[:180]


def _state_info(state="N/A", status: str = "unsupported", error: str = ""):
    return {
        "state": state,
        "state_read_status": status,
        "state_read_error": error,
    }


def _state_fields(info):
    return {
        "state": info.get("state", "N/A"),
        "state_read_status": info.get("state_read_status", "unsupported"),
        "state_read_error": info.get("state_read_error", ""),
    }


def _child_hit_fields(match: str = "not_applicable", tid=None, parent_cid=None,
                      parent_symbol: str = "", child_symbol: str = "",
                      child_env_addr: str = ""):
    return {
        "child_hit_match": match,
        "child_hit_thread_id": tid,
        "child_hit_parent_cid": parent_cid,
        "child_hit_parent_symbol": parent_symbol or "",
        "child_hit_child_symbol": child_symbol or "",
        "child_hit_env_addr": child_env_addr or "",
    }


def _is_kernel_addr(addr) -> bool:
    a = _normalize_addr(addr)
    if a is None:
        return False
    try:
        ptr_bits = _ptr_size() * 8
    except Exception:
        ptr_bits = 64
    return a >= (1 << (ptr_bits - 1))


def _infer_privilege(addr=None, file: str = "", fullname: str = "", func: str = "") -> str:
    if addr:
        if _is_kernel_addr(addr):
            return "kernel"
        try:
            a = _normalize_addr(addr)
            if a is not None and a > 0:
                return "user"
        except Exception:
            pass

    text = " ".join(x for x in (file, fullname, func) if x).lower()
    if any(marker in text for marker in (
        "rel4_kernel/src",
        "/kernel/",
        "rustlib::",
        "trap_entry",
        "c_handle_",
        "decode_invocation",
    )):
        return "kernel"
    if any(marker in text for marker in (
        "rust-root-task-demo",
        "crates/example",
        "sel4_sys::",
        "sel4::",
    )):
        return "user"
    if _PRIVILEGE_STATE in ("user", "kernel", "transition"):
        return _PRIVILEGE_STATE
    return "unknown"


def _privilege_fields(addr=None, file: str = "", fullname: str = "", func: str = ""):
    privilege = _infer_privilege(addr, file, fullname, func)
    transition_event = "none"
    if _PRIVILEGE_TRANSITION_EVENT != "none":
        if privilege in ("kernel", "transition"):
            transition_event = _PRIVILEGE_TRANSITION_EVENT
    return {
        "privilege": privilege,
        "transition_event": transition_event,
    }


def _set_privilege_state(privilege: str, transition_event: str = "none",
                         symbol: str = "", pc=None):
    global _PRIVILEGE_STATE, _PRIVILEGE_TRANSITION_EVENT
    global _PRIVILEGE_LAST_SYMBOL, _PRIVILEGE_LAST_PC
    _PRIVILEGE_STATE = privilege if privilege in ("user", "kernel", "transition", "unknown") else "unknown"
    _PRIVILEGE_TRANSITION_EVENT = transition_event or "none"
    _PRIVILEGE_LAST_SYMBOL = symbol or ""
    if pc is None:
        _PRIVILEGE_LAST_PC = ""
    else:
        try:
            _PRIVILEGE_LAST_PC = f"{int(pc):#x}"
        except Exception:
            _PRIVILEGE_LAST_PC = str(pc)


def _set_privilege_group_enabled(group: str):
    global _PRIVILEGE_ACTIVE_GROUP
    group = (group or "").strip().lower()
    if group not in ("user", "kernel", "all", "none"):
        raise ValueError(f"unsupported privilege breakpoint group: {group}")
    _PRIVILEGE_ACTIVE_GROUP = group

    for bp_group, bps in _PRIVILEGE_BPS.items():
        enabled = group == "all" or group == bp_group
        if group == "none":
            enabled = False
        for bp in list(bps):
            try:
                if bp.is_valid():
                    bp.enabled = enabled
            except Exception:
                pass


def _register_privilege_bp(group: str, bp):
    group = (group or "").strip().lower()
    _PRIVILEGE_BPS.setdefault(group, []).append(bp)
    try:
        bp.enabled = _PRIVILEGE_ACTIVE_GROUP in ("all", group)
    except Exception:
        pass


def _clear_privilege_bps():
    for bps in _PRIVILEGE_BPS.values():
        for bp in list(bps):
            try:
                bp.delete()
            except Exception:
                pass
        bps.clear()


def _privilege_hit_label(label: str = "") -> str:
    if label:
        return label
    try:
        return _current_function_name()
    except Exception:
        return "<unknown>"


def _record_privilege_hit(group: str, label: str = ""):
    group = (group or "").strip().lower()
    symbol = _privilege_hit_label(label)
    try:
        pc = _current_pc()
    except Exception:
        pc = None

    if group == "user":
        _set_privilege_state("transition", "user_to_kernel", symbol, pc)
        _log_ard(f"[ARD][priv] user hit {symbol} pc={_PRIVILEGE_LAST_PC or 'unknown'}")
        _log_ard("[ARD][priv] transition user -> kernel")
        _set_privilege_group_enabled("kernel")
    elif group == "kernel":
        transition = _PRIVILEGE_TRANSITION_EVENT
        if transition == "none":
            transition = "user_to_kernel" if _PRIVILEGE_STATE in ("user", "transition") else "none"
        _set_privilege_state("kernel", transition, symbol, pc)
        _log_ard(f"[ARD][priv] kernel hit {symbol} pc={_PRIVILEGE_LAST_PC or 'unknown'}")
        _set_privilege_group_enabled("kernel")


def _record_async_privilege_hit(symbol: str):
    try:
        pc = _current_pc()
    except Exception:
        pc = None
    privilege = "kernel" if (pc is not None and _is_kernel_addr(pc)) else "user"
    transition = _PRIVILEGE_TRANSITION_EVENT
    if transition == "none" and privilege == "kernel" and _PRIVILEGE_STATE in ("user", "transition"):
        transition = "user_to_kernel"
    _set_privilege_state(privilege, transition, symbol, pc)
    _log_ard(f"[ARD][priv] {privilege} hit {symbol} pc={_PRIVILEGE_LAST_PC or 'unknown'}")


def _frame_source_fields():
    file = ""
    fullname = ""
    line = 0
    try:
        frame = gdb.selected_frame()
        sal = frame.find_sal()
        if sal and sal.symtab:
            file = sal.symtab.filename or ""
            try:
                fullname = sal.symtab.fullname()
            except Exception:
                fullname = file
            line = int(sal.line or 0)
    except Exception:
        pass
    return file, fullname, line


def _pc_hex(pc=None) -> str:
    if pc is None:
        try:
            pc = _current_pc()
        except Exception:
            return ""
    try:
        return f"{int(pc):#x}"
    except Exception:
        return str(pc) if pc is not None else ""


def _reset_transition_path():
    global _TRANSITION_PATH, _TRANSITION_SEQ
    _TRANSITION_PATH = []
    _TRANSITION_SEQ = 0


def _record_transition_node(node_type: str, privilege: str, label: str,
                            func: str = "", pc=None, file: str = "",
                            fullname: str = "", line=None, event: str = ""):
    global _TRANSITION_SEQ
    node_type = (node_type or "sync").strip().lower()
    privilege = (privilege or "unknown").strip().lower()
    label = (label or "").strip()
    func = (func or "").strip()
    event = (event or "").strip()

    if node_type not in ("sync", "transition", "async"):
        node_type = "sync"
    if privilege not in ("user", "kernel", "transition", "unknown"):
        privilege = "unknown"

    if not file and not fullname:
        auto_file, auto_fullname, auto_line = _frame_source_fields()
        file = auto_file
        fullname = auto_fullname
        if line in (None, "", 0, "0"):
            line = auto_line

    if not func and node_type != "transition":
        try:
            func = _current_function_name()
        except Exception:
            func = ""

    try:
        line_value = int(line) if line not in (None, "") else 0
    except Exception:
        line_value = 0

    _TRANSITION_SEQ += 1
    node = {
        "seq": _TRANSITION_SEQ,
        "type": node_type,
        "privilege": privilege,
        "label": label or event or func or node_type,
    }
    if func:
        node["func"] = func
    if event:
        node["event"] = event
    pc_text = _pc_hex(pc)
    if pc_text:
        node["pc"] = pc_text
    if file:
        node["file"] = file
    if fullname:
        node["fullname"] = fullname
    if line_value:
        node["line"] = line_value

    _TRANSITION_PATH.append(node)
    _log_ard(
        f"[ARD][transition] add seq={node['seq']} type={node_type} privilege={privilege} "
        f"label={node['label']} func={func or ''} event={event or ''} pc={pc_text or ''}"
    )
    return node


def _record_transition_event(event: str):
    event = (event or "unknown").strip()
    _set_privilege_state("transition", event)
    return _record_transition_node(
        "transition",
        "transition",
        event,
        event=event,
        pc="",
        file="",
        fullname="",
        line=0,
    )


def _get_transition_path_snapshot():
    return [dict(node) for node in _TRANSITION_PATH]


def _warn_missing_transition_probe_source(path: str):
    if path and not os.path.exists(path):
        gdb.write(f"[ARD][transition-probe] warning: source path not found: {path}\n")


def _transition_probe_project_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _resolve_transition_probe_config_path(path: str):
    raw_path = os.path.expanduser((path or "").strip())
    if not raw_path:
        raise ValueError("config path is required")

    if os.path.isabs(raw_path):
        candidates = [("absolute", raw_path)]
    else:
        candidates = [
            ("cwd", os.path.abspath(raw_path)),
            ("project-root", os.path.join(_transition_probe_project_root(), raw_path)),
        ]
        temp_dir = (os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR") or "").strip()
        if temp_dir:
            candidates.append(
                ("temp-parent", os.path.join(os.path.dirname(os.path.abspath(temp_dir)), raw_path))
            )

    seen = set()
    for source, candidate in candidates:
        candidate = os.path.abspath(candidate)
        if candidate in seen:
            continue
        seen.add(candidate)
        if os.path.isfile(candidate):
            return candidate, source

    raise ValueError(f"config file not found: {raw_path}")


def _transition_probe_env_value(spec: dict, field: str):
    env_name = str(spec.get(f"{field}_env") or "").strip()
    if env_name:
        env_value = (os.environ.get(env_name) or "").strip()
        if env_value:
            return env_value
    return spec.get(field)


def _normalize_transition_probe_spec(raw_spec: dict, index: int) -> dict:
    if not isinstance(raw_spec, dict):
        raise ValueError(f"probes[{index}] must be an object")

    spec = dict(raw_spec)
    for field in ("label", "type", "privilege", "location"):
        value = spec.get(field)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"probes[{index}].{field} must be a non-empty string")

    node_type = spec["type"].strip().lower()
    if node_type not in ("sync", "transition", "async"):
        raise ValueError(f"probes[{index}].type must be sync, transition, or async")
    privilege = spec["privilege"].strip().lower()
    if privilege not in ("user", "kernel", "transition", "unknown"):
        raise ValueError(
            f"probes[{index}].privilege must be user, kernel, transition, or unknown"
        )

    location = str(_transition_probe_env_value(spec, "location") or "").strip()
    if location and not location.startswith("*") and re.fullmatch(r"(?:0x)?[0-9a-fA-F]+", location):
        location = f"*{location}"

    fullname = str(_transition_probe_env_value(spec, "fullname") or "").strip()
    line = _transition_probe_env_value(spec, "line")
    try:
        line = int(line) if line not in (None, "") else 0
    except Exception:
        raise ValueError(f"probes[{index}].line must be an integer")

    normalized = {
        "label": spec["label"].strip(),
        "node_type": node_type,
        "privilege": privilege,
        "location": location,
        "event": str(spec.get("event") or "").strip(),
        "func": str(spec.get("func") or "").strip(),
        "file": str(spec.get("file") or "").strip(),
        "fullname": fullname,
        "line": line,
        "message": str(spec.get("message") or "").strip(),
        "event_message": str(spec.get("event_message") or "").strip(),
    }
    if not normalized["location"]:
        raise ValueError(f"probes[{index}].location resolved to an empty string")
    return normalized


def _load_transition_probe_config(path: str):
    resolved_path, resolution_source = _resolve_transition_probe_config_path(path)
    try:
        with open(resolved_path, "r", encoding="utf-8") as f:
            config = json.load(f)
    except Exception as e:
        raise ValueError(f"failed to read config {resolved_path}: {_short_error(e)}")

    if not isinstance(config, dict):
        raise ValueError("transition probe config must be a JSON object")
    probes = config.get("probes")
    if not isinstance(probes, list) or not probes:
        raise ValueError("transition probe config field 'probes' must be a non-empty array")

    name = str(config.get("name") or os.path.splitext(os.path.basename(resolved_path))[0]).strip()
    specs = [_normalize_transition_probe_spec(spec, index) for index, spec in enumerate(probes)]
    return name, resolved_path, resolution_source, specs


def _set_privilege_for_transition_probe_spec(spec: dict):
    privilege = (spec.get("privilege") or "unknown").strip().lower()
    label = spec.get("label") or spec.get("func") or ""
    try:
        pc = _current_pc()
    except Exception:
        pc = None
    if privilege == "user":
        _set_privilege_state("user", "none", label, pc)
    elif privilege == "kernel":
        transition = _PRIVILEGE_TRANSITION_EVENT
        if transition == "none":
            transition = "user_to_kernel" if _PRIVILEGE_STATE in ("user", "transition") else "none"
        _set_privilege_state("kernel", transition, label, pc)


def _delete_transition_probe_bps():
    for bp in list(_TRANSITION_PROBE_BPS):
        try:
            bp.delete()
        except Exception:
            pass
        try:
            _CREATED_BPS.remove(bp)
        except ValueError:
            pass
        try:
            _RUN_SCOPED_BPS.remove(bp)
        except ValueError:
            pass
    _TRANSITION_PROBE_BPS.clear()


def _clear_transition_probe_metadata():
    global _TRANSITION_PROBE_CONFIG_NAME
    global _TRANSITION_PROBE_CONFIG_PATH
    global _TRANSITION_PROBE_CONFIG_COUNT
    _TRANSITION_PROBE_CONFIG_NAME = ""
    _TRANSITION_PROBE_CONFIG_PATH = ""
    _TRANSITION_PROBE_CONFIG_COUNT = 0


def _child_hit_key(tid, parent_cid, parent_sym: str, child_sym: str, child_addr: str):
    return (
        tid if tid is not None else "unknown",
        parent_cid if parent_cid is not None else "unknown",
        parent_sym or "",
        child_sym or "",
        child_addr or "",
    )


def _record_structured_child_hit(tid, parent_cid, parent_sym: str, parent_addr: str,
                                 child_sym: str, child_addr: str, hit: dict):
    rec = dict(hit)
    rec.update({
        "thread_id": tid,
        "parent_cid": parent_cid,
        "parent_symbol": parent_sym or "",
        "parent_addr": parent_addr or "",
        "child_symbol": child_sym or hit.get("func", ""),
        "child_env_addr": child_addr or hit.get("addr", ""),
    })
    key = _child_hit_key(tid, parent_cid, parent_sym, child_sym, child_addr)
    _LAST_CHILD_HIT_BY_STRUCTURED[key] = rec


def _find_structured_child_hit(tid, parent_cid, parent_sym: str,
                               child_sym: str, child_addr: str):
    key = _child_hit_key(tid, parent_cid, parent_sym, child_sym, child_addr)
    hit = _LAST_CHILD_HIT_BY_STRUCTURED.get(key)
    if hit:
        return hit

    # If the inferred child address is unavailable, still prefer a hit that
    # agrees on thread, parent CID/symbol, and child symbol.
    for (k_tid, k_parent_cid, k_parent_sym, k_child_sym, _k_child_addr), rec in _LAST_CHILD_HIT_BY_STRUCTURED.items():
        if k_tid != (tid if tid is not None else "unknown"):
            continue
        if parent_cid is not None and k_parent_cid != parent_cid:
            continue
        if parent_sym and k_parent_sym != parent_sym:
            continue
        if k_child_sym == child_sym:
            return rec
    return None


def _find_coro_id_for_symbol_addr(sym: str, addr: str):
    if not sym or not addr:
        return None
    for (poll_sym, this_ptr), cid in _CO_BY_KEY.items():
        if poll_sym != sym:
            continue
        try:
            if hex(int(this_ptr)) == addr:
                return cid
        except Exception:
            pass
    return None


def _merge_state_info_from_observed(base_info: dict, observed: dict) -> dict:
    state = observed.get("state")
    if _is_valid_state_value(state):
        return _state_info(
            state,
            observed.get("state_read_status", "ok"),
            observed.get("state_read_error", ""),
        )
    return base_info

class _TraceReturnBP(gdb.FinishBreakpoint):
    """Record an admitted runtime call exit, then clean up the snapshot stack."""
    def __init__(self, tid: int, cid: int, func: str):
        super().__init__(gdb.selected_frame(), internal=True)
        self.silent = True
        self.tid = tid
        self.cid = cid
        self.func = func
        _RUN_SCOPED_BPS.append(self)

    def stop(self):
        try:
            _record_call_exit(
                self.func,
                self.cid if self.cid else None,
                thread_id=self.tid,
            )

            # _TLS_STACK remains a snapshot-only current-path aid. It is not
            # used to determine call graph parents or edges.
            if not self.cid:
                return False
            st = _TLS_STACK.get(self.tid, [])
            if not st:
                return False

            if st[-1] == self.cid:
                st.pop()
            else:
                # Best-effort snapshot cleanup when GDB returns out of order.
                for i in range(len(st) - 1, -1, -1):
                    if st[i] == self.cid:
                        del st[i]
                        break
        except Exception as e:
            _record_call_event(
                "call_exit_error",
                thread_id=self.tid,
                cid=self.cid,
                func=self.func,
                error=_short_error(e),
            )
        return False


# -------------------------
# State (breakpoints / whitelist)
# -------------------------

_CREATED_BPS = []
_RUN_SCOPED_BPS = []
_RUNTIME_EVENT_BPS = []  # Whitelist-installed runtime event instrumentation only.

_CALLSITE_INSTALLED_FOR_FN = set()   # per-run: avoid re-installing callsite BPs
_ACTIVE_RUNTIME_EVENT_SYMBOLS = set()  # Symbols with RuntimeEventBP instrumentation.
ACTIVE_TRACE_ROOT = None               # Single user-selected observation/view root.

# whitelist: exact + prefix(*)
_WHITELIST_EXACT = None   # set[str] | None
_WHITELIST_PREFIX = None  # list[str] | None
_WHITELIST_PATH = None

# addr map only for exact symbols (PIE/ASLR-safe per-run)
_WHITELIST_ADDR_MAP = {}             # addr -> exact symbol
_WHITELIST_ADDR_READY = False

# Async symbol set from grouped whitelist (symbols classified as "async")
_ASYNC_SYMBOL_SET = None   # set[str] | None

_EVENTS_INSTALLED = False


# -------------------------
# Low-level helpers
# -------------------------

CALL_MNEMONIC_RE = re.compile(r"^\s*(call\w*|bl|blx|jal|jalr|c\.jal|c\.jalr|c\.jr|c\.j)\b", re.IGNORECASE)
HEX_ADDR_RE = re.compile(r"(0x[0-9a-fA-F]+)")
RISCV_CALL_MNEMONIC_RE = re.compile(r"^\s*(call|jal|jalr|c\.jal|c\.jalr|c\.jr|c\.j)\b", re.IGNORECASE)

def _ptr_size() -> int:
    try:
        return gdb.lookup_type("char").pointer().sizeof
    except gdb.error:
        try:
            return gdb.lookup_type("unsigned char").pointer().sizeof
        except gdb.error:
            return 8

def _read_ptr(addr: int) -> int:
    inf = gdb.selected_inferior()
    ps = _ptr_size()
    mem = inf.read_memory(addr, ps).tobytes()
    if ps == 8:
        return struct.unpack("<Q", mem)[0]
    return struct.unpack("<I", mem)[0]

def _reg_u64(name: str) -> int:
    addr = _normalize_addr(gdb.parse_and_eval(f"${name}"))
    if addr is None:
        raise ValueError(f"cannot normalize register ${name}")
    return addr

def _first_arg_reg() -> str:
    """
    Return the architecture-appropriate register name for the first argument.
    x86_64 SysV -> rdi
    ARM/Thumb (AAPCS) -> r0
    AArch64 (AAPCS64) -> x0
    RISC-V -> a0
    """
    try:
        arch_name = gdb.selected_frame().architecture().name().lower()
    except Exception:
        arch_name = ""

    if "aarch64" in arch_name:
        return "x0"

    if "riscv" in arch_name:
        return "a0"

    if "arm" in arch_name or "thumb" in arch_name:
        return "r0"

    return "rdi"


def _arch_name_or_empty() -> str:
    try:
        return gdb.selected_frame().architecture().name().lower()
    except Exception:
        return ""


def _riscv_arch_or_unknown() -> bool:
    arch = _arch_name_or_empty()
    return (not arch) or ("riscv" in arch)


def _current_pc() -> int:
    return int(gdb.parse_and_eval("$pc"))

def _current_function_name() -> str:
    f = gdb.selected_frame()
    return f.name() or "<unknown>"

def _normalize_addr(addr):
    try:
        a = int(addr)
    except Exception:
        try:
            a = int(str(addr), 0)
        except Exception:
            return None

    try:
        ptr_bits = _ptr_size() * 8
        mask = (1 << ptr_bits) - 1
        a &= mask
    except Exception:
        pass

    return a

def _info_symbol_raw(addr):
    a = _normalize_addr(addr)
    if a is None:
        return ""
    try:
        return gdb.execute(f"info symbol 0x{a:x}", to_string=True).strip()
    except gdb.error:
        return ""

def _info_symbol_name(addr: int) -> str:
    s = _info_symbol_raw(addr)
    s = s.split(" in section")[0].strip()
    s = s.split(" + ")[0].strip()
    return s

def _find_pc_function_name(addr: int) -> str | None:
    try:
        sym = gdb.find_pc_function(addr)
        if sym is None:
            return None
        n = getattr(sym, "print_name", None)
        if n:
            return str(n)
        n2 = getattr(sym, "name", None)
        if n2:
            return str(n2)
        return str(sym)
    except Exception:
        return None

def _parse_info_symbol_range(addr: int, window: int = 0x200):
    raw = _info_symbol_raw(addr)
    if not raw or raw.startswith("No symbol matches"):
        return (addr, addr + window, None)

    head = raw.split(" in section", 1)[0].strip()
    name = head
    offset = 0
    m = re.match(r"^(.*) \+ (0x[0-9a-fA-F]+|[0-9]+)$", head)
    if m:
        name = m.group(1).strip()
        off_s = m.group(2)
        try:
            offset = int(off_s, 0)
        except Exception:
            offset = 0

    start = max(0, addr - offset)
    if name:
        for resolver in (_try_addr_by_lookup_global_symbol, _try_addr_by_info_address):
            try:
                resolved = resolver(name)
            except Exception:
                resolved = None
            if resolved is not None and resolved <= addr:
                start = int(resolved)
                break
    end = start + window
    return (start, end, name or None)

def _function_range(frame=None) -> tuple[int, int, str | None, bool] | None:
    frame = frame or gdb.selected_frame()
    try:
        blk = frame.block()
        while blk is not None and blk.function is None:
            blk = blk.superblock
        if blk is not None and blk.start is not None and blk.end is not None:
            name = None
            try:
                name = str(blk.function.print_name) if blk.function is not None else None
            except Exception:
                name = None
            return (int(blk.start), int(blk.end), name, False)
    except (gdb.error, RuntimeError, Exception) as e:
        block_error = e
    else:
        block_error = None

    try:
        pc = int(frame.pc())
    except Exception:
        try:
            pc = _current_pc()
        except Exception:
            _log_ard("[ARD] warning: cannot get function range: no debug block and no pc")
            return None

    start, end, name = _parse_info_symbol_range(pc)
    if name:
        _log_ard(f"[ARD] warning: no debug block for {name}; using fallback range {start:#x}..{end:#x}")
    else:
        _log_ard(f"[ARD] warning: no debug block near pc={pc:#x}; using fallback range {start:#x}..{end:#x}")
    if block_error is not None:
        _log_ard(f"[ARD] warning: frame.block unavailable: {block_error}")
    return (start, end, name, True)

def _collect_call_sites() -> list[int]:
    r = _function_range()
    if r is None:
        _log_ard("[ARD] warning: cannot get function range; skipping call-site scan")
        return []
    start, end, name, degraded = r
    if degraded:
        label = name or f"{start:#x}"
        _log_ard(f"[ARD] warning: skipping call-site scan for no-debug-block function {label}")
        return []
    arch = gdb.selected_frame().architecture()
    insns = arch.disassemble(start, end)

    out = []
    seen = set()
    for ins in insns:
        asm = ins.get("asm", "").strip()
        if CALL_MNEMONIC_RE.match(asm):
            _log_ard(f"[ARD] call-detect insn: {asm}")
            a = _normalize_addr(ins["addr"])
            if a is None:
                continue
            if a not in seen:
                out.append(a)
                seen.add(a)

    return out[:MAX_CALLSITES_PER_FN]

def _current_asm() -> str:
    pc = _current_pc()
    arch = gdb.selected_frame().architecture()
    insns = arch.disassemble(pc, pc + 16)
    for ins in insns:
        if int(ins["addr"]) == pc:
            return ins.get("asm", "")
    return gdb.execute("x/i $pc", to_string=True).strip()


def _asm_instruction_text(asm: str) -> str:
    s = (asm or "").strip()
    s = re.sub(r"^=>\s*", "", s)
    m = re.match(r"^0x[0-9a-fA-F]+(?:\s+<[^>]*>)?:\s*(.*)$", s)
    if m:
        s = m.group(1).strip()
    if "\t" in s:
        parts = [p.strip() for p in s.split("\t") if p.strip()]
        for part in reversed(parts):
            if RISCV_CALL_MNEMONIC_RE.match(part):
                return part
        s = parts[-1] if parts else s
    s = re.sub(r"^(?:[0-9a-fA-F]{2}\s+)+", "", s).strip()
    return s


def _resolve_riscv_call_target_from_asm(asm: str) -> int | None:
    s = _asm_instruction_text(asm)
    m = RISCV_CALL_MNEMONIC_RE.match(s)
    if not m:
        return None

    mnemonic = m.group(1).lower()
    if mnemonic == "call" and not _riscv_arch_or_unknown():
        return None

    body, _sep, comment = s.partition("#")
    comment_target = HEX_ADDR_RE.search(comment)

    if mnemonic in ("jalr", "c.jr", "c.jalr"):
        if comment_target:
            target = int(comment_target.group(1), 16)
            _log_ard(f"[ARD] riscv-call-comment-target pc={_current_pc():#x} asm={s} target={target:#x}")
            return target
        _log_ard(f"[ARD] riscv-call-indirect-unresolved pc={_current_pc():#x} asm={s} reason=no static target")
        return None

    if mnemonic == "call" and ("*" in body or "(%" in body):
        return None

    target_m = HEX_ADDR_RE.search(body)
    if not target_m:
        return None

    target = int(target_m.group(1), 16)
    _log_ard(f"[ARD] riscv-call-direct pc={_current_pc():#x} asm={s} target={target:#x}")
    return target


def _resolve_call_target_from_asm(asm: str) -> int | None:
    s = asm.strip()
    target = _resolve_riscv_call_target_from_asm(s)
    if target is not None:
        return target

    # ARM/Thumb: bl/blx immediate
    m = re.search(r"\bblx?\s+0x([0-9a-fA-F]+)", s)
    if m:
        try:
            return int(m.group(1), 16)
        except Exception:
            return None
        
    # direct call (has immediate 0xADDR)
    if "call" in s and "0x" in s and "*0x" not in s:
        m = HEX_ADDR_RE.search(s)
        if m:
            return int(m.group(1), 16)

    # call *%reg
    m = re.search(r"call\w*\s+\*\%([a-z0-9]+)\b", s)
    if m:
        return _reg_u64(m.group(1))

    # call *disp(%rip)  (x86_64: ff 15 disp32 ; instruction length is 6 bytes)
    m = re.search(r"call\w*\s+\*([\-0-9a-fx]+)\(\%rip\)", s)
    if m:
        disp_s = m.group(1)
        disp = int(disp_s, 16) if disp_s.startswith(("0x", "-0x")) else int(disp_s, 10)
        pc = _current_pc()
        slot = pc + 6 + disp  # RIP-relative base = next instruction
        return _read_ptr(slot)

    # call *disp(%reg)
    m = re.search(r"call\w*\s+\*([\-0-9a-fx]+)\(\%([a-z0-9]+)\)", s)
    if m:
        disp_s, base = m.group(1), m.group(2)
        disp = int(disp_s, 16) if disp_s.startswith(("0x", "-0x")) else int(disp_s, 10)
        slot = _reg_u64(base) + disp
        return _read_ptr(slot)

    return None


# -------------------------
# __awaitee extraction (best-effort)
# -------------------------

def _pollsym_to_envtype(poll_sym: str) -> str | None:
    """
    Map a poll symbol to the concrete async env type name.

    Important rule:
    - If the symbol names an async block poll like
      foo::{async_fn#0}::{async_block#0},
      the env type is foo::{async_fn#0}::{async_block_env#0}
      (only replace the async_block part).
    - Otherwise, for a plain async function poll like
      foo::{async_fn#0},
      the env type is foo::{async_fn_env#0}.
    """
    if "{async_block#" in poll_sym:
        return poll_sym.replace("{async_block#", "{async_block_env#")

    if "{async_fn#" in poll_sym:
        return poll_sym.replace("{async_fn#", "{async_fn_env#")

    return None

def _read_state_with_status(poll_sym: str, this_ptr: int):
    """
    Read the state discriminant from an async env struct.

    Returns a dict with state, state_read_status, and state_read_error.
    """
    if not this_ptr:
        return _state_info("N/A", "unsupported", "missing future pointer")

    env_type_name = _pollsym_to_envtype(poll_sym)
    if not env_type_name:
        return _state_info("N/A", "unsupported", "unsupported poll symbol")

    try:
        env_t = gdb.lookup_type(env_type_name)
        env_val = gdb.Value(this_ptr).cast(env_t.pointer()).dereference()
    except gdb.error as e:
        return _state_info("N/A", "error", _short_error(e))
    except Exception as e:
        return _state_info("N/A", "error", _short_error(e))

    # Primary: try the well-known __state field.
    try:
        state = int(env_val["__state"])
        return _state_info(state, "ok", "")
    except Exception as e:
        state_field_error = e

    # Fallback: read the first field as discriminant.
    try:
        fields = env_t.fields()
        if fields:
            first_name = fields[0].name
            if not first_name:
                return _state_info("N/A", "not_found", "missing discriminant field")
            first_val = env_val[first_name]
            first_code = first_val.type.strip_typedefs().code
            if first_code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_BOOL,
                              gdb.TYPE_CODE_ENUM):
                return _state_info(int(first_val), "ok", "")
    except gdb.error as e:
        return _state_info("N/A", "error", _short_error(e))
    except Exception as e:
        return _state_info("N/A", "error", _short_error(e))

    err = _short_error(state_field_error, "missing discriminant field")
    if "optimized out" in err.lower():
        return _state_info("N/A", "not_found", err)
    return _state_info("N/A", "not_found", "missing discriminant field")


def _read_env_state(poll_sym: str, this_ptr: int):
    return _read_state_with_status(poll_sym, this_ptr)["state"]


def _read_state_from_value_with_status(env_val):
    """
    Read the state discriminant directly from a GDB value that already
    represents an async env object.

    Returns a dict with state, state_read_status, and state_read_error.
    """
    try:
        return _state_info(int(env_val["__state"]), "ok", "")
    except Exception as e:
        state_field_error = e

    try:
        env_t = env_val.type.strip_typedefs()
        fields = env_t.fields()
        if fields:
            first_name = fields[0].name
            if not first_name:
                return _state_info("N/A", "not_found", "missing discriminant field")
            first_val = env_val[first_name]
            first_code = first_val.type.strip_typedefs().code
            if first_code in (gdb.TYPE_CODE_INT, gdb.TYPE_CODE_BOOL, gdb.TYPE_CODE_ENUM):
                return _state_info(int(first_val), "ok", "")
    except gdb.error as e:
        return _state_info("N/A", "error", _short_error(e))
    except Exception as e:
        return _state_info("N/A", "error", _short_error(e))

    err = _short_error(state_field_error, "missing discriminant field")
    if "optimized out" in err.lower():
        return _state_info("N/A", "not_found", err)
    return _state_info("N/A", "not_found", "missing discriminant field")


def _read_env_state_from_value(env_val):
    return _read_state_from_value_with_status(env_val)["state"]

def _try_read_env_value_from_frame(frame: gdb.Frame, poll_sym: str):
    """
    Best-effort: for inlined async frames, try to read the hidden __awaitee
    variable from the current block or its superblock.

    Returns:
      - a gdb.Value representing the async env object
      - None if unavailable
    """
    try:
        block = frame.block()
    except Exception:
        return None

    candidates = []
    b = block
    steps = 0
    while b is not None and steps < 3:
        candidates.append(b)
        b = b.superblock
        steps += 1

    for b in candidates:
        try:
            v = frame.read_var("__awaitee", b)
        except Exception:
            continue

        try:
            ty_name = str(v.type.strip_typedefs())
        except Exception:
            ty_name = str(v.type)

        # Prefer an env object that matches the target poll symbol's env type
        env_type_name = _pollsym_to_envtype(poll_sym)
        if env_type_name and env_type_name in ty_name:
            return v

        # Also accept direct async env-looking types
        if "{async_fn_env#" in ty_name or "{async_block_env#" in ty_name:
            return v

    return None

def _try_read_local_awaitee_value(frame: gdb.Frame):
    """
    Read the current block's __awaitee, which usually represents the
    inner future being awaited by the current async frame.
    """
    try:
        block = frame.block()
    except Exception:
        return None

    try:
        return frame.read_var("__awaitee", block)
    except Exception:
        return None


def _value_type_name(val) -> str:
    try:
        return str(val.type.strip_typedefs())
    except Exception:
        try:
            return str(val.type)
        except Exception:
            return "UNKNOWN"


def _value_state_name(val):
    """
    Best-effort semantic state extraction from a GDB value string.
    Examples:
      Type::Unresumed -> Unresumed
      YieldCpu {polled: <optimized out>} -> YieldCpu
    """
    try:
        s = str(val).strip()
        if not s:
            return "N/A"

        if "{" in s:
            return s.split("{", 1)[0].strip()

        if "::" in s:
            return s.split("::")[-1].strip()

        return s
    except Exception:
        return "N/A"
    
def _try_read_awaitee_from_current_poll(poll_sym: str):
    env_type_name = _pollsym_to_envtype(poll_sym)
    if not env_type_name:
        return None

    try:
        env_t = gdb.lookup_type(env_type_name)
    except gdb.error:
        return None

    # x86_64 SysV: rdi = env ptr
    try:
        env_ptr = _reg_u64(_first_arg_reg())
    except Exception:
        return None

    if env_ptr == 0:
        return None

    try:
        env_val = gdb.Value(env_ptr).cast(env_t.pointer()).dereference()
        state = int(env_val["__state"])
    except gdb.error:
        return None

    variant_map = {}
    for f in env_t.fields():
        if f.name is not None and re.fullmatch(r"\d+", str(f.name)):
            variant_map[int(f.name)] = f.type

    vt = variant_map.get(state)
    if vt is None:
        return None

    try:
        payload = env_val.address.cast(vt.pointer()).dereference()
        awaitee = payload["__awaitee"]
        return (str(awaitee.type), str(awaitee))
    except gdb.error:
        return None
def _extract_angle_inner_types(s: str) -> list[str]:
    out = []
    depth = 0
    cur = []
    for ch in s:
        if ch == '<':
            depth += 1
            if depth == 1:
                cur = []
                continue
        elif ch == '>':
            if depth == 1:
                inner = ''.join(cur).strip()
                if inner:
                    parts = [p.strip() for p in inner.split(',') if p.strip()]
                    out.extend(parts)
                cur = []
            depth = max(0, depth - 1)
            continue

        if depth >= 1:
            cur.append(ch)
    return out

def _symbol_query_tokens(ty: str) -> list[str]:
    ty = (ty or "").strip()
    if not ty:
        return []

    toks = [ty]

    base = ty.split("::")[-1].strip()
    if base and base not in toks:
        toks.append(base)

    for part in re.split(r"::|<|>|,|\s+", ty):
        part = part.strip()
        if len(part) >= 4 and part not in toks:
            toks.append(part)

    return toks

def _future_type_to_poll_symbol(future_ty: str) -> str | None:
    """
    Best-effort mapping:
      my_crate::FutureType
        -> <my_crate::FutureType as core::future::future::Future>::poll

    Strategy:
      1) Query by full type name, base name, and split tokens
      2) Accept lines containing both Future and poll
      3) Prefer exact matches containing the full future type
    """
    future_ty = (future_ty or "").strip()
    if not future_ty:
        return None

    tokens = _symbol_query_tokens(future_ty)
    base = future_ty.split("::")[-1].strip()

    all_matches = []

    for q in tokens:
        try:
            txt = gdb.execute(f"info functions {q}", to_string=True)
        except Exception:
            continue

        for line in txt.splitlines():
            s = line.strip()
            if not s:
                continue
            if "Future" not in s or "poll" not in s:
                continue

            score = 0
            if future_ty in s:
                score += 100
            if f"<{future_ty} as " in s:
                score += 100
            if base and base in s:
                score += 20
            if "::poll" in s:
                score += 20

            all_matches.append((score, s))

    if not all_matches:
        _log_ard(f"[ARD] future->poll miss: {future_ty}")
        return None

    all_matches.sort(key=lambda x: x[0], reverse=True)
    best = all_matches[0][1]
    _log_ard(f"[ARD] future->poll hit: {future_ty} -> {best}")
    return best
def _base_type_name(ty: str) -> str:
    ty = (ty or "").strip()
    if not ty:
        return ""
    return ty.split("::")[-1].strip()


def _infer_child_poll_from_current_frame(awaitee_ty: str) -> str | None:
    """
    Infer the awaited child's poll symbol by scanning the current frame's
    callsites and looking for a poll callee whose symbol mentions the awaitee type.
    This is more reliable than `info functions <type>` for Rust demangled names.
    """
    awaitee_ty = (awaitee_ty or "").strip()
    if not awaitee_ty:
        return None

    base = _base_type_name(awaitee_ty)

    try:
        r = _function_range()
        if r is None:
            return None
        start, end, _name, degraded = r
        if degraded:
            return None
        arch = gdb.selected_frame().architecture()
        insns = arch.disassemble(start, end)
    except Exception:
        return None

    candidates = []

    for ins in insns:
        asm = ins.get("asm", "").strip()
        if not CALL_MNEMONIC_RE.match(asm):
            continue

        target = _resolve_call_target_from_asm(asm)
        if not target:
            continue

        for callee in _callee_candidates(target):
            if "poll" not in callee or "Future" not in callee:
                continue

            score = 0
            if awaitee_ty in callee:
                score += 100
            if base and base in callee:
                score += 40
            if "::poll" in callee:
                score += 20

            candidates.append((score, callee))

    if not candidates:
        return None

    candidates.sort(key=lambda x: x[0], reverse=True)
    return candidates[0][1]

def _child_poll_symbol_from_awaitee_type(awaitee_ty: str) -> str | None:
    awaitee_ty = (awaitee_ty or "").strip()
    if not awaitee_ty:
        return None

    if "{async_fn_env#" in awaitee_ty:
        return awaitee_ty.replace("{async_fn_env#", "{async_fn#")

    if "{async_block_env#" in awaitee_ty:
        return awaitee_ty.replace("{async_block_env#", "{async_block#")

    # Prefer direct inference from current frame's callsites
    poll_sym = _infer_child_poll_from_current_frame(awaitee_ty)
    if poll_sym:
        _log_ard(f"[ARD] future->poll via-callsites: {awaitee_ty} -> {poll_sym}")
        return poll_sym

    # Fallback to the old info-functions strategy
    poll_sym = _future_type_to_poll_symbol(awaitee_ty)
    if poll_sym:
        return poll_sym

    return None


# -------------------------
# Whitelist (PIE/ASLR-safe via per-run addr map)
# -------------------------

def _default_whitelist_path() -> str | None:
    cwd = os.getcwd()
    temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
    if not temp_dir:
        return None
    return os.path.join(cwd, temp_dir, "poll_functions.txt")

def _load_whitelist_file(path: str):
    """
    Supports:
      - exact:  minimal::sync_a
      - prefix: minimal::block_on*   (matches any symbol starting with that prefix)
    Also supports existing "idx sym" format.
    Returns: (exact_set, prefix_list)
    """
    exact: set[str] = set()
    prefix: list[str] = []
    with open(path, "r", encoding="utf-8") as fp:
        for raw in fp:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            # The optional numeric index occupies only the first field. Keep
            # the remainder intact because Rust generic symbols contain spaces.
            parts = line.split(maxsplit=1)
            sym = parts[1] if (len(parts) >= 2 and parts[0].isdigit()) else line

            if sym.endswith("*"):
                prefix.append(sym[:-1])
            else:
                exact.add(sym)

    return exact, prefix

def _invalidate_whitelist_addrs():
    global _WHITELIST_ADDR_MAP, _WHITELIST_ADDR_READY
    _WHITELIST_ADDR_MAP = {}
    _WHITELIST_ADDR_READY = False

def _try_addr_by_lookup_global_symbol(name: str) -> int | None:
    try:
        sym = gdb.lookup_global_symbol(name)
        if sym is None:
            return None
        v = sym.value()
        voidp = gdb.lookup_type("char").pointer()
        return int(v.cast(voidp))
    except Exception:
        return None

def _try_addr_by_info_address(name: str) -> int | None:
    for expr in (name, f"'{name}'"):
        try:
            out = gdb.execute(f"info address {expr}", to_string=True)
        except gdb.error:
            continue
        m = HEX_ADDR_RE.search(out)
        if m:
            return int(m.group(1), 16)
    return None


def _default_transition_candidates_path() -> str:
    temp_dir = (os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR") or "").strip()
    if temp_dir:
        out_dir = os.path.abspath(os.path.expanduser(temp_dir))
    else:
        out_dir = os.path.join(os.getcwd(), "temp")
    return os.path.join(out_dir, "transition_candidates.json")


def _transition_candidate_symbol(signature: str) -> str:
    text = (signature or "").strip().rstrip(";").strip()
    if not text:
        return ""

    rust_match = re.match(r"^(?:static\s+)?fn\s+(.+)$", text)
    if rust_match:
        text = rust_match.group(1).strip()
        paren = text.find("(")
        return text[:paren].strip() if paren >= 0 else text

    paren = text.find("(")
    head = text[:paren].strip() if paren >= 0 else text
    if not head:
        return ""
    return head.rsplit(None, 1)[-1].strip()


def _parse_transition_candidate_functions(output: str):
    functions = []
    current_file = ""
    for raw_line in (output or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("File "):
            current_file = line[len("File "):].rstrip(":").strip()
            continue
        if line.startswith("Non-debugging symbols:"):
            current_file = ""
            continue

        source_match = re.match(r"^(\d+):\s*(.+)$", line)
        if source_match and current_file:
            signature = source_match.group(2).strip()
            symbol = _transition_candidate_symbol(signature)
            if symbol:
                functions.append({
                    "file": current_file,
                    "line": int(source_match.group(1)),
                    "signature": signature,
                    "symbol": symbol,
                    "addr": None,
                })
            continue

        address_match = re.match(r"^(0x[0-9a-fA-F]+)\s+(.+)$", line)
        if address_match:
            signature = address_match.group(2).strip()
            symbol = _transition_candidate_symbol(signature)
            if symbol:
                functions.append({
                    "file": "",
                    "line": 0,
                    "signature": signature,
                    "symbol": symbol,
                    "addr": int(address_match.group(1), 16),
                })
    return functions


def _transition_candidate_keyword_hits(symbol: str, signature: str):
    haystack = f"{symbol} {signature}".lower()
    return [keyword for keyword in _TRANSITION_CANDIDATE_KEYWORDS if keyword in haystack]


def _transition_candidate_privilege(addr):
    if addr is None:
        return "unknown", "address: unavailable"
    value = int(addr)
    if value >= 0xffffffff00000000:
        return "kernel", "address: kernel high range"
    if value <= 0x00000000ffffffff:
        return "user", "address: user low range"
    return "unknown", "address: privilege range unknown"


def _transition_candidate_confidence(keyword_hits):
    hits = set(keyword_hits)
    if hits.intersection({"async_syscall_handler", "user_to_kernel", "kernel_to_user"}):
        return "high"
    if hits.intersection({"decode_invocation", "syscall"}):
        return "medium-high"
    if hits and hits.issubset({"trap", "entry", "restore"}):
        return "medium"
    return "low"


def _transition_candidate_source(entry: dict, addr):
    file = str(entry.get("file") or "")
    fullname = file if file and os.path.isabs(file) else ""
    line = int(entry.get("line") or 0)

    if addr is not None:
        try:
            sal = gdb.find_pc_line(int(addr))
            if sal and sal.symtab:
                if not file:
                    file = sal.symtab.filename or ""
                try:
                    fullname = sal.symtab.fullname() or fullname
                except Exception:
                    pass
                if not line:
                    line = int(sal.line or 0)
        except Exception:
            pass
    return file, fullname, line


def _scan_transition_candidates():
    output = gdb.execute("info functions", to_string=True)
    functions = _parse_transition_candidate_functions(output)
    candidates_by_symbol = {}

    for entry in functions:
        symbol = str(entry.get("symbol") or "").strip()
        signature = str(entry.get("signature") or "").strip()
        keyword_hits = _transition_candidate_keyword_hits(symbol, signature)
        if not keyword_hits:
            continue

        addr = entry.get("addr")
        if addr is None:
            for resolver in (_try_addr_by_lookup_global_symbol, _try_addr_by_info_address):
                addr = resolver(symbol)
                if addr is not None:
                    break

        file, fullname, line = _transition_candidate_source(entry, addr)
        privilege_guess, address_reason = _transition_candidate_privilege(addr)
        reason = [f"keyword: {keyword}" for keyword in keyword_hits]
        reason.append(address_reason)

        candidate = {
            "label": symbol,
            "func": symbol,
            "symbol": symbol,
            "location": f"*0x{int(addr):x}" if addr is not None else "",
            "addr": f"0x{int(addr):x}" if addr is not None else "",
            "file": file,
            "fullname": fullname,
            "line": line,
            "keyword_hits": keyword_hits,
            "privilege_guess": privilege_guess,
            "confidence": _transition_candidate_confidence(keyword_hits),
            "reason": reason,
        }

        previous = candidates_by_symbol.get(symbol)
        if previous is None:
            candidates_by_symbol[symbol] = candidate
        else:
            if not previous.get("location") and candidate.get("location"):
                for field in ("location", "addr", "privilege_guess"):
                    previous[field] = candidate[field]
            for field in ("file", "fullname", "line"):
                if not previous.get(field) and candidate.get(field):
                    previous[field] = candidate[field]

            merged_hits = [
                keyword for keyword in _TRANSITION_CANDIDATE_KEYWORDS
                if keyword in set(previous["keyword_hits"]) | set(keyword_hits)
            ]
            previous["keyword_hits"] = merged_hits
            previous["confidence"] = _transition_candidate_confidence(merged_hits)
            previous["reason"] = [f"keyword: {keyword}" for keyword in merged_hits]
            previous["reason"].append(
                _transition_candidate_privilege(
                    int(previous["addr"], 16) if previous.get("addr") else None
                )[1]
            )

    confidence_rank = {"high": 0, "medium-high": 1, "medium": 2, "low": 3}
    candidates = sorted(
        candidates_by_symbol.values(),
        key=lambda item: (
            confidence_rank.get(item.get("confidence"), 9),
            item.get("symbol", "").lower(),
        ),
    )
    return len(functions), candidates


def _write_transition_candidates(output_path: str):
    scanned_count, candidates = _scan_transition_candidates()
    path = os.path.abspath(os.path.expanduser(output_path))
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    payload = {
        "version": 1,
        "name": "transition-candidates",
        "source": "info functions",
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "candidates": candidates,
    }
    with open(path, "w", encoding="utf-8") as fp:
        json.dump(payload, fp, indent=2, ensure_ascii=False)
        fp.write("\n")
    return path, scanned_count, len(candidates)


def _default_transition_probe_draft_path() -> str:
    temp_dir = (os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR") or "").strip()
    if temp_dir:
        out_dir = os.path.abspath(os.path.expanduser(temp_dir))
    else:
        out_dir = os.path.join(os.getcwd(), "temp")
    return os.path.join(out_dir, "transition-probe.draft.json")


def _load_transition_candidates(path: str):
    resolved_path, _ = _resolve_transition_probe_config_path(path)
    try:
        with open(resolved_path, "r", encoding="utf-8") as fp:
            payload = json.load(fp)
    except Exception as e:
        raise ValueError(
            f"failed to read candidates {resolved_path}: {_short_error(e)}"
        )

    if not isinstance(payload, dict):
        raise ValueError("transition candidates JSON must be an object")
    candidates = payload.get("candidates")
    if not isinstance(candidates, list):
        raise ValueError("transition candidates field 'candidates' must be an array")
    for index, candidate in enumerate(candidates):
        if not isinstance(candidate, dict):
            raise ValueError(f"candidates[{index}] must be an object")
    return resolved_path, candidates


def _transition_draft_location(candidate: dict) -> str:
    location = str(candidate.get("location") or "").strip()
    if not location:
        location = str(candidate.get("addr") or "").strip()
    if location and not location.startswith("*"):
        location = f"*{location}"
    if not re.fullmatch(r"\*0x[0-9a-fA-F]+", location):
        return ""
    return location.lower()


def _transition_draft_keyword_hits(candidate: dict):
    raw_hits = candidate.get("keyword_hits")
    if not isinstance(raw_hits, list):
        return []
    present = {
        str(keyword).strip().lower()
        for keyword in raw_hits
        if isinstance(keyword, str) and keyword.strip()
    }
    return [
        keyword for keyword in _TRANSITION_DRAFT_KEYWORD_PRIORITY
        if keyword in present
    ]


def _transition_draft_completeness(candidate: dict) -> int:
    score = 0
    for field in ("label", "func", "symbol", "location", "file", "fullname"):
        if str(candidate.get(field) or "").strip():
            score += 1
    try:
        if int(candidate.get("line") or 0) > 0:
            score += 1
    except Exception:
        pass
    if isinstance(candidate.get("reason"), list) and candidate["reason"]:
        score += 1
    return score


def _transition_draft_semantic_rank(candidate: dict, keyword_hits):
    symbol = str(candidate.get("symbol") or candidate.get("func") or "").lower()
    compact_symbol = re.sub(r"[^a-z0-9]+", "", symbol)
    hits = set(keyword_hits)

    if hits.intersection({"user_to_kernel", "kernel_to_user"}):
        return 0
    if "handlesyscall" in compact_symbol or "handle_syscall" in hits:
        return 1
    if "decode_invocation" in symbol or "decode_invocation" in hits:
        return 2
    if symbol.count("async_syscall_handler") >= 2:
        return 3
    if "syscall" in hits:
        return 4
    if hits.intersection({"decode", "invocation"}):
        return 5
    if "async_syscall_handler" in hits:
        return 6
    return 7


def _transition_draft_sort_key(item: dict):
    confidence_rank = {"high": 0, "medium-high": 1}
    keyword_hits = item["_draft_keyword_hits"]
    keyword_rank = min(
        (
            _TRANSITION_DRAFT_KEYWORD_PRIORITY.index(keyword)
            for keyword in keyword_hits
        ),
        default=len(_TRANSITION_DRAFT_KEYWORD_PRIORITY),
    )
    return (
        confidence_rank.get(item["_draft_confidence"], 9),
        _transition_draft_semantic_rank(item, keyword_hits),
        keyword_rank,
        -item["_draft_completeness"],
        item["_draft_symbol"].lower(),
        item["_draft_location"],
        item["_draft_index"],
    )


def _select_transition_probe_draft_candidates(candidates):
    eligible = []
    for index, raw_candidate in enumerate(candidates):
        confidence = str(raw_candidate.get("confidence") or "").strip().lower()
        if confidence not in _TRANSITION_DRAFT_CONFIDENCE:
            continue
        keyword_hits = _transition_draft_keyword_hits(raw_candidate)
        if not keyword_hits:
            continue
        location = _transition_draft_location(raw_candidate)
        symbol = str(
            raw_candidate.get("symbol")
            or raw_candidate.get("func")
            or raw_candidate.get("label")
            or ""
        ).strip()
        if not symbol or not location:
            continue

        candidate = dict(raw_candidate)
        candidate["_draft_index"] = index
        candidate["_draft_confidence"] = confidence
        candidate["_draft_keyword_hits"] = keyword_hits
        candidate["_draft_location"] = location
        candidate["_draft_symbol"] = symbol
        candidate["_draft_completeness"] = _transition_draft_completeness(candidate)
        eligible.append(candidate)

    # Prefer the most complete duplicate before applying the final semantic ordering.
    dedupe_order = sorted(
        eligible,
        key=lambda item: (
            -item["_draft_completeness"],
            item["_draft_index"],
        ),
    )
    deduped = []
    seen_symbols = set()
    seen_locations = set()
    for candidate in dedupe_order:
        symbol_key = candidate["_draft_symbol"].lower()
        location_key = candidate["_draft_location"]
        if symbol_key in seen_symbols or location_key in seen_locations:
            continue
        seen_symbols.add(symbol_key)
        seen_locations.add(location_key)
        deduped.append(candidate)

    ordered = sorted(deduped, key=_transition_draft_sort_key)
    selected = []
    selected_ids = set()

    # Preserve semantic diversity before filling the remaining slots by global rank.
    seed_rules = (
        (lambda item: set(item["_draft_keyword_hits"]).intersection(
            {"user_to_kernel", "kernel_to_user"}
        ), 2),
        (lambda item: _transition_draft_semantic_rank(
            item, item["_draft_keyword_hits"]
        ) == 1, 3),
        (lambda item: _transition_draft_semantic_rank(
            item, item["_draft_keyword_hits"]
        ) == 2, 3),
        (lambda item: _transition_draft_semantic_rank(
            item, item["_draft_keyword_hits"]
        ) == 3, 2),
    )
    for predicate, limit in seed_rules:
        added = 0
        for candidate in ordered:
            candidate_id = candidate["_draft_index"]
            if candidate_id in selected_ids or not predicate(candidate):
                continue
            selected.append(candidate)
            selected_ids.add(candidate_id)
            added += 1
            if added >= limit:
                break

    for candidate in ordered:
        if len(selected) >= _TRANSITION_DRAFT_MAX_PROBES:
            break
        candidate_id = candidate["_draft_index"]
        if candidate_id in selected_ids:
            continue
        selected.append(candidate)
        selected_ids.add(candidate_id)

    return sorted(selected, key=_transition_draft_sort_key)


def _transition_probe_draft_spec(candidate: dict) -> dict:
    keyword_hits = candidate["_draft_keyword_hits"]
    event = ""
    if "user_to_kernel" in keyword_hits:
        event = "user_to_kernel"
    elif "kernel_to_user" in keyword_hits:
        event = "kernel_to_user"

    privilege = str(candidate.get("privilege_guess") or "unknown").strip().lower()
    if privilege not in ("user", "kernel", "unknown"):
        privilege = "unknown"
    try:
        line = int(candidate.get("line") or 0)
    except Exception:
        line = 0
    reason = candidate.get("reason")
    if not isinstance(reason, list):
        reason = []

    spec = {
        "label": str(candidate.get("label") or candidate["_draft_symbol"]).strip(),
        "type": "transition" if event else "sync",
        "privilege": privilege,
        "location": candidate["_draft_location"],
        "func": str(candidate.get("func") or candidate["_draft_symbol"]).strip(),
        "file": str(candidate.get("file") or "").strip(),
        "fullname": str(candidate.get("fullname") or "").strip(),
        "line": line,
        "confidence": candidate["_draft_confidence"],
        "reason": [str(item) for item in reason],
        "draft_note": "review required before enabling",
    }
    if event:
        spec["event"] = event
    return spec


def _write_transition_probe_draft(candidates_path: str, output_path: str):
    resolved_candidates_path, candidates = _load_transition_candidates(candidates_path)
    path = os.path.abspath(os.path.expanduser(output_path))
    formal_path = os.path.abspath(
        os.path.join(_transition_probe_project_root(), _REL4_TRANSITION_PROBE_CONFIG)
    )
    if os.path.normcase(os.path.realpath(path)) == os.path.normcase(
        os.path.realpath(formal_path)
    ):
        raise ValueError("refusing to overwrite the formal rel4 transition-probe.json")
    if os.path.basename(path).lower() == "transition-probe.json":
        raise ValueError("draft output must not be named transition-probe.json")
    if os.path.normcase(os.path.realpath(path)) == os.path.normcase(
        os.path.realpath(resolved_candidates_path)
    ):
        raise ValueError("draft output must differ from the candidates input")

    selected = _select_transition_probe_draft_candidates(candidates)
    probes = [_transition_probe_draft_spec(candidate) for candidate in selected]
    payload = {
        "version": 1,
        "name": "draft-from-candidates",
        "source": "transition-candidates",
        "generated_from": resolved_candidates_path,
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "candidate_count": len(candidates),
        "selected_count": len(probes),
        "selection_policy": (
            "high and medium-high transition-related candidates; "
            "semantic diversity; maximum 20 probes"
        ),
        "probes": probes,
    }
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fp:
        json.dump(payload, fp, indent=2, ensure_ascii=False)
        fp.write("\n")
    return path, len(candidates), len(probes)


def _whitelist_enabled() -> bool:
    return (_WHITELIST_EXACT is not None) or (_WHITELIST_PREFIX is not None)

def _normalize_sym_name(sym: str) -> str:
    # strip PLT suffix if present
    if sym.endswith("@plt"):
        return sym[:-4]
    return sym

def _whitelist_allows_by_name(sym: str) -> str | None:
    if not _whitelist_enabled():
        return sym  # no whitelist => allow

    if _WHITELIST_EXACT is not None and sym in _WHITELIST_EXACT:
        return sym

    if _WHITELIST_PREFIX:
        for p in _WHITELIST_PREFIX:
            if sym.startswith(p):
                return sym

    return None


def _make_runtime_event(event_kind, symbol, addr, thread_id, source, metadata=None):
    """Build an ENTRY_SEED event without mutating the runtime call graph."""
    raw_event = {
        "event_kind": str(event_kind or "runtime_hit"),
        "symbol": str(symbol or ""),
        "addr": addr or "",
        "thread_id": thread_id,
        "source": str(source or "runtime"),
        "timestamp": _call_graph_now(),
        "metadata": dict(metadata or {}),
    }
    _log_diag(
        f"[ENTRY_SEED] kind={raw_event['event_kind']} symbol={raw_event['symbol']} "
        f"source={raw_event['source']} thread={thread_id}"
    )
    return raw_event


def _classify_runtime_event(raw_event):
    """Classify a runtime event before the whitelist admission gate."""
    symbol = str(raw_event.get("symbol") or "")
    metadata = dict(raw_event.get("metadata") or {})
    is_dispatch = _is_async_dispatch_observe_symbol(symbol)
    whitelist_enabled = _whitelist_enabled()
    whitelist_match = (
        _whitelist_allows_by_name(symbol) if whitelist_enabled else None
    )
    metadata.update({
        "whitelist_allowed": bool(whitelist_enabled and whitelist_match),
        "whitelist_reason": (
            "whitelist_match" if whitelist_match
            else "whitelist_rejected" if whitelist_enabled else "whitelist_not_loaded"
        ),
        "dispatch_observe": is_dispatch,
    })
    candidate = {
        "semantic_kind": "dispatch_observation" if is_dispatch else "runtime_call",
        "node_kind": "dispatch_observation" if is_dispatch else "call",
        "edge_kind": "observation" if is_dispatch else "call",
        "symbol": symbol,
        "addr": raw_event.get("addr", ""),
        "thread_id": raw_event.get("thread_id"),
        "source": raw_event.get("source", "runtime"),
        "timestamp": raw_event.get("timestamp", ""),
        "metadata": metadata,
    }
    _log_diag(
        f"[RUNTIME_EVENT] semantic={candidate['semantic_kind']} "
        f"symbol={symbol} whitelist={metadata['whitelist_allowed']}"
    )
    return candidate


def _admit_trace_candidate(candidate):
    """Admit graph writes only for whitelist-approved runtime events."""
    symbol = str(candidate.get("symbol") or "")
    if not symbol:
        decision = {"action": "REJECT", "reason": "missing_symbol"}
    elif candidate.get("semantic_kind") == "dispatch_observation":
        # DISPATCH HOOK SOFT DISABLED FOR GRAPH STABILITY - DO NOT REMOVE
        decision = {"action": "REDIRECT", "reason": "dispatch_hook_soft_disabled"}
    elif not candidate.get("metadata", {}).get("whitelist_allowed"):
        decision = {"action": "REJECT", "reason": "whitelist_not_allowed"}
    else:
        decision = {"action": "ALLOW", "reason": "whitelist_runtime_execution_hit"}
    _log_diag(
        f"[NODE_ADMISSION] action={decision['action']} reason={decision['reason']} "
        f"symbol={symbol}"
    )
    return decision

def _build_whitelist_addr_map_if_needed(caller_is_user_visible: bool):
    global _WHITELIST_ADDR_READY, _WHITELIST_ADDR_MAP

    # addr-map only for exact symbols
    if _WHITELIST_EXACT is None or _WHITELIST_ADDR_READY:
        return

    resolved = 0
    total = len(_WHITELIST_EXACT)
    addr_map = {}

    for name in _WHITELIST_EXACT:
        addr = _try_addr_by_lookup_global_symbol(name)
        if addr is None:
            addr = _try_addr_by_info_address(name)
        if addr is None:
            continue
        addr_map[int(addr)] = name
        resolved += 1

    _WHITELIST_ADDR_MAP = addr_map
    _WHITELIST_ADDR_READY = True

    if caller_is_user_visible and PRINT_WHITELIST_ADDR_STATS:
        prefix_n = len(_WHITELIST_PREFIX) if _WHITELIST_PREFIX else 0
        _log_ard(f"[ARD] whitelist addrs: {resolved}/{total} resolved (exact), prefix={prefix_n}")

def _whitelist_allows_by_addr(target_addr: int) -> str | None:
    if _WHITELIST_EXACT is None or not _WHITELIST_ADDR_READY:
        return None
    return _WHITELIST_ADDR_MAP.get(int(target_addr))

# -------------------------
# Logging helpers (runtime)
# -------------------------

def _default_log_path() -> str | None:
    cwd = os.getcwd()
    temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
    if not temp_dir:
        return None
    return os.path.join(cwd, temp_dir, "ardb.log")

def _log_ard(message: str, to_console: bool = False):
    """
    双轨日志记录：
    - 始终尝试写入磁盘文件 (ardb.log) 以供开发者检查。
    - 根据 to_console 参数决定是否实时打印到 GDB 终端。
    """
    path = _default_log_path()
    if path:
        try:
            # 确保 temp 目录存在（如果之前没生成白名单的话）
            log_dir = os.path.dirname(path)
            if not os.path.exists(log_dir):
                os.makedirs(log_dir, exist_ok=True)
                
            with open(path, "a", encoding="utf-8") as fp:
                fp.write(message + "\n")
        except Exception:
            pass

    if to_console:
        gdb.write(message + "\n")

def _ard_diag_enabled() -> bool:
    value = os.environ.get("ARD_DIAG") or os.environ.get("ARDB_DIAG") or ""
    return value.lower() in ("1", "true", "yes", "on")

def _log_diag(message: str):
    if _ard_diag_enabled():
        _log_ard(message)

# -------------------------
# Callee selection
# -------------------------

def _is_pollish_name(sym_name: str) -> bool:
    return ("::poll" in sym_name) or ("{async_fn#" in sym_name) or ("{async_block#" in sym_name)

def _is_async_symbol(sym_name: str) -> bool:
    """
    Check whether a symbol is an async function.
    Uses the same criteria as gen_whitelist._classify_symbol:
    1. Name contains {async_fn# or {async_block# (compiler-generated async)
    2. Symbol is in the async set from the grouped whitelist (e.g. manual Future::poll impls)
    """
    if ("{async_fn#" in sym_name) or ("{async_block#" in sym_name):
        return True
    if "async_runtime::coroutine::Coroutine::execute" in sym_name:
        return True
    if _ASYNC_SYMBOL_SET is not None and sym_name in _ASYNC_SYMBOL_SET:
        return True
    return False

def _load_async_symbol_set_from_grouped():
    """
    Load the async symbol set from poll_functions_grouped.json.
    Called after whitelist generation or when the grouped JSON is first read.
    """
    global _ASYNC_SYMBOL_SET
    temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
    if not temp_dir:
        return
    grouped_path = os.path.join(os.getcwd(), temp_dir, "poll_functions_grouped.json")
    if not os.path.exists(grouped_path):
        return
    try:
        with open(grouped_path, "r", encoding="utf-8") as fp:
            data = json.load(fp)
        async_set = set()
        for crate_info in data.get("crates", {}).values():
            for sym in crate_info.get("symbols", []):
                if sym.get("kind") == "async":
                    async_set.add(sym["name"])
        _ASYNC_SYMBOL_SET = async_set
    except Exception:
        pass

def _has_existing_real_async_child(snapshot_path, phys_tail, leaf_func: str) -> bool:
    """
    Check whether a real async child with the same function already exists
    either in the shadow-stack-derived snapshot path or in the physical tail.
    """
    try:
        for node in snapshot_path:
            if node.get("type") != "async":
                continue
            if node.get("cid") is None:
                continue
            if node.get("func") == leaf_func:
                return True

        for node in reversed(phys_tail):
            if node.get("type") != "async":
                continue
            if node.get("cid") is None:
                continue
            if node.get("func") == leaf_func:
                return True
    except Exception:
        pass
    return False

def _should_log_child_key_miss(leaf_func: str, node_addr: str) -> bool:
    if not leaf_func:
        return False

    key = (leaf_func, node_addr)
    if key in _CHILD_KEY_MISS_LOGGED:
        return False

    _CHILD_KEY_MISS_LOGGED.add(key)
    return True

def _extract_raw_ptr(val: gdb.Value, depth: int = 0) -> int:
    """
    Recursively unwrap a GDB value to extract the raw memory address.

    Handles common Rust wrapper types:
      - Pin<P>      → struct with '__pointer' or 'pointer' field
      - Box<T>      → struct with 'pointer' field (Unique) containing '*mut T'
      - &mut T / &T → TYPE_CODE_REF / TYPE_CODE_RVALUE_REF
      - *mut T / *const T → TYPE_CODE_PTR
      - Unique<T>   → struct with 'pointer' field (NonNull) → inner '*const T'
      - NonNull<T>  → struct with 'pointer' field → '*const T'

    Recursion depth is capped to avoid infinite loops on pathological types.
    """
    if depth > 8:
        result = _normalize_addr(val)
        return result if result and result > 0xffff else 0

    try:
        ty = val.type.strip_typedefs()
        code = ty.code

        # Pointer or reference — this is what we want
        if code in (gdb.TYPE_CODE_PTR, gdb.TYPE_CODE_REF, gdb.TYPE_CODE_RVALUE_REF):
            result = _normalize_addr(val)
            return result if result and result > 0xffff else 0

        # Struct — drill into known wrapper fields
        if code == gdb.TYPE_CODE_STRUCT:
            # Try well-known inner-pointer field names in priority order
            for field_name in ('__pointer', 'pointer', 'data', 'inner', 'value'):
                try:
                    inner = val[field_name]
                    result = _extract_raw_ptr(inner, depth + 1)
                    if result > 0xffff:  # looks like a valid pointer
                        return result
                except Exception:
                    pass

            # Generic single-field struct (common in Rust newtypes)
            try:
                fields = ty.fields()
                if len(fields) == 1:
                    inner = val[fields[0].name]
                    result = _extract_raw_ptr(inner, depth + 1)
                    if result > 0xffff:
                        return result
            except Exception:
                pass

        # Fallback — direct integer conversion
        result = _normalize_addr(val)
        return result if result and result > 0xffff else 0
    except Exception:
        return 0


def _callee_candidates(addr: int) -> list[str]:
    cands = []
    n1 = _find_pc_function_name(addr)
    if n1:
        cands.append(n1.strip())
    n2 = _info_symbol_name(addr)
    if n2:
        cands.append(n2.strip())

    seen = set()
    out = []
    for s in cands:
        s2 = s.strip()
        if s2 and s2 not in seen:
            out.append(s2)
            seen.add(s2)
    return out

def _pick_interesting_callee(target_addr: int) -> str | None:
    # whitelist enabled + addr-map ready: prefer addr hit, else fallback to name
    if _whitelist_enabled() and _WHITELIST_ADDR_READY:
        hit = _whitelist_allows_by_addr(target_addr)
        if hit:
            return hit
        # address miss: fallback to name-based match (prefix/plt/monomorph)
        for n in _callee_candidates(target_addr):
            n2 = _normalize_sym_name(n)
            if _whitelist_allows_by_name(n2):
                return n2
        return None

    # whitelist enabled but addr-map not ready: name-based match
    if _whitelist_enabled():
        for n in _callee_candidates(target_addr):
            n2 = _normalize_sym_name(n)
            if _whitelist_allows_by_name(n2):
                return n2
        return None

    # Runtime event instrumentation is whitelist-owned. Without a whitelist,
    # no dynamic callee may become an event source or a graph node.
    return None


# -------------------------
# Run-scoped cleanup (PIE/ASLR safe)
# -------------------------

def _cleanup_run_scoped():
    global _RECENT_CALL_ROOT_GLOBAL, _RECENT_CALL_PARENT_GLOBAL
    for bp in list(_RUN_SCOPED_BPS):
        try:
            bp.delete()
        except Exception:
            pass
    _RUN_SCOPED_BPS.clear()
    _TRANSITION_PROBE_BPS.clear()

    _CALLSITE_INSTALLED_FOR_FN.clear()
    _invalidate_whitelist_addrs()

    _TLS_STACK.clear()
    _CALL_STACK.clear()
    _RECENT_CALL_ROOT_BY_THREAD.clear()
    _RECENT_CALL_ROOT_GLOBAL = None
    _RECENT_CALL_PARENT_BY_THREAD.clear()
    _RECENT_CALL_PARENT_GLOBAL = None
    _CO_BY_KEY.clear()
    _CO_META.clear()
    _CO_POLL_SEQ.clear()
    _LAST_CHILD_HIT_BY_PARENT.clear()
    _LAST_CHILD_HIT_BY_CALLER_FRAME.clear()
    _LAST_CHILD_HIT_BY_FUNC_ADDR.clear()
    _LAST_CHILD_HIT_BY_STRUCTURED.clear()
    _CHILD_KEY_MISS_LOGGED.clear()
    global _CO_NEXT_ID
    _CO_NEXT_ID = 1

def _on_exited(event):
    _cleanup_run_scoped()

def _on_new_objfile(event):
    _cleanup_run_scoped()


def _remove_runtime_event_breakpoints():
    """Remove whitelist-installed event instrumentation without touching probes."""
    for bp in list(_RUNTIME_EVENT_BPS):
        try:
            bp.delete()
        except Exception:
            pass
        try:
            _CREATED_BPS.remove(bp)
        except ValueError:
            pass
        try:
            _RUN_SCOPED_BPS.remove(bp)
        except ValueError:
            pass
    _RUNTIME_EVENT_BPS.clear()
    _ACTIVE_RUNTIME_EVENT_SYMBOLS.clear()


def _install_whitelist_runtime_event_breakpoints():
    """Install runtime event probes for exact whitelist symbols.

    These breakpoints are instrumentation, not trace roots: their callbacks
    capture execution hits, pass the whitelist admission gate, and only then
    write the execution graph.
    """
    _remove_runtime_event_breakpoints()
    if not _whitelist_enabled():
        return

    for symbol in sorted(_WHITELIST_EXACT or ()):
        try:
            RuntimeEventBP(symbol, func_name=symbol, internal=True)
            _ACTIVE_RUNTIME_EVENT_SYMBOLS.add(symbol)
        except Exception as e:
            _log_ard(
                f"[ARD] whitelist runtime event probe install failed {symbol}: "
                f"{_short_error(e)}"
            )

# -------------------------
# Breakpoints
# -------------------------

class RuntimeEventBP(gdb.Breakpoint):
    """Whitelist-owned runtime execution event source for the call graph."""
    def __init__(self, location: str, func_name: str | None, internal: bool, temporary: bool = False):
        # Rust generic symbols may contain commas and spaces. Quote symbolic
        # locations so every exact whitelist entry is instrumented as written.
        location_text = str(location)
        gdb_location = (
            location_text
            if location_text.strip().startswith("*")
            else _quote_gdb_break_location(location_text)
        )
        super().__init__(gdb_location, type=gdb.BP_BREAKPOINT, internal=internal, temporary=temporary)
        self.silent = True
        self.func_name = func_name or ""
        self.internal = internal
        _CREATED_BPS.append(self)
        _RUNTIME_EVENT_BPS.append(self)

        # addr breakpoints / finish breakpoints are run-scoped
        if isinstance(location, str) and location.strip().startswith("*"):
            _RUN_SCOPED_BPS.append(self)

    def stop(self) -> bool:
        fn = _current_function_name()
        _log_diag(
            f"[ARD][diag] RuntimeEventBP.stop enter fn={fn!r} func_name={self.func_name!r} internal={self.internal!r}"
        )
        try:
            frame = gdb.selected_frame()
            _log_diag(f"[ARD][diag] frame={frame.name()!r}")
        except Exception as e:
            frame = None
            _log_diag(f"[ARD][diag] frame read failed: {e!r}")
        try:
            pc = int(gdb.parse_and_eval("$pc"))
            _log_diag(f"[ARD][diag] pc=0x{pc:x}")
            _log_diag(f"[ARD][diag] info_symbol={_info_symbol_raw(pc)!r}")
        except Exception as e:
            _log_diag(f"[ARD][diag] pc/symbol failed: {e!r}")
        try:
            names = []
            f = gdb.newest_frame()
            depth_i = 0
            while f is not None and depth_i < 8:
                try:
                    names.append(f.name())
                except Exception:
                    names.append("<name-failed>")
                f = f.older()
                depth_i += 1
            _log_diag(f"[ARD][diag] bt_top={names!r}")
        except Exception as e:
            _log_diag(f"[ARD][diag] bt_top failed: {e!r}")

        # ---- coro context enter (best-effort) ----
        tid = _thread_id()
        try:
            _log_diag(
                f"[ARD][diag] TLS_STACK before tid={tid} stack={_TLS_STACK.get(tid, [])!r} all={_TLS_STACK!r}"
            )
        except Exception as e:
            _log_diag(f"[ARD][diag] TLS_STACK read failed: {e!r}")
        poll_sym = self.func_name or fn
        is_dispatch_observe = _is_async_dispatch_observe_symbol(poll_sym)
        dispatch_fields = (
            _read_async_dispatch_observe_args() if is_dispatch_observe else None
        )
        self_ptr = 0
        this_arg_ptr = 0
        if frame is not None:
            for arg_name in ("self", "this"):
                try:
                    arg_val = frame.read_var(arg_name)
                    arg_ptr = _extract_raw_ptr(arg_val)
                    if arg_name == "self":
                        self_ptr = arg_ptr
                    else:
                        this_arg_ptr = arg_ptr
                    _log_diag(
                        f"[ARD][diag] arg {arg_name}={arg_val!r} ptr=0x{arg_ptr:x}"
                    )
                except Exception as e:
                    _log_diag(f"[ARD][diag] arg {arg_name} read failed: {e!r}")
        # Dispatch observe uses a0..a3 as ABI metadata, not a Future self pointer.
        # Keep the shared call-graph path pointer-safe for that ordinary hook.
        this_ptr = None
        a0_ptr = 0
        if not is_dispatch_observe:
            try:
                first_arg = _first_arg_reg()
                raw_reg_val = gdb.parse_and_eval(f"${first_arg}")
                a0_ptr = _normalize_addr(raw_reg_val) or 0
                this_ptr = self_ptr or this_arg_ptr or a0_ptr
                _log_ard(
                    f"[ARD] ptr-selected self=0x{self_ptr:x} this=0x{this_arg_ptr:x} {first_arg}=0x{a0_ptr:x} selected=0x{this_ptr:x}"
                )
                if this_ptr <= 0x10000:
                    _log_diag(f"[ARD][diag] this_ptr rejected by low-address filter: 0x{this_ptr:x}")
                    this_ptr = 0
            except Exception as e:
                _log_diag(f"[ARD][diag] first arg read failed: {e!r}")
                this_ptr = 0
        else:
            _log_diag("[ARD][diag] dispatch observe: a0 is ABI data, not a future pointer")
        _log_diag(f"[ARD][diag] final this_ptr=0x{(this_ptr or 0):x}")

        cid = 0
        is_new = False
        depth = -1
        _log_diag(
            f"[ARD][diag] before node create: poll_sym={poll_sym!r} "
            f"this_ptr=0x{(this_ptr or 0):x}"
        )

        if poll_sym and this_ptr:
            cid, is_new = _get_or_make_coro_id(poll_sym, this_ptr)
            _log_diag(f"[ARD][diag] cid selected: cid={cid!r} is_new={is_new!r}")
            depth = _push_coro(cid)
            _log_diag(
                f"[ARD][diag] TLS_STACK after push tid={tid} depth={depth} stack={_TLS_STACK.get(tid, [])!r} all={_TLS_STACK!r}"
            )

        indent = "  " * max(depth, 0)

        # poll sequence per coro instance
        seq = 0
        if cid:
            seq = _CO_POLL_SEQ.get(cid, 0) + 1
            _CO_POLL_SEQ[cid] = seq
            _log_diag(f"[ARD][diag] poll sequence updated: cid={cid} seq={seq}")
        state_info = (
            _read_state_with_status(poll_sym, this_ptr)
            if cid and this_ptr
            else _state_info("N/A", "unsupported", "missing future pointer")
        )
        _record_async_privilege_hit(poll_sym)
        runtime_metadata = {
            "cid": cid if cid else None,
            "depth": depth,
            **_state_fields(state_info),
        }
        if dispatch_fields:
            runtime_metadata.update(dispatch_fields)
        raw_event = _make_runtime_event(
            "dispatch_hook_hit" if is_dispatch_observe else "call_entry_hit",
            poll_sym,
            hex(this_ptr) if this_ptr else "",
            tid,
            "dispatch-hook" if is_dispatch_observe else "whitelist-runtime-event",
            runtime_metadata,
        )
        candidate = _classify_runtime_event(raw_event)
        decision = _admit_trace_candidate(candidate)
        graph_write_enabled = (
            decision["action"] == "ALLOW"
            and (not is_dispatch_observe or DISPATCH_HOOK_ENABLED)
        )
        if is_dispatch_observe and not DISPATCH_HOOK_ENABLED:
            _log_ard(
                "[ARD] dispatch observe hit: graph write soft-disabled "
                f"queue={dispatch_fields.get('dispatch_queue_state_name', 'unknown')} "
                f"branch={dispatch_fields.get('dispatch_branch_name', 'unknown')}"
            )
        if graph_write_enabled:
            call_frame = None
            try:
                call_fields = {
                    "thread_id": tid,
                    "addr": hex(this_ptr) if this_ptr else "",
                    "depth": depth,
                    "origin": "runtime-dispatch-observe" if is_dispatch_observe else "runtime-call",
                    "privilege": _PRIVILEGE_STATE,
                    "transition_event": _PRIVILEGE_TRANSITION_EVENT,
                    "semantic_kind": candidate.get("semantic_kind"),
                    "node_kind": candidate.get("node_kind"),
                    "edge_kind": candidate.get("edge_kind"),
                    "admission_action": decision.get("action"),
                    "admission_reason": decision.get("reason"),
                    **_state_fields(state_info),
                }
                if dispatch_fields:
                    call_fields.update(dispatch_fields)
                call_frame = _record_call_enter(
                    poll_sym,
                    cid if cid else None,
                    **call_fields,
                )
                _TraceReturnBP(tid, cid, poll_sym)
                if dispatch_fields:
                    _record_call_dispatch_observe(poll_sym, tid, cid, dispatch_fields)
            except Exception as e:
                if call_frame is not None:
                    _record_call_exit(poll_sym, cid if cid else None, thread_id=tid)
                _record_call_event(
                    "call_enter_error",
                    thread_id=tid,
                    cid=cid if cid else None,
                    func=poll_sym,
                    error=_short_error(e),
                )
        if is_dispatch_observe:
            return False
        if cid and this_ptr:
            addr_hex = hex(this_ptr)
            _LAST_CHILD_HIT_BY_FUNC_ADDR[(poll_sym, addr_hex)] = {
                "func": poll_sym,
                "cid": cid,
                "poll": seq,
                "addr": addr_hex,
                **_state_fields(state_info),
            }
            _log_diag(
                f"[ARD][diag] node cache updated: poll_sym={poll_sym!r} cid={cid} addr={addr_hex}"
            )
        # Record the latest direct child poll hit for the current parent.
        try:
            st = _TLS_STACK.get(tid, [])
            if cid and len(st) >= 2:
                parent_cid = st[-2]
                parent_sym, parent_ptr = _CO_META.get(parent_cid, ("", 0))
                if parent_sym:
                    child_addr = hex(this_ptr) if this_ptr else ""
                    hit = {
                        "func": poll_sym,
                        "cid": cid,
                        "poll": seq,
                        "addr": child_addr,
                        **_state_fields(state_info),
                    }
                    _LAST_CHILD_HIT_BY_PARENT[parent_sym] = hit
                    _record_structured_child_hit(
                        tid,
                        parent_cid,
                        parent_sym,
                        hex(parent_ptr) if parent_ptr else "",
                        poll_sym,
                        child_addr,
                        hit,
                    )
                    _log_ard(
                        f"[ARD] child-hit parent={parent_sym} parent_cid={parent_cid} child={poll_sym} cid={cid} poll={seq} addr={child_addr or '0x0'}"
                    )
                    _log_ard(f"[ARD][async] {parent_sym} -> {poll_sym}")
        except Exception:
            pass
                # Also record the most relevant async caller frame name from the physical stack.
        try:
            caller_frame = gdb.selected_frame().older()
            caller_async_name = ""

            while caller_frame:
                caller_name = caller_frame.name() or ""
                if caller_name and caller_name != poll_sym and _is_async_symbol(caller_name):
                    caller_async_name = caller_name
                    break
                caller_frame = caller_frame.older()

            if cid and caller_async_name:
                child_addr = hex(this_ptr) if this_ptr else ""
                caller_cid = None
                try:
                    for stack_cid in reversed(_TLS_STACK.get(tid, [])):
                        stack_sym, _stack_ptr = _CO_META.get(stack_cid, ("", 0))
                        if stack_sym == caller_async_name:
                            caller_cid = stack_cid
                            break
                except Exception:
                    caller_cid = None
                hit = {
                    "func": poll_sym,
                    "cid": cid,
                    "poll": seq,
                    "addr": child_addr,
                    **_state_fields(state_info),
                }
                _LAST_CHILD_HIT_BY_CALLER_FRAME[caller_async_name] = hit
                _record_structured_child_hit(
                    tid,
                    caller_cid,
                    caller_async_name,
                    "",
                    poll_sym,
                    child_addr,
                    hit,
                )
                _log_ard(
                    f"[ARD] caller-frame-hit caller={caller_async_name} caller_cid={caller_cid} child={poll_sym} cid={cid} poll={seq} addr={child_addr or '0x0'}"
                )
        except Exception:
            pass

        _build_whitelist_addr_map_if_needed(caller_is_user_visible=(not self.internal))

        # new coro line
        if cid and is_new:
            _log_ard(f"[ARD]{indent} coro#{cid} new: {poll_sym} @ {this_ptr:#x}") # 使用默认的 False

        # poll line
        if (not self.internal) or PRINT_INTERNAL_POLL_HITS:
            _log_ard(f"[ARD]{indent} poll[coro#{cid} poll#{seq}] {fn}") # 使用默认的 False

        # awaitee line (no output dedup)
        if self.func_name:
            awa = _try_read_awaitee_from_current_poll(self.func_name)
            if awa is not None:
                awa_ty, _awa_val = awa
                _log_ard(f"[ARD]{indent} awa[coro#{cid} poll#{seq}] {fn} -> {awa_ty}") # 使用默认的 False

                # Discover a new whitelist-approved runtime event source.
                child_poll = _child_poll_symbol_from_awaitee_type(awa_ty)
                if (
                    child_poll
                    and child_poll not in _ACTIVE_RUNTIME_EVENT_SYMBOLS
                    and _whitelist_enabled()
                    and _whitelist_allows_by_name(child_poll)
                ):
                    RuntimeEventBP(
                        child_poll,
                        func_name=child_poll,
                        internal=True,
                        temporary=False,
                    )
                    _ACTIVE_RUNTIME_EVENT_SYMBOLS.add(child_poll)

        # Install call-site breakpoints once per function (per run)
        if fn not in _CALLSITE_INSTALLED_FOR_FN:
            try:
                call_sites = _collect_call_sites()
            except gdb.error as e:
                if (not self.internal) or PRINT_INTERNAL_POLL_HITS:
                    _log_ard(f"[ARD]{indent} call-site scan failed: {e}")
                return False

            for a in call_sites:
                try:
                    CallSiteBP(a)
                except Exception as e:
                    _log_ard(f"[ARD]{indent} call-site bp install failed addr={a:#x}: {_short_error(e)}")

            _CALLSITE_INSTALLED_FOR_FN.add(fn)
            if (not self.internal) or PRINT_INTERNAL_POLL_HITS:
                _log_ard(f"[ARD]{indent} call-sites: {len(call_sites)}")

        return False


class CallSiteBP(gdb.Breakpoint):
    def __init__(self, addr: int):
        super().__init__(f"*{addr:#x}", type=gdb.BP_BREAKPOINT, internal=True)
        self.silent = True
        self.addr = addr
        _CREATED_BPS.append(self)
        _RUN_SCOPED_BPS.append(self)

    def stop(self) -> bool:
        target = _resolve_call_target_from_asm(_current_asm())
        if not target:
            return False

        callee = _pick_interesting_callee(target)
        if not callee:
            return False

        caller = _current_function_name()
        cid, depth = _current_coro()
        indent = "  " * max(depth, 0)
        seq = _CO_POLL_SEQ.get(cid, 0) if cid else 0

        # call line (no output dedup)
        _log_ard(f"[ARD]{indent} call[coro#{cid} poll#{seq}] {caller} -> {callee}") # 使用默认的 False

        if callee not in _ACTIVE_RUNTIME_EVENT_SYMBOLS:
            RuntimeEventBP(callee, func_name=callee, internal=True, temporary=False)
            _ACTIVE_RUNTIME_EVENT_SYMBOLS.add(callee)

        return False


class PrivilegeGroupBP(gdb.Breakpoint):
    def __init__(self, group: str, location: str, label: str = ""):
        self.group = (group or "").strip().lower()
        if self.group not in ("user", "kernel"):
            raise ValueError("privilege breakpoint group must be user or kernel")
        super().__init__(location, type=gdb.BP_BREAKPOINT, internal=True)
        self.silent = True
        self.location_text = location
        self.label = label or location
        _CREATED_BPS.append(self)
        _RUN_SCOPED_BPS.append(self)
        _register_privilege_bp(self.group, self)

    def stop(self) -> bool:
        _record_privilege_hit(self.group, self.label)
        return False


class TransitionProbeBP(gdb.Breakpoint):
    def __init__(self, spec: dict):
        self.spec = dict(spec)
        self.probe_hits = 0
        location = self.spec.get("location") or ""
        super().__init__(location, type=gdb.BP_BREAKPOINT, internal=True)
        self.silent = True
        self.location_text = location
        _TRANSITION_PROBE_BPS.append(self)
        _CREATED_BPS.append(self)
        _RUN_SCOPED_BPS.append(self)

    def stop(self) -> bool:
        spec = self.spec
        try:
            self.probe_hits += 1
            event = (spec.get("event") or "").strip()
            node_type = spec.get("node_type", "sync")
            node = None
            if event:
                event_node = _record_transition_event(event)
                gdb.write(
                    f"[ARD][transition-probe] {spec.get('event_message') or '[TRANSITION]'} "
                    f"transition_event={event_node.get('event', event)}\n"
                )
                if node_type == "transition":
                    node = event_node

            if node is None:
                _set_privilege_for_transition_probe_spec(spec)
                node = _record_transition_node(
                    node_type,
                    spec.get("privilege", "unknown"),
                    spec.get("label", ""),
                    func=spec.get("func", ""),
                    file=spec.get("file", ""),
                    fullname=spec.get("fullname", ""),
                    line=spec.get("line", 0),
                    pc=None,
                )
            gdb.write(
                f"[ARD][transition-probe] {spec.get('message') or node.get('label')}\n"
            )
            try:
                self.enabled = False
            except Exception:
                pass
        except Exception as e:
            gdb.write(
                f"[ARD][transition-probe] warning: probe hit failed: {_short_error(e)}\n"
            )
        return False


def _enable_transition_probe(config_path: str) -> bool:
    global _TRANSITION_PROBE_CONFIG_NAME
    global _TRANSITION_PROBE_CONFIG_PATH
    global _TRANSITION_PROBE_CONFIG_COUNT

    try:
        name, resolved_path, resolution_source, specs = _load_transition_probe_config(
            config_path
        )
    except Exception as e:
        gdb.write(f"[ARD][transition-probe] failed to load config: {_short_error(e)}\n")
        return False

    # Re-enabling the same live configuration used to delete every probe and
    # clear the accumulated transition path.  The Inspector can request a
    # refresh while a user also enables the probe manually, so make this exact
    # already-enabled case idempotent.  Use ardb-disable-transition-probe
    # before enabling again when a changed config must be reloaded.
    if (
        _TRANSITION_PROBE_CONFIG_PATH == resolved_path
        and len(_TRANSITION_PROBE_BPS) == len(specs)
        and all(
            getattr(bp, "is_valid", lambda: False)()
            for bp in _TRANSITION_PROBE_BPS
        )
    ):
        gdb.write(
            "[ARD][transition-probe] already enabled, skip reinstall "
            f"(path_nodes={len(_TRANSITION_PATH)})\n"
        )
        return True

    _delete_transition_probe_bps()
    _reset_transition_path()
    _TRANSITION_PROBE_CONFIG_NAME = name
    _TRANSITION_PROBE_CONFIG_PATH = resolved_path
    _TRANSITION_PROBE_CONFIG_COUNT = len(specs)

    try:
        gdb.execute("set breakpoint pending on", to_string=True)
    except Exception:
        pass

    gdb.write(f"[ARD][transition-probe] loaded config: {name}\n")
    if resolution_source not in ("absolute", "cwd"):
        gdb.write(
            f"[ARD][transition-probe] config path fallback: "
            f"{resolution_source} -> {resolved_path}\n"
        )
    for path in {spec.get("fullname", "") for spec in specs}:
        _warn_missing_transition_probe_source(path)

    installed = 0
    failed = 0
    for spec in specs:
        location = spec.get("location") or ""
        try:
            bp = TransitionProbeBP(spec)
            installed += 1
            gdb.write(
                f"[ARD][transition-probe] installed #{bp.number} {location} "
                f"{spec.get('label', '')}\n"
            )
        except Exception as e:
            failed += 1
            gdb.write(
                f"[ARD][transition-probe] warning: failed to install {location} "
                f"{spec.get('label', '')}: {_short_error(e)}\n"
            )

    gdb.write(f"[ARD][transition-probe] enabled: {installed} breakpoints")
    if failed:
        gdb.write(f" ({failed} failed)")
    gdb.write("\n")
    return installed > 0


def _disable_transition_probe():
    count = len(_TRANSITION_PROBE_BPS)
    _delete_transition_probe_bps()
    _reset_transition_path()
    gdb.write(f"[ARD][transition-probe] disabled: deleted {count} breakpoints\n")


def _transition_probe_status():
    valid = 0
    enabled = 0
    entries = []
    for bp in list(_TRANSITION_PROBE_BPS):
        try:
            is_valid = bp.is_valid()
        except Exception:
            is_valid = False
        is_enabled = False
        if is_valid:
            valid += 1
            try:
                is_enabled = bool(bp.enabled)
            except Exception:
                pass
            if is_enabled:
                enabled += 1
        spec = getattr(bp, "spec", {}) or {}
        entries.append({
            "number": getattr(bp, "number", None),
            "valid": is_valid,
            "enabled": is_enabled,
            "location": spec.get("location", ""),
            "label": spec.get("label", ""),
            "type": spec.get("node_type", ""),
            "privilege": spec.get("privilege", ""),
            "hits": int(getattr(bp, "probe_hits", 0)),
        })
    return {
        "total": len(_TRANSITION_PROBE_BPS),
        "configured": _TRANSITION_PROBE_CONFIG_COUNT,
        "valid": valid,
        "enabled": enabled,
        "breakpoints": entries,
        "config_name": _TRANSITION_PROBE_CONFIG_NAME,
        "config_path": _TRANSITION_PROBE_CONFIG_PATH,
        "transition_path_length": len(_TRANSITION_PATH),
    }

# -------------------------
# Commands
# -------------------------

def _parse_trace_symbol(arg):
    sym = (arg or "").strip()
    if len(sym) >= 2 and sym[0] == sym[-1] and sym[0] in ("'", '"'):
        sym = sym[1:-1]
    return sym


def _trace_symbol(sym):
    """Select one observation root without changing runtime instrumentation."""
    global ACTIVE_TRACE_ROOT
    if not sym:
        return False

    try:
        gdb.execute("set pagination off", to_string=True)
        gdb.execute("set debuginfod enabled off", to_string=True)

        # Observation roots are view/snapshot context only. They must never
        # create a node, edge, graph event, or runtime breakpoint.
        ACTIVE_TRACE_ROOT = sym
        gdb.write(f"[ARD] trace root 已切换到 {sym}\n")
        return True
    except Exception as e:
        gdb.write(f"[ARD] warning: trace failed for {sym}: {_short_error(e)}\n")
        return False


def _quote_gdb_break_location(sym):
    # Single quotes preserve Rust symbols containing braces, #, and ::.
    return "'" + sym.replace("\\", "\\\\").replace("'", "\\'") + "'"


class ARDTraceCommand(gdb.Command):
    def __init__(self):
        super().__init__("ardb-trace", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        sym = _parse_trace_symbol(arg)
        if not sym:
            gdb.write("Usage: ardb-trace <function-symbol>\n")
            return
        _trace_symbol(sym)


class ARDTraceBreakCommand(gdb.Command):
    """Combine ardb-trace with a visible ordinary GDB breakpoint."""
    def __init__(self, command_name="ardb-trace-break"):
        super().__init__(command_name, gdb.COMMAND_USER)
        self.command_name = command_name

    def invoke(self, arg, from_tty):
        sym = _parse_trace_symbol(arg)
        if not sym:
            gdb.write(f"Usage: {self.command_name} <symbol>\n")
            return

        trace_ok = _trace_symbol(sym)
        if not trace_ok:
            gdb.write(f"[ARD] warning: continuing with ordinary break after trace failure: {sym}\n")

        try:
            gdb.execute(f"break {_quote_gdb_break_location(sym)}", to_string=False)
            gdb.write(f"[ARD] trace+break root: {sym}\n")
        except Exception as e:
            gdb.write(f"[ARD] warning: break failed for {sym}: {_short_error(e)}\n")


class ARDPrivAddCommand(gdb.Command):
    """
    Add a breakpoint to a privilege breakpoint group.
    Usage: ardb-priv-add <user|kernel> <location> [label]
    Example: ardb-priv-add user *0x27d7a seL4_Uint_Notification_register_async_syscall
    """
    def __init__(self):
        super().__init__("ardb-priv-add", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        try:
            parts = gdb.string_to_argv(arg)
        except Exception:
            parts = arg.split()
        if len(parts) < 2:
            gdb.write("Usage: ardb-priv-add <user|kernel> <location> [label]\n")
            return

        group = parts[0].strip().lower()
        location = parts[1].strip()
        label = " ".join(parts[2:]).strip() if len(parts) > 2 else location
        if group not in ("user", "kernel"):
            gdb.write("[ARD][priv] group must be user or kernel\n")
            return

        try:
            bp = PrivilegeGroupBP(group, location, label)
        except Exception as e:
            gdb.write(f"[ARD][priv] failed to add {group} breakpoint {location}: {e}\n")
            return
        gdb.write(
            f"[ARD][priv] added {group} breakpoint #{bp.number} {location} label={label} enabled={bp.enabled}\n"
        )


class ARDPrivEnableCommand(gdb.Command):
    """
    Enable one privilege breakpoint group.
    Usage: ardb-priv-enable <user|kernel|all|none>
    """
    def __init__(self):
        super().__init__("ardb-priv-enable", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        group = (arg or "").strip().lower()
        if not group:
            group = "user"
        try:
            _set_privilege_group_enabled(group)
        except Exception as e:
            gdb.write(f"[ARD][priv] failed to enable group: {e}\n")
            return
        gdb.write(f"[ARD][priv] active breakpoint group: {_PRIVILEGE_ACTIVE_GROUP}\n")


class ARDPrivResetCommand(gdb.Command):
    """
    Delete privilege breakpoint groups and reset privilege state.
    Usage: ardb-priv-reset
    """
    def __init__(self):
        super().__init__("ardb-priv-reset", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        global _PRIVILEGE_ACTIVE_GROUP
        _clear_privilege_bps()
        _PRIVILEGE_BPS["user"].clear()
        _PRIVILEGE_BPS["kernel"].clear()
        _PRIVILEGE_ACTIVE_GROUP = "user"
        _set_privilege_state("unknown", "none")
        _reset_transition_path()
        gdb.write("[ARD][priv] reset done.\n")


class ARDPrivStatusCommand(gdb.Command):
    """
    Print current privilege state and breakpoint group counts.
    Usage: ardb-priv-status
    """
    def __init__(self):
        super().__init__("ardb-priv-status", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        gdb.write(
            "[ARD][priv] "
            f"state={_PRIVILEGE_STATE} transition={_PRIVILEGE_TRANSITION_EVENT} "
            f"symbol={_PRIVILEGE_LAST_SYMBOL or ''} pc={_PRIVILEGE_LAST_PC or ''} "
            f"active_group={_PRIVILEGE_ACTIVE_GROUP} "
            f"user_bps={len(_PRIVILEGE_BPS.get('user', []))} "
            f"kernel_bps={len(_PRIVILEGE_BPS.get('kernel', []))}\n"
        )


class ARDTransitionResetCommand(gdb.Command):
    """
    Reset the structured cross-privilege transition path.
    Usage: ardb-transition-reset
    """
    def __init__(self):
        super().__init__("ardb-transition-reset", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        _reset_transition_path()
        gdb.write("[ARD][transition] reset done.\n")


class ARDTransitionAddCommand(gdb.Command):
    """
    Add one node to the structured transition path.
    Usage:
      ardb-transition-add type|privilege|label|func|file|fullname|line|pc
    Only the first three fields are required. Use pipe separators so labels
    and symbols may contain spaces.
    """
    def __init__(self):
        super().__init__("ardb-transition-add", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        raw = (arg or "").strip()
        if not raw:
            gdb.write("Usage: ardb-transition-add type|privilege|label|func|file|fullname|line|pc\n")
            return

        parts = [p.strip() for p in raw.split("|")]
        if len(parts) < 3:
            gdb.write("[ARD][transition] need at least type|privilege|label\n")
            return

        while len(parts) < 8:
            parts.append("")

        node_type, privilege, label, func, file, fullname, line, pc = parts[:8]
        node = _record_transition_node(
            node_type,
            privilege,
            label,
            func=func,
            file=file,
            fullname=fullname,
            line=line,
            pc=pc or None,
        )
        gdb.write(
            f"[ARD][transition] added seq={node.get('seq')} "
            f"{node.get('privilege')} {node.get('type')} {node.get('label')}\n"
        )


class ARDTransitionEventCommand(gdb.Command):
    """
    Add a transition event node.
    Usage: ardb-transition-event user_to_kernel
    """
    def __init__(self):
        super().__init__("ardb-transition-event", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        event = (arg or "").strip() or "unknown"
        node = _record_transition_event(event)
        gdb.write(f"[ARD][transition] event seq={node.get('seq')} {event}\n")


class ARDTransitionStatusCommand(gdb.Command):
    """
    Print the current transition path JSON.
    Usage: ardb-transition-status
    """
    def __init__(self):
        super().__init__("ardb-transition-status", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        gdb.write(json.dumps({"transition_path": _get_transition_path_snapshot()}) + "\n")


class ARDEnableTransitionProbeCommand(gdb.Command):
    """
    Load a JSON config and install boundary breakpoints that populate transition_path.
    Usage: ardb-enable-transition-probe <json_path>
    """
    def __init__(self):
        super().__init__("ardb-enable-transition-probe", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        try:
            parts = gdb.string_to_argv(arg)
        except Exception:
            parts = (arg or "").split()
        if len(parts) != 1:
            gdb.write("Usage: ardb-enable-transition-probe <json_path>\n")
            return
        _enable_transition_probe(parts[0])


class ARDDisableTransitionProbeCommand(gdb.Command):
    """
    Delete the configured transition-path probe breakpoints and reset path state.
    Usage: ardb-disable-transition-probe
    """
    def __init__(self):
        super().__init__("ardb-disable-transition-probe", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        _disable_transition_probe()


class ARDTransitionProbeStatusCommand(gdb.Command):
    """
    Print configured transition probe status.
    Usage: ardb-transition-probe-status
    """
    def __init__(self):
        super().__init__("ardb-transition-probe-status", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        gdb.write(json.dumps({"transition_probe": _transition_probe_status()}) + "\n")


class ARDRel4EnableTransitionProbeCommand(gdb.Command):
    """Compatibility wrapper for the default rel4-async transition probe config."""
    def __init__(self):
        super().__init__("ardb-rel4-enable-transition-probe", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        _enable_transition_probe(_REL4_TRANSITION_PROBE_CONFIG)


class ARDRel4DisableTransitionProbeCommand(gdb.Command):
    """Compatibility wrapper for ardb-disable-transition-probe."""
    def __init__(self):
        super().__init__("ardb-rel4-disable-transition-probe", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        _disable_transition_probe()


class ARDRel4TransitionProbeStatusCommand(gdb.Command):
    """Compatibility wrapper preserving the rel4 status JSON field."""
    def __init__(self):
        super().__init__("ardb-rel4-transition-probe-status", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        gdb.write(json.dumps({
            "rel4_transition_probe": _transition_probe_status(),
            "transition_path": _get_transition_path_snapshot(),
        }) + "\n")


class ARDScanTransitionCandidatesCommand(gdb.Command):
    """
    Scan GDB function symbols for possible privilege-transition boundaries.
    Usage: ardb-scan-transition-candidates [output_json]
    """
    def __init__(self):
        super().__init__("ardb-scan-transition-candidates", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        try:
            parts = gdb.string_to_argv(arg)
        except Exception:
            parts = (arg or "").split()
        if len(parts) > 1:
            gdb.write("Usage: ardb-scan-transition-candidates [output_json]\n")
            return

        output_path = parts[0] if parts else _default_transition_candidates_path()
        try:
            path, scanned_count, candidate_count = _write_transition_candidates(output_path)
        except Exception as e:
            gdb.write(
                f"[ARD][transition-candidates] scan failed: {_short_error(e)}\n"
            )
            return

        gdb.write(f"[ARD][transition-candidates] scanned functions: {scanned_count}\n")
        gdb.write(f"[ARD][transition-candidates] candidates: {candidate_count}\n")
        gdb.write(f"[ARD][transition-candidates] output: {path}\n")


class ARDGenerateTransitionProbeDraftCommand(gdb.Command):
    """
    Generate a review-only transition probe draft from candidate scan JSON.
    Usage: ardb-generate-transition-probe-draft <candidates_json> [output_json]
    """
    def __init__(self):
        super().__init__("ardb-generate-transition-probe-draft", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        try:
            parts = gdb.string_to_argv(arg)
        except Exception:
            parts = (arg or "").split()
        if len(parts) not in (1, 2):
            gdb.write(
                "Usage: ardb-generate-transition-probe-draft "
                "<candidates_json> [output_json]\n"
            )
            return

        output_path = (
            parts[1] if len(parts) == 2 else _default_transition_probe_draft_path()
        )
        try:
            path, candidate_count, selected_count = _write_transition_probe_draft(
                parts[0], output_path
            )
        except Exception as e:
            gdb.write(
                f"[ARD][transition-draft] generation failed: {_short_error(e)}\n"
            )
            return

        gdb.write(f"[ARD][transition-draft] loaded candidates: {candidate_count}\n")
        gdb.write(f"[ARD][transition-draft] selected probes: {selected_count}\n")
        gdb.write(f"[ARD][transition-draft] output: {path}\n")
        gdb.write("[ARD][transition-draft] review required before enabling\n")


class ARDResetCommand(gdb.Command):
    def __init__(self):
        super().__init__("ardb-reset", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        global ACTIVE_TRACE_ROOT
        for bp in list(_CREATED_BPS):
            try:
                bp.delete()
            except Exception:
                pass
        _CREATED_BPS.clear()
        _RUN_SCOPED_BPS.clear()
        _RUNTIME_EVENT_BPS.clear()
        _ACTIVE_RUNTIME_EVENT_SYMBOLS.clear()

        _CALLSITE_INSTALLED_FOR_FN.clear()
        ACTIVE_TRACE_ROOT = None

        _invalidate_whitelist_addrs()

        _TLS_STACK.clear()
        _CO_BY_KEY.clear()
        _CO_META.clear()
        _CO_POLL_SEQ.clear()
        _LAST_CHILD_HIT_BY_PARENT.clear()
        _LAST_CHILD_HIT_BY_CALLER_FRAME.clear()
        _LAST_CHILD_HIT_BY_FUNC_ADDR.clear()
        _LAST_CHILD_HIT_BY_STRUCTURED.clear()
        _CHILD_KEY_MISS_LOGGED.clear()
        _clear_privilege_bps()
        _PRIVILEGE_BPS["user"].clear()
        _PRIVILEGE_BPS["kernel"].clear()
        _TRANSITION_PROBE_BPS.clear()
        _clear_transition_probe_metadata()
        global _PRIVILEGE_ACTIVE_GROUP
        _PRIVILEGE_ACTIVE_GROUP = "user"
        _set_privilege_state("unknown", "none")
        _reset_transition_path()
        _clear_call_graph()
        global _CO_NEXT_ID
        _CO_NEXT_ID = 1

        # Preserve the loaded whitelist, then restore only its runtime event
        # instrumentation. ardb-reset does not create a trace root.
        _install_whitelist_runtime_event_breakpoints()

        # Clear log file if exists
        path = _default_log_path()
        if path and os.path.exists(path):
            try:
                with open(path, "w") as f:
                    pass
            except Exception:
                pass

        gdb.write("[ARD] reset done.\n")

class ARDLoadWhitelistCommand(gdb.Command):
    def __init__(self):
        super().__init__("ardb-load-whitelist", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        global _WHITELIST_EXACT, _WHITELIST_PREFIX, _WHITELIST_PATH
        path = arg.strip() or _default_whitelist_path()
        if not path:
            gdb.write("[ARD] whitelist path not provided and ASYNC_RUST_DEBUGGER_TEMP_DIR is not set.\n")
            return

        try:
            wl_exact, wl_prefix = _load_whitelist_file(path)
        except Exception as e:
            gdb.write(f"[ARD] failed to load whitelist: {e}\n")
            return

        _WHITELIST_EXACT = wl_exact
        _WHITELIST_PREFIX = wl_prefix
        _WHITELIST_PATH = path
        _invalidate_whitelist_addrs()

        _install_whitelist_runtime_event_breakpoints()

        gdb.write(f"[ARD] whitelist loaded: exact={len(wl_exact)} prefix={len(wl_prefix)} from {path}\n")


class ARDGenWhitelistCommand(gdb.Command):
    def __init__(self):
        super().__init__("ardb-gen-whitelist", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        try:
            from async_rust_debugger.static_analysis.gen_whitelist import gen_default_whitelist
        except Exception as e:
            gdb.write(f"[ARD] cannot import gen_whitelist: {e}\n")
            return
        try:
            gen_default_whitelist()
            # Populate the async symbol set from the newly generated grouped JSON
            _load_async_symbol_set_from_grouped()
        except Exception as e:
            gdb.write(f"[ARD] gen_default_whitelist failed: {e}\n")

class ARDGetSnapshotCommand(gdb.Command):
    """
    Get a mixed-mode snapshot of the current call stack, including 
    asynchronous coroutines and synchronous function calls.
    Usage: ardb-get-snapshot
    """
    def __init__(self):
        super().__init__("ardb-get-snapshot", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        tid = _thread_id()
        stack = _TLS_STACK.get(tid, [])
        try:
            _log_diag(
                f"[ARD][diag] snapshot enter thread={tid} stack={stack!r} all_tls={_TLS_STACK!r}"
            )
            _log_diag(
                f"[ARD][diag] snapshot observation_root={ACTIVE_TRACE_ROOT!r} "
                f"runtime_event_symbols={sorted(_ACTIVE_RUNTIME_EVENT_SYMBOLS)!r} "
                f"co_by_key={list(_CO_BY_KEY.keys())[:20]!r}"
            )
            _log_diag(
                f"[ARD][diag] snapshot co_meta={dict(list(_CO_META.items())[:20])!r} poll_seq={dict(list(_CO_POLL_SEQ.items())[:20])!r}"
            )
        except Exception as e:
            _log_diag(f"[ARD][diag] snapshot state diag failed: {e!r}")
        
        snapshot = {
            "thread_id": tid,
            "privilege": _PRIVILEGE_STATE,
            "transition_event": _PRIVILEGE_TRANSITION_EVENT,
            "transition_symbol": _PRIVILEGE_LAST_SYMBOL,
            "transition_pc": _PRIVILEGE_LAST_PC,
            "transition_path": _get_transition_path_snapshot(),
            "path": []
        }
        
        # 1. Extract the shadow stack (traced coroutines and functions)
        top_async_func = ""
        for cid in stack:
            poll_sym, this_ptr = _CO_META.get(cid, ("<unknown>", 0))
            seq = _CO_POLL_SEQ.get(cid, 0)
            top_async_func = poll_sym

            node_type = "async" if _is_async_symbol(poll_sym) else "sync"

            state_info = _read_state_with_status(poll_sym, this_ptr)

            # Try to get source location for this async function
            async_file = ""
            async_fullname = ""
            async_line = 0
            try:
                info = gdb.execute(f"info line '{poll_sym}'", to_string=True)
                m = _re_info_line.match(info)
                if m:
                    async_line = int(m.group(1))
                    async_file = m.group(2)
                    # Try to resolve absolute path
                    async_fullname = os.path.abspath(async_file) if async_file else ""
            except Exception:
                pass

            snapshot["path"].append({
                "type": node_type,
                "cid": cid,
                "func": poll_sym,
                "addr": hex(this_ptr),
                "poll": seq,
                **_state_fields(state_info),
                **_child_hit_fields(),
                **_privilege_fields(hex(this_ptr), async_file, async_fullname, poll_sym),
                "origin": "trace",
                "file": async_file,
                "fullname": async_fullname,
                "line": async_line
            })
            
        # 2. Extract the physical stack tail (frames above the top traced function).
        #    Only do this if the shadow stack is non-empty; if nothing has been
        #    traced yet, we should not fabricate nodes from physical frames.
        phys_tail = []
        shadow_cids = set(stack)  # CIDs already on the shadow stack
        if not stack:
            try:
                _log_ard(
                    f"[ARD] warning: snapshot empty stack: thread={tid} all_tls={_TLS_STACK!r} co_meta={dict(list(_CO_META.items())[:20])!r}"
                )
            except Exception as e:
                _log_diag(f"[ARD][diag] snapshot empty-stack diag failed: {e!r}")
            json_output = json.dumps(snapshot) + "\n"
            gdb.write(json_output)
            temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
            if temp_dir:
                snapshot_path = os.path.join(os.getcwd(), temp_dir, "ardb_snapshot.json")
                try:
                    with open(snapshot_path, "w", encoding="utf-8") as f:
                        f.write(json_output)
                except Exception:
                    pass
            return
        try:
            saved_frame = gdb.selected_frame()
            frame = saved_frame
            while frame:
                fname = frame.name()

                # Stop if we reach the entry of the top traced function
                # to avoid duplication with the shadow stack
                if fname == top_async_func:
                    break

                if fname:
                    frame_type = "async" if _is_async_symbol(fname) else "sync"

                    # Get source location from the frame
                    phys_file = ""
                    phys_fullname = ""
                    phys_line = 0
                    try:
                        sal = frame.find_sal()
                        if sal and sal.symtab:
                            phys_file = sal.symtab.filename or ""
                            phys_fullname = sal.symtab.fullname() if hasattr(sal.symtab, 'fullname') else phys_file
                            phys_line = sal.line or 0
                    except Exception:
                        pass

                    node_cid = None
                    node_poll = 0
                    node_state_info = _state_info("NON-ASYNC", "unsupported", "non-async frame")
                    node_addr = hex(frame.pc())

                    if frame_type == "async":
                        # For async frames, try to read the env ptr from the
                        # frame's debug info (first argument / self).
                        # $rdi is unreliable for non-entry frames.
                        node_state_info = _state_info("N/A", "unsupported", "missing future pointer")
                        this_ptr = 0
                        env_val = None

                        try:
                            frame.select()
                            block = frame.block()
                            for sym in block:
                                if sym.is_argument:
                                    val = frame.read_var(sym)
                                    this_ptr = _extract_raw_ptr(val)
                                    if this_ptr:
                                        break
                        except Exception:
                            pass

                        # Fallback to register-based first arg
                        if not this_ptr:
                            try:
                                frame.select()
                                reg_ptr = _reg_u64(_first_arg_reg())
                                if reg_ptr > 0x10000:
                                    this_ptr = reg_ptr
                            except Exception:
                                pass

                        # Additional fallback for inlined async frames:
                        # try to read the hidden __awaitee env object directly
                        if not this_ptr:
                            try:
                                frame.select()
                                env_val = _try_read_env_value_from_frame(frame, fname)
                                if env_val is not None:
                                    node_state_info = _read_state_from_value_with_status(env_val)
                            except Exception:
                                pass

                        if this_ptr:
                            try:
                                cid_phys, is_new = _get_or_make_coro_id(fname, this_ptr)

                                if is_new:
                                    nearby = _find_nearby_coro(fname, this_ptr)
                                    if nearby is not None and nearby != cid_phys:
                                        key_new = (fname, int(this_ptr))
                                        _CO_BY_KEY.pop(key_new, None)
                                        _CO_META.pop(cid_phys, None)
                                        _CO_POLL_SEQ.pop(cid_phys, None)
                                        cid_phys = nearby

                                if cid_phys not in shadow_cids:
                                    node_cid = cid_phys
                                    node_poll = _CO_POLL_SEQ.get(cid_phys, 0)
                                    node_addr = hex(this_ptr)
                                    node_state_info = _read_state_with_status(fname, this_ptr)
                            except Exception:
                                pass

                    # Try to expand the currently awaited inner future as an extra leaf node.
                    try:
                        frame.select()
                        local_awaitee = _try_read_local_awaitee_value(frame)
                    except Exception:
                        local_awaitee = None

                    if local_awaitee is not None:
                        try:
                            awaitee_type = _value_type_name(local_awaitee)
                            outer_env_type = _pollsym_to_envtype(fname) or ""

                            if awaitee_type and awaitee_type != outer_env_type:
                                awaitee_state = _value_state_name(local_awaitee)
                                awaitee_state_info = (
                                    _state_info(awaitee_state, "ok", "")
                                    if _is_valid_state_value(awaitee_state)
                                    else _state_info("N/A", "unsupported", "no runtime future object")
                                )
                                awaitee_poll_sym = _child_poll_symbol_from_awaitee_type(awaitee_type)
                                leaf_func = awaitee_poll_sym or awaitee_type

                                leaf_cid = None
                                leaf_poll = 0
                                leaf_addr = f"{node_addr}::awaitee::{leaf_func}"
                                leaf_state_info = awaitee_state_info
                                leaf_origin = "inferred"
                                child_env_addr = ""
                                try:
                                    inferred_child_ptr = _extract_raw_ptr(local_awaitee)
                                    if inferred_child_ptr:
                                        child_env_addr = hex(inferred_child_ptr)
                                except Exception:
                                    child_env_addr = ""
                                parent_cid_for_hit = (
                                    node_cid
                                    if node_cid is not None
                                    else _find_coro_id_for_symbol_addr(fname, node_addr)
                                )
                                child_hit = _child_hit_fields(
                                    "miss",
                                    tid,
                                    parent_cid_for_hit,
                                    fname,
                                    leaf_func,
                                    child_env_addr,
                                )

                                observed = _find_structured_child_hit(
                                    tid,
                                    parent_cid_for_hit,
                                    fname,
                                    leaf_func,
                                    child_env_addr,
                                )
                                if observed and observed.get("func") == leaf_func:
                                    leaf_cid = observed.get("cid")
                                    leaf_poll = observed.get("poll", 0)
                                    leaf_addr = observed.get("addr") or leaf_addr
                                    leaf_state_info = _merge_state_info_from_observed(leaf_state_info, observed)
                                    leaf_origin = "trace-upgraded"
                                    child_hit = _child_hit_fields(
                                        "structured",
                                        observed.get("thread_id", tid),
                                        observed.get("parent_cid", parent_cid_for_hit),
                                        observed.get("parent_symbol", fname),
                                        observed.get("child_symbol", leaf_func),
                                        observed.get("child_env_addr") or observed.get("addr") or child_env_addr,
                                    )
                                    _log_ard(
                                        f"[ARD] snapshot-upgrade structured parent={fname} child={leaf_func} cid={leaf_cid} poll={leaf_poll} addr={leaf_addr}"
                                    )
                                else:
                                    observed = (
                                        _LAST_CHILD_HIT_BY_CALLER_FRAME.get(fname)
                                        or _LAST_CHILD_HIT_BY_PARENT.get(fname)
                                    )
                                    if observed and observed.get("func") == leaf_func:
                                        leaf_cid = observed.get("cid")
                                        leaf_poll = observed.get("poll", 0)
                                        leaf_addr = observed.get("addr") or leaf_addr
                                        leaf_state_info = _merge_state_info_from_observed(leaf_state_info, observed)
                                        leaf_origin = "trace-upgraded"
                                        child_hit = _child_hit_fields(
                                            "legacy_fallback",
                                            tid,
                                            parent_cid_for_hit,
                                            fname,
                                            leaf_func,
                                            observed.get("addr") or child_env_addr,
                                        )
                                        _log_ard(
                                            f"[ARD] snapshot-upgrade legacy parent={fname} child={leaf_func} cid={leaf_cid} poll={leaf_poll} addr={leaf_addr}"
                                        )
                                    else:
                                        observed_by_key = _LAST_CHILD_HIT_BY_FUNC_ADDR.get((leaf_func, node_addr))
                                        if observed_by_key:
                                            leaf_cid = observed_by_key.get("cid")
                                            leaf_poll = observed_by_key.get("poll", 0)
                                            leaf_addr = observed_by_key.get("addr") or leaf_addr
                                            leaf_state_info = _merge_state_info_from_observed(leaf_state_info, observed_by_key)
                                            leaf_origin = "trace-upgraded"
                                            child_hit = _child_hit_fields(
                                                "legacy_fallback",
                                                tid,
                                                parent_cid_for_hit,
                                                fname,
                                                leaf_func,
                                                observed_by_key.get("addr") or child_env_addr,
                                            )
                                            _log_ard(
                                                f"[ARD] snapshot-upgrade-by-child-key fallback child={leaf_func} cid={leaf_cid} poll={leaf_poll} addr={leaf_addr}"
                                            )
                                        elif _should_log_child_key_miss(leaf_func, node_addr):
                                            _log_ard(
                                                f"[ARD] snapshot-upgrade miss child={leaf_func} parent={fname} parent_cid={parent_cid_for_hit} child_addr={child_env_addr} node_addr={node_addr}"
                                            )

                                # If the next real async frame is already this same child poll,
                                # do not also append an inferred awaitee leaf.
                                if _has_existing_real_async_child(snapshot["path"], phys_tail, leaf_func):
                                    _log_ard(
                                        f"[ARD] awaitee-skip-duplicate parent={fname} child={leaf_func}"
                                    )
                                else:
                                    _log_ard(
                                        f"[ARD] awaitee-phys {fname} -> type={awaitee_type} poll={awaitee_poll_sym} state={awaitee_state}"
                                    )

                                    phys_tail.append({
                                        "type": "async",
                                        "cid": leaf_cid,
                                        "func": leaf_func,
                                        "addr": leaf_addr,
                                        "poll": leaf_poll,
                                        **_state_fields(leaf_state_info),
                                        **child_hit,
                                        **_privilege_fields(leaf_addr, phys_file, phys_fullname, leaf_func),
                                        "origin": leaf_origin,
                                        "file": phys_file,
                                        "fullname": phys_fullname,
                                        "line": phys_line
                                    })
                        except Exception:
                            pass

                    if node_cid is not None and node_poll == 0:
                        filled_poll = _CO_POLL_SEQ.get(node_cid, node_poll)
                        if filled_poll != 0:
                            node_poll = filled_poll
                            _log_ard(
                                f"[ARD] snapshot-fill-poll cid={node_cid} poll={node_poll} func={fname}"
                            )

                    phys_tail.append({
                        "type": frame_type,
                        "cid": node_cid,
                        "func": fname,
                        "addr": node_addr,
                        "poll": node_poll,
                        **_state_fields(node_state_info),
                        **_child_hit_fields(),
                        **_privilege_fields(node_addr, phys_file, phys_fullname, fname),
                        "origin": "physical",
                        "file": phys_file,
                        "fullname": phys_fullname,
                        "line": phys_line
                    })
                frame = frame.older()

            # Restore the originally selected frame
            try:
                saved_frame.select()
            except Exception:
                pass
        except Exception:
            pass

        # Physical frames are captured in reverse order (deepest first),
        # so we reverse them before appending to the path.
        snapshot["path"].extend(reversed(phys_tail))
            
        # Output pure JSON for the Debug Adapter
        json_output = json.dumps(snapshot) + "\n"
        gdb.write(json_output)
        
        # Also write to file if ASYNC_RUST_DEBUGGER_TEMP_DIR is set (for DA integration)
        temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
        if temp_dir:
            snapshot_path = os.path.join(os.getcwd(), temp_dir, "ardb_snapshot.json")
            try:
                with open(snapshot_path, "w", encoding="utf-8") as f:
                    f.write(json_output)
            except Exception:
                pass  # Best-effort file write, don't fail if it doesn't work


def _get_full_snapshot_from_command():
    output = gdb.execute("ardb-get-snapshot", to_string=True)
    json_start = output.find("{")
    json_end = output.rfind("}")
    if json_start < 0 or json_end <= json_start:
        raise ValueError("ardb-get-snapshot did not return JSON")
    snapshot = json.loads(output[json_start:json_end + 1])
    if not isinstance(snapshot, dict):
        raise ValueError("ardb-get-snapshot returned a non-object JSON value")
    return snapshot


def _snapshot_context_fields(snapshot: dict):
    return {
        "thread_id": snapshot.get("thread_id", 0),
        "privilege": snapshot.get("privilege", "unknown"),
        "transition_event": snapshot.get("transition_event", "none"),
        "transition_symbol": snapshot.get("transition_symbol", ""),
        "transition_pc": snapshot.get("transition_pc", ""),
    }


class ARDGetSnapshotPathCommand(gdb.Command):
    """
    Get only the async execution path portion of the current snapshot.
    Usage: ardb-get-snapshot-path
    """
    def __init__(self):
        super().__init__("ardb-get-snapshot-path", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        try:
            snapshot = _get_full_snapshot_from_command()
            result = _snapshot_context_fields(snapshot)
            path = snapshot.get("path")
            result["path"] = path if isinstance(path, list) else []
            gdb.write(json.dumps(result) + "\n")
        except Exception as e:
            gdb.write(f"[ARD] failed to get snapshot path: {_short_error(e)}\n")


class ARDGetTransitionChainCommand(gdb.Command):
    """
    Get only the cross-privilege transition chain portion of the current snapshot.
    Usage: ardb-get-transition-chain
    """
    def __init__(self):
        super().__init__("ardb-get-transition-chain", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        try:
            snapshot = _get_full_snapshot_from_command()
            result = _snapshot_context_fields(snapshot)
            transition_path = snapshot.get("transition_path")
            result["transition_path"] = (
                transition_path if isinstance(transition_path, list) else []
            )
            gdb.write(json.dumps(result) + "\n")
        except Exception as e:
            gdb.write(f"[ARD] failed to get transition chain: {_short_error(e)}\n")


class ARDGetHistoryTreeCommand(gdb.Command):
    """
    Get the cumulative runtime function call graph.
    Usage: ardb-get-history-tree
    """
    def __init__(self):
        super().__init__("ardb-get-history-tree", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        try:
            result = _export_call_graph()
            result["validation"] = _validate_call_graph()
            gdb.write(json.dumps(result) + "\n")
        except Exception as e:
            gdb.write(json.dumps({
                "type": "history_tree",
                "roots": [],
                "events_count": len(_CALL_GRAPH_EVENTS),
                "nodes_count": len(_CALL_GRAPH_NODES),
                "roots_count": 0,
                "stable_roots_count": 0,
                "edges_count": len(_CALL_GRAPH_EDGES),
                "graph_kind": "call_graph",
                "error": _short_error(e),
                "validation": _validate_call_graph(),
            }) + "\n")


class ARDValidateHistoryTreeCommand(gdb.Command):
    """Validate the filtered runtime History Tree without changing it."""
    def __init__(self):
        super().__init__("ardb-validate-history-tree", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        result = _validate_call_graph()
        stats = result["stats"]
        gdb.write(
            "[ARD][GRAPH VALIDATOR] "
            f"ok={str(result['ok']).lower()} "
            f"nodes={stats['nodes_count']} edges={stats['edges_count']} "
            f"roots={stats['roots_count']} events={stats['events_count']}\n"
        )
        for message in result["errors"]:
            gdb.write(f"[ARD][GRAPH VALIDATOR][ERROR] {message}\n")
        for message in result["warnings"]:
            gdb.write(f"[ARD][GRAPH VALIDATOR][WARNING] {message}\n")


class ARDClearHistoryTreeCommand(gdb.Command):
    """
    Clear the runtime event history tree.
    Usage: ardb-clear-history-tree
    """
    def __init__(self):
        super().__init__("ardb-clear-history-tree", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        _clear_call_graph()
        gdb.write(json.dumps({
            "type": "history_tree",
            "roots": [],
            "events_count": 0,
            "nodes_count": 0,
            "roots_count": 0,
            "stable_roots_count": 0,
            "edges_count": 0,
            "graph_kind": "call_graph",
            "cleared": True,
        }) + "\n")


class ARDGetGroupedWhitelistCommand(gdb.Command):
    """
    Return the grouped whitelist JSON (crate-level grouping with user-crate detection).
    Reads poll_functions_grouped.json from the temp directory.
    Usage: ardb-get-whitelist-grouped
    """
    def __init__(self):
        super().__init__("ardb-get-whitelist-grouped", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
        if not temp_dir:
            gdb.write('[ARD] ASYNC_RUST_DEBUGGER_TEMP_DIR is not set.\n')
            return

        grouped_path = os.path.join(os.getcwd(), temp_dir, "poll_functions_grouped.json")
        if not os.path.exists(grouped_path):
            gdb.write('[ARD] grouped whitelist not found. Run ardb-gen-whitelist first.\n')
            return

        try:
            with open(grouped_path, "r", encoding="utf-8") as fp:
                content = fp.read()
            # Ensure async symbol set is populated when grouped whitelist is read
            if _ASYNC_SYMBOL_SET is None:
                _load_async_symbol_set_from_grouped()
            gdb.write(content + "\n")
        except Exception as e:
            gdb.write(f'[ARD] failed to read grouped whitelist: {e}\n')


class ARDUpdateWhitelistCommand(gdb.Command):
    """
    Update the runtime whitelist based on enabled crates.
    Reads the grouped JSON, filters to enabled crates, writes flat poll_functions.txt,
    and reloads the whitelist.
    Usage: ardb-update-whitelist {"enabled_crates": ["my_app", "my_lib"]}
    """
    def __init__(self):
        super().__init__("ardb-update-whitelist", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        global _WHITELIST_EXACT, _WHITELIST_PREFIX, _WHITELIST_PATH

        temp_dir = os.environ.get("ASYNC_RUST_DEBUGGER_TEMP_DIR")
        if not temp_dir:
            gdb.write('[ARD] ASYNC_RUST_DEBUGGER_TEMP_DIR is not set.\n')
            return

        cwd = os.getcwd()
        grouped_path = os.path.join(cwd, temp_dir, "poll_functions_grouped.json")
        flat_path = os.path.join(cwd, temp_dir, "poll_functions.txt")

        if not os.path.exists(grouped_path):
            gdb.write('[ARD] grouped whitelist not found. Run ardb-gen-whitelist first.\n')
            return

        # Parse the enabled crates from the argument
        arg = arg.strip()
        if not arg:
            gdb.write('Usage: ardb-update-whitelist {"enabled_crates": ["crate1", ...]}\n')
            return

        try:
            payload = json.loads(arg)
            enabled_crates = set(payload.get("enabled_crates", []))
        except Exception as e:
            gdb.write(f'[ARD] failed to parse argument: {e}\n')
            return

        # Read grouped JSON
        try:
            with open(grouped_path, "r", encoding="utf-8") as fp:
                grouped_data = json.load(fp)
        except Exception as e:
            gdb.write(f'[ARD] failed to read grouped whitelist: {e}\n')
            return

        # Write filtered flat whitelist
        idx = 0
        try:
            with open(flat_path, "w", encoding="utf-8") as fp:
                for crate_name, crate_info in grouped_data.get("crates", {}).items():
                    if crate_name not in enabled_crates:
                        continue
                    for sym_info in crate_info.get("symbols", []):
                        fp.write(f"{idx} {sym_info['name']}\n")
                        idx += 1
        except Exception as e:
            gdb.write(f'[ARD] failed to write filtered whitelist: {e}\n')
            return

        # Reload the whitelist
        try:
            wl_exact, wl_prefix = _load_whitelist_file(flat_path)
            _WHITELIST_EXACT = wl_exact
            _WHITELIST_PREFIX = wl_prefix
            _WHITELIST_PATH = flat_path
            _invalidate_whitelist_addrs()
            _install_whitelist_runtime_event_breakpoints()
        except Exception as e:
            gdb.write(f'[ARD] failed to reload whitelist: {e}\n')
            return

        gdb.write(f'[ARD] whitelist updated: {len(enabled_crates)} crates enabled, {idx} symbols -> {flat_path}\n')


class ARDInferTraceRootCommand(gdb.Command):
    """
    Infer the trace root by walking the GDB stack from the current breakpoint position.
    Finds the outermost user-crate async function in the call stack.
    Usage: ardb-infer-trace-root
    """
    def __init__(self):
        super().__init__("ardb-infer-trace-root", gdb.COMMAND_USER)

    def invoke(self, arg, from_tty):
        from async_rust_debugger.static_analysis.gen_whitelist import (
            _extract_crate_name, KNOWN_FRAMEWORK_CRATES
        )

        all_async_frames = []
        outermost_user_async = None
        max_frames = 100

        try:
            frame = gdb.selected_frame()
            count = 0
            while frame and count < max_frames:
                fname = frame.name()
                if fname and ("{async_fn#" in fname or "{async_block#" in fname):
                    all_async_frames.append(fname)
                    # Check if this is a user-crate async function
                    crate_name = _extract_crate_name(fname)
                    if crate_name not in KNOWN_FRAMEWORK_CRATES:
                        outermost_user_async = fname  # keep overwriting → outermost wins
                frame = frame.older()
                count += 1
        except Exception:
            pass

        result = {
            "trace_root": outermost_user_async,
            "all_async_frames": all_async_frames,
        }

        gdb.write(json.dumps(result) + "\n")


# -------------------------
# Entry
# -------------------------

def install():
    global _EVENTS_INSTALLED

    gdb.execute("set pagination off", to_string=True)
    gdb.execute("set debuginfod enabled off", to_string=True)

    ARDTraceCommand()
    ARDTraceBreakCommand()
    ARDTraceBreakCommand("ardb-tb")
    ARDPrivAddCommand()
    ARDPrivEnableCommand()
    ARDPrivResetCommand()
    ARDPrivStatusCommand()
    ARDTransitionResetCommand()
    ARDTransitionAddCommand()
    ARDTransitionEventCommand()
    ARDTransitionStatusCommand()
    ARDEnableTransitionProbeCommand()
    ARDDisableTransitionProbeCommand()
    ARDTransitionProbeStatusCommand()
    ARDRel4EnableTransitionProbeCommand()
    ARDRel4DisableTransitionProbeCommand()
    ARDRel4TransitionProbeStatusCommand()
    ARDScanTransitionCandidatesCommand()
    ARDGenerateTransitionProbeDraftCommand()
    ARDResetCommand()
    ARDLoadWhitelistCommand()
    ARDGenWhitelistCommand()
    ARDGetSnapshotCommand()
    ARDGetSnapshotPathCommand()
    ARDGetTransitionChainCommand()
    ARDGetHistoryTreeCommand()
    ARDValidateHistoryTreeCommand()
    ARDClearHistoryTreeCommand()
    ARDGetGroupedWhitelistCommand()
    ARDUpdateWhitelistCommand()
    ARDInferTraceRootCommand()

    if not _EVENTS_INSTALLED:
        try:
            gdb.events.exited.connect(_on_exited)
        except Exception:
            pass
        try:
            gdb.events.new_objfile.connect(_on_new_objfile)
        except Exception:
            pass
        _EVENTS_INSTALLED = True

    gdb.write("[ARD] installed. Commands: ardb-gen-whitelist, ardb-load-whitelist, ardb-trace, ardb-trace-break, ardb-tb, ardb-get-snapshot, ardb-get-snapshot-path, ardb-get-transition-chain, ardb-get-history-tree, ardb-validate-history-tree, ardb-clear-history-tree, ardb-reset, ardb-get-whitelist-grouped, ardb-update-whitelist, ardb-infer-trace-root, ardb-priv-add, ardb-priv-enable, ardb-priv-reset, ardb-priv-status, ardb-transition-reset, ardb-transition-add, ardb-transition-event, ardb-transition-status, ardb-enable-transition-probe, ardb-disable-transition-probe, ardb-transition-probe-status, ardb-rel4-enable-transition-probe, ardb-rel4-disable-transition-probe, ardb-rel4-transition-probe-status, ardb-scan-transition-candidates, ardb-generate-transition-probe-draft\n")
