"""Capture durable, user-visible learning into the shared knowledge store."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any

from .frontmatter import frontmatter, set_field, summary_line
from .project_resolver import resolve_project
from .protocol import write_json
from .topics import same_subject, shares_word, tokens


CREDENTIAL_ASSIGNMENT = re.compile(
    r"(?im)\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|private[_-]?key)\b\s*[:=]\s*[^\s<>{}\[\]]{8,}"
)
KINDS = ("explicit", "correction", "decision", "error", "preference", "pitfall")
STATUSES = ("verified", "needs_verification", "superseded")
MAX_SUMMARY_CHARS = 200


def _slug(value: str) -> str:
    result = re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff]+", "-", value.casefold()).strip("-")
    return result[:72] or "learning"


def _project_id(cwd: str, state_root: str) -> str:
    resolved = resolve_project(cwd, state_root, False, [], "")
    project_id = str(resolved.get("project_id", ""))
    if not project_id:
        raise RuntimeError("could not resolve project for learning capture")
    return project_id


def _frontmatter(data: dict[str, str]) -> str:
    return "---\n" + "\n".join(f"{key}: {value}" for key, value in data.items()) + "\n---\n\n"


def _write(path: Path, text: str) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(text, encoding="utf-8", newline="\n")
    os.replace(temporary, path)


def _base(state: Path, scope: str, project_id: str) -> Path:
    if scope == "global":
        return state / "knowledge" / "global" / "entries"
    return state / "projects" / project_id / "knowledge" / "entries"


def _resolve(base: Path, reference: str) -> tuple[Path, str]:
    """Find an entry by either identifier Capture prints: the file id or the content sha."""
    wanted = reference.strip()
    for path in sorted(base.glob("*.md")):
        try:
            text = path.read_text(encoding="utf-8-sig")
        except OSError:
            continue
        digest = str(frontmatter(text).get("content_sha256") or "")
        if path.stem == wanted or (digest and digest == wanted):
            return path, digest
    raise RuntimeError("no entry in this scope: " + reference)


def _live(base: Path) -> list[dict[str, Any]]:
    """Captured entries still presented as current: native, not already retired."""
    found: list[dict[str, Any]] = []
    for path in sorted(base.glob("*.md")):
        try:
            text = path.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            continue
        data = frontmatter(text)
        sha = str(data.get("content_sha256") or "")
        if not sha or str(data.get("origin") or "").casefold() != "native":
            continue
        if str(data.get("status") or "verified").casefold() == "superseded":
            continue
        topic = str(data.get("topic") or path.stem)
        found.append({
            "path": path,
            "id": path.stem,
            "sha": sha,
            "topic": topic,
            "kind": str(data.get("kind") or ""),
            "summary": summary_line(text, MAX_SUMMARY_CHARS),
            "tokens": tokens(topic),
            "coexists": {str(value) for value in (data.get("coexists_with") or [])},
        })
    return found


def _report(entry: dict[str, Any]) -> dict[str, str]:
    return {"id": entry["id"], "topic": entry["topic"], "kind": entry["kind"], "summary": entry["summary"]}


def conflicts(base: Path) -> list[dict[str, Any]]:
    """Live entries that read as the same subject and were never reconciled.

    The safety net for a capture that should have replaced an earlier entry and did
    not: nothing at write time can tell a contradiction from another instance of the
    same lesson -- and blocking the second one would starve `skill-draft`, which
    exists precisely to notice a subject recurring. So this reports rather than gates.
    """
    entries = _live(base)
    parent = {entry["sha"]: entry["sha"] for entry in entries}

    def root(sha: str) -> str:
        while parent[sha] != sha:
            parent[sha] = parent[parent[sha]]
            sha = parent[sha]
        return sha

    shared: dict[str, set[str]] = {}
    for index, left in enumerate(entries):
        for right in entries[index + 1:]:
            if right["sha"] in left["coexists"] or left["sha"] in right["coexists"]:
                continue
            if not same_subject(left["tokens"], right["tokens"]):
                continue
            parent[root(left["sha"])] = root(right["sha"])
            shared.setdefault(right["sha"], set()).update(left["tokens"] & right["tokens"])
    grouped: dict[str, list[dict[str, Any]]] = {}
    for entry in entries:
        grouped.setdefault(root(entry["sha"]), []).append(entry)
    results = []
    for members in grouped.values():
        if len(members) < 2:
            continue
        subject = set().union(*(shared.get(member["sha"], set()) for member in members))
        results.append({"subject": sorted(subject), "occurrences": len(members),
                        "entries": [_report(member) for member in members]})
    results.sort(key=lambda item: (-item["occurrences"], item["subject"]))
    return results


def conflict_count(state_root: str | os.PathLike[str], project_id: str) -> int:
    """Nudge count for the SessionStart hook; never raises."""
    try:
        state = Path(state_root).expanduser().resolve()
        return len(conflicts(_base(state, "project", project_id))) if project_id else 0
    except Exception:
        return 0


def _forget(state: Path, path: Path) -> None:
    path.unlink()
    # `skill-draft` caches its pending count against the newest entry mtime, and deleting
    # a file only ever lowers that -- without this the stale count would survive.
    try:
        from .skill_draft import invalidate_scan_cache

        invalidate_scan_cache(state)
    except Exception:
        pass


def _retire(path: Path, replacement: str) -> None:
    text = path.read_text(encoding="utf-8-sig")
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    for name, value in (("status", "superseded"), ("superseded_by", replacement), ("updated_at", stamp)):
        text = set_field(text, name, value)
    _write(path, text)


def _scope_of(args: argparse.Namespace) -> tuple[Path, Path]:
    state = Path(args.state_root).expanduser().resolve()
    scope = args.scope.casefold()
    project_id = "" if scope == "global" else (args.project_id or _project_id(args.cwd, str(state)))
    return state, _base(state, scope, project_id)


def capture(args: argparse.Namespace) -> dict[str, Any]:
    content = args.content.strip()
    if not args.kind:
        raise RuntimeError("Capture requires --kind")
    if not args.topic.strip() or not content:
        raise RuntimeError("Capture requires --topic and --content")
    if CREDENTIAL_ASSIGNMENT.search(content):
        raise RuntimeError("learning content looks like it contains a credential")
    state = Path(args.state_root).expanduser().resolve()
    project_id = args.project_id or _project_id(args.cwd, str(state))
    scope = args.scope.casefold()
    if scope == "global" and not args.approved_by_user:
        raise RuntimeError("Global learning requires --approved-by-user")
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    base = _base(state, scope, project_id)
    base.mkdir(parents=True, exist_ok=True)
    # Resolved before anything is written, so a typo fails the whole capture instead of
    # leaving a new entry beside the stale one it was meant to replace or remove.
    retiring = [_resolve(base, reference) for reference in args.supersedes]
    deleting = [_resolve(base, reference) for reference in args.forget]
    if any(sha == digest for _, sha in retiring + deleting):
        raise RuntimeError("an entry cannot replace itself")
    overlap = {sha for _, sha in retiring} & {sha for _, sha in deleting}
    if overlap:
        raise RuntimeError("an entry is either superseded or forgotten, not both: " + ", ".join(sorted(overlap)))
    accounted = {sha for _, sha in retiring + deleting}
    related = [_report(entry) for entry in _live(base)
               if entry["sha"] not in accounted and entry["sha"] != digest
               and shares_word(entry["tokens"], tokens(_slug(args.topic)))]
    for existing in base.glob("*.md"):
        try:
            if f"content_sha256: {digest}" in existing.read_text(encoding="utf-8-sig"):
                for target, _ in retiring:
                    _retire(target, digest)
                for target, _ in deleting:
                    _forget(state, target)
                return {"status": "existing", "path": str(existing), "id": existing.stem,
                        "superseded": [target.stem for target, _ in retiring],
                        "forgotten": [target.stem for target, _ in deleting], "related": related}
        except OSError:
            continue
    stamp = time.strftime("%Y%m%d-%H%M%S")
    entry_id = f"{stamp}-{args.kind}-{_slug(args.topic)}-{digest[:10]}"
    path = base / f"{entry_id}.md"
    metadata = {
        "id": digest,
        "topic": _slug(args.topic),
        "scope": scope,
        "origin": "native",
        "source_path": str(path),
        "kind": args.kind,
        "source_event": args.source_event,
        "scope": scope,
        "project_id": "" if scope == "global" else project_id,
        "status": args.status,
        "content_sha256": digest,
        "relationships": "[" + ", ".join(f"supersedes:{sha}" for _, sha in retiring) + "]",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    _write(path, _frontmatter(metadata) + content + "\n")
    # Replaced only once the new entry is on disk, so a crash mid-capture leaves the old
    # one live rather than retiring or deleting it against a record that never landed.
    for target, _ in retiring:
        _retire(target, digest)
    for target, _ in deleting:
        _forget(state, target)
    return {"status": "created", "path": str(path), "id": entry_id,
            "superseded": [target.stem for target, _ in retiring],
            "forgotten": [target.stem for target, _ in deleting], "related": related}


def forget(args: argparse.Namespace) -> dict[str, Any]:
    """Delete entries outright: a conclusion that was overturned is not history worth
    keeping, it is a wrong answer that any later session would read as current."""
    if not args.id:
        raise RuntimeError("Forget requires at least one --id")
    if not args.reason.strip():
        raise RuntimeError("Forget requires --reason saying what overturned the conclusion")
    state, base = _scope_of(args)
    targets = [_resolve(base, reference) for reference in args.id]
    removed = []
    for path, _ in targets:
        removed.append({"id": path.stem, "topic": str(frontmatter(path.read_text(encoding="utf-8-sig")).get("topic", ""))})
        _forget(state, path)
    return {"status": "forgotten", "removed": removed, "reason": args.reason.strip()}


def keep(args: argparse.Namespace) -> dict[str, Any]:
    """Record that entries reading as one subject are deliberately both current, so the
    sweep stops raising them and a settled judgement is not re-litigated every session."""
    if len(args.id) < 2:
        raise RuntimeError("Keep needs at least two --id: it records that they coexist on purpose")
    if not args.reason.strip():
        raise RuntimeError("Keep requires --reason saying why both still stand")
    _, base = _scope_of(args)
    targets = [_resolve(base, reference) for reference in args.id]
    shas = {sha for _, sha in targets}
    for path, sha in targets:
        text = path.read_text(encoding="utf-8-sig")
        existing = {str(value) for value in (frontmatter(text).get("coexists_with") or [])}
        merged = sorted((existing | shas) - {sha})
        text = set_field(text, "coexists_with", "[" + ", ".join(merged) + "]")
        _write(path, set_field(text, "updated_at", time.strftime("%Y-%m-%dT%H:%M:%S%z")))
    return {"status": "kept", "entries": [path.stem for path, _ in targets], "reason": args.reason.strip()}


def main(argv: list[str] | None = None) -> int:
    home = Path.home()
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", required=True, choices=("Capture", "Forget", "Keep", "Conflicts"))
    parser.add_argument("--state-root", default=str(home / ".agent-workflow"))
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--scope", choices=("Project", "Global"), default="Project")
    parser.add_argument("--project-id", default="")
    parser.add_argument("--kind", choices=KINDS, default="")
    parser.add_argument("--topic", default="")
    parser.add_argument("--content", default="")
    parser.add_argument("--source-event", default="agent-learning")
    parser.add_argument("--status", choices=("verified", "needs_verification"), default="verified")
    parser.add_argument("--supersedes", action="append", default=[],
                        help="entry this capture narrows or refines; it is retired but stays readable")
    parser.add_argument("--forget", action="append", default=[],
                        help="entry this capture overturns; it is deleted outright")
    parser.add_argument("--id", action="append", default=[], help="Forget and Keep target")
    parser.add_argument("--reason", default="")
    parser.add_argument("--approved-by-user", action="store_true")
    args = parser.parse_args(argv)
    if args.action == "Conflicts":
        write_json(conflicts(_scope_of(args)[1]))
        return 0
    if args.action == "Forget":
        write_json(forget(args))
        return 0
    if args.action == "Keep":
        write_json(keep(args))
        return 0
    # The entry id embeds the topic slug, which keeps CJK, so the result must not go
    # through a console codepage.
    write_json(capture(args))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
