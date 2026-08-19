"""Central task profile classification shared by all Python gates."""

from __future__ import annotations


def get_task_profile(code_change: bool, risk_flags: list[str] | None = None,
                     change_kind: str = "", subtask_role: str = "") -> str:
    if not code_change:
        return "non-code"
    if subtask_role in {"coordinator", "worker"}:
        return "elevated"
    if any(risk_flags or []):
        return "elevated"
    if change_kind in {"feature", "refactor"}:
        return "elevated"
    return "standard"
