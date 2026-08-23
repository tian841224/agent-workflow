"""Capture durable, user-visible learning into the shared knowledge store."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import time
from pathlib import Path

from .project_resolver import resolve_project


CREDENTIAL_ASSIGNMENT = re.compile(
    r"(?im)\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|private[_-]?key)\b\s*[:=]\s*[^\s<>{}\[\]]{8,}"
)
KINDS = ("explicit", "correction", "decision", "error", "preference", "pitfall")


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


def capture(args: argparse.Namespace) -> dict[str, str]:
    content = args.content.strip()
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
    base = state / "knowledge" / "global" / "entries" if scope == "global" else state / "projects" / project_id / "knowledge" / "entries"
    base.mkdir(parents=True, exist_ok=True)
    for existing in base.glob("*.md"):
        try:
            if f"content_sha256: {digest}" in existing.read_text(encoding="utf-8-sig"):
                return {"status": "existing", "path": str(existing), "id": existing.stem}
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
        "relationships": [],
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    temporary = path.with_suffix(".tmp")
    temporary.write_text(_frontmatter(metadata) + content + "\n", encoding="utf-8", newline="\n")
    os.replace(temporary, path)
    return {"status": "created", "path": str(path), "id": entry_id}


def main(argv: list[str] | None = None) -> int:
    home = Path.home()
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", required=True, choices=("Capture",))
    parser.add_argument("--state-root", default=str(home / ".agent-workflow"))
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--scope", choices=("Project", "Global"), default="Project")
    parser.add_argument("--project-id", default="")
    parser.add_argument("--kind", choices=KINDS, required=True)
    parser.add_argument("--topic", required=True)
    parser.add_argument("--content", required=True)
    parser.add_argument("--source-event", default="agent-learning")
    parser.add_argument("--status", choices=("verified", "needs_verification"), default="verified")
    parser.add_argument("--approved-by-user", action="store_true")
    args = parser.parse_args(argv)
    print(json.dumps(capture(args), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
