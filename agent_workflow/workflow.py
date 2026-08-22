"""Workflow capability selection under ``workflow_mode: main``.

The main conversation is the only capability selector: it writes the
complete list of capabilities into ``workflow_request`` and this module
turns that into ordered evidence/role work with each capability's steps.
There is no suppression logic here and none is needed -- the main
conversation can already omit an entire capability from the request, which
is strictly more powerful than any runtime-side suppression could be.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Mapping

POLICY_PATH = Path(__file__).resolve().parent.parent / "schemas" / "workflow-policy.json"
POLICY_VERSION = 4


def main_controlled(task: Mapping[str, Any]) -> bool:
    return str(task.get("workflow_mode", "")).casefold() == "main"


def load_policy(path: str | Path = POLICY_PATH) -> dict[str, Any]:
    policy = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if policy.get("version") != POLICY_VERSION or not isinstance(policy.get("capabilities"), list):
        raise ValueError(f"workflow policy must declare version {POLICY_VERSION} and capabilities")
    names = [item.get("name") for item in policy["capabilities"]]
    if any(not isinstance(name, str) or not name for name in names) or len(names) != len(set(names)):
        raise ValueError("workflow capabilities must have unique non-empty names")
    known = set(names)
    seen_steps: set[str] = set()
    for item in policy["capabilities"]:
        if item.get("kind") not in {"evidence", "role"}:
            raise ValueError(f"workflow capability needs kind evidence|role: {item.get('name')}")
        if not str(item.get("section", "")).strip():
            raise ValueError(f"workflow capability needs a section: {item.get('name')}")
        for dependency in item.get("order_after", []):
            if dependency not in known:
                raise ValueError(f"workflow capability has unknown order_after: {dependency}")
        for step in item.get("steps", []):
            step_id = str(step.get("id", ""))
            if not re.fullmatch(r"[A-Z]{2}[0-9]+", step_id):
                raise ValueError(f"workflow step needs an id like SC1: {step_id!r}")
            if step_id in seen_steps:
                raise ValueError(f"duplicate workflow step id: {step_id}")
            seen_steps.add(step_id)
    return policy


def _predecessors(name: str, order_after: Mapping[str, list[str]], seen: set[str] | None = None) -> set[str]:
    """Transitive closure, so ordering survives an absent intermediate capability."""
    seen = seen if seen is not None else set()
    for dependency in order_after.get(name, []):
        if dependency in seen:
            continue
        seen.add(dependency)
        _predecessors(dependency, order_after, seen)
    return seen


def order(names: list[str], order_after: Mapping[str, list[str]]) -> list[str]:
    pending = {name: _predecessors(name, order_after) & set(names) for name in names}
    ordered: list[str] = []
    while pending:
        ready = sorted(name for name, deps in pending.items() if not (deps & pending.keys()))
        if not ready:
            raise ValueError("workflow capability order cycle")
        ordered.extend(ready)
        for name in ready:
            pending.pop(name)
    return ordered


def _facts(task: Mapping[str, Any]) -> dict[str, Any]:
    """Declared facts only -- the agent's own ``workflow_facts`` JSON blob.

    There is no observed-fact collection in main mode: the main conversation
    already decided which capabilities apply by writing ``workflow_request``.
    Step selection inside a selected capability is a strictly weaker,
    declared-only refinement of that same decision.
    """
    raw = task.get("workflow_facts")
    if not raw:
        return {}
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _member(value: Any, expected: list[Any]) -> bool:
    if isinstance(value, str):
        return value.casefold() in {str(item).casefold() for item in expected}
    if isinstance(value, (list, tuple, set, frozenset)):
        actual = {str(item).casefold() for item in value}
        return bool(actual.intersection(str(item).casefold() for item in expected))
    return value in expected


def _rank(policy: Mapping[str, Any], kind: str, value: Any) -> int | None:
    return policy.get(f"{kind}_rank", {}).get(str(value).casefold())


def _condition(policy: Mapping[str, Any], task: Mapping[str, Any], facts: Mapping[str, Any],
              condition: Mapping[str, Any]) -> bool | None:
    """Evaluate one condition to True / False / None (cannot be proven).

    An unproven ``fact`` (the agent never declared it) returns None, not
    False: an unproven condition must never be able to drop a step, only a
    condition that is actively disproven can.
    """
    if "not" in condition:
        inner = _condition(policy, task, facts, condition["not"])
        return None if inner is None else not inner
    if condition.get("always") is True:
        return True
    if "fact" in condition:
        name = str(condition["fact"])
        if name not in facts:
            return None
        return _member(facts[name], list(condition.get("equals", [])))
    if "change_kind" in condition:
        return _member(str(task.get("change_kind", "")), list(condition["change_kind"]))
    if "risk_flags" in condition:
        flags = {str(value).casefold() for value in task.get("risk_flags", [])}
        return bool(flags.intersection(str(item).casefold() for item in condition["risk_flags"]))
    if "impact_effect" in condition:
        return _member(str(task.get("impact_effect", "")), list(condition["impact_effect"]))
    if "impact_scope" in condition:
        return _member(str(task.get("impact_scope", "")), list(condition["impact_scope"]))
    for key, kind, source in (("impact_scope_at_least", "scope", "impact_scope"),
                               ("impact_effect_at_least", "effect", "impact_effect")):
        if key in condition:
            actual = _rank(policy, kind, task.get(source, ""))
            threshold = _rank(policy, kind, condition[key])
            if actual is None or threshold is None:
                return None
            return actual >= threshold
    return False


def _groups(policy: Mapping[str, Any], task: Mapping[str, Any], facts: Mapping[str, Any],
           groups: list[list[Mapping[str, Any]]]) -> bool | None:
    """OR across groups, AND inside a group. None when nothing matched but something is unproven."""
    unproven = False
    for group in groups:
        states = [_condition(policy, task, facts, condition) for condition in group]
        if states and all(state is True for state in states):
            return True
        if any(state is None for state in states) and not any(state is False for state in states):
            unproven = True
    return None if unproven else False


def selected_steps(policy: Mapping[str, Any], task: Mapping[str, Any], facts: Mapping[str, Any],
                   capability: Mapping[str, Any]) -> list[dict[str, str]]:
    """Inner selection. An unproven condition keeps the step: unknown is never treated as no."""
    chosen = []
    for step in capability.get("steps", []):
        state = _groups(policy, task, facts, step.get("when", []))
        if state is not False:
            chosen.append({"id": str(step["id"]), "title": str(step.get("title", ""))})
    return chosen


def manual_plan(task: Mapping[str, Any], policy_path: str | Path = POLICY_PATH) -> dict[str, Any]:
    """Build exactly the capabilities selected by the main conversation."""
    policy = load_policy(policy_path)
    facts = _facts(task)
    requested = {str(name) for name in task.get("workflow_request", [])}
    capabilities = {str(item["name"]): item for item in policy["capabilities"]}
    selected = [{"name": name, "kind": str(item["kind"]), "section": str(item["section"]),
                 "steps": selected_steps(policy, task, facts, item), "reason": "selected by the main conversation"}
                for name, item in capabilities.items() if name in requested]
    ordered = order([item["name"] for item in selected],
                    {str(item["name"]): list(item.get("order_after", [])) for item in policy["capabilities"]})
    selected.sort(key=lambda item: ordered.index(item["name"]))
    roles = [item["name"] for item in selected if item["kind"] == "role"]
    profile = "direct" if not selected else ("elevated" if "adversarial" in roles else "standard" if roles else "light")
    return {"version": policy["version"], "selected": selected, "suppressed": [], "unknown": [], "order": ordered,
            "roles": roles, "sections": sorted({item["section"] for item in selected if item["kind"] == "evidence"}),
            "profile": profile, "final_action": "direct" if not selected else "workflow"}
