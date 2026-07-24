"""Read-only projection of validated relations onto Snapshot path copies."""

from copy import deepcopy


def _unknown_relation(parent, child):
    return {
        "kind": "unknown",
        "confidence": "unknown",
        "parent_cid": parent.get("cid") if isinstance(parent, dict) else None,
        "child_cid": child.get("cid") if isinstance(child, dict) else None,
        "child_future_address": (
            child.get("future_address") if isinstance(child, dict) else None
        ),
        "evidence": [],
    }


def _matches(parent, child, relation):
    if not all(isinstance(value, dict) for value in (parent, child, relation)):
        return False
    if relation.get("kind") != "await" or relation.get("confidence") != "observed":
        return False
    evidence = relation.get("evidence")
    if not isinstance(evidence, list) or not all(isinstance(item, str) for item in evidence):
        return False
    return (
        parent.get("cid") == relation.get("parent_cid")
        and parent.get("function") == relation.get("parent_symbol")
        and parent.get("future_address") == relation.get("parent_address")
        and child.get("cid") == relation.get("child_cid")
        and child.get("function") == relation.get("child_symbol")
        and child.get("future_address") == relation.get("child_address")
    )


def project_snapshot_relations(async_path, relation_records):
    """Return a projected deep copy without reading GDB or mutating inputs."""
    if not isinstance(async_path, list):
        return []

    projected = deepcopy(async_path)
    records = deepcopy(relation_records) if isinstance(relation_records, list) else []

    for index, child in enumerate(projected):
        if not isinstance(child, dict):
            continue
        if index == 0:
            child["relation_from_parent"] = {
                "kind": "root",
                "confidence": "observed",
                "parent_cid": None,
                "child_cid": None,
                "child_future_address": None,
                "evidence": ["path-root"],
            }
            child["edge_from_parent"] = None
            continue

        parent = projected[index - 1]
        matched = next(
            (relation for relation in records if _matches(parent, child, relation)),
            None,
        )
        if matched is None:
            child["relation_from_parent"] = _unknown_relation(parent, child)
            child["edge_from_parent"] = "unknown"
            continue

        child["relation_from_parent"] = {
            "kind": "await",
            "confidence": "observed",
            "parent_cid": matched["parent_cid"],
            "child_cid": matched["child_cid"],
            "child_future_address": matched["child_address"],
            "evidence": deepcopy(matched["evidence"]),
        }
        child["edge_from_parent"] = "await"

    return projected

