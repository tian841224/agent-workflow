"""Safe, patch-based lifecycle for automatically split coordinator work."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any

from .frontmatter import frontmatter
from .project_resolver import resolve_project
from .split_plan import eligible
from .agent_profiles import request_fields

PLATFORMS = {"Codex", "Claude", "Antigravity"}


def _dispatch_command(platform: str) -> str:
    return os.environ.get(f"AGENT_WORKFLOW_{platform.upper()}_DISPATCH_COMMAND", "").strip()


def launch(platform: str, request: dict[str, Any]) -> dict[str, Any]:
    """Launch through the platform adapter without exposing shell interpolation."""
    if platform not in PLATFORMS:
        return {"accepted": False, "error": f"unsupported platform: {platform}"}
    command = _dispatch_command(platform)
    if not command:
        return {"accepted": False, "error": f"{platform} dispatcher is not configured"}
    try:
        result = subprocess.run(command, input=json.dumps(request, ensure_ascii=False).encode("utf-8"),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                shell=True, check=False, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"accepted": False, "error": f"{platform} dispatcher failed: {exc}"}
    if result.returncode:
        return {"accepted": False, "error": result.stderr.decode("utf-8", "replace").strip() or "dispatcher rejected launch"}
    try:
        reply = json.loads(result.stdout.decode("utf-8", "replace"))
    except json.JSONDecodeError:
        return {"accepted": False, "error": "dispatcher did not return JSON"}
    expected_root = str(Path(str(request["worktree"])).resolve())
    if not isinstance(reply, dict) or reply.get("accepted") is not True:
        return {"accepted": False, "error": str(reply.get("error", "dispatcher rejected launch")) if isinstance(reply, dict) else "dispatcher rejected launch"}
    if str(Path(str(reply.get("worker_root", ""))).resolve()) != expected_root:
        return {"accepted": False, "error": "dispatcher acknowledgement has a different worker_root"}
    if str(reply.get("parent_task_id", "")) != str(request["parent_task_id"]):
        return {"accepted": False, "error": "dispatcher acknowledgement has a different parent_task_id"}
    return {"accepted": True, "dispatch_id": str(reply.get("dispatch_id", "")), "worker_root": expected_root}


def launch_reader(platform: str, goal: str, path: str = "") -> dict[str, Any]:
    """Launch a read-only profile without creating an implementation worktree."""
    request = {"goal": goal, "path": path, "read_only": True}
    request.update(request_fields(platform, "cheap_read"))
    command = _dispatch_command(platform)
    if not command:
        return {"accepted": False, "error": f"{platform} dispatcher is not configured"}
    try:
        result = subprocess.run(command, input=json.dumps(request, ensure_ascii=False).encode("utf-8"), stdout=subprocess.PIPE, stderr=subprocess.PIPE, shell=True, check=False, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"accepted": False, "error": f"{platform} dispatcher failed: {exc}"}
    if result.returncode:
        return {"accepted": False, "error": result.stderr.decode("utf-8", "replace").strip() or "dispatcher rejected launch"}
    try:
        reply = json.loads(result.stdout.decode("utf-8", "replace"))
    except json.JSONDecodeError:
        return {"accepted": False, "error": "dispatcher did not return JSON"}
    if not isinstance(reply, dict) or reply.get("accepted") is not True:
        return {"accepted": False, "error": str(reply.get("error", "dispatcher rejected launch")) if isinstance(reply, dict) else "dispatcher rejected launch"}
    return {"accepted": True, "dispatch_id": str(reply.get("dispatch_id", "")), "agent_profile": "cheap_read"}


def stamp() -> str: return datetime.now().astimezone().isoformat(timespec="seconds")


def git(repo: str | Path, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(["git", "-C", str(repo), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          stdin=subprocess.DEVNULL, shell=False, check=False, timeout=30, env=env)


def text(proc: subprocess.CompletedProcess[bytes]) -> str: return proc.stdout.decode("utf-8", "replace").strip()
def error(proc: subprocess.CompletedProcess[bytes]) -> str: return proc.stderr.decode("utf-8", "replace").strip() or text(proc)


def write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def set_field(path: Path, values: dict[str, str]) -> None:
    import re
    body = path.read_text(encoding="utf-8")
    for key, value in values.items():
        pattern = rf"(?m)^{re.escape(key)}:[^\r\n]*"
        body = re.sub(pattern, f"{key}: {value}", body, count=1) if re.search(pattern, body) else body
    path.write_text(body, encoding="utf-8", newline="")


def branch(repo: Path) -> str:
    result = git(repo, "symbolic-ref", "--quiet", "--short", "HEAD")
    return text(result) if result.returncode == 0 else ""


def snapshot(repo: Path) -> dict[str, str]:
    """Create an unreferenced commit from all current content without touching the real index."""
    head = text(git(repo, "rev-parse", "HEAD"))
    index, env = temporary_index(repo, head)
    try:
        added = git(repo, "add", "-A", env=env)
        if added.returncode: raise RuntimeError(f"cannot stage snapshot: {error(added)}")
        tree = text(git(repo, "write-tree", env=env))
        if not tree: raise RuntimeError("cannot create snapshot tree")
        commit_env = dict(env)
        commit_env.update({"GIT_AUTHOR_NAME": "agent-workflow snapshot", "GIT_AUTHOR_EMAIL": "snapshot@agent-workflow.invalid",
                           "GIT_COMMITTER_NAME": "agent-workflow snapshot", "GIT_COMMITTER_EMAIL": "snapshot@agent-workflow.invalid"})
        made = git(repo, "commit-tree", tree, "-p", head, env=commit_env)
        if made.returncode: raise RuntimeError(f"cannot create snapshot commit: {error(made)}")
        return {"head": head, "tree": tree, "base_commit": text(made), "fingerprint": hashlib.sha256((head + "\\0" + tree).encode()).hexdigest()}
    finally:
        index.unlink(missing_ok=True)


def snapshot_matches(repo: Path, saved: dict[str, Any]) -> bool:
    try:
        current = snapshot(repo)
    except RuntimeError:
        return False
    return current["head"] == saved.get("head") and current["tree"] == saved.get("tree")


def base_matches(repo: Path, base_commit: str) -> bool:
    """Native-dispatch equivalent of snapshot_matches: there is no captured dirty-state snapshot
    to compare against, so this only accepts a clean tree still sitting on the declared base."""
    if text(git(repo, "rev-parse", "HEAD")) != base_commit: return False
    status = git(repo, "status", "--porcelain")
    return status.returncode == 0 and not status.stdout.strip()


def owns(path: str, ownership: list[str]) -> bool:
    candidate = path.replace("\\", "/").casefold()
    for entry in ownership:
        prefix = str(entry).replace("\\", "/").casefold()
        if (prefix.endswith("/") and candidate.startswith(prefix)) or candidate == prefix:
            return True
    return False


def temporary_index(repo: Path, base: str) -> tuple[Path, dict[str, str]]:
    handle = tempfile.NamedTemporaryFile(prefix="aw-orchestrate-index-", delete=False); handle.close()
    env = os.environ.copy(); env["GIT_INDEX_FILE"] = handle.name
    result = git(repo, "read-tree", base, env=env)
    if result.returncode:
        Path(handle.name).unlink(missing_ok=True)
        raise RuntimeError(f"cannot initialise temporary index: {error(result)}")
    return Path(handle.name), env


def capture(worktree: Path, base: str) -> tuple[bytes, list[str]]:
    index, env = temporary_index(worktree, base)
    try:
        added = git(worktree, "add", "-A", env=env)
        if added.returncode: raise RuntimeError(f"cannot stage temporary delivery: {error(added)}")
        diff = git(worktree, "diff", "--cached", "--binary", "--full-index", "--no-renames", base, env=env)
        names = git(worktree, "diff", "--cached", "--name-only", "-z", base, env=env)
        if diff.returncode or names.returncode: raise RuntimeError(f"cannot collect delivery: {error(diff) or error(names)}")
        return diff.stdout, [item for item in names.stdout.decode("utf-8", "replace").split("\0") if item]
    finally:
        index.unlink(missing_ok=True)


def assess_repository(repo: str | Path, plan: dict[str, Any], platform: str) -> dict[str, Any]:
    root = Path(repo).resolve(); result = eligible("", plan); errors = list(result["errors"])
    if platform not in PLATFORMS: errors.append(f"unsupported platform: {platform}")
    if not branch(root): errors.append("parallel development requires a named branch")
    return {"eligible": not errors, "errors": errors, "workers": result["workers"], "platform": platform,
            "dispatch": "native-worker-root-confirmation" if platform in PLATFORMS else "sequential"}


def capture_patch(worktree: str | Path, base: str, ownership: list[str], destination: str | Path) -> dict[str, Any]:
    payload, paths = capture(Path(worktree).resolve(), base)
    if not payload: raise RuntimeError("worker delivery is empty")
    outside = [path for path in paths if not owns(path, ownership)]
    if outside: raise RuntimeError("worker delivery is outside file ownership: " + ", ".join(outside))
    target = Path(destination); target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(payload)
    return {"patch": str(target), "sha256": hashlib.sha256(payload).hexdigest(), "changed_paths": paths}


def integrate_patches(repo: str | Path, base: str, deliveries: list[dict[str, Any]], integration_root: str | Path,
                      destination: str | Path) -> dict[str, Any]:
    root, integration = Path(repo).resolve(), Path(integration_root).resolve()
    made = git(root, "worktree", "add", "--detach", str(integration), base)
    if made.returncode: raise RuntimeError(f"cannot create integration worktree: {error(made)}")
    auto_merged: list[str] = []
    try:
        for delivery in sorted(deliveries, key=lambda item: str(item.get("worker_id", ""))):
            patch = Path(str(delivery["patch"])); payload = patch.read_bytes()
            if hashlib.sha256(payload).hexdigest() != delivery["sha256"]: raise RuntimeError(f"delivery hash mismatch: {patch}")
            applied = git(integration, "apply", str(patch))
            if applied.returncode:
                merged = git(integration, "apply", "--3way", str(patch))
                if merged.returncode or text(git(integration, "diff", "--name-only", "--diff-filter=U")):
                    raise RuntimeError(f"cannot automatically integrate {delivery['worker_id']}: {error(merged) or error(applied)}")
                auto_merged.append(str(delivery["worker_id"]))
        checked = git(integration, "diff", "--check")
        if checked.returncode: raise RuntimeError(f"integrated patch fails diff check: {error(checked)}")
        payload, _ = capture(integration, base)
        if not payload: raise RuntimeError("cannot produce integrated patch: empty patch")
        target = Path(destination); target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(payload)
        return {"status": "ready", "patch": str(target), "sha256": hashlib.sha256(payload).hexdigest(), "auto_merged_workers": auto_merged}
    finally:
        removed = git(root, "worktree", "remove", "--force", str(integration))
        if removed.returncode: shutil.rmtree(integration, ignore_errors=True)


def context(args: argparse.Namespace) -> tuple[dict[str, Any], Path, str, Path]:
    result = resolve_project(args.path, args.state_root, False, [], ""); active = result["active_tasks"]
    if len(active) != 1: raise RuntimeError("exactly one active coordinator task is required in the current worktree")
    task = Path(active[0]); data = frontmatter(task.read_text(encoding="utf-8"))
    if data.get("subtask_role") != "coordinator": raise RuntimeError("the active task must be a coordinator")
    return result, task, str(data["id"]), task.parent


def record_for(args: argparse.Namespace) -> tuple[dict[str, Any], Path, Path, dict[str, Any], Path]:
    result, task, _, directory = context(args); path = directory / "orchestration.json"
    if not path.is_file(): raise RuntimeError("orchestration record is missing")
    return result, task, directory, json.loads(path.read_text(encoding="utf-8")), path


def assess(args: argparse.Namespace) -> None:
    result, _, coordinator, directory = context(args); outcome = assess_repository(result["root"], json.loads(Path(args.plan_path).read_text(encoding="utf-8")), args.platform)
    outcome["coordinator_task_id"] = coordinator; write(directory / "parallel-assessment.json", outcome); print(json.dumps(outcome, ensure_ascii=False, indent=2))


def init(args: argparse.Namespace) -> None:
    result, task, coordinator, directory = context(args)
    if str(frontmatter(task.read_text(encoding="utf-8")).get("task_type", "")).casefold() == "read_only":
        raise RuntimeError("read_only tasks must use the installed reader agent, not implementation orchestration")
    if (directory / "orchestration.json").exists(): raise RuntimeError("orchestration already exists")
    outcome = assess_repository(result["root"], json.loads(Path(args.plan_path).read_text(encoding="utf-8")), args.platform); write(directory / "parallel-assessment.json", outcome)
    if not outcome["eligible"]:
        set_field(task, {"integration_status": "abandoned", "updated_at": stamp()}); print(json.dumps({"mode": "sequential-fallback", **outcome}, ensure_ascii=False)); return
    snap = snapshot(Path(result["root"])); base = snap["base_commit"]; workers = []
    try:
        for item in outcome["workers"]:
            root = Path(result["project_dir"]) / "worktrees" / f"{coordinator}-{item['id']}"; made = git(result["root"], "worktree", "add", "--detach", str(root), base)
            if made.returncode: raise RuntimeError(f"cannot create worker {item['id']}: {error(made)}")
            worker = {"id": item["id"], "worktree": str(root.resolve()), "ownership": item["file_ownership"],
                      "title": item["title"], "goal": item["goal"], "completion_criteria": item["completion_criteria"],
                      "status": "pending", "delivery": None}
            workers.append(worker)
        def dispatch(worker: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
            reply = launch(args.platform, {"parent_task_id": coordinator, "worker_id": worker["id"], "worktree": worker["worktree"],
                                           "goal": worker["goal"], "file_ownership": worker["ownership"], "base_commit": base})
            return worker, reply
        with ThreadPoolExecutor(max_workers=len(workers), thread_name_prefix="agent-workflow-dispatch") as pool:
            dispatched = list(pool.map(dispatch, workers))
        failures = [(worker, reply) for worker, reply in dispatched if not reply.get("accepted")]
        if failures:
            worker, reply = failures[0]
            raise RuntimeError(f"cannot dispatch {worker['id']}: {reply.get('error', '')}")
        for worker, reply in dispatched:
            worker.update({"status": "running", "dispatch_id": reply.get("dispatch_id", "")})
    except Exception:
        for worker in workers: git(result["root"], "worktree", "remove", "--force", worker["worktree"])
        raise
    record = {"version": 3, "snapshot": snap, "base_commit": base, "branch": branch(Path(result["root"])), "platform": args.platform, "workers": workers, "integration": {"status": "pending"}, "created_at": stamp(), "updated_at": stamp()}
    write(directory / "orchestration.json", record); print(json.dumps(record, ensure_ascii=False, indent=2))


def start(args: argparse.Namespace) -> None:
    """Run the coordinator's explicit Assess -> Init entrypoint."""
    assess(args)
    init(args)


