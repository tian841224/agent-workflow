"""PreToolUse Git safety guard with a UTF-8-only JSON boundary."""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path
from typing import Any

from .frontmatter import field
from .paths import is_within
from .protocol import read_json_stdin, write_json, write_stderr


def revision_arg(token: str) -> bool:
    return token == "HEAD" or bool(re.fullmatch(r"HEAD~[1-9][0-9]*|[0-9a-fA-F]{7,40}", token))


def git_segment_read_only(tokens: list[str]) -> bool:
    if not tokens or tokens[0] != "git":
        return False
    index = 1
    while index < len(tokens):
        if tokens[index] == "-C":
            if index + 1 >= len(tokens):
                return False
            index += 2
            continue
        if tokens[index] == "--no-pager":
            index += 1
            continue
        break
    if index >= len(tokens):
        return False
    command = tokens[index]
    rest = tokens[index + 1 :]
    if command == "status":
        return all(item in {"--short", "--porcelain", "--branch"} for item in rest)
    if command == "diff":
        after_separator = False
        for item in rest:
            if after_separator:
                continue
            if item == "--":
                after_separator = True
                continue
            if item in {"--binary", "--check", "--name-only", "--name-status"} or revision_arg(item):
                continue
            return False
        return True
    if command == "log":
        after_separator = False
        index = 0
        while index < len(rest):
            item = rest[index]
            if after_separator:
                index += 1
                continue
            if item == "--":
                after_separator = True
            elif item == "-n":
                if index + 1 >= len(rest) or not re.fullmatch(r"[1-9][0-9]*", rest[index + 1]):
                    return False
                index += 1
            elif item != "--oneline" and not revision_arg(item):
                return False
            index += 1
        return True
    if command == "rev-parse":
        return all(item in {"HEAD", "--is-inside-work-tree", "--show-toplevel", "--git-dir", "--git-common-dir"} for item in rest)
    if command == "ls-files":
        after_separator = False
        for item in rest:
            if after_separator:
                continue
            if item == "--":
                after_separator = True
                continue
            if item not in {"--others", "--exclude-standard", "-z"}:
                return False
        return True
    return False


def readonly_git_command(command: str) -> bool:
    if "|" in command:
        return False
    segments = [item.strip() for item in re.split(r"(?:;|&&)", command) if item.strip()]
    return bool(segments) and all(git_segment_read_only(re.split(r"\s+", item)) for item in segments)


def decision(platform: str, value: str, reason: str) -> None:
    if platform.lower() == "antigravity":
        write_json({"decision": value, "reason": reason})
    else:
        write_json({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": value,
            "permissionDecisionReason": reason,
        }})


def active_role(cwd: str, state_root: str) -> str:
    from .project_resolver import resolve_project

    try:
        resolved = resolve_project(cwd, state_root, False, [], "")
    except Exception:
        return ""
    tasks = resolved.get("active_tasks", [])
    if len(tasks) != 1:
        return ""
    content = Path(tasks[0]).read_text(encoding="utf-8")
    return field(content, "subtask_role")


def command_from_payload(payload: dict[str, Any]) -> str:
    if payload.get("toolCall"):
        args = payload["toolCall"].get("args") or {}
        return str(args.get("CommandLine") or args.get("command") or "")
    return str((payload.get("tool_input") or {}).get("command") or "")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--platform", default="")
    parser.add_argument("--state-root", default=str(Path.home() / ".agent-workflow"))
    args = parser.parse_args(argv)
    try:
        payload = read_json_stdin()
        command = command_from_payload(payload)
        if not command:
            return 0
        flat = re.sub(r"\s+", " ", command).strip()
        if not re.search(r"\bgit\b", flat) or readonly_git_command(flat):
            return 0
        workspace = (payload.get("workspacePaths") or [payload.get("cwd") or ""])[0]
        role = active_role(workspace, args.state_root) if workspace else ""
        if role == "worker":
            decision(args.platform, "deny", "git-guard: worker task may only run allowlisted read-only Git commands.")
            return 0
        if role == "coordinator":
            decision(args.platform, "deny", "git-guard: coordinator task must not run direct Git writes; use orchestrate.py.")
            return 0

        deny = [
            r"\bgit\b[^&;|]*\bpush\b[^&;|]*(\s-f\b|\s--force\b|\s--force-with-lease\b)",
            r"\bgit\b[^&;|]*\breset\b[^&;|]*\s--hard\b",
            r"\bgit\b[^&;|]*\bclean\b[^&;|]*\s-[a-zA-Z]*f",
            r"\bgit\b[^&;|]*\bbranch\b[^&;|]*\s-D\b",
            r"\bgit\b[^&;|]*\bcheckout\b[^&;|]*\s--\s",
            r"\bgit\b[^&;|]*\brestore\b(?![^&;|]*--staged)",
            r"\bgit\b[^&;|]*\bstash\b[^&;|]*\b(drop|clear)\b",
        ]
        if any(re.search(pattern, flat) for pattern in deny):
            decision(args.platform, "deny", "git-guard: destructive Git operation denied; ask the user to perform it explicitly.")
            return 0

        ask = [
            r"\bgit\b[^&;|]*\bcommit\b", r"\bgit\b[^&;|]*\bpush\b", r"\bgit\b[^&;|]*\brebase\b",
            r"\bgit\b[^&;|]*\bmerge\b(?![^&;|]*--abort)", r"\bgit\b[^&;|]*\breset\b",
            r"\bgit\b[^&;|]*\bcherry-pick\b", r"\bgit\b[^&;|]*\brevert\b(?![^&;|]*--abort)",
        ]
        if any(re.search(pattern, flat) for pattern in ask):
            if args.platform.lower() == "codex":
                decision(args.platform, "deny", "git-guard: Codex does not support an interactive approval prompt for this hook, so the write is denied outright. Ask the user to run this Git command themselves.")
            else:
                decision(args.platform, "ask", "git-guard: Git write requires explicit user approval.")
    except Exception as error:
        try:
            log_dir = Path.home() / ".agent-workflow" / "logs"
            log_dir.mkdir(parents=True, exist_ok=True)
            with (log_dir / "hook-errors.log").open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(f"git-guard\t{error}\n")
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
