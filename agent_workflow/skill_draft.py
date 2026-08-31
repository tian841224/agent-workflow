"""Distil recurring knowledge entries into reviewable skill drafts.

Drafts are staged outside every platform skill directory on purpose: a draft is
machine-written instruction text, and only an explicit Promote moves it to the
one place agents actually load skills from.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any

from .frontmatter import body as strip_frontmatter, frontmatter, summary_line
from .learn import CREDENTIAL_ASSIGNMENT
from .protocol import write_json
from .topics import tokens as _tokens

DRAFT_ROOT = "skill-drafts"
SKILL_ROOT = "skills"
NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
MIN_OCCURRENCES = 3
MAX_CANDIDATES = 10
MAX_SUMMARY_CHARS = 200
MAX_DRAFT_CHARS = 20000
STATUSES = ("draft", "promoted", "rejected")


def _entry_roots(state: Path, project_id: str) -> list[Path]:
    roots = [state / "knowledge" / "global" / "entries"]
    if project_id:
        roots.insert(0, state / "projects" / project_id / "knowledge" / "entries")
    return roots


def _read_entries(state: Path, project_id: str) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for root in _entry_roots(state, project_id):
        if not root.is_dir():
            continue
        for path in sorted(root.glob("*.md")):
            try:
                text = path.read_text(encoding="utf-8-sig", errors="replace")
            except OSError:
                continue
            data = frontmatter(text)
            sha = str(data.get("content_sha256") or "")
            if not sha or sha in seen:
                continue
            # Only what `learn` deliberately captured and confirmed is distilled: an
            # imported store arrives unverified and in bulk, and swamped the real
            # captures 237 entries to 7 the first time this ran against a live store.
            if str(data.get("origin") or "").casefold() != "native":
                continue
            if str(data.get("status") or "verified").casefold() != "verified":
                continue
            summary = summary_line(text, MAX_SUMMARY_CHARS)
            if not summary:
                continue
            seen.add(sha)
            topic = str(data.get("topic") or path.stem)
            entries.append({
                "sha": sha,
                "path": str(path),
                "topic": topic,
                "kind": str(data.get("kind") or ""),
                "summary": summary,
                "topic_tokens": _tokens(topic),
            })
    return entries


def _label(tokens: set[str], members: list[dict[str, Any]]) -> str:
    """Name a cluster after the token its entries actually chose as a topic, so an
    incidental word shared by the summaries does not become the cluster's identity."""
    def score(token: str) -> tuple[int, int, str]:
        return (sum(1 for member in members if token in member["topic_tokens"]), len(token), token)

    return max(tokens, key=score)


def _clusters(entries: list[dict[str, Any]], min_occurrences: int) -> list[dict[str, Any]]:
    """Group entries by the words they were filed under.

    Clustering runs on topic tokens rather than the whole entry: a summary's incidental
    vocabulary is shared by unrelated entries and forms a cluster that swallows the real
    ones, while the topic is the subject the capture deliberately named.
    """
    by_token: dict[str, list[dict[str, Any]]] = {}
    for entry in entries:
        for token in entry["topic_tokens"]:
            by_token.setdefault(token, []).append(entry)
    found: dict[tuple[str, ...], dict[str, Any]] = {}
    for token in sorted(by_token):
        members = by_token[token]
        if len(members) < min_occurrences:
            continue
        key = tuple(sorted(member["sha"] for member in members))
        found.setdefault(key, {"tokens": set(), "members": members})["tokens"].add(token)
    return [{"cluster_id": _label(value["tokens"], value["members"]), "tokens": value["tokens"],
             "members": value["members"]} for value in found.values()]


def _fingerprint(shas: list[str]) -> str:
    return hashlib.sha256("|".join(sorted(shas)).encode("utf-8")).hexdigest()


def _skill_roots(state: Path, canonical_root: str) -> list[Path]:
    return [state / SKILL_ROOT, Path(canonical_root).expanduser() / "skills"]