def register_native(args: argparse.Namespace) -> None:
    """Record an orchestration for workers the caller already dispatched with a host-native
    agent tool (e.g. Claude Code's Agent tool with isolation: "worktree"). Skips worktree
    creation and subprocess dispatch -- those already happened outside this process -- but
    reuses the same Collect/Integrate/Apply/Cleanup lifecycle as the subprocess-dispatch path."""
    result, task, coordinator, directory = context(args)
    if (directory / "orchestration.json").exists(): raise RuntimeError("orchestration already exists")
    declared = json.loads(Path(args.workers_path).read_text(encoding="utf-8"))
    plan = {"shared_persistent_state": False, "has_order_dependency": False, "workers": declared}
    outcome = eligible("", plan)
    if not outcome["errors"]:
        for item in declared:
            if item.get("status", "completed") == "failed": continue  # a worker the native dispatch never produced a worktree for
            if not str(item.get("worktree", "")).strip(): outcome["errors"].append(f"worker {item.get('id', '')} has no worktree")
            if not str(item.get("base_commit", "")).strip(): outcome["errors"].append(f"worker {item.get('id', '')} has no base_commit")
    if outcome["errors"]: raise RuntimeError("invalid native worker declaration: " + "; ".join(outcome["errors"]))
    workers = [{"id": item["id"], "worktree": str(Path(item["worktree"]).resolve()) if item.get("worktree") else "",
                "ownership": item["file_ownership"], "title": item["title"], "goal": item["goal"],
                "completion_criteria": item["completion_criteria"], "base_commit": item.get("base_commit", ""),
                "status": item.get("status", "completed"), "error": item.get("error"), "delivery": None} for item in declared]
    record = {"version": 3, "snapshot": None, "base_commit": args.base_commit, "branch": branch(Path(result["root"])),
              "platform": args.platform, "dispatch_mode": "native", "workers": workers,
              "integration": {"status": "pending"}, "created_at": stamp(), "updated_at": stamp()}
    write(directory / "orchestration.json", record); print(json.dumps(record, ensure_ascii=False, indent=2))


