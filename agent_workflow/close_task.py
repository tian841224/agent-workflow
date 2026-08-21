"""Only sanctioned status=in_progress -> done transition."""

from __future__ import annotations

import argparse
import re
from datetime import datetime
from pathlib import Path

from .project_resolver import resolve_project
from .task_gate import gate


def close(task_path: str = "", path: str = ".", state_root: str | None = None) -> int:
    state = state_root or str(Path.home() / ".agent-workflow")
    worktree_id = ""
    if not task_path:
        resolved = resolve_project(path, state, False, [], "")
        active = resolved.get("active_tasks", [])
        if not active: print("no in_progress task in this worktree; nothing to close."); return 1
        if len(active) > 1: print("this worktree has multiple in_progress tasks; close them one at a time: " + ", ".join(active)); return 1
        task_path, worktree_id = active[0], resolved["worktree_id"]
    target = Path(task_path)
    if not target.is_file(): print(f"task file not found: {task_path}"); return 1
    result = gate(str(target), path, worktree_id, "Close")
    if result["issues"]:
        print(f"close-task: {task_path} is not ready to close.")
        for issue in result["issues"]: print(f"  - {issue}")
        print("Fix the items above, or set status to paused/blocked if the work is stopping here.")
        return 1
    raw = target.read_text(encoding="utf-8")
    updated = re.sub(r"(?m)^(status:)\s*in_progress\s*(\r?)$", r"\1 done\2", raw, count=1)
    updated = re.sub(r"(?m)^(updated_at:)\s*\S+\s*(\r?)$", lambda m: f"{m.group(1)} {datetime.now().astimezone().isoformat(timespec='seconds')}{m.group(2)}", updated, count=1)
    if updated == raw: print(f"could not find a status: in_progress line in {task_path}"); return 1
    target.write_text(updated, encoding="utf-8", newline="")
    print(f"close-task: {task_path} is now done.")
    if result.get("waived"): print(f"close-task: WARNING - the independent roles were waived: {result['waived']}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(); parser.add_argument("--task-path", default=""); parser.add_argument("--path", default="."); parser.add_argument("--state-root", default="")
    args = parser.parse_args(argv); return close(args.task_path, args.path, args.state_root or None)


if __name__ == "__main__": raise SystemExit(main())
