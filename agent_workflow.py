"""Source-tree entrypoint for the portable agent-workflow Python runtime."""

from __future__ import annotations

import sys
from pathlib import Path

# Register this exact script directory explicitly instead of relying on the
# console's current-directory state or a Python installation's path settings.
SOURCE_ROOT = str(Path(__file__).resolve().parent)
if SOURCE_ROOT not in sys.path:
    sys.path.insert(0, SOURCE_ROOT)

# command -> agent_workflow submodule name. Each submodule exposes main(argv).
# Import is deferred to dispatch time so a hook invocation (git-guard, skill-guard,
# memory-context) only pays for the module it actually runs.
COMMANDS = {
    "git-guard": "git_guard",
    "skill-guard": "skill_guard",
    "project-resolver": "project_resolver",
    "task-gate": "task_gate",
    "validate-task": "validate_task",
    "worktree-fingerprint": "worktree_fingerprint",
    "close-task": "close_task",
    "check-task": "check_task",
    "install": "installer",
    "knowledge": "knowledge",
    "learn": "learn",
    "memory-context": "memory_context",
    "pre-review": "pre_review",
    "project-doc": "project_doc",
    "retro": "retro",
    "runtime-check": "runtime_check",
    "split-plan": "split_plan",
    "waive-roles": "waive_roles",
    "orchestrate": "orchestrate",
    "workflow-plan": "workflow_plan",
}


def main() -> int:
    argv = sys.argv[1:]
    if not argv or argv[0] not in COMMANDS:
        sys.stderr.write(
            "usage: agent_workflow.py <command> [args]\ncommands: "
            + ", ".join(sorted(COMMANDS))
            + "\n"
        )
        return 2
    from importlib import import_module

    module = import_module("agent_workflow." + COMMANDS[argv[0]])
    return module.main(argv[1:])


if __name__ == "__main__":
    raise SystemExit(main())
