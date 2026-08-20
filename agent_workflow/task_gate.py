"""Shared Stop/Close completion gate, implemented without PowerShell text pipelines."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from .frontmatter import frontmatter, read_text
from .task_profile import get_task_profile
from .validate_task import validate_task
from .workflow_planner import decision_projection, main_controlled, manual_plan, plan_task, planner_enabled
from .worktree_fingerprint import fingerprint


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


def fingerprint_issue(body: str, label: str, expected: str, issues: list[str]) -> None:
    match = re.search(r"(?mi)^\s*-\s*diff_sha256:\s*([0-9a-f]{64})\s*$", body)
    if not match:
        issues.append(f"{label} has no '- diff_sha256: <64-hex>' line recording which diff it reviewed")
    elif match.group(1).lower() != expected.lower():
        issues.append(f"{label} reviewed diff {match.group(1)[:12]} but the working tree is now {expected[:12]}; the diff changed afterwards and it must be re-run")


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
            issues.append('a regression needs framework_change: either "recorded:<retro-id>" from retro.py -Action Record, or "not_needed - <reason>"')


def decision_issues(data: dict[str, Any], plan: dict[str, Any], issues: list[str]) -> None:
    """The recorded decision must reproduce the canonical planner result exactly."""
    expected_profile = str(data.get("workflow_profile", ""))
    if expected_profile and not re.fullmatch(r"<.*>", expected_profile) and expected_profile != str(plan["profile"]):
        issues.append(f"workflow_profile is {expected_profile}, but planner calculated {plan['profile']}")
    raw = str(data.get("workflow_decision", ""))
    if not raw or re.fullmatch(r"<.*>", raw):
        issues.append("planner-enabled task requires a non-placeholder workflow_decision JSON object")
        return
    decision = json.loads(raw)
    if decision.get("final_action") != plan.get("final_action"):
        issues.append("workflow_decision final_action does not match the planner result")
    for key in ("selected", "suppressed", "unknown"):
        if not isinstance(decision.get(key), list):
            issues.append(f"workflow_decision is missing list field: {key}")
            return
    names = [{str(item.get("name")) for item in decision.get(key, []) if isinstance(item, dict)} |
             {str(item) for item in decision.get(key, []) if isinstance(item, str)} for key in ("selected", "suppressed", "unknown")]
    if names[0] & names[1]:
        issues.append("workflow_decision lists the same capability as both selected and suppressed")
    if names[1] & names[2]:
        issues.append("workflow_decision lists the same capability as both suppressed and unknown")
    if decision_projection(decision) != decision_projection(plan):
        issues.append("workflow_decision graph does not match the canonical planner result")


# A declared risk flag is discharged only when observed evidence suppressed every
# capability that flag stands for. Declared risk always escalates; only evidence lowers it.
FLAG_CAPABILITIES = {
    "schema": ("schema_compatibility", "adversarial"),
    "migration": ("migration_safety", "adversarial"),
    "data_write": ("data_impact", "adversarial"),
    "financial": ("data_impact", "adversarial"),
    "contract": ("contract_review", "adversarial"),
    "irreversible": ("adversarial",),
}


def effective_flags(flags: list[str], plan: dict[str, Any]) -> list[str]:
    suppressed = {str(item.get("name")) for item in plan.get("suppressed", [])}
    selected = {str(item.get("name")) for item in plan.get("selected", [])}
    kept = []
    for flag in flags:
        capabilities = FLAG_CAPABILITIES.get(flag, ())
        if capabilities and all(name in suppressed and name not in selected for name in capabilities):
            continue
        kept.append(flag)
    return kept


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
        pre_passed = False
        if not waiting:
            if not pre: issues.append("pre-review result must be PASS or SKIP")
            elif pre.group(1).upper() == "SKIP":
                reason = line_value(validation_body, "skip reason")
                if not reason or re.fullmatch(r"<.*>", reason): issues.append("SKIP pre-review requires a reason")
            else: pre_passed = True
        schema_path = Path(__file__).resolve().parent.parent / "schemas" / "task.schema.json"
        schema = json.loads(schema_path.read_text(encoding="utf-8-sig"))
        flags = [str(flag) for flag in validation.get("risk_flags", [])]
        change_kind = str(data.get("change_kind", ""))
        code_change = data.get("code_change") is True
        planner_task = code_change and planner_enabled(data)
        main_task = code_change and main_controlled(data)
        plan: dict[str, Any] = {}
        planner_failed = False
        if main_task:
            plan = manual_plan(data)
        elif planner_task:
            try:
                plan = plan_task(data, cwd=cwd)
                decision_issues(data, plan, issues)
            except (TypeError, ValueError, KeyError, json.JSONDecodeError) as exc:
                issues.append(f"workflow planner failed: {exc}")
                planner_failed = True
        if (planner_task or main_task) and not planner_failed:
            profile = str(plan["profile"])
            role_set = set(plan.get("roles", []))
        else:
            profile = "elevated" if planner_task else get_task_profile(code_change, flags, change_kind, role)
            role_set = {"reviewer", "verifier"} if code_change else set()
            if role_set and (planner_task or any(flag in schema["x_agent_workflow"]["adversarial_required"] for flag in flags)):
                role_set.add("adversarial")
        needs_roles = code_change and not waiting and bool(role_set)
        # 'extended' only drives the legacy profile path; planner tasks derive their
        # requirements from the selected capabilities instead.
        extended = (not planner_task and not main_task) and needs_roles and profile == "elevated"
        if planner_task and not planner_failed:
            flags = effective_flags(flags, plan)
        freeze_flags = schema["x_agent_workflow"]["freeze_required"]
        if any(flag in freeze_flags for flag in flags):
            if not data.get("frozen_at"): issues.append("freeze-required task has no frozen_at")
            for name in ("Non-goals and compatibility", "Current state and impact", "Decision and tradeoffs", "Boundary and error paths", "User confirmation"):
                if not re.search(rf"(?m)^## {re.escape(name)}", content): issues.append(f"missing section: {name}")
        if any(flag in flags for flag in ("behavior_change", "ui")) or any(flag in freeze_flags for flag in flags): missing_section(content, "Acceptance cases", issues)
        if any(flag in flags for flag in ("cross_feature", "migration", "irreversible")): missing_section(content, "Implementation sequence", issues)
        if "ui" in flags: missing_section(content, "Browser verification", issues)
        if change_kind == "refactor": missing_section(content, "Behavior invariants and before-after evidence", issues)
        current = ""
        if cwd and extended:
            fp = fingerprint(cwd, str(data.get("base_commit", "HEAD")))
            current = str(fp.get("sha256", ""))
            if not current: issues.append(f"cannot compute the working tree fingerprint: {fp.get('error', '')}")
        # A planner task is "deep" when it selected evidence work or an adversarial pass;
        # that is the composable equivalent of the legacy elevated profile.
        evidence_sections = required_evidence(plan) if (planner_task or main_task) and not planner_failed else {}
        deep = bool(evidence_sections) or ((planner_task or main_task) and not planner_failed and "adversarial" in role_set)
        if (planner_task or main_task) and not planner_failed:
            for name, steps in evidence_sections.items():
                missing_section(content, name, issues)
                body = section(content, name)
                for step in steps:
                    step_id = str(step.get("id"))
                    value = line_value(body, step_id)
                    if not value or re.fullmatch(r"<.*>", value):
                        issues.append(f"'## {name}' has no evidence line '- {step_id}: <結論>' ({step.get('title', '')})")
            if plan.get("suppressed") or plan.get("unknown"):
                missing_section(content, "Impact surface", issues)
            if deep:
                project_docs_issue(content, cwd, issues)
        elif extended:
            if any(flag in schema["x_agent_workflow"]["contract_impact_required"] for flag in flags): missing_section(content, "Contract and data impact", issues)
            project_docs_issue(content, cwd, issues)
            missing_section(content, "Impact surface", issues)
            missing_section(content, "Execution path and regression evidence", issues)
        elif not planner_task and any(flag in schema["x_agent_workflow"]["contract_impact_required"] for flag in flags):
            missing_section(content, "Contract and data impact", issues)
        verify_fingerprint = bool(current) and extended
        if verify_fingerprint and pre_passed: fingerprint_issue(validation_body, "pre-review", current, issues)
        if needs_roles and not waived:
            if "reviewer" in role_set:
                review = section(content, "Reviewer result")
                if not re.search(r"(?mi)^\s*-\s*result:\s*PASS\s*$", review): issues.append("Reviewer result is missing or not passed")
                # Blast-radius dimensions may be answered N/A when the planner proved there is
                # no blast radius; a waived N/A still has to carry its reason.
                waived_dimensions = {str(name) for item in plan.get("selected", [])
                                     if item.get("name") == "reviewer" for name in item.get("waived_dimensions", [])}
                for dim in schema["x_agent_workflow"]["reviewer_dimensions"]:
                    # [ \t] not \s: \s matches the newline and would let the reason be satisfied
                    # by the '-' bullet of the next dimension.
                    if dim["name"] in waived_dimensions: allowed = r"(?:PASS|N/A[ \t]*-[ \t]*\S.*)"
                    elif dim.get("na_allowed"): allowed = r"(?:PASS|N/A)"
                    else: allowed = r"PASS"
                    if not re.search(rf"(?mi)^\s*-\s*{re.escape(dim['name'])}:\s*{allowed}(?:\s+.*)?\s*$", review): issues.append(f"Reviewer result missing or not passed dimension: {dim['name']}")
                if verify_fingerprint: fingerprint_issue(review, "Reviewer result", current, issues)
            if "adversarial" in role_set:
                adversarial = section(content, "Adversarial result")
                if not re.search(r"(?mi)^\s*-\s*result:\s*PASS\s*$", adversarial): issues.append("Adversarial result is missing or not passed")
                for name in ("Provenance", "Pattern fan-out", "Engine semantics", "Cross-round accumulation"):
                    if not re.search(rf"(?mi)^\s*-\s*{re.escape(name)}:\s*PASS(?:\s+.*)?\s*$", adversarial): issues.append(f"Adversarial result missing or not passed check: {name}")
                if verify_fingerprint: fingerprint_issue(adversarial, "Adversarial result", current, issues)
            if "verifier" in role_set:
                verify = section(content, "Verifier result")
                if not re.search(r"(?mi)^\s*-\s*PASS\s*$", verify): issues.append("Verifier result is missing or not passed")
                if verify_fingerprint: fingerprint_issue(verify, "Verifier result", current, issues)
        if mode == "Close" and code_change and role != "worker":
            if not change_kind: issues.append("code change has no change_kind (fix | feature | refactor | chore)")
            docs_required = extended or deep
            if docs_required and change_kind in {"feature", "refactor"} and not line_value(section(content, "Project docs"), "updated"):
                issues.append(f"'## Project docs' has no '- updated:' line (change_kind {change_kind} requires a disposition here)")
            _retro_check(content, path, issues)
            if extended and role in {"coordinator", "worker"} and not waived and data.get("independence") != "native":
                issues.append("independence must be 'native' or 'degraded' before closing (missing or invalid value)")
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
