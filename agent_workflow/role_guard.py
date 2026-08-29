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
VERIFIER_EPHEMERAL_NAME = r"aw-verifier[-_][a-zA-Z0-9_.-]+"
VERIFIER_SCRATCH_FILE = re.compile(r"^aw[-_]verifier[-_][A-Za-z0-9_.-]+$", re.I)
CREATE_TOOL_NAMES = frozenset({"write", "write_file", "create_file"})
PATH_KEYS = ("file_path", "filePath", "path", "target_file", "notebook_path")
SQL_CLIENT = re.compile(r"(?:^|[\s;&|])(?:mysql|mariadb|psql|sqlite3|sqlcmd|isql)(?:\.exe)?\b", re.I)
SQL_WRITE = re.compile(r"\b(?:insert|update|delete|drop|alter|truncate|replace|grant|revoke|create|load\s+data|copy)\b", re.I)
DOCKER_READ_COMMANDS = frozenset({"version", "info", "ps", "images", "inspect", "logs", "stats", "top", "port", "history", "diff", "pull"})
DOCKER_INSPECT_COMMANDS = DOCKER_READ_COMMANDS - {"pull"}


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
    if re.search(r"(?:^|\s)(?:python|python3|py|node|pwsh|powershell|bash|sh|cmd)\b[^;&|]*(?:open\s*\([^)]*['\"][waxWAX]|write_text|write_bytes|fs\.write|set-content|out-file)", flat, re.I):
        return True
    if re.search(r"(?:^|\s)(?:npm|pnpm|yarn|pip|go)\s+(?:install|uninstall|update|get)\b", flat, re.I):
        return True
    # Redirections to /dev/null, NUL, or another stream (2>&1, >&2) are stderr
    # plumbing, not writes; strip them before checking for a real file target.
    scrubbed = re.sub(r"\d?>{1,2}\s*(?:&\d+|/dev/null|nul)\b", " ", flat, flags=re.I)
    if re.search(r"(^|[^<>])>{1,2}[^>]", scrubbed) or re.search(r"\b(?:>>|2>|2>>)", scrubbed):
        return True
    return False


def verifier_docker_allowed(command: str) -> bool:
    """Allow Docker only for isolated, prefixed, disposable resources."""
    segments = [item.strip() for item in re.split(r"(?:;|&&|\|\|)", command) if item.strip()]
    for segment in segments:
        match = re.search(r"(?:^|\s)docker(?:\.exe)?\s+(.+)$", segment, re.I)
        if not match:
            continue
        args = match.group(1).strip()
        command_name = args.split(None, 1)[0].casefold()
        if command_name in DOCKER_READ_COMMANDS:
            continue
        if command_name == "run":
            if not re.search(r"(?:^|\s)--rm(?:\s|$)", args) or not re.search(r"(?:^|\s)--name(?:=|\s+)" + VERIFIER_EPHEMERAL_NAME + r"(?:\s|$)", args, re.I):
                return False
            if re.search(r"(?:^|\s)(?:-v|--volume|--mount|--volumes-from|--privileged)(?:=|\s|$)", args, re.I):
                return False
            if re.search(r"(?:^|\s)(?:--network\s+host|--pid\s+host)(?:\s|$)", args, re.I):
                return False
            continue
        if command_name == "exec":
            if not re.search(r"^exec\s+(?:(?:-it|-i|-t|--interactive|--tty)\s+)*" + VERIFIER_EPHEMERAL_NAME + r"(?:\s|$)", args, re.I):
                return False
            continue
        if command_name in {"stop", "rm", "kill"}:
            if not re.search(r"^(?:stop|rm|kill)\s+(?:(?:-f|--force)\s+)*" + VERIFIER_EPHEMERAL_NAME + r"(?:\s|$)", args, re.I):
                return False
            continue
        return False
    return True


def verifier_shell_allowed(command: str) -> bool:
    if re.search(r"(?:^|[\s;&|])docker(?:\.exe)?\s+", command, re.I) and not verifier_docker_allowed(command):
        return False
    if SQL_CLIENT.search(command) and SQL_WRITE.search(command):
        return bool(re.search(r"\bdocker(?:\.exe)?\s+exec\b[^;&|]*" + VERIFIER_EPHEMERAL_NAME, command, re.I))
    return True


def protected_external_write(command: str) -> bool:
    if SQL_CLIENT.search(command) and SQL_WRITE.search(command):
        return True
    segments = [item.strip() for item in re.split(r"(?:;|&&|\|\|)", command) if item.strip()]
    for segment in segments:
        match = re.search(r"(?:^|\s)docker(?:\.exe)?\s+(.+)$", segment, re.I)
        if match and match.group(1).split(None, 1)[0].casefold() not in DOCKER_INSPECT_COMMANDS:
            return True
    return False


def path_from_payload(payload: dict[str, Any]) -> str:
    call = payload.get("toolCall")
    if isinstance(call, dict):
        args = call.get("args") or {}
        if isinstance(args, dict):
            for key in PATH_KEYS:
                value = args.get(key)
                if isinstance(value, str) and value.strip():
                    return value
    tool_input = payload.get("tool_input") or payload.get("input") or {}
    if isinstance(tool_input, dict):
        for key in PATH_KEYS:
            value = tool_input.get(key)
            if isinstance(value, str) and value.strip():
                return value
    return ""


def verifier_scratch_create(payload: dict[str, Any]) -> bool:
    """Verifier may create its own disposable verification files and nothing else.

    Create-only on an `aw-verifier-*` name: an existing path is always refused, so
    anything the main conversation wrote stays untouched.
    """
    if tool_name(payload) not in CREATE_TOOL_NAMES:
        return False
    raw = path_from_payload(payload)
    if not raw:
        return False
    target = Path(raw)
    if not VERIFIER_SCRATCH_FILE.match(target.name):
        return False
    return not target.exists()


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
        command = command_from_payload(payload)
        if role == "verifier" and command and not verifier_shell_allowed(command):
            decision(args.platform, "deny", "role-guard: verifier may use only disposable, prefixed Docker resources and SQL writes inside them.")
            return 0
        if role and role != "verifier" and command and protected_external_write(command):
            decision(args.platform, "deny", "role-guard: only verifier may use mutating Docker or SQL operations, and only in disposable test resources.")
            return 0
        if role in WRITE_ROLES or not role or not write_requested(payload):
            return 0
        if role == "verifier":
            if verifier_scratch_create(payload):
                return 0
            decision(args.platform, "deny", "role-guard: verifier may only create a new file named aw-verifier-*; existing files stay as the main conversation left them.")
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
