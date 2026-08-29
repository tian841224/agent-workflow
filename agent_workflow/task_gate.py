"""Shared Stop/Close completion gate, implemented without PowerShell text pipelines."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from .frontmatter import frontmatter, read_text
from .validate_task import validate_task
from .workflow import main_controlled, manual_plan


def section(content: str, name: str) -> str:
    match = re.search(rf"(?ms)^## {re.escape(name)}.*?\r?\n(.*?)(?=^## |\Z)", content)
    return match.group(1).strip() if match else ""


def missing_section(content: str, name: str, issues: list[str]) -> None:
    body = section(content, name)
    if not body or re.fullmatch(r"<.*>", body):
        issues.append(f"missing or empty section: {name}")


def line_value(body: str, name: str) -> str:
    match = re.search(rf"(?mi)^\s*-\s*{re.escape(name)}:\s*(.+?)\s*$", body)
    return match.group(1).strip() if match else ""


def project_docs_issue(content: str, cwd: str, issues: list[str]) -> None:
    docs = section(content, "Project docs")
    value = line_value(docs, "read")
    if not value or re.fullmatch(r"<.*>", value):
        issues.append("missing or empty section: Project docs")
        return
    none = re.match(r"(?i)^none\s*-\s*(.+)$", value)
    if none:
        if not none.group(1).strip() or re.fullmatch(r"<.*>", none.group(1).strip()):
            issues.append("'## Project docs' - read: none needs an actual reason, not a placeholder")
        return
    missing = []
    for item in value.split(","):
        item = item.strip()
        if item and not (Path(item) if Path(item).is_absolute() else Path(cwd, item)).is_file():
            missing.append(item)
    if missing:
        issues.append("'## Project docs' - read: names a path that does not exist: " + ", ".join(missing))


def _retro_check(content: str, task_path: Path, issues: list[str]) -> None:
    match = re.search(r"(?ms)^## Retrospective result.*?\r?\n(.*?)(?=^## |\Z)", content)
    if not match:
        return
    body = match.group(1).strip()
    if not body:
        issues.append("Retrospective result is empty; remove the optional section or complete it")
        return
    if re.fullmatch(r"<.*>", body):
        issues.append("Retrospective result is a placeholder; remove the optional section or complete it")
        return
    introduced = line_value(body, "introduced_by")
    if not introduced or re.fullmatch(r"<.*>", introduced):
        issues.append('Retrospective result has no introduced_by (a commit sha, or "unknown - <what was searched>")')
    schema_path = Path(__file__).resolve().parent.parent / "schemas" / "retro.schema.json"
    try: retro = json.loads(schema_path.read_text(encoding="utf-8-sig"))
    except Exception as exc:
        issues.append(f"retro schema is unreadable: {exc}")
        return
    classification = line_value(body, "classification")
    classes = retro["properties"]["classification"]["enum"]
    if classification not in classes:
        issues.append("Retrospective result needs a classification from: " + ", ".join(classes))
    elif classification in retro["x_agent_workflow"]["gap_required"]:
        category = line_value(body, "miss_category")
        allowed = retro["properties"]["miss_category"]["enum"]
        if category not in allowed: issues.append("a regression needs a miss_category from: " + ", ".join(allowed))
        evidence = line_value(body, "gap_evidence")
        if not evidence or re.fullmatch(r"<.*>", evidence): issues.append("a regression needs gap_evidence naming which task section or gate let it through")
        change = line_value(body, "framework_change")
        if not re.fullmatch(r"(?:recorded:[0-9]{8}-[0-9]{6}-[a-f0-9]{8}|not_needed\s*-\s*\S.*)", change):
            issues.append('a regression needs framework_change: either "recorded:<retro-id>" from retro --action Record, or "not_needed - <reason>"')


def _review_cause_check(content: str, issues: list[str]) -> None:
    """A round past the first exists because the previous one was pushed back, so that
    round is exactly where the attribution belongs."""
    body = section(content, "Review round")
    if not body:
        return
    try:
        round_number = int(line_value(body, "round"))
    except ValueError:
        return
    if round_number < 2:
        return
    value = line_value(body, "cause")
    if not value or re.fullmatch(r"<.*>", value):
        issues.append('round >= 2 needs a cause: either an id from review-cause --action Record, or "none - <reason>"')
        return
    none = re.match(r"(?i)^none\s*-\s*(.+)$", value)
    if none and (not none.group(1).strip() or re.fullmatch(r"<.*>", none.group(1).strip())):
        issues.append("'## Review round' - cause: none needs an actual reason, not a placeholder")
    elif not none and not re.fullmatch(r"[0-9]{8}-[0-9]{6}-[a-f0-9]{8}", value):
        issues.append('cause must be a review-cause id (YYYYMMDD-HHmmss-xxxxxxxx) or "none - <reason>"')


def required_evidence(plan: dict[str, Any]) -> dict[str, list[dict[str, str]]]:
    """Selected evidence capabilities collapsed to section -> steps (sections may be shared)."""
    required: dict[str, list[dict[str, str]]] = {}
    for capability in plan.get("selected", []):
        if capability.get("kind") != "evidence":
            continue
        required.setdefault(str(capability.get("section")), []).extend(capability.get("steps", []))
    return required


def gate(task_path: str, cwd: str = "", worktree_id: str = "", mode: str = "Stop") -> dict[str, Any]:
    issues: list[str] = []
    waiting = False
    waived = ""
    path = Path(task_path)
    if not path.is_file(): return {"issues": [f"task file not found: {task_path}"], "waiting": False, "waived": ""}
    try:
        raw = read_text(path)
        content = re.sub(r"(?s)<!--.*?-->", "", raw)
        validation = validate_task(task_path)
        if not validation["valid"]: issues.extend(validation["errors"])
        data = validation.get("data", {})
        if worktree_id and data.get("worktree_id") != worktree_id: issues.append("task worktree_id does not match the current worktree")
        for name in ("id", "project_id", "worktree_id", "status", "code_change", "risk_flags", "created_at", "updated_at"):
            if not re.search(rf"(?m)^{name}:\s*\S+", content): issues.append(f"missing frontmatter field: {name}")
        if not re.search(r"(?m)^status:\s*in_progress\s*$", content): issues.append("active task status is invalid")
        waived = str(data.get("roles_waived", ""))
        if re.fullmatch(r"<.*>", waived): waived = ""
        role = str(data.get("subtask_role", ""))
        # A coordinator may stop while workers are non-terminal. The Python port keeps the
        # lightweight behavior; check-task performs the detailed roster validation when invoked.
        if role == "coordinator" and mode == "Stop":
            waiting_for = Path(task_path).parent / "workers.json"
            if waiting_for.is_file():
                try:
                    roster = json.loads(waiting_for.read_text(encoding="utf-8"))
                    waiting = any(item.get("status") not in {"done", "merged", "rejected", "skipped"} for item in roster if isinstance(item, dict))
                except Exception: pass
        if not waiting:
            unchecked = re.findall(r"(?m)^\s*-\s*\[ \]\s+(.+)$", content)
            if unchecked: issues.append("unchecked completion items: " + "; ".join(item.strip() for item in unchecked))
        for name in (["Goal", "Scope", "Completion criteria"] + ([] if waiting else ["Validation results"])):
            missing_section(content, name, issues)
        validation_body = section(content, "Validation results")
        pre = re.search(r"(?mi)^\s*-\s*pre-review:\s*(PASS|SKIP)\s*$", validation_body)
        if not waiting:
            if not pre: issues.append("pre-review result must be PASS or SKIP")
            elif pre.group(1).upper() == "SKIP":
                reason = line_value(validation_body, "skip reason")
                if not reason or re.fullmatch(r"<.*>", reason): issues.append("SKIP pre-review requires a reason")
        schema_path = Path(__file__).resolve().parent.parent / "schemas" / "task.schema.json"
        schema = json.loads(schema_path.read_text(encoding="utf-8-sig"))
        flags = [str(flag) for flag in validation.get("risk_flags", [])]
        change_kind = str(data.get("change_kind", ""))
        code_change = data.get("code_change") is True
        main_task = code_change and main_controlled(data)
        plan: dict[str, Any] = {}
        if main_task:
            plan = manual_plan(data)
            role_set = set(plan.get("roles", []))
        else:
            # Legacy default: a code-change task without workflow_mode: main still requires
            # reviewer. This is deliberately the ONLY behavior for pre-main-mode tasks;
            # there is no migration step and no separate legacy planner.
            role_set = {"reviewer"} if code_change else set()
        needs_roles = code_change and not waiting and bool(role_set)
        freeze_flags = schema["x_agent_workflow"]["freeze_required"]
        if any(flag in freeze_flags for flag in flags):
            if not data.get("frozen_at"): issues.append("freeze-required task has no frozen_at")
            for name in ("Non-goals and compatibility", "Current state and impact", "Decision and tradeoffs", "Boundary and error paths", "User confirmation"):
                if not re.search(rf"(?m)^## {re.escape(name)}", content): issues.append(f"missing section: {name}")
        if any(flag in flags for flag in ("behavior_change", "ui")) or any(flag in freeze_flags for flag in flags): missing_section(content, "Acceptance cases", issues)
        if any(flag in flags for flag in ("cross_feature", "migration", "irreversible")): missing_section(content, "Implementation sequence", issues)
        if "ui" in flags: missing_section(content, "Browser verification", issues)
        if change_kind == "refactor": missing_section(content, "Behavior invariants and before-after evidence", issues)
        # A main-mode task is "deep" when it selected evidence work; that determines
        # whether Project docs disposition is required at Close.
        evidence_sections = required_evidence(plan) if main_task else {}
        deep = bool(evidence_sections)
        if main_task:
            for name, steps in evidence_sections.items():
                missing_section(content, name, issues)
                body = section(content, name)
                for step in steps:
                    step_id = str(step.get("id"))
                    value = line_value(body, step_id)
                    if not value or re.fullmatch(r"<.*>", value):
                        issues.append(f"'## {name}' has no evidence line '- {step_id}: <結論>' ({step.get('title', '')})")
            if not plan.get("selected"):
                # An empty workflow_request means the main conversation judged this task
                # isolated with no capability work -- that judgment call itself must be
                # written down, not silently assumed.
                missing_section(content, "Impact surface", issues)
            if deep:
                project_docs_issue(content, cwd, issues)
        elif any(flag in schema["x_agent_workflow"]["contract_impact_required"] for flag in flags):
            missing_section(content, "Contract and data impact", issues)
        if needs_roles and not waived:
            if "reviewer" in role_set:
                review = section(content, "Reviewer result")
                if not re.search(r"(?mi)^\s*-\s*result:\s*PASS\s*$", review): issues.append("Reviewer result is missing or not passed")
        if mode == "Close" and code_change and role != "worker":
            if not change_kind: issues.append("code change has no change_kind (fix | feature | refactor | chore)")
            if deep and change_kind in {"feature", "refactor"} and not line_value(section(content, "Project docs"), "updated"):
                issues.append(f"'## Project docs' has no '- updated:' line (change_kind {change_kind} requires a disposition here)")
            _retro_check(content, path, issues)
            _review_cause_check(content, issues)
    except Exception as exc:
        issues.append(f"task-gate failed to inspect the task: {exc}")
    return {"issues": issues, "waiting": waiting, "waived": waived}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task-path", required=True)
    parser.add_argument("--cwd", default="")
    parser.add_argument("--worktree-id", default="")
    parser.add_argument("--mode", choices=("Stop", "Close"), default="Stop")
    args = parser.parse_args(argv)
    from .protocol import write_json
    write_json(gate(args.task_path, args.cwd, args.worktree_id, args.mode))
    return 0


if __name__ == "__main__": main()
