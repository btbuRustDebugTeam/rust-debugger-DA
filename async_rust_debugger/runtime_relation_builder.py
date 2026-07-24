"""Pure-fact orchestration for async relation validation and storage."""

from copy import deepcopy

from async_rust_debugger.runtime_relation_validator import RuntimeRelationValidator


class RuntimeRelationBuilder:
    """Validate detached facts and write only successful results to a store."""

    def __init__(self, store):
        self._store = store

    def build(self, parent_node: dict, child_hit: dict, minimum_event_id: int):
        parent_copy = deepcopy(parent_node)
        hit_copy = deepcopy(child_hit)
        validation = RuntimeRelationValidator.validate_await_relation(
            parent_copy,
            hit_copy,
            minimum_event_id,
        )
        if validation.get("matched") is True:
            self._store.add_validated_relation(validation, parent_copy, hit_copy)
        return deepcopy(validation)