def worker_ready(args: argparse.Namespace) -> None:
    _, _, _, record, path = record_for(args); worker = next((item for item in record["workers"] if item["id"] == args.worker_id), None)
    if not worker: raise RuntimeError("worker was not declared by this orchestration")
    if Path(args.worker_root).resolve() != Path(worker["worktree"]).resolve(): worker["status"] = "fallback"; write(path, record); raise RuntimeError("worker root does not match its isolated worktree")
    worker["status"] = "completed"; worker["completed_at"] = stamp(); record["updated_at"] = stamp(); write(path, record)


def worker_failed(args: argparse.Namespace) -> None:
    _, _, _, record, path = record_for(args)
    worker = next((item for item in record["workers"] if item["id"] == args.worker_id), None)
    if not worker: raise RuntimeError("worker was not declared by this orchestration")
    worker["status"] = "failed"; worker["error"] = args.reason or "worker ended without completion"; worker["failed_at"] = stamp()
    record["updated_at"] = stamp(); write(path, record)


def collect(args: argparse.Namespace) -> None:
    result, _, directory, record, path = record_for(args); workers = [item for item in record["workers"] if not args.worker_id or item["id"] == args.worker_id]
    if not workers: raise RuntimeError("worker was not found")
    for worker in workers:
        if worker["status"] != "completed": continue
        delivery = capture_patch(worker["worktree"], worker.get("base_commit") or record["base_commit"], worker["ownership"], directory / "deliveries" / f"{worker['id']}.patch")
        delivery["worker_id"] = worker["id"]; worker["delivery"] = delivery; worker["status"] = "collected"
        # -C must be the main repo, not the worktree being removed: on Windows, git refuses to
        # delete a directory that is also its own -C target ("Permission denied").
        removed = git(result["root"], "worktree", "remove", "--force", worker["worktree"])
        if removed.returncode: raise RuntimeError(f"cannot clean collected worker {worker['id']}: {error(removed)}")
        worker["worktree_cleaned"] = True
    record["updated_at"] = stamp(); write(path, record)


