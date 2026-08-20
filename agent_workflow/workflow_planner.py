"""Composable workflow capability planning with conservative legacy fallback."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path
from typing import Any, Mapping

from .protocol import write_json


POLICY_PATH = Path(__file__).resolve().parent.parent / "schemas" / "workflow-policy.json"
UNKNOWN = object()


def planner_enabled(task: Mapping[str, Any]) -> bool:
    return bool(str(task.get("workflow_decision", "")).strip())


def _load_policy(path: str | Path = POLICY_PATH) -> dict[str, Any]:
    policy = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    if policy.get("version") != 1 or not isinstance(policy.get("capabilities"), list):
        raise ValueError("workflow policy must declare version 1 and capabilities")
    names = [item.get("name") for item in policy["capabilities"]]
    if any(not isinstance(name, str) or not name for name in names) or len(names) != len(set(names)):
        raise ValueError("workflow capabilities must have unique non-empty names")
    known = set(names) | {"baseline_validation"}
    for item in policy["capabilities"]:
        for dependency in item.get("requires", []):
            if dependency not in known:
                raise ValueError(f"workflow capability has unknown dependency: {dependency}")
    return policy


def _task_type(task: Mapping[str, Any]) -> str:
    explicit = str(task.get("task_type", "")).strip().casefold()
    if explicit:
        return explicit
    flags = {str(value).casefold() for value in task.get("risk_flags", [])}
    if "schema" in flags:
        return "schema"
    if "migration" in flags:
        return "migration"
    return str(task.get("change_kind", "")).strip().casefold()


def _fact_value(task: Mapping[str, Any], facts: Mapping[str, Any], name: str) -> Any:
    if name in facts:
        return facts[name]
    if name in task:
        return task[name]
    return UNKNOWN


def _equals(value: Any, expected: list[Any]) -> bool | None:
    if value is UNKNOWN:
        return None
    if isinstance(value, str):
        return value.casefold() in {str(item).casefold() for item in expected}
    return value in expected


def _condition(task: Mapping[str, Any], facts: Mapping[str, Any], condition: Mapping[str, Any]) -> bool | None:
    if "fact" in condition:
        return _equals(_fact_value(task, facts, str(condition["fact"])), list(condition.get("equals", [])))
    if "code_change" in condition:
        return task.get("code_change") is condition["code_change"]
    if "task_type" in condition:
        return _task_type(task) in set(condition.get("task_type", []))
    return False


def _candidate(task: Mapping[str, Any], capability: Mapping[str, Any]) -> bool:
    candidate = capability.get("candidate", {})
    flags = {str(value).casefold() for value in task.get("risk_flags", [])}
    task_type = _task_type(task)
    checks: list[bool] = []
    if "code_change" in candidate:
        checks.append(task.get("code_change") is candidate["code_change"])
    if candidate.get("task_types"):
        checks.append(task_type in {str(value).casefold() for value in candidate["task_types"]})
    if candidate.get("change_kinds"):
        checks.append(str(task.get("change_kind", "")).casefold() in {str(value).casefold() for value in candidate["change_kinds"]})
    if candidate.get("risk_flags"):
        checks.append(bool(flags.intersection(str(value).casefold() for value in candidate["risk_flags"])))
    if candidate.get("impact_effect"):
        checks.append(str(task.get("impact_effect", "")).casefold() in {str(value).casefold() for value in candidate["impact_effect"]})
    if candidate.get("impact_scope"):
        checks.append(str(task.get("impact_scope", "")).casefold() in {str(value).casefold() for value in candidate["impact_scope"]})
    return any(checks)


def _derive_facts(task: Mapping[str, Any], facts: Mapping[str, Any]) -> dict[str, Any]:
    result = {
        key: task[key]
        for key in ("impact_scope", "impact_effect", "impact_confidence", "schema_operation", "data_transform", "has_consumer", "public_api_change", "destructive_operation")
        if key in task
    }
    result.update(facts)
    effect = str(_fact_value(task, result, "impact_effect")).casefold()
    scope = str(_fact_value(task, result, "impact_scope")).casefold()
    confidence = str(_fact_value(task, result, "impact_confidence")).casefold()
    known_high_confidence = confidence == "high"
    no_runtime = known_high_confidence and effect in {"none", "schema"} and scope in {"file", "module"} and result.get("has_consumer") is False and result.get("public_api_change") is False
    no_data = known_high_confidence and effect in {"none", "schema"} and result.get("data_transform") is False and result.get("has_consumer") is False
    no_contract = known_high_confidence and effect not in {"contract", "data"} and result.get("public_api_change") is False
    no_high_risk = no_runtime and no_data and no_contract and result.get("destructive_operation") is False
    result.update({
        "safe_no_runtime_impact": no_runtime,
        "safe_no_data_impact": no_data,
        "safe_no_contract_impact": no_contract,
        "safe_no_high_risk_impact": no_high_risk,
        "safe_additive_schema": known_high_confidence and result.get("schema_operation") in {"none", "additive_nullable"} and no_data and no_contract,
    })
    return result


def _changed_paths(cwd: str | Path) -> list[str]:
    root = str(cwd)
    commands = [
        ["git", "-C", root, "diff", "--name-only", "HEAD"],
        ["git", "-C", root, "ls-files", "--others", "--exclude-standard"],
    ]
    paths: set[str] = set()
    for command in commands:
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
        if result.returncode != 0:
            continue
        paths.update(line.strip() for line in result.stdout.splitlines() if line.strip())
    return sorted(paths)


def collect_evidence(cwd: str | Path, task: Mapping[str, Any]) -> dict[str, Any]:
    """Collect only evidence that can be proven from the current worktree."""
    paths = _changed_paths(cwd)
    evidence: dict[str, Any] = {"changed_paths": paths}
    if not paths:
        return evidence
    sql_paths = [path for path in paths if Path(path).suffix.casefold() == ".sql"]
    task_type = _task_type(task)
    risk_flags = {str(value).casefold() for value in task.get("risk_flags", [])}
    if task_type not in {"schema", "migration"} and not risk_flags.intersection({"schema", "migration"}):
        return evidence
    if not sql_paths:
        return evidence
    root = Path(cwd)
    sql_text = "\n".join((root / path).read_text(encoding="utf-8", errors="replace") for path in sql_paths if (root / path).is_file())
    destructive = bool(re.search(r"\b(?:DROP|TRUNCATE|RENAME|DELETE|UPDATE)\b", sql_text, re.IGNORECASE))
    data_transform = bool(re.search(r"\b(?:INSERT|UPDATE|DELETE|BACKFILL|SELECT\s+INTO)\b", sql_text, re.IGNORECASE))
    added_columns = re.findall(r"\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?[`\"]?([A-Za-z_][A-Za-z0-9_]*)", sql_text, re.IGNORECASE)
    safe_additive = bool(added_columns) and not destructive and not data_transform and not re.search(r"\b(?:NOT\s+NULL|DEFAULT|UNIQUE|PRIMARY\s+KEY|FOREIGN\s+KEY|INDEX|TRIGGER|CONSTRAINT)\b", sql_text, re.IGNORECASE)
    evidence.update({
        "schema_operation": "additive_nullable" if safe_additive else "changed",
        "data_transform": data_transform,
        "destructive_operation": destructive,
        "public_api_change": False if all(Path(path).suffix.casefold() == ".sql" for path in paths) else "unknown",
    })
    if added_columns:
        try:
            hits: list[str] = []
            for column in added_columns:
                result = subprocess.run(["rg", "-n", "-F", "-m", "20", column, str(root), "--glob", "!.git/**", "--glob", "!*.sql", "--glob", "!docs/**"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
                if result.returncode == 0:
                    hits.extend(line for line in result.stdout.splitlines() if line.strip())
            evidence["has_consumer"] = bool(hits)
            evidence["consumer_search"] = hits[:20]
        except (FileNotFoundError, subprocess.TimeoutExpired):
            evidence["has_consumer"] = "unknown"
    else:
        evidence["has_consumer"] = "unknown"
    return evidence


def _decision(task: Mapping[str, Any], facts: Mapping[str, Any], capability: Mapping[str, Any]) -> tuple[str, str, list[str]]:
    name = str(capability["name"])
    groups = capability.get("suppress_when", [])
    unknown = False
    for group in groups:
        states = [_condition(task, facts, condition) for condition in group]
        if all(state is True for state in states):
            return "suppressed", f"suppress rule {group} matched", []
        if any(state is None for state in states) and not any(state is False for state in states):
            unknown = True
    if unknown:
        return "unknown", "suppression could not be proven from available evidence", list(capability.get("requires", []))
    return "selected", f"candidate {name} has no proven suppression rule", list(capability.get("requires", []))


def _order(selected: Mapping[str, list[str]]) -> list[str]:
    pending = {name: set(dependencies) for name, dependencies in selected.items()}
    ordered: list[str] = []
    while pending:
        ready = sorted(name for name, dependencies in pending.items() if not (dependencies & pending.keys()))
        if not ready:
            raise ValueError("workflow capability dependency cycle")
        ordered.extend(ready)
        for name in ready:
            pending.pop(name)
    return ordered


def plan_workflows(task: Mapping[str, Any], facts: Mapping[str, Any] | None = None,
                   policy_path: str | Path = POLICY_PATH) -> dict[str, Any]:
    policy = _load_policy(policy_path)
    facts = _derive_facts(task, facts or {})
    selected: list[dict[str, Any]] = []
    suppressed: list[dict[str, Any]] = []
    unknown: list[dict[str, Any]] = []
    dependencies: dict[str, list[str]] = {}
    for capability in policy["capabilities"]:
        if not _candidate(task, capability):
            continue
        status, reason, requires = _decision(task, facts, capability)
        record = {"name": capability["name"], "reason": reason, "requires": requires}
        if status == "selected":
            selected.append(record)
            dependencies[capability["name"]] = requires
        elif status == "suppressed":
            suppressed.append(record)
        else:
            unknown.append(record)
            selected.append(record)
            dependencies[capability["name"]] = requires
    selected_names = {item["name"] for item in selected}
    for item in list(selected):
        for dependency in item["requires"]:
            if dependency != "baseline_validation" and dependency not in selected_names:
                suppressed = [record for record in suppressed if record["name"] != dependency]
                unknown = [record for record in unknown if record["name"] != dependency]
                selected.append({"name": dependency, "reason": f"required by {item['name']}", "requires": []})
                dependencies[dependency] = []
                selected_names.add(dependency)
    order = _order(dependencies) if dependencies else []
    role_names = {"reviewer", "adversarial", "verifier"}
    roles = [name for name in order if name in role_names]
    request = str(task.get("workflow_request", "auto")).casefold()
    minimum_roles = {"standard": ["reviewer", "verifier"], "elevated": ["reviewer", "adversarial", "verifier"]}.get(request, [])
    for role in minimum_roles:
        if role not in roles:
            suppressed = [record for record in suppressed if record["name"] != role]
            unknown = [record for record in unknown if record["name"] != role]
            roles.append(role)
            selected.append({"name": role, "reason": f"workflow_request {request} requires this capability", "requires": ["reviewer"] if role in {"adversarial", "verifier"} else ["baseline_validation"]})
    if request in {"standard", "elevated"}:
        selected_names = {item["name"] for item in selected}
        for role in minimum_roles:
            selected_names.add(role)
        dependencies = {item["name"]: item.get("requires", []) for item in selected}
        order = _order({name: deps for name, deps in dependencies.items() if name in selected_names or name in role_names})
    profile = "direct" if not task.get("code_change") else ("light" if not roles else ("elevated" if "adversarial" in roles else "standard"))
    return {
        "version": policy["version"],
        "task_type": _task_type(task),
        "selected": selected,
        "suppressed": suppressed,
        "unknown": unknown,
        "order": order,
        "roles": roles,
        "baseline": policy.get("baseline", []),
        "profile": profile,
        "final_action": "direct" if not roles else "workflow",
        "facts": facts,
    }


def plan_task(task: Mapping[str, Any], policy_path: str | Path = POLICY_PATH, cwd: str | Path = "") -> dict[str, Any]:
    raw = task.get("workflow_facts", "{}")
    facts: Mapping[str, Any] = {}
    if raw:
        try:
            parsed = json.loads(str(raw))
            if not isinstance(parsed, dict):
                raise ValueError("workflow_facts must be a JSON object")
            facts = parsed
        except json.JSONDecodeError as exc:
            raise ValueError(f"workflow_facts is not valid JSON: {exc.msg}") from exc
    if cwd:
        collected = collect_evidence(cwd, task)
        merged = dict(facts)
        merged.update(collected)
        facts = merged
    return plan_workflows(task, facts, policy_path)


def decision_projection(plan: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: [
            {"name": item.get("name"), "reason": item.get("reason"), "requires": sorted(item.get("requires", []))}
            for item in plan.get(key, [])
        ]
        for key in ("selected", "suppressed", "unknown")
    }


def legacy_profile(code_change: bool, risk_flags: list[str] | None = None,
                   change_kind: str = "", subtask_role: str = "") -> str:
    if not code_change:
        return "non-code"
    if subtask_role in {"coordinator", "worker"}:
        return "elevated"
    if {"authorization", "contract", "cross_feature", "data_write", "financial", "irreversible", "migration", "schema", "unclear_requirements"}.intersection(risk_flags or []):
        return "elevated"
    if change_kind in {"feature", "refactor"}:
        return "elevated"
    return "standard"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task-json", required=True)
    parser.add_argument("--facts-json", default="{}")
    parser.add_argument("--policy-path", default=str(POLICY_PATH))
    parser.add_argument("--cwd", default="")
    args = parser.parse_args(argv)
    task = json.loads(args.task_json)
    facts = json.loads(args.facts_json)
    write_json(plan_workflows(task, facts, args.policy_path) if not args.cwd else plan_task({**task, "workflow_facts": json.dumps(facts)}, args.policy_path, args.cwd))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
