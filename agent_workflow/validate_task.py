"""Dependency-free validation of the constrained task frontmatter contract."""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from .frontmatter import frontmatter, read_text
from .protocol import write_json


def _schema(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _ci(value: str, allowed: list[str]) -> bool:
    return any(value.casefold() == item.casefold() for item in allowed)


def _ownership_reason(value: str) -> str:
    if not value:
        return "empty entry"
    if value.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:[\\/]", value):
        return "absolute path"
    if value.startswith("./") or value.startswith("../") or "\\" in value:
        return "must use repository-relative forward-slash paths"
    parts = value.split("/")
    if any(part == ".." for part in parts):
        return "parent traversal"
    if any(ch in value for ch in ",[]"):
        return "reserved character"
    return ""


def validate_task(task_path: str, schema_path: str | None = None) -> dict[str, Any]:
    path = Path(task_path)
    schema_file = Path(schema_path) if schema_path else Path(__file__).resolve().parent.parent / "schemas" / "task.schema.json"
    errors: list[str] = []
    if not path.is_file():
        return {"valid": False, "errors": [f"task file not found: {task_path}"], "data": {}}
    content = read_text(path)
    if not re.match(r"\A---\r?\n.*?\r?\n---(?:\r?\n|\Z)", content, re.DOTALL):
        return {"valid": False, "errors": ["missing YAML frontmatter"], "data": {}}
    data = frontmatter(content)
    schema = _schema(schema_file)
    required = schema.get("required", [])
    for name in required:
        if name not in data or data[name] in (None, ""):
            errors.append(f"missing required field: {name}")
    properties = schema.get("properties", {})
    for name in data:
        if name not in properties:
            errors.append(f"unknown field: {name}")
    patterns = {
        "id": r"^[0-9]{8}-[0-9]{6}-[a-z0-9-]+$",
        "project_id": r"^[a-f0-9]{16}$",
        "worktree_id": r"^[a-f0-9]{16}$",
        "parent_task_id": r"^[0-9]{8}-[0-9]{6}-[a-z0-9-]+$",
        "base_commit": r"^[a-f0-9]{40}$",
    }
    for name, pattern in patterns.items():
        value = str(data.get(name, ""))
        if value and not re.match(pattern, value):
            errors.append(f"invalid {name}")
    for name in ("status", "delivery_status", "integration_status", "subtask_role"):
        value = str(data.get(name, ""))
        allowed = properties.get(name, {}).get("enum", [])
        if value and not _ci(value, allowed):
            errors.append(f"invalid {name}: {value}" if name != "status" else "invalid status")
    kind = str(data.get("change_kind", ""))
    if kind and not _ci(kind, properties["change_kind"]["enum"]):
        errors.append(f"invalid change_kind: {kind}")
    for name in ("task_type", "impact_scope", "impact_effect", "impact_confidence", "workflow_request", "workflow_profile"):
        value = str(data.get(name, ""))
        allowed = properties.get(name, {}).get("enum", [])
        if value and not _ci(value, allowed):
            errors.append(f"invalid {name}: {value}")
    if data.get("workflow_facts"):
        try:
            parsed_facts = json.loads(str(data["workflow_facts"]))
            if not isinstance(parsed_facts, dict):
                errors.append("workflow_facts must be a JSON object")
        except json.JSONDecodeError:
            errors.append("workflow_facts must contain valid JSON")
    if data.get("workflow_decision"):
        try:
            parsed_decision = json.loads(str(data["workflow_decision"]))
            if not isinstance(parsed_decision, dict):
                errors.append("workflow_decision must be a JSON object")
        except json.JSONDecodeError:
            errors.append("workflow_decision must contain valid JSON")
    code_change: bool | None = data.get("code_change") if isinstance(data.get("code_change"), bool) else None
    if "code_change" in data and code_change is None:
        errors.append("code_change must be true or false")
    flags = data.get("risk_flags")
    if not isinstance(flags, list):
        flags = []
        errors.append("risk_flags must use inline array syntax")
    allowed_flags = properties.get("risk_flags", {}).get("items", {}).get("enum", [])
    for flag in flags:
        if not _ci(str(flag), allowed_flags):
            errors.append(f"invalid risk flag: {flag}")
    if len({str(item).casefold() for item in flags}) != len(flags):
        errors.append("risk_flags contains duplicates")
    for name in ("created_at", "updated_at", "frozen_at"):
        value = data.get(name)
        if value:
            try:
                datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            except ValueError:
                errors.append(f"invalid date-time: {name}")

    role = str(data.get("subtask_role", ""))
    ownership = data.get("file_ownership", [])
    if "file_ownership" in data:
        if not isinstance(ownership, list) or not ownership:
            errors.append("file_ownership must use inline array syntax" if not isinstance(ownership, list) else "file_ownership must not be empty")
            ownership = []
        for entry in ownership:
            reason = _ownership_reason(str(entry))
            if reason:
                errors.append(f"invalid file_ownership entry '{entry}': {reason}")
        if len(set(ownership)) != len(ownership):
            errors.append("file_ownership contains duplicates")
    worker_fields = ["parent_task_id", "base_commit", "file_ownership", "delivery_status"]
    coordinator_fields = ["integration_status"]
    if role == "worker":
        for name in worker_fields:
            if not data.get(name): errors.append(f"worker task requires {name}")
        for name in coordinator_fields:
            if name in data: errors.append(f"worker task must not set {name}")
        if code_change is not True: errors.append("worker task requires code_change: true")
    elif role == "coordinator":
        for name in coordinator_fields:
            if not data.get(name): errors.append(f"coordinator task requires {name}")
        for name in worker_fields:
            if name in data: errors.append(f"coordinator task must not set {name}")
        if code_change is not True: errors.append("coordinator task requires code_change: true")
    else:
        for name in worker_fields + coordinator_fields:
            if name in data: errors.append(f"{name} requires subtask_role")
    return {"valid": not errors, "errors": errors, "data": data,
            "code_change": code_change, "change_kind": kind or None,
            "risk_flags": flags, "subtask_role": role, "file_ownership": ownership}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--task-path", required=True)
    parser.add_argument("--schema-path")
    args = parser.parse_args(argv)
    write_json(validate_task(args.task_path, args.schema_path))
    return 0


if __name__ == "__main__":
    main()
