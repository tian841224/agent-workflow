"""Source-tree entrypoint for the portable agent-workflow Python runtime."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Register this exact script directory explicitly instead of relying on the
# console's current-directory state or a Python installation's path settings.
SOURCE_ROOT = str(Path(__file__).resolve().parent)
if SOURCE_ROOT not in sys.path:
    sys.path.insert(0, SOURCE_ROOT)

from agent_workflow.close_task import main as close_task_main
from agent_workflow.check_task import main as check_task_main
from agent_workflow.git_guard import main as git_guard_main
from agent_workflow.role_guard import main as role_guard_main
from agent_workflow.knowledge import main as knowledge_main
from agent_workflow.installer import main as installer_main
from agent_workflow.path_grammar import main as path_grammar_main
from agent_workflow.pre_review import main as pre_review_main
from agent_workflow.project_resolver import main as project_resolver_main
from agent_workflow.project_doc import main as project_doc_main
from agent_workflow.retro import main as retro_main
from agent_workflow.runtime_check import main as runtime_check_main
from agent_workflow.split_plan import main as split_plan_main
from agent_workflow.task_gate import main as task_gate_main
from agent_workflow.validate_task import main as validate_task_main
from agent_workflow.waive_roles import main as waive_roles_main
from agent_workflow.worktree_fingerprint import main as fingerprint_main
from agent_workflow.orchestrate import main as orchestrate_main
from agent_workflow.migrate import main as migrate_main


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("git-guard", "role-guard", "project-resolver", "task-gate", "validate-task", "worktree-fingerprint", "close-task", "check-task", "install", "knowledge", "path-grammar", "pre-review", "project-doc", "retro", "runtime-check", "split-plan", "waive-roles", "orchestrate", "migrate"))
    args, rest = parser.parse_known_args()
    if args.command == "git-guard":
        return git_guard_main(rest)
    if args.command == "role-guard":
        return role_guard_main(rest)
    commands = {
        "project-resolver": project_resolver_main,
        "task-gate": task_gate_main,
        "validate-task": validate_task_main,
        "worktree-fingerprint": fingerprint_main,
        "close-task": close_task_main,
        "check-task": check_task_main,
        "install": installer_main,
        "knowledge": knowledge_main,
        "path-grammar": path_grammar_main,
        "pre-review": pre_review_main,
        "project-doc": project_doc_main,
        "retro": retro_main,
        "runtime-check": runtime_check_main,
        "split-plan": split_plan_main,
        "waive-roles": waive_roles_main,
        "orchestrate": orchestrate_main,
        "migrate": migrate_main,
    }
    return commands[args.command](rest)


if __name__ == "__main__":
    raise SystemExit(main())
