"""Compatibility API for composable workflow planning."""

from __future__ import annotations

from typing import Any, Mapping

from .workflow_planner import legacy_profile, plan_task, planner_enabled


def get_task_profile(code_change: bool, risk_flags: list[str] | None = None,
                     change_kind: str = "", subtask_role: str = "",
                     task: Mapping[str, Any] | None = None) -> str:
    if task and planner_enabled(task):
        return str(plan_task(task).get("profile", "standard"))
    return legacy_profile(code_change, risk_flags, change_kind, subtask_role)
