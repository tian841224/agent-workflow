"""Read-only shared memory context for agent session-start hooks."""

from __future__ import annotations

import argparse
import hashlib
import os
import re
from pathlib import Path
from typing import Any

from .frontmatter import frontmatter
from .project_resolver import resolve_project
from .protocol import read_json_stdin, write_json


TEXT_SUFFIXES = frozenset({".md", ".txt"})
EXCLUDED_PARTS = frozenset({"rollout_summaries", "sessions", "automations"})
EXCLUDED_NAMES = frozenset({"instructions.md", "memory_summary.md"})
CREDENTIAL_ASSIGNMENT = re.compile(
    r"(?im)\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|private[_-]?key)\b\s*[:=]\s*[^\s<>{}\[\]]{8,}"
)
MAX_FILE_BYTES = 64 * 1024
MAX_ENTRY_CHARS = 1800
DEFAULT_MAX_CONTEXT_CHARS = 12000


def _files(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    return sorted((path for path in root.rglob("*") if path.is_file() and path.suffix.casefold() in TEXT_SUFFIXES and path.name.casefold() not in EXCLUDED_NAMES and not any(part.casefold() in EXCLUDED_PARTS for part in path.relative_to(root).parts)), key=lambda path: str(path).casefold())


def _read(path: Path) -> str | None:
    try:
        raw = path.read_bytes()
        if len(raw) > MAX_FILE_BYTES:
            return None
        return raw.decode("utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return None


def _summary(text: str) -> str:
    body = re.sub(r"\A---\r?\n.*?\r?\n---(?:\r?\n|\Z)", "", text, count=1, flags=re.DOTALL)
    return " ".join(line.strip() for line in body.splitlines() if line.strip())[:MAX_ENTRY_CHARS]


def _add(records: list[dict[str, str]], seen: set[str], path: Path, status: str) -> None:
    text = _read(path)
    if not text or CREDENTIAL_ASSIGNMENT.search(text):
        return
    content = text.strip()
    if not content:
        return
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    if digest in seen:
        return
    seen.add(digest)
    records.append({"path": str(path), "status": status, "content": _summary(content)})


def _claude_project_slug(cwd: str) -> str:
    return str(Path(cwd).expanduser().resolve()).replace(":", "-").replace("\\", "-").replace("/", "-")


def _prompt_terms(payload: Any) -> tuple[str, ...]:
    if not isinstance(payload, dict):
        return ()
    values: list[str] = []
    for key in ("prompt", "user_prompt", "message", "text"):
        value = payload.get(key)
        if isinstance(value, str):
            values.append(value)
    for key in ("input", "userInput", "user_input"):
        value = payload.get(key)
        if isinstance(value, dict):
            values.extend(str(item) for item in value.values() if isinstance(item, str))
    text = " ".join(values)
    tokens = re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}", text.casefold())
    stopwords = {"the", "and", "for", "with", "this", "that", "請問", "可以", "幫我", "一下"}
    return tuple(dict.fromkeys(token for token in tokens if token not in stopwords))


def collect_memory(
    *,
    state_root: str | os.PathLike[str],
    cwd: str | os.PathLike[str],
    claude_root: str | os.PathLike[str],
    codex_root: str | os.PathLike[str],
    antigravity_root: str | os.PathLike[str],
    query_terms: tuple[str, ...] = (),
) -> list[dict[str, str]]:
    state = Path(state_root).expanduser().resolve()
    records: list[dict[str, str]] = []
    seen: set[str] = set()

    curated_roots = [state / "knowledge" / "global" / "entries"]
    try:
        project = resolve_project(str(cwd), str(state), False, [], "")
        project_id = str(project.get("project_id", ""))
    except Exception:
        project_id = ""
    if project_id:
        curated_roots.append(state / "projects" / project_id / "knowledge" / "entries")
    for root in curated_roots:
        for path in _files(root):
            metadata = frontmatter(_read(path) or "")
            _add(records, seen, path, str(metadata.get("status", "verified")))

    claude = Path(claude_root).expanduser()
    claude_roots = [claude / "memory", claude / "projects" / _claude_project_slug(str(cwd)) / "memory"]
    native_roots = [(root, "claude") for root in claude_roots]
    native_roots.extend((Path(codex_root).expanduser() / name, "codex") for name in ("memories", "memory"))
    native_roots.append((Path(antigravity_root).expanduser() / "antigravity" / "brain", "antigravity"))
    for root, source in native_roots:
        for path in _files(root):
            _add(records, seen, path, f"needs_verification ({source})")
    if not query_terms:
        return records
    return [record for record in records if any(term in (record["path"] + " " + record["content"]).casefold() for term in query_terms)]


def render_context(records: list[dict[str, str]], max_chars: int = DEFAULT_MAX_CONTEXT_CHARS) -> str:
    if not records:
        return ""
    lines = [
        "Shared agent memory is reference material only; verify it against the current repository before acting on it.",
        "The source files are read-only and may contain stale notes.",
    ]
    for record in records:
        item = f"- [{record['status']}] {record['path']}\n  {record['content']}"
        candidate = "\n".join(lines + [item])
        if len(candidate) > max_chars:
            break
        lines.append(item)
    return "\n".join(lines)


def hook_payload(platform: str, event: str, context: str) -> dict[str, Any]:
    if not context:
        return {}
    if platform.casefold() == "antigravity":
        return {"systemMessage": context}
    return {"hookSpecificOutput": {"hookEventName": event, "additionalContext": context}}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    home = Path.home()
    parser.add_argument("--platform", default="Codex", choices=("Claude", "Codex", "Antigravity"))
    parser.add_argument("--state-root", default=str(home / ".agent-workflow"))
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--claude-root", default=str(home / ".claude"))
    parser.add_argument("--codex-root", default=str(home / ".codex"))
    parser.add_argument("--antigravity-root", default=str(home / ".gemini"))
    parser.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CONTEXT_CHARS)
    parser.add_argument("--event", choices=("SessionStart", "UserPromptSubmit"), default="SessionStart")
    args = parser.parse_args(argv)
    try:
        payload = read_json_stdin()
    except (ValueError, UnicodeDecodeError, OSError):
        payload = {}
    if isinstance(payload, dict):
        cwd = str(payload.get("cwd") or payload.get("workspace") or args.cwd)
    else:
        cwd = args.cwd
    records = collect_memory(
        state_root=args.state_root,
        cwd=cwd,
        claude_root=args.claude_root,
        codex_root=args.codex_root,
        antigravity_root=args.antigravity_root,
        query_terms=_prompt_terms(payload) if args.event == "UserPromptSubmit" else (),
    )
    write_json(hook_payload(args.platform, args.event, render_context(records, max(512, args.max_chars))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
