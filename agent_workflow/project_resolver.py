"""Project/worktree resolution used by Python hooks and command entrypoints."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

from .frontmatter import field
from .paths import normalized, resolved
from .protocol import run_command, write_json


def stable_id(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


class ProjectLock:
    def __init__(self, path: Path, timeout: float = 5.0) -> None:
        self.path = path
        self.timeout = timeout
        self.held = False

    def __enter__(self) -> "ProjectLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                self.path.mkdir()
                self.held = True
                return self
            except FileExistsError:
                if time.monotonic() >= deadline:
                    raise RuntimeError(f"could not acquire the project lock: {self.path}")
                time.sleep(0.025)

    def __exit__(self, *_: object) -> None:
        if self.held:
            self.path.rmdir()


def resolve_project(path: str, state_root: str, ensure: bool, register: list[str], roster_for: str) -> dict[str, Any]:
    resolved_path = resolved(path)
    root = resolved_path
    common_dir = resolved_path
    remote = ""
    repo_fingerprint = ""
    is_git = False

    # One process instead of three: rev-parse accepts all its query flags together and
    # prints one line per flag in order, so the work-tree probe, toplevel, and
    # git-common-dir lookups collapse into a single subprocess spawn.
    probe = run_command(["git", "-C", str(resolved_path), "rev-parse",
                         "--is-inside-work-tree", "--show-toplevel", "--git-common-dir"])
    probe_lines = probe.stdout.splitlines()
    if probe.returncode == 0 and len(probe_lines) >= 3 and probe_lines[0].strip().lower() == "true":
        is_git = True
        root = resolved(probe_lines[1].strip())
        common_raw = probe_lines[2].strip()
        common_dir = resolved(Path(root, common_raw) if not Path(common_raw).is_absolute() else common_raw)
        remote_result = run_command(["git", "-C", str(resolved_path), "config", "--get", "remote.origin.url"])
        if remote_result.returncode == 0:
            remote = remote_result.stdout.splitlines()[0].strip() if remote_result.stdout.splitlines() else ""
        roots_result = run_command(["git", "-C", str(resolved_path), "rev-list", "--max-parents=0", "HEAD"])
        if roots_result.returncode == 0:
            repo_fingerprint = ",".join(sorted(line.strip() for line in roots_result.stdout.splitlines() if line.strip())).casefold()

    root_norm = normalized(root)
    common_norm = normalized(common_dir)
    project_id = stable_id(common_norm + "|" + remote.casefold() + "|" + repo_fingerprint)
    worktree_id = stable_id(root_norm)
    project_dir = Path(state_root).expanduser() / "projects" / project_id
    task_root = project_dir / "tasks"
    project_file = project_dir / "project.json"
    now = time.strftime("%Y-%m-%dT%H:%M:%S%z")

    registered = [{"id": stable_id(normalized(item)), "path": str(resolved(item))} for item in register]
    if ensure or registered:
        task_root.mkdir(parents=True, exist_ok=True)
        (project_dir / "knowledge" / "entries").mkdir(parents=True, exist_ok=True)
        (project_dir / "history" / "tasks").mkdir(parents=True, exist_ok=True)
        with ProjectLock(project_dir / ".project.lock"):
            if project_file.exists():
                project = json.loads(project_file.read_text(encoding="utf-8"))
                aliases = list(project.get("aliases", []))
                worktrees = list(project.get("worktrees", []))
                created_at = project.get("created_at", now)
            else:
                aliases, worktrees, created_at = [], [], now
            if str(root) not in aliases:
                aliases.append(str(root))
            incoming = ([{"id": worktree_id, "path": str(root)}] if ensure else []) + registered
            for entry in incoming:
                worktrees = [item for item in worktrees if item.get("id") != entry["id"]]
                worktrees.append(entry)
            if not worktrees:
                worktrees = [{"id": worktree_id, "path": str(root)}]
            data = {
                "id": project_id,
                "canonical_root": str(root),
                "git_common_dir": str(common_dir),
                "remote": remote,
                "repo_fingerprint": repo_fingerprint,
                "aliases": sorted(set(aliases)),
                "worktrees": sorted(worktrees, key=lambda item: item.get("id", "")),
                "created_at": created_at,
                "updated_at": now,
            }
            if project_file.exists():
                before = json.loads(project_file.read_text(encoding="utf-8"))
                data["updated_at"] = before.get("updated_at", now)
                if before != data:
                    data["updated_at"] = now
                else:
                    data = before
            project_file.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")

    active: list[str] = []
    stopped: list[dict[str, str]] = []
    roster: list[dict[str, str]] = []
    if task_root.exists():
        for task_path in task_root.rglob("task.md"):
            try:
                content = "\n".join(task_path.read_text(encoding="utf-8").splitlines()[:64])
            except OSError:
                continue
            task_worktree = field(content, "worktree_id")
            status = field(content, "status")
            if task_worktree == worktree_id and status == "in_progress":
                active.append(str(task_path))
            if task_worktree == worktree_id and status in {"paused", "blocked"}:
                stopped.append({"path": str(task_path), "status": status, "stop_reason": field(content, "stop_reason")})
            if roster_for and field(content, "parent_task_id") == roster_for:
                roster.append({
                    "id": field(content, "id"),
                    "path": str(task_path),
                    "worktree_id": task_worktree,
                    "status": status,
                    "subtask_role": field(content, "subtask_role"),
                    "delivery_status": field(content, "delivery_status"),
                })

    return {
        "is_git": is_git,
        "project_id": project_id,
        "worktree_id": worktree_id,
        "root": str(root),
        "git_common_dir": str(common_dir),
        "remote": remote,
        "repo_fingerprint": repo_fingerprint,
        "project_dir": str(project_dir),
        "task_root": str(task_root),
        "active_tasks": sorted(active),
        "stopped_tasks": sorted(stopped, key=lambda item: item["path"]),
        "registered_worktrees": registered,
        "roster": sorted(roster, key=lambda item: item["id"]),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--path", default=os.getcwd())
    parser.add_argument("--state-root", default=str(Path.home() / ".agent-workflow"))
    parser.add_argument("--ensure", action="store_true")
    parser.add_argument("--register-worktree", action="append", default=[])
    parser.add_argument("--roster-for", default="")
    args = parser.parse_args(argv)
    write_json(resolve_project(args.path, args.state_root, args.ensure, args.register_worktree, args.roster_for))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