def integrate(args: argparse.Namespace) -> None:
    result, task, directory, record, path = record_for(args)
    deliveries = [worker["delivery"] for worker in record["workers"] if worker["status"] == "collected"]
    if not deliveries: raise RuntimeError("there are no successful worker deliveries to integrate")
    try: combined = integrate_patches(result["root"], record["base_commit"], deliveries, directory / "integration-worktree", directory / "deliveries" / "combined.patch")
    except Exception as exc:
        record["integration"] = {"status": "blocked", "error": str(exc)}; record["updated_at"] = stamp(); write(path, record); set_field(task, {"integration_status": "conflicted", "updated_at": stamp()}); raise
    record["integration"] = combined; record["updated_at"] = stamp(); write(path, record)


def apply(args: argparse.Namespace) -> None:
    result, task, _, record, path = record_for(args); integration = record.get("integration", {})
    if integration.get("status") != "ready": raise RuntimeError("integration is not ready")
    root, patch = Path(result["root"]), Path(integration["patch"])
    unchanged = snapshot_matches(root, record["snapshot"]) if record.get("snapshot") else base_matches(root, record["base_commit"])
    if not unchanged: raise RuntimeError("main working tree changed after parallel development began")
    payload = patch.read_bytes()
    if hashlib.sha256(payload).hexdigest() != integration["sha256"]: raise RuntimeError("combined patch hash mismatch")
    checked = git(root, "apply", "--check", str(patch))
    if checked.returncode: raise RuntimeError(f"combined patch preflight failed: {error(checked)}")
    applied = git(root, "apply", str(patch))
    if applied.returncode: raise RuntimeError(f"combined patch apply failed: {error(applied)}")
    for worker in record["workers"]:
        if worker["status"] == "collected": worker["status"] = "applied"
    integration["status"] = "applied"; integration["applied_at"] = stamp(); record["updated_at"] = stamp(); write(path, record); set_field(task, {"integration_status": "applied", "updated_at": stamp()})


