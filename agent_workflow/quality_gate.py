"""Fail-open Stop hook plumbing around the shared Python task gate."""

from __future__ import annotations

import json
from pathlib import Path

from .frontmatter import field
from .project_resolver import resolve_project
from .protocol import read_json_stdin, write_json, write_stderr
from .task_gate import gate


def run(payload: dict, state_root: str | None = None) -> None:
    if payload.get("stop_hook_active"): return
    cwd = (payload.get("workspacePaths") or [payload.get("cwd")])[0]
    if not cwd: return
    state = state_root or str(Path.home() / ".agent-workflow")
    resolved = resolve_project(str(cwd), state, False, [], "")
    notes: list[str] = []
    keys: list[str] = []
    for item in resolved.get("stopped_tasks", []):
        if not item.get("stop_reason") or str(item.get("stop_reason")).startswith("<"):
            notes.append(f"{item['path']} [{item['status']}] has no stop_reason")
            keys.append(f"{item['path']}|{item['status']}")
    active = resolved.get("active_tasks", [])
    if len(active) > 1:
        notes.append(f"worktree {resolved['worktree_id']} has multiple in_progress tasks: {', '.join(active)}"); keys.append(f"multiple:{resolved['worktree_id']}")
    elif len(active) == 1:
        result = gate(active[0], str(cwd), resolved["worktree_id"], "Stop")
        if result["issues"]:
            notes.append(f"{active[0]} is in_progress and incomplete - {' | '.join(result['issues'])}"); keys.append(f"task:{active[0]}")
    if not notes: return
    session = str(payload.get("session_id", ""))
    if session:
        notice_dir = Path(resolved["project_dir"]) / ".stop-notices"; notice_dir.mkdir(parents=True, exist_ok=True)
        notice_path = notice_dir / f"{session}.json"
        try: existing = json.loads(notice_path.read_text(encoding="utf-8"))
        except Exception: existing = []
        keys = [key for key in keys if key not in existing]
        if not keys: return
        notice_path.write_text(json.dumps(existing + keys, ensure_ascii=False), encoding="utf-8", newline="\n")
    write_json({"continue": True, "systemMessage": "agent-workflow: this worktree has unfinished task state - " + " | ".join(notes)})


def main(argv: list[str] | None = None) -> int:
    try: run(read_json_stdin())
    except Exception as exc:
        try: write_stderr(f"quality-gate: {exc}")
        except Exception: pass
    return 0


if __name__ == "__main__": raise SystemExit(main())