def _existing_skill_tokens(state: Path, canonical_root: str) -> dict[str, tuple[set[str], set[str]]]:
    """Every installed skill's name tokens and its full name-plus-description tokens."""
    known: dict[str, tuple[set[str], set[str]]] = {}
    for root in _skill_roots(state, canonical_root):
        if not root.is_dir():
            continue
        for skill in sorted(root.iterdir()):
            document = skill / "SKILL.md"
            if not document.is_file():
                continue
            try:
                data = frontmatter(document.read_text(encoding="utf-8-sig", errors="replace"))
            except OSError:
                continue
            name = str(data.get("name") or skill.name)
            in_name, everything = known.setdefault(name, (set(), set()))
            in_name.update(_tokens(name))
            everything.update(_tokens(name + " " + str(data.get("description") or "")))
    return known


def _skill_match(cluster_id: str, cluster_tokens: set[str],
                 known: dict[str, tuple[set[str], set[str]]]) -> str:
    """The installed skill that plausibly already covers this cluster, if any.

    One shared word is not coverage: matching a lone token against the description
    made `code` claim `eli5` and `and` claim `codebase-design`, so the distiller was
    told every cluster was already taken.
    """
    for name, (in_name, everything) in sorted(known.items()):
        if cluster_id in in_name or len(cluster_tokens & everything) >= 2:
            return name
    return ""


def index_path(state: Path) -> Path:
    return state / DRAFT_ROOT / "index.json"


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="\n", dir=path.parent,
                                     prefix="." + path.name + ".", suffix=".tmp", delete=False) as handle:
        handle.write(text)
        temporary = Path(handle.name)
    os.replace(temporary, path)


