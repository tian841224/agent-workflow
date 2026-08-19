"""Pre-tool edit guard with explicit UTF-8 JSON protocol and cheap Standard fast path."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .frontmatter import read_text, frontmatter
from .paths import is_within
from .project_resolver import resolve_project
from .protocol import read_json_stdin, write_json, write_stderr
from .task_profile import get_task_profile


def _deny(reason: str, antigravity: bool) -> None:
    write_json({"decision": "deny", "reason": reason} if antigravity else {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}})


def _section(content: str, name: str) -> str:
    match = re.search(rf"(?ms)^## {re.escape(name)}.*?\r?\n(.*?)(?=^## |\Z)", content)
    return match.group(1).strip() if match else ""


def _patch_paths(text: str) -> list[str]:
    return re.findall(r"(?m)^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$|^\*\*\*\s+Move to:\s*(.+?)\s*$", text)


def _targets(payload: dict[str, Any], antigravity: bool) -> list[str]:
    result: list[str] = []
    if antigravity:
        args = ((payload.get("toolCall") or {}).get("args") or {})
        for key in ("TargetFile", "AbsolutePath", "file_path", "path"):
            if args.get(key): result.append(str(args[key])); break
    else:
        tool = payload.get("tool_input")
        if isinstance(tool, str):
            result.extend(next((list(pair) for pair in _patch_paths(tool) if pair), []))
        elif isinstance(tool, dict):
            if tool.get("file_path"): result.append(str(tool["file_path"]))
            elif isinstance(tool.get("input"), str):
                result.extend(next((list(pair) for pair in _patch_paths(tool["input"]) if pair), []))
    return [item for item in result if item]


def _write_text(payload: dict[str, Any], antigravity: bool) -> str:
    parts: list[str] = []
    if antigravity:
        args = ((payload.get("toolCall") or {}).get("args") or {})
        keys = ("CodeEdit", "ReplacementText", "Content", "content", "NewString", "new_string")
        parts.extend(str(args[key]) for key in keys if isinstance(args.get(key), str))
    else:
        tool = payload.get("tool_input")
        if isinstance(tool, str): parts.append(tool)
        elif isinstance(tool, dict):
            parts.extend(str(tool[key]) for key in ("content", "new_string", "new_str", "input") if isinstance(tool.get(key), str))
            parts.extend(str(item.get("new_string")) for item in tool.get("edits", []) if isinstance(item, dict) and isinstance(item.get("new_string"), str))
    return "\n".join(parts)


def run(payload: dict[str, Any], state_root: str | None = None) -> None:
    antigravity = bool(payload.get("toolCall"))
    cwd_raw = (payload.get("workspacePaths") or [payload.get("cwd")])[0]
    if not cwd_raw: return
    cwd = Path(str(cwd_raw)).resolve()
    candidates = []
    for item in _targets(payload, antigravity):
        path = (Path(item) if Path(item).is_absolute() else cwd / item).resolve()
        candidates.append(path)
    if not candidates: return
    state = Path(state_root or (Path.home() / ".agent-workflow")).resolve()
    gated = [path for path in candidates if is_within(path, cwd)]
    state_targets = [path for path in candidates if not is_within(path, cwd) and is_within(path, state)]
    if not gated and not state_targets: return
    task_targets = [path for path in gated + state_targets if path.name == "task.md"]
    text = _write_text(payload, antigravity)
    if task_targets and re.search(r"(?m)^\s*\+?\s*status:\s*done\s*$", text):
        _deny("impact-guard: do not set 'status: done' by editing the task file. Run ~/.agent-workflow/runtime/scripts/close-task.py instead - it re-runs the full completion gate before writing done.", antigravity); return
    if task_targets and re.search(r"(?m)^\s*\+?\s*roles_waived:\s*\S", text):
        _deny("impact-guard: do not set 'roles_waived' by editing the task file - use the user-authorized waive-roles command.", antigravity); return
    resolved = resolve_project(str(cwd), str(state), False, [], "")
    active = resolved.get("active_tasks", [])
    if len(active) != 1: return
    task_path = Path(active[0])
    if not task_path.is_file(): return
    content = re.sub(r"(?s)<!--.*?-->", "", read_text(task_path))
    data = frontmatter(content)
    role = str(data.get("subtask_role", ""))
    flags = [str(item) for item in data.get("risk_flags", [])] if isinstance(data.get("risk_flags", []), list) else []
    code_change = data.get("code_change") is True
    profile = get_task_profile(code_change, flags, str(data.get("change_kind", "")), role)
    own_task_dir = task_path.parent.resolve()
    if state_targets and role in {"coordinator", "worker"}:
        outside = [str(path) for path in state_targets if not is_within(path, own_task_dir)]
        if outside:
            _deny(f"impact-guard: {role} task {task_path} may only write its own worktree and task directory; out of lane: {', '.join(outside)}", antigravity); return
    if gated and role == "coordinator":
        _deny(f"impact-guard: coordinator task {task_path} must not edit source directly; use orchestrate.py -Action Apply.", antigravity); return
    if not gated or role == "coordinator" or not code_change: return
    schema_path = Path(__file__).resolve().parent.parent / "schemas" / "task.schema.json"
    import json
    schema = json.loads(schema_path.read_text(encoding="utf-8-sig"))
    freeze = [item for item in flags if item in schema["x_agent_workflow"]["freeze_required"]]
    if freeze and not data.get("frozen_at"):
        _deny(f"impact-guard: {task_path} carries freeze-required risk flag(s) [{', '.join(freeze)}] but has no 'frozen_at'.", antigravity); return
    # Standard is intentionally the hot path: no Project docs / Impact surface / fingerprint.
    if profile == "standard": return
    impact = _section(content, "Impact surface")
    if not impact or "<" in impact and ">" in impact:
        _deny(f"impact-guard: fill '## Impact surface' in {task_path} before editing code.", antigravity); return
    docs = _section(content, "Project docs")
    read_value = ""
    match = re.search(r"(?mi)^\s*-\s*read:\s*(.+?)\s*$", docs)
    if match: read_value = match.group(1).strip()
    if not read_value or re.fullmatch(r"<.*>", read_value):
        _deny(f"impact-guard: fill '## Project docs' - read: in {task_path} before editing code.", antigravity); return
    none = re.match(r"(?i)^none\s*-\s*(.+)$", read_value)
    if none and re.fullmatch(r"<.*>", none.group(1).strip()):
        _deny(f"impact-guard: '## Project docs' - read: none needs an actual reason in {task_path}.", antigravity); return
    if not none:
        missing = [item.strip() for item in read_value.split(",") if item.strip() and not (Path(item.strip()) if Path(item.strip()).is_absolute() else Path(resolved["root"], item.strip())).is_file()]
        if missing:
            _deny(f"impact-guard: '## Project docs' - read: names a path that does not exist in the repo: {', '.join(missing)}.", antigravity); return


def main(argv: list[str] | None = None) -> int:
    try: run(read_json_stdin())
    except Exception as exc:
        try: write_stderr(f"impact-guard: {exc}")
        except Exception: pass
    return 0


if __name__ == "__main__": raise SystemExit(main())
