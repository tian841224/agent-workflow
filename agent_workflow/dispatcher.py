"""Platform-neutral contract for launching isolated implementation workers.

The host platform owns agent creation.  The runtime supplies one JSON request
on stdin to a configured launcher and accepts only an acknowledgement that
echoes the exact worktree and parent task.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any


PLATFORMS = frozenset({"Codex", "Claude", "Antigravity"})


def _command(platform: str) -> str:
    return os.environ.get(f"AGENT_WORKFLOW_{platform.upper()}_DISPATCH_COMMAND", "").strip()


def launch(platform: str, request: dict[str, Any]) -> dict[str, Any]:
    """Launch through the platform adapter without exposing shell interpolation."""
    if platform not in PLATFORMS:
        return {"accepted": False, "error": f"unsupported platform: {platform}"}
    command = _command(platform)
    if not command:
        return {"accepted": False, "error": f"{platform} dispatcher is not configured"}
    try:
        result = subprocess.run(command, input=json.dumps(request, ensure_ascii=False).encode("utf-8"),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
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
