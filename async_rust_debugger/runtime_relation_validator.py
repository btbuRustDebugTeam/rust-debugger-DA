"""Pure validation of an awaitee candidate against a runtime child hit."""

from typing import Any, Dict, Optional


def _result(matched: bool, reason: Optional[str], evidence=None) -> Dict[str, Any]:
    return {
        "matched": matched,
        "relation_kind": "await" if matched else None,
        "confidence": "observed" if matched else "unknown",
        "reason": reason,
        "evidence": list(evidence or ()),
    }


def _positive_int(value) -> Optional[int]:
    if isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if parsed > 0 else None


def _canonical_address(value) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    if not text.startswith("0x"):
        return None
    try:
        address = int(text, 16)
    except ValueError:
        return None
    return hex(address) if address > 0 else None


def _canonical_type(value) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = " ".join(value.strip().split())
    for prefix in ("struct ", "class ", "union ", "enum "):
        if text.startswith(prefix):
            text = text[len(prefix):]
            break
    return text or None


class RuntimeRelationValidator:
    """Validate facts without reading or modifying runtime state."""

    @staticmethod
    def validate_await_relation(parent_node: dict, child_hit: dict,
                                minimum_event_id: int) -> Dict[str, Any]:
        if not isinstance(parent_node, dict):
            return _result(False, "missing_parent_node")
        if not isinstance(child_hit, dict):
            return _result(False, "missing_child_hit")

        candidate = parent_node.get("awaitee_candidate")
        if not isinstance(candidate, dict):
            return _result(False, "missing_awaitee_candidate")
        if (
            candidate.get("source") != "dwarf-active-variant-field"
            or candidate.get("confidence") != "high"
        ):
            return _result(False, "untrusted_awaitee_candidate")

        parent_thread = _positive_int(parent_node.get("thread_id"))
        hit_thread = _positive_int(child_hit.get("thread_id"))
        if parent_thread is None or hit_thread is None or parent_thread != hit_thread:
            return _result(False, "thread_mismatch")

        parent_cid = _positive_int(parent_node.get("cid"))
        hit_parent_cid = _positive_int(child_hit.get("parent_cid"))
        if parent_cid is None or hit_parent_cid is None or parent_cid != hit_parent_cid:
            return _result(False, "parent_cid_mismatch")

        parent_symbol = parent_node.get("function")
        hit_parent_symbol = child_hit.get("parent_symbol")
        if (
            not isinstance(parent_symbol, str)
            or not parent_symbol
            or parent_symbol != hit_parent_symbol
        ):
            return _result(False, "parent_symbol_mismatch")

        parent_address = _canonical_address(parent_node.get("future_address"))
        hit_parent_address = _canonical_address(child_hit.get("parent_address"))
        if parent_address is None or parent_address != hit_parent_address:
            return _result(False, "parent_address_mismatch")

        candidate_address = _canonical_address(candidate.get("address"))
        child_address = _canonical_address(child_hit.get("child_address"))
        if candidate_address is None:
            return _result(False, "missing_candidate_address")
        if child_address is None or candidate_address != child_address:
            return _result(False, "candidate_address_mismatch")

        candidate_type = _canonical_type(candidate.get("type"))
        child_type = _canonical_type(child_hit.get("child_type"))
        if candidate_type is None:
            return _result(False, "missing_candidate_type")
        if child_type is None or candidate_type != child_type:
            return _result(False, "child_type_mismatch")

        if child_hit.get("source") != "poll-entry-direct-parent":
            return _result(False, "invalid_child_hit_source")
        if _positive_int(child_hit.get("child_cid")) is None:
            return _result(False, "invalid_child_cid")
        if not isinstance(child_hit.get("child_symbol"), str) or not child_hit.get("child_symbol"):
            return _result(False, "missing_child_symbol")
        if _positive_int(child_hit.get("child_poll_sequence")) is None:
            return _result(False, "invalid_child_poll_sequence")

        event_id = _positive_int(child_hit.get("event_id"))
        event_floor = _positive_int(minimum_event_id)
        if event_floor is None:
            return _result(False, "missing_freshness_window")
        if event_id is None:
            return _result(False, "invalid_event_id")
        if event_id < event_floor:
            return _result(False, "stale_child_hit")

        return _result(True, None, [
            "same-thread",
            "parent-cid-match",
            "parent-symbol-match",
            "parent-address-match",
            "candidate-address-match",
            "candidate-type-match",
            "child-cid-present",
            "child-poll-hit",
            "event-id-fresh",
        ])
