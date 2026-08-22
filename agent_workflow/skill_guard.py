"""PreToolUse guard reminding agents to load writing-for-agents before editing .agents/."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from .git_guard import decision
from .protocol import read_json_stdin, write_stderr
from .role_guard import WRITE_TOOL_NAMES, tool_name

PATH_KEYS = (
    "file_path", "FilePath", "notebook_path", "NotebookPath",
    "path", "Path", "target_file", "TargetFile",
)


def is_write_tool(name: str) -> bool:
    return name in WRITE_TOOL_NAMES or any(token in name for token in ("write", "edit", "delete", "rename"))


def paths_from_payload(payload: dict[str, Any]) -> list[str]:
    containers: list[dict[str, Any]] = []
    call = payload.get("toolCall")
    if isinstance(call, dict) and isinstance(call.get("args"), dict):
        containers.append(call["args"])
    tool_input = payload.get("tool_input") or payload.get("input")
    if isinstance(tool_input, dict):
        containers.append(tool_input)

    found: list[str] = []
    for container in containers:
        for key in PATH_KEYS:
            value = container.get(key)
            if isinstance(value, str) and value.strip():
                found.append(value)
        edits = container.get("edits")
        if isinstance(edits, list):
            for edit in edits:
                if not isinstance(edit, dict):
                    continue
                for key in PATH_KEYS:
                    value = edit.get(key)
                    if isinstance(value, str) and value.strip():
                        found.append(value)
    return found


def targets_agents_dir(path_value: str) -> bool:
    return ".agents" in Path(path_value.replace("\\", "/")).parts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--platform", default="")
    args = parser.parse_args(argv)
    try:
        payload = read_json_stdin()
        if not is_write_tool(tool_name(payload)):
            return 0
        paths = paths_from_payload(payload)
        if not paths or not any(targets_agents_dir(value) for value in paths):
            return 0

        reason = "skill-guard: editing files under .agents/ requires loading the writing-for-agents skill first."
        if args.platform.lower() == "codex":
            decision(args.platform, "deny", reason + " Codex does not support an interactive approval prompt for this hook, so the write is denied outright. Load the skill, then retry.")
        else:
            decision(args.platform, "ask", reason)
    except Exception as error:
        try:
            write_stderr(f"skill-guard: {error}")
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
