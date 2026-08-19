"""Hard write guard for non-development agent roles."""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path
from typing import Any

from .git_guard import active_role, decision
from .protocol import read_json_stdin, write_stderr


WRITE_ROLES = frozenset({"worker"})
ROLE_KEYS = frozenset({"role", "agent_role", "agentRole", "agent_type", "agentType", "agent_name", "agentName", "subtask_role"})
WRITE_TOOL_NAMES = frozenset({
    "apply_patch", "delete_file", "edit", "edit_file", "multi_edit", "notebookedit",
    "rename_file", "write", "write_file",
})


def normalize_role(value: str) -> str:
    role = value.strip().casefold().replace("agent-workflow-", "")
    return role.replace("_", "-")


def payload_role(payload: dict[str, Any]) -> str:
    for key in ROLE_KEYS:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return normalize_role(value)
    for container_key in ("agent", "metadata", "context", "session"):
        container = payload.get(container_key)
        if isinstance(container, dict):
            for key in ROLE_KEYS:
                value = container.get(key)
                if isinstance(value, str) and value.strip():
                    return normalize_role(value)
    return ""


def tool_name(payload: dict[str, Any]) -> str:
    for key in ("tool_name", "toolName", "tool"):
        value = payload.get(key)
        if isinstance(value, str):
            return value.casefold().replace("-", "_")
    call = payload.get("toolCall")
    if isinstance(call, dict) and isinstance(call.get("name"), str):
        return str(call["name"]).casefold().replace("-", "_")
    return ""


def command_from_payload(payload: dict[str, Any]) -> str:
    call = payload.get("toolCall")
    if isinstance(call, dict):
        args = call.get("args") or {}
        if isinstance(args, dict):
            return str(args.get("CommandLine") or args.get("command") or "")
    tool_input = payload.get("tool_input") or payload.get("input") or {}
    if isinstance(tool_input, dict):
        return str(tool_input.get("command") or tool_input.get("CommandLine") or "")
    return ""


def shell_writes(command: str) -> bool:
    flat = re.sub(r"\s+", " ", command).strip()
    if not flat:
        return False
    if re.search(r"(?:^|[;&|])\s*(?:apply_patch|patch|tee|touch|rm|rmdir|cp|mv|mkdir|install)\b", flat, re.I):
        return True
    if re.search(r"\b(?:set-content|add-content|out-file|clear-content|new-item|remove-item|copy-item|move-item|rename-item)\b", flat, re.I):
        return True
    if re.search(r"(?:^|\s)(?:sed|perl)\b[^;&|]*\s-i(?:\s|$)", flat, re.I):
        return True
    if re.search(r"(?:^|\s)(?:python|python3|py|node|pwsh|powershell|bash|sh|cmd)\b[^;&|]*(?:open\s*\(|write_text|write_bytes|fs\.write|set-content|out-file)", flat, re.I):
        return True
    if re.search(r"(?:^|\s)(?:npm|pnpm|yarn|pip|go)\s+(?:install|uninstall|update|get)\b", flat, re.I):
        return True
    if re.search(r"(^|[^<>])>{1,2}[^>]", flat) or re.search(r"\b(?:>>|2>|2>>)", flat):
        return True
    return False


def write_requested(payload: dict[str, Any]) -> bool:
    name = tool_name(payload)
    if name in WRITE_TOOL_NAMES or any(token in name for token in ("write", "edit", "delete", "rename")):
        return True
    if name in {"bash", "powershell", "shell_command", "run_command", "terminal"}:
        return shell_writes(command_from_payload(payload))
    return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--platform", default="")
    parser.add_argument("--role", default="")
    parser.add_argument("--state-root", default=str(Path.home() / ".agent-workflow"))
    args = parser.parse_args(argv)
    try:
        payload = read_json_stdin()
        explicit_role = normalize_role(args.role) if args.role else ""
        role = explicit_role or normalize_role(os.environ.get("AGENT_WORKFLOW_ROLE", ""))
        if not role:
            for env_name in ("CLAUDE_AGENT_TYPE", "CLAUDE_AGENT_NAME", "CODEX_AGENT_TYPE", "CODEX_AGENT_NAME", "ANTIGRAVITY_AGENT_TYPE", "ANTIGRAVITY_AGENT_NAME"):
                role = normalize_role(os.environ.get(env_name, ""))
                if role:
                    break
        role = role or payload_role(payload)
        if not role:
            workspace = (payload.get("workspacePaths") or [payload.get("cwd") or ""])[0]
            role = active_role(workspace, args.state_root) if workspace else ""
        if role in WRITE_ROLES or not role or not write_requested(payload):
            return 0
        decision(args.platform, "deny", f"role-guard: {role or 'unknown'} role is read-only; write operation denied.")
    except Exception as error:
        try:
            write_stderr(f"role-guard: {error}")
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
