"""Read-only shared memory context for agent SessionStart hooks.

Injected once per session, not once per turn: the main conversation pulls
further context on demand via ``knowledge --action Search`` (see
workflow/SKILL.md section 2), so this only has to carry a small, well-mixed
sample across the three tiers rather than try to be exhaustive.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
from pathlib import Path
from typing import Any

from .frontmatter import frontmatter, summary_line
from .protocol import read_json_stdin, write_json


TEXT_SUFFIXES = frozenset({".md", ".txt"})
EXCLUDED_PARTS = frozenset({"rollout_summaries", "sessions", "automations"})
EXCLUDED_NAMES = frozenset({"instructions.md", "memory_summary.md"})
CREDENTIAL_ASSIGNMENT = re.compile(
    r"(?im)\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|private[_-]?key)\b\s*[:=]\s*[^\s<>{}\[\]]{8,}"
)
MAX_READ_CHARS = 4096
MAX_ENTRY_CHARS = 240
DEFAULT_MAX_CONTEXT_CHARS = 3000
MAX_FILES_PER_ROOT = 200
MAX_DEPTH = 3
PROJECT_QUOTA = 10
GLOBAL_QUOTA = 6
NATIVE_QUOTA = 6


def _excluded(name: str) -> bool:
    return name.casefold() in EXCLUDED_PARTS


def _walk(root: Path, dir_path: Path, depth: int, found: list[tuple[float, Path]]) -> None:
    if len(found) >= MAX_FILES_PER_ROOT or depth > MAX_DEPTH:
        return
    try:
        entries = list(os.scandir(dir_path))
    except OSError:
        return
    for entry in entries:
        if len(found) >= MAX_FILES_PER_ROOT:
            return
        # Prune excluded directories before descending -- rollout_summaries can hold
        # thousands of files, and none of them should ever be walked at all.
        if entry.is_dir(follow_symlinks=False):
            if not _excluded(entry.name):
                _walk(root, Path(entry.path), depth + 1, found)
            continue
        if not entry.is_file(follow_symlinks=False):
            continue
        name = entry.name
        if Path(name).suffix.casefold() not in TEXT_SUFFIXES or name.casefold() in EXCLUDED_NAMES:
            continue
        try:
            mtime = entry.stat(follow_symlinks=False).st_mtime
        except OSError:
            continue
        found.append((mtime, Path(entry.path)))


def _files(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    found: list[tuple[float, Path]] = []
    _walk(root, root, 0, found)
    found.sort(key=lambda item: item[0], reverse=True)
    return [path for _, path in found]


def _read(path: Path) -> str | None:
    try:
        with open(path, "r", encoding="utf-8-sig") as handle:
            return handle.read(MAX_READ_CHARS)
    except (OSError, UnicodeDecodeError):
        return None


def _summary(text: str) -> str:
    """The store's convention is that the first non-empty body line is a
    self-contained one-line summary; everything after it is detail the agent
    reads on demand via knowledge.py Search, not from this injection."""
    return summary_line(text, MAX_ENTRY_CHARS)


def _polluted_source(text: str) -> bool:
    """A curated entry imported from a source path that itself lives under an
    excluded directory (e.g. rollout_summaries) is exactly the content the
    native scan is supposed to filter out; import must not re-introduce it."""
    source_path = str(frontmatter(text).get("source_path", ""))
    parts = re.split(r"[\\/]+", source_path)
    return any(_excluded(part) for part in parts)


def _add(records: list[dict[str, str]], seen: set[str], path: Path, text: str, status: str, curated: bool) -> bool:
    """Returns True iff a record was actually added, so callers can fill a quota
    from filtered candidates instead of pre-slicing before filtering runs."""
    if not text or CREDENTIAL_ASSIGNMENT.search(text):
        return False
    if curated and _polluted_source(text):
        return False
    content = text.strip()
    if not content:
        return False
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    if digest in seen:
        return False
    summary = _summary(content)
    if not summary:
        return False
    seen.add(digest)
    records.append({"path": str(path), "status": status, "content": summary})
    return True


def _collect_tier(root: Path, quota: int, seen: set[str], *, curated: bool,
                  status_of) -> list[dict[str, str]]:
    """Walk candidates in mtime-desc order until `quota` records are actually
    added -- filtering (pollution, credentials, dedup) must never silently
    shrink a tier below its quota while more valid candidates remain."""
    records: list[dict[str, str]] = []
    for path in _files(root):
        if len(records) >= quota:
            break
        text = _read(path)
        status = status_of(path, text)
        # A superseded entry has a live replacement in the same store; injecting it
        # would spend the tier's quota on advice the user has already corrected.
        if curated and status.casefold() == "superseded":
            continue
        _add(records, seen, path, text or "", status, curated=curated)
    return records


def _claude_project_slug(cwd: str) -> str:
    return str(Path(cwd).expanduser().resolve()).replace(":", "-").replace("\\", "-").replace("/", "-")


def project_id_for(state: Path, cwd: str | os.PathLike[str]) -> str:
    from .project_resolver import resolve_project

    try:
        return str(resolve_project(str(cwd), str(state), False, [], "").get("project_id", ""))
    except Exception:
        return ""


def collect_memory(
    *,
    state_root: str | os.PathLike[str],
    cwd: str | os.PathLike[str],
    claude_root: str | os.PathLike[str],
    codex_root: str | os.PathLike[str],
    antigravity_root: str | os.PathLike[str],
    project_id: str | None = None,
) -> list[dict[str, str]]:
    state = Path(state_root).expanduser().resolve()
    seen: set[str] = set()

    # Three tiers, each with its own quota, rendered in this order: a small
    # global store must never starve project or native the way one shared
    # char budget did (project/global/native used to render in that order
    # against a single 12k-char cap, and global alone could fill it).
    if project_id is None:
        project_id = project_id_for(state, cwd)

    def curated_status(path: Path, text: str | None) -> str:
        return str(frontmatter(text or "").get("status", "verified"))

    project_records: list[dict[str, str]] = []
    if project_id:
        root = state / "projects" / project_id / "knowledge" / "entries"
        project_records = _collect_tier(root, PROJECT_QUOTA, seen, curated=True, status_of=curated_status)

    global_root = state / "knowledge" / "global" / "entries"
    global_records = _collect_tier(global_root, GLOBAL_QUOTA, seen, curated=True, status_of=curated_status)

    claude = Path(claude_root).expanduser()
    claude_roots = [claude / "memory", claude / "projects" / _claude_project_slug(str(cwd)) / "memory"]
    native_roots = [(root, "claude") for root in claude_roots]
    native_roots.extend((Path(codex_root).expanduser() / name, "codex") for name in ("memories", "memory"))
    native_roots.append((Path(antigravity_root).expanduser() / "antigravity" / "brain", "antigravity"))
    native_candidates: list[tuple[float, Path, str]] = []
    for root, source in native_roots:
        if not root.is_dir():
            continue
        found: list[tuple[float, Path]] = []
        _walk(root, root, 0, found)
        native_candidates.extend((mtime, path, source) for mtime, path in found)
    native_candidates.sort(key=lambda item: item[0], reverse=True)
    native_records: list[dict[str, str]] = []
    for _, path, source in native_candidates:
        if len(native_records) >= NATIVE_QUOTA:
            break
        _add(native_records, seen, path, _read(path) or "", f"needs_verification ({source})", curated=False)

    return project_records + global_records + native_records


def render_context(records: list[dict[str, str]], max_chars: int = DEFAULT_MAX_CONTEXT_CHARS,
                   pending_drafts: int = 0, escalated_causes: int = 0, open_conflicts: int = 0) -> str:
    if not records and not pending_drafts and not escalated_causes and not open_conflicts:
        return ""
    lines = [
        "Shared agent memory is reference material only; verify it against the current repository before acting on it.",
        "The source files are read-only and may contain stale notes.",
    ]
    # Ahead of the entries so the char budget can never truncate the nudges away.
    if pending_drafts:
        lines.append(f"{pending_drafts} recurring memory pattern(s) are ready to distil into a skill draft; "
                     "load the distill skill to review them.")
    if escalated_causes:
        lines.append(f"{escalated_causes} review cause(s) have reached the remedy threshold; "
                     "load the distill skill to route them.")
    if open_conflicts:
        lines.append(f"{open_conflicts} group(s) of memory entries read as the same subject and were never "
                     "reconciled; run `learn --action Conflicts` and decide per group whether one "
                     "supersedes another, one is overturned, or both stand.")
    for record in records:
        item = f"- [{record['status']}] {record['path']}\n  {record['content']}"
        candidate = "\n".join(lines + [item])
        if len(candidate) > max_chars:
            break
        lines.append(item)
    return "\n".join(lines)


def hook_payload(platform: str, context: str) -> dict[str, Any]:
    if not context:
        return {}
    if platform.casefold() == "antigravity":
        return {"systemMessage": context}
    return {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": context}}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    home = Path.home()
    parser.add_argument("--platform", default="Codex", choices=("Claude", "Codex", "Antigravity"))
    parser.add_argument("--state-root", default=str(home / ".agent-workflow"))
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--claude-root", default=str(home / ".claude"))
    parser.add_argument("--codex-root", default=str(home / ".codex"))
    parser.add_argument("--antigravity-root", default=str(home / ".gemini"))
    parser.add_argument("--canonical-root", default=str(home / ".agents"))
    parser.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CONTEXT_CHARS)
    args = parser.parse_args(argv)
    try:
        payload = read_json_stdin()
    except (ValueError, UnicodeDecodeError, OSError):
        payload = {}
    if isinstance(payload, dict):
        cwd = str(payload.get("cwd") or payload.get("workspace") or args.cwd)
    else:
        cwd = args.cwd
    state = Path(args.state_root).expanduser().resolve()
    project_id = project_id_for(state, cwd)
    records = collect_memory(
        state_root=args.state_root,
        cwd=cwd,
        claude_root=args.claude_root,
        codex_root=args.codex_root,
        antigravity_root=args.antigravity_root,
        project_id=project_id,
    )
    from .learn import conflict_count
    from .review_cause import escalated_count
    from .skill_draft import scan_summary

    pending = scan_summary(state, project_id, args.canonical_root)
    write_json(hook_payload(args.platform, render_context(records, max(512, args.max_chars),
                                                          pending, escalated_count(str(state)),
                                                          conflict_count(state, project_id))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
