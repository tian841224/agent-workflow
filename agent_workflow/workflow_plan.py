"""Expose deterministic capability suggestions for the main conversation."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .frontmatter import frontmatter, read_text
from .protocol import read_json_stdin, write_json
from .workflow import manual_plan, suggested_capabilities


def _task(args: argparse.Namespace) -> dict:
    if args.task_path:
        return frontmatter(read_text(Path(args.task_path)))
    value = read_json_stdin()
    if not isinstance(value, dict):
        raise ValueError("stdin must contain a JSON task object")
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Suggest workflow capabilities from task metadata")
    parser.add_argument("--task-path", default="", help="task.md path; otherwise read a JSON task object from stdin")
    args = parser.parse_args(argv)
    task = _task(args)
    plan = manual_plan(task)
    write_json({
        "suggested": suggested_capabilities(task),
        "requested": list(task.get("workflow_request", [])),
        "selected": [item["name"] for item in plan["selected"]],
        "order": plan["order"],
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
