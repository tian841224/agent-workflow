"""Why a review round found a blocker, accumulated until it earns a remedy.

Deliberately parallel to retro.py rather than merged into it: retro asks which
framework gate missed a regression, this asks which input was missing when the
work was done. Counting the two together would make neither total mean anything.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from pathlib import Path
from typing import Any

from .frontmatter import frontmatter
from .protocol import write_json

STORE = "review-causes"


def _schema() -> dict[str, Any]:
    path = Path(__file__).resolve().parent.parent / "schemas" / "review-cause.schema.json"
    return json.loads(path.read_text(encoding="utf-8-sig"))


def causes() -> list[str]:
    return list(_schema()["properties"]["cause"]["enum"])


def routing() -> dict[str, str]:
    return dict(_schema()["x_agent_workflow"]["remedy_routing"])


def threshold() -> int:
    return int(_schema()["x_agent_workflow"]["escalate_threshold"])


def _index(state: str) -> tuple[Path, dict[str, Any]]:
    path = Path(state) / STORE / "index.json"
    if not path.is_file():
        return path, {"schema_version": 1, "entries": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        raise RuntimeError("review-cause index is unreadable: " + str(path))
    if not isinstance(data.get("entries"), list):
        raise RuntimeError("review-cause index has no entries array: " + str(path))
    return path, data


def _save(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    data["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def escalated(state: str, minimum: int | None = None) -> list[dict[str, Any]]:
    """Open findings grouped by cause, keeping only groups that earned a remedy."""
    _, data = _index(state)
    limit = threshold() if minimum is None else minimum
    routes = routing()
    grouped: dict[str, list[dict[str, Any]]] = {}
    for entry in data["entries"]:
        if entry.get("status") == "open":
            grouped.setdefault(str(entry.get("cause")), []).append(entry)
    results = []
    for cause, members in grouped.items():
        remedy = routes.get(cause, "none")
        # A plain coding mistake has no input to fix, so it never earns a remedy however
        # often it recurs; without this the routing would invent work for noise.
        if remedy == "none" or len(members) < limit:
            continue
        paths = sorted({value for member in members for value in member.get("paths", [])})
        results.append({
            "cause": cause,
            "remedy_kind": remedy,
            "occurrences": len(members),
            "finding_ids": [str(member.get("id")) for member in members],
            "task_ids": sorted({str(member.get("task_id")) for member in members}),
            "paths": paths,
            "evidence": [str(member.get("evidence", "")) for member in members],
        })
    results.sort(key=lambda item: (-item["occurrences"], item["cause"]))
    return results


def escalated_count(state: str) -> int:
    """Nudge count for the SessionStart hook; never raises."""
    try:
        return len(escalated(str(state)))
    except Exception:
        return 0


def _uncovered(paths: list[str], repo_root: str) -> list[str]:
    from .project_doc import run

    try:
        result = run("Lookup", repo_root=repo_root, paths=paths)
    except Exception:
        return []
    return list(result.get("uncovered", [])) if isinstance(result, dict) else []


def record(state: str, task_path: str, round_number: int, cause: str,
           evidence: str, paths: list[str]) -> dict[str, Any]:
    if cause not in causes():
        raise RuntimeError("--cause must be one of: " + ", ".join(causes()))
    if not evidence.strip():
        raise RuntimeError("Record needs --evidence saying what was missing when the work was done")
    if round_number < 2:
        raise RuntimeError("a cause is recorded for a round that followed a blocker, so --round must be 2 or more")
    task = Path(task_path)
    if not task.is_file():
        raise RuntimeError("Record needs an existing --task-path")
    data = frontmatter(task.read_text(encoding="utf-8-sig"))
    task_id = str(data.get("id") or task.parent.name)
    index_path, index = _index(state)
    # One cause per review round: re-running Record for the same round corrects the
    # earlier judgement instead of inflating the count that drives the remedy.
    existing = next((item for item in index["entries"]
                     if item.get("task_id") == task_id and item.get("round") == round_number), None)
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    if existing:
        ident = str(existing["id"])
        existing.update({"cause": cause, "paths": paths, "evidence": evidence.strip(),
                         "status": "open", "updated_at": stamp})
    else:
        ident = time.strftime("%Y%m%d-%H%M%S-") + hashlib.sha256(f"{task_id}|{round_number}".encode()).hexdigest()[:8]
        index["entries"].append({"id": ident, "task_id": task_id, "project_id": str(data.get("project_id", "")),
                                 "round": round_number, "cause": cause, "paths": paths,
                                 "evidence": evidence.strip(), "status": "open",
                                 "created_at": stamp, "updated_at": stamp})
    finding = Path(state) / STORE / "findings" / (ident + ".md")
    finding.parent.mkdir(parents=True, exist_ok=True)
    finding.write_text(
        "---\nid: " + ident + "\ntask_id: " + task_id + "\nround: " + str(round_number)
        + "\ncause: " + cause + "\npaths: [" + ", ".join(paths) + "]\nstatus: open\ncreated_at: " + stamp
        + "\n---\n\n# " + task_id + " round " + str(round_number)
        + "\n\n## What was missing\n\n" + evidence.strip() + "\n",
        encoding="utf-8", newline="\n")
    index["entries"].sort(key=lambda item: str(item.get("created_at", "")))
    _save(index_path, index)
    open_count = sum(1 for item in index["entries"] if item.get("cause") == cause and item.get("status") == "open")
    remedy = routing().get(cause, "none")
    return {"ok": True, "id": ident, "cause": cause, "remedy_kind": remedy, "occurrences": open_count,
            "escalate": remedy != "none" and open_count >= threshold()}


def resolve(state: str, identifiers: list[str], status: str, note: str) -> dict[str, Any]:
    if status not in ("applied", "rejected"):
        raise RuntimeError("Resolve needs --status applied or rejected")
    index_path, index = _index(state)
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    resolved = []
    for ident in identifiers:
        entry = next((item for item in index["entries"] if item.get("id") == ident), None)
        finding = Path(state) / STORE / "findings" / (ident + ".md")
        if not entry or not finding.is_file():
            raise RuntimeError("finding or finding file is missing: " + ident)
        entry.update({"status": status, "updated_at": stamp})
        text = finding.read_text(encoding="utf-8-sig").replace("status: open", "status: " + status, 1)
        finding.write_text(text.rstrip("\n") + "\n\n## Resolution\n\n- " + status + ": " + (note or "no note") + "\n",
                           encoding="utf-8", newline="\n")
        resolved.append(ident)
    _save(index_path, index)
    return {"ok": True, "resolved": resolved, "status": status}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", required=True, choices=("Record", "List", "Escalate", "Resolve"))
    parser.add_argument("--state-root", default=str(Path.home() / ".agent-workflow"))
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--task-path", default="")
    parser.add_argument("--round", type=int, default=0)
    parser.add_argument("--cause", default="")
    parser.add_argument("--evidence", default="")
    parser.add_argument("--paths", nargs="*", default=[])
    parser.add_argument("--id", action="append", default=[])
    parser.add_argument("--status", choices=("open", "applied", "rejected"))
    parser.add_argument("--note", default="")
    parser.add_argument("--min-occurrences", type=int, default=0)
    args = parser.parse_args(argv)
    if args.action == "List":
        _, data = _index(args.state_root)
        entries = [item for item in data["entries"]
                   if (not args.cause or item.get("cause") == args.cause)
                   and (not args.status or item.get("status") == args.status)]
        write_json(sorted(entries, key=lambda item: str(item.get("created_at", "")), reverse=True))
        return 0
    if args.action == "Escalate":
        groups = escalated(args.state_root, args.min_occurrences or None)
        for group in groups:
            # Naming the paths no doc covers turns "documentation was missing" into a
            # concrete file to write, which is the whole point of routing doc_gap here.
            if group["remedy_kind"] == "project_doc" and group["paths"]:
                group["uncovered_paths"] = _uncovered(group["paths"], args.repo_root)
        write_json(groups)
        return 0
    if args.action == "Resolve":
        write_json(resolve(args.state_root, args.id, args.status or "", args.note))
        return 0
    write_json(record(args.state_root, args.task_path, args.round, args.cause, args.evidence, list(args.paths)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