def cleanup(args: argparse.Namespace) -> None:
    result, _, _, record, path = record_for(args)
    if record.get("integration", {}).get("status") not in {"applied", "blocked"}: raise RuntimeError("cleanup is allowed only after integration is applied or blocked")
    for worker in record["workers"]:
        if args.worker_id and worker["id"] != args.worker_id: continue
        if worker["status"] not in {"applied", "failed", "blocked", "superseded"}: continue
        if worker.get("worktree_cleaned"): continue
        if not worker.get("worktree"): worker["status"] = "cleaned"; continue  # native dispatch never produced a worktree for this worker
        if worker.get("delivery"):
            payload, _ = capture(Path(worker["worktree"]), record["base_commit"])
            if hashlib.sha256(payload).hexdigest() != worker["delivery"]["sha256"]: raise RuntimeError(f"worker {worker['id']} changed after collection; refusing cleanup")
        removed = git(result["root"], "worktree", "remove", "--force", worker["worktree"])
        if removed.returncode: raise RuntimeError(f"cannot remove worker {worker['id']}: {error(removed)}")
        worker["status"] = "cleaned"
    record["updated_at"] = stamp(); write(path, record)


def status(args: argparse.Namespace) -> None:
    _, _, _, record, _ = record_for(args); print(json.dumps(record, ensure_ascii=False, indent=2))