def load_index(state: Path) -> dict[str, Any]:
    path = index_path(state)
    if not path.is_file():
        return {"schema_version": 1, "entries": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        raise RuntimeError("skill-draft index is unreadable: " + str(path))
    if not isinstance(data.get("entries"), list):
        raise RuntimeError("skill-draft index has no entries array: " + str(path))
    return data


def save_index(state: Path, data: dict[str, Any]) -> None:
    data["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    _atomic_write(index_path(state), json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def scan(state: Path, project_id: str, min_occurrences: int, canonical_root: str) -> list[dict[str, Any]]:
    entries = _read_entries(state, project_id)
    index = load_index(state)
    consumed: set[str] = set()
    suppressed: set[str] = set()
    for record in index["entries"]:
        shas = [str(value) for value in record.get("source_entries", [])]
        if record.get("status") == "promoted":
            consumed.update(shas)
        elif record.get("status") == "rejected":
            suppressed.update(str(value) for value in record.get("suppressed_sha", shas))
    entries = [entry for entry in entries if entry["sha"] not in consumed]
    known = _existing_skill_tokens(state, canonical_root)
    results: list[dict[str, Any]] = []
    for cluster in _clusters(entries, min_occurrences):
        members = cluster["members"]
        shas = [member["sha"] for member in members]
        # A rejected pattern only returns once enough genuinely new entries land, so a
        # decline is not re-litigated at every session start.
        if len(set(shas) - suppressed) < min_occurrences:
            continue
        match = _skill_match(cluster["cluster_id"], cluster["tokens"], known)
        results.append({
            "cluster_id": cluster["cluster_id"],
            "cluster_fingerprint": _fingerprint(shas),
            "occurrences": len(members),
            "kinds": sorted({member["kind"] for member in members if member["kind"]}),
            "topics": sorted({member["topic"] for member in members}),
            "entry_paths": [member["path"] for member in members],
            "entry_sha": shas,
            "summaries": [member["summary"] for member in members],
            "existing_skill_match": match,
        })
    results.sort(key=lambda item: (-item["occurrences"], item["cluster_id"]))
    return results[:MAX_CANDIDATES]


def _newest_mtime(state: Path, project_id: str) -> float:
    newest = 0.0
    for root in _entry_roots(state, project_id) + [index_path(state).parent]:
        try:
            for entry in os.scandir(root):
                if entry.is_file(follow_symlinks=False):
                    newest = max(newest, entry.stat(follow_symlinks=False).st_mtime)
        except OSError:
            continue
    return newest


def scan_summary(state_root: str | os.PathLike[str], project_id: str,
                 canonical_root: str | os.PathLike[str]) -> int:
    """Pending candidate count for the SessionStart nudge; never raises.

    Cached against the newest entry mtime so an unchanged store costs one scandir
    per root instead of a full re-cluster on every session.
    """
    try:
        state = Path(state_root).expanduser().resolve()
        cache = state / DRAFT_ROOT / "pending.json"
        newest = _newest_mtime(state, project_id)
        try:
            stored = json.loads(cache.read_text(encoding="utf-8-sig"))
            if float(stored.get("scanned_at", -1)) >= newest and stored.get("project_id") == project_id:
                return int(stored.get("pending", 0))
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            pass
        pending = len(scan(state, project_id, MIN_OCCURRENCES, str(canonical_root)))
        try:
            _atomic_write(cache, json.dumps({"scanned_at": newest, "project_id": project_id,
                                             "pending": pending}, ensure_ascii=False) + "\n")
        except OSError:
            pass
        return pending
    except Exception:
        return 0


def invalidate_scan_cache(state: Path) -> None:
    try:
        (state / DRAFT_ROOT / "pending.json").unlink()
    except OSError:
        pass


def _record(index: dict[str, Any], name: str) -> dict[str, Any] | None:
    return next((item for item in index["entries"] if item.get("name") == name), None)


def draft(state: Path, name: str, description: str, content: str,
          source_entries: list[str], cluster_id: str) -> dict[str, Any]:
    if not NAME_PATTERN.match(name):
        raise RuntimeError("--name must be a lowercase slug, for example regression-triage")
    description = description.strip()
    content = content.strip()
    if not description or not content:
        raise RuntimeError("Draft requires --description and --content")
    if len(content) > MAX_DRAFT_CHARS:
        raise RuntimeError("draft body exceeds " + str(MAX_DRAFT_CHARS) + " characters")
    if CREDENTIAL_ASSIGNMENT.search(content) or CREDENTIAL_ASSIGNMENT.search(description):
        raise RuntimeError("draft content looks like it contains a credential")
    if not source_entries:
        raise RuntimeError("Draft requires at least one --source-entry")
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    path = state / DRAFT_ROOT / name / "SKILL.md"
    fingerprint = _fingerprint(source_entries)
    _atomic_write(path, (
        "---\n"
        "name: " + name + "\n"
        "description: " + description + "\n"
        "status: draft\n"
        "origin: distilled\n"
        "cluster_id: " + cluster_id + "\n"
        "cluster_fingerprint: " + fingerprint + "\n"
        "source_entries: [" + ", ".join(sorted(source_entries)) + "]\n"
        "created_at: " + stamp + "\n"
        "---\n\n" + content + "\n"
    ))
    index = load_index(state)
    record = _record(index, name)
    if record is None:
        record = {"name": name, "created_at": stamp}
        index["entries"].append(record)
    record.update({
        "status": "draft",
        "cluster_id": cluster_id,
        "cluster_fingerprint": fingerprint,
        "source_entries": sorted(source_entries),
        "draft_path": str(path),
        "updated_at": stamp,
    })
    save_index(state, index)
    invalidate_scan_cache(state)
    return {"status": "draft", "name": name, "path": str(path)}


def distribute_state_skills(state: Path, targets: dict[str, str] | None = None) -> list[str]:
    """Make promoted skills visible to whichever platforms this machine installed."""
    from .installer import ensure_platform_skill_visibility

    if targets is None:
        try:
            manifest = json.loads((state / "managed-runtime.json").read_text(encoding="utf-8-sig"))
            targets = manifest.get("targets") or {}
        except (OSError, json.JSONDecodeError):
            targets = {}
    if not targets:
        return []
    return ensure_platform_skill_visibility(state / SKILL_ROOT, targets)


def promote(state: Path, name: str, approved: bool, distribute: bool,
            targets: dict[str, str] | None = None) -> dict[str, Any]:
    if not approved:
        raise RuntimeError("Promote requires --approved-by-user; a draft takes effect only once the user approves it")
    source = state / DRAFT_ROOT / name / "SKILL.md"
    if not source.is_file():
        raise RuntimeError("no draft to promote: " + str(source))
    text = source.read_text(encoding="utf-8-sig")
    data = frontmatter(text)
    body = strip_frontmatter(text).strip()
    if not data.get("name") or not data.get("description"):
        raise RuntimeError("draft frontmatter needs both name and description")
    if not body:
        raise RuntimeError("draft has an empty body")
    if len(body) > MAX_DRAFT_CHARS:
        raise RuntimeError("draft body exceeds " + str(MAX_DRAFT_CHARS) + " characters")
    if CREDENTIAL_ASSIGNMENT.search(text):
        raise RuntimeError("draft content looks like it contains a credential")
    target = state / SKILL_ROOT / name / "SKILL.md"
    _atomic_write(target, "---\nname: " + str(data["name"]) + "\ndescription: " + str(data["description"]) + "\n---\n\n" + body + "\n")
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    index = load_index(state)
    record = _record(index, name)
    if record is None:
        record = {"name": name, "created_at": stamp}
        index["entries"].append(record)
    record.update({"status": "promoted", "skill_path": str(target), "updated_at": stamp})
    save_index(state, index)
    invalidate_scan_cache(state)
    return {"status": "promoted", "name": name, "path": str(target),
            "distributed": distribute_state_skills(state, targets) if distribute else []}


def reject(state: Path, name: str, note: str) -> dict[str, Any]:
    index = load_index(state)
    record = _record(index, name)
    if record is None:
        raise RuntimeError("no draft named " + name)
    record.update({
        "status": "rejected",
        "note": note,
        "suppressed_sha": sorted(record.get("source_entries", [])),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    })
    save_index(state, index)
    invalidate_scan_cache(state)
    return {"status": "rejected", "name": name}


def _project_id(cwd: str, state: Path, override: str) -> str:
    if override:
        return override
    from .project_resolver import resolve_project

    try:
        return str(resolve_project(cwd, str(state), False, [], "").get("project_id", ""))
    except Exception:
        return ""


def main(argv: list[str] | None = None) -> int:
    home = Path.home()
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", required=True, choices=("Scan", "Draft", "Promote", "Reject", "List"))
    parser.add_argument("--state-root", default=str(home / ".agent-workflow"))
    parser.add_argument("--canonical-root", default=str(home / ".agents"))
    parser.add_argument("--cwd", default=os.getcwd())
    parser.add_argument("--project-id", default="")
    parser.add_argument("--min-occurrences", type=int, default=MIN_OCCURRENCES)
    parser.add_argument("--name", default="")
    parser.add_argument("--description", default="")
    parser.add_argument("--content", default="")
    parser.add_argument("--cluster-id", default="")
    parser.add_argument("--source-entry", action="append", default=[])
    parser.add_argument("--note", default="")
    parser.add_argument("--status", choices=STATUSES)
    parser.add_argument("--approved-by-user", action="store_true")
    parser.add_argument("--no-distribute", action="store_true")
    args = parser.parse_args(argv)
    state = Path(args.state_root).expanduser().resolve()
    if args.action == "Scan":
        write_json(scan(state, _project_id(args.cwd, state, args.project_id),
                        max(2, args.min_occurrences), args.canonical_root))
        return 0
    if args.action == "List":
        entries = load_index(state)["entries"]
        write_json([item for item in entries if not args.status or item.get("status") == args.status])
        return 0
    if not args.name:
        raise RuntimeError(args.action + " requires --name")
    if args.action == "Draft":
        write_json(draft(state, args.name, args.description, args.content,
                         sorted(set(args.source_entry)), args.cluster_id))
        return 0
    if args.action == "Promote":
        write_json(promote(state, args.name, args.approved_by_user, not args.no_distribute))
        return 0
    write_json(reject(state, args.name, args.note))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