def read(args: argparse.Namespace) -> None:
    result = launch_reader(args.platform, args.goal, args.read_path)
    if not result.get("accepted"):
        raise RuntimeError(result.get("error", "reader dispatch rejected"))
    print(json.dumps(result, ensure_ascii=False, indent=2))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(); parser.add_argument("--action", required=True, choices=("Assess", "Init", "Start", "Read", "RegisterNative", "WorkerReady", "WorkerFailed", "Collect", "Integrate", "Apply", "Cleanup", "Status")); parser.add_argument("--path", default="."); parser.add_argument("--state-root", default=str(Path.home() / ".agent-workflow")); parser.add_argument("--plan-path", default=""); parser.add_argument("--platform", default="Codex"); parser.add_argument("--goal", default=""); parser.add_argument("--read-path", default=""); parser.add_argument("--worker-id", default=""); parser.add_argument("--worker-root", default=""); parser.add_argument("--reason", default=""); parser.add_argument("--local-check", action="append", default=[]); parser.add_argument("--workers-path", default=""); parser.add_argument("--base-commit", default=""); args = parser.parse_args(argv)
    if args.action == "Read" and not args.goal: parser.error("--goal is required")
    if args.action in {"Assess", "Init", "Start"} and not args.plan_path: parser.error("--plan-path is required")
    if args.action == "RegisterNative" and (not args.workers_path or not args.base_commit): parser.error("--workers-path and --base-commit are required")
    if args.action == "WorkerReady" and (not args.worker_id or not args.worker_root): parser.error("--worker-id and --worker-root are required")
    if args.action == "WorkerFailed" and not args.worker_id: parser.error("--worker-id is required")
    {"Assess": assess, "Init": init, "Start": start, "Read": read, "RegisterNative": register_native, "WorkerReady": worker_ready, "WorkerFailed": worker_failed, "Collect": collect, "Integrate": integrate, "Apply": apply, "Cleanup": cleanup, "Status": status}[args.action](args)
    return 0


if __name__ == "__main__":
    try: raise SystemExit(main())
    except Exception as exc: print(str(exc), file=sys.stderr); raise SystemExit(1)
