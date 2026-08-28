"""Portable installer for agent-workflow using the user's Python installation.

This intentionally owns only agent-workflow-managed files.  It keeps user hook entries,
creates UTF-8/LF JSON, and never asks the Windows console to transcode hook payloads.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from .codex_hook_trust import untrusted

ROOT = Path(__file__).resolve().parent.parent


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Replace rather than truncate in place so an old platform hard link cannot
    # make a later adapter write overwrite another platform's generated file.
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="\n", dir=path.parent,
                                     prefix=f".{path.name}.", suffix=".tmp", delete=False) as handle:
        handle.write(text)
        temporary = Path(handle.name)
    os.replace(temporary, path)


def _json(path: Path, value: Any) -> None:
    _write(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def _hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _backup(path: Path, dry_run: bool) -> None:
    if not path.exists(): return
    target=path.with_name(path.name+".bak."+time.strftime("%Y%m%d-%H%M%S"))
    if not dry_run:
        shutil.copytree(path,target) if path.is_dir() else shutil.copy2(path,target)

def _copy(source: Path, destination: Path, files: list[dict[str, str]], dry_run: bool, previous: dict[str,str] | None = None, force: bool = False) -> None:
    if not source.is_file():
        raise RuntimeError(f"managed source is missing: {source}")
    source_hash=_hash(source)
    destination_hash=_hash(destination) if destination.is_file() else ""
    if destination.is_file() and destination_hash != source_hash and not force and previous and previous.get(str(destination)) and previous.get(str(destination)) != destination_hash:
        files.append({"path": str(destination), "sha256": destination_hash, "kind": "preserved-local-change"}); return
    if destination.exists() and destination_hash != source_hash: _backup(destination,dry_run)
    if not dry_run:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
    files.append({"path": str(destination), "sha256": source_hash, "kind": "runtime"})


def _managed_command(command: str, runtime_root: Path) -> bool:
    return str(runtime_root).casefold() in command.casefold() or "\\hooks\\ai-workflow\\" in command.casefold()


def _merge_hooks(fragment_path: Path, destination: Path, runtime_root: Path, python_executable: Path, top_level: bool, dry_run: bool) -> None:
    fragment_text = fragment_path.read_text(encoding="utf-8-sig")
    fragment_text = fragment_text.replace("{{RUNTIME_DIR}}", str(runtime_root).replace("\\", "\\\\"))
    fragment_text = fragment_text.replace("{{PYTHON_EXE}}", str(python_executable).replace("\\", "\\\\"))
    fragment = json.loads(fragment_text)
    try: current = json.loads(destination.read_text(encoding="utf-8-sig"))
    except FileNotFoundError: current = {}
    if top_level:
        current = {key: value for key, value in current.items() if not key.startswith("agent-workflow-")}
        current.update(fragment)
    else:
        hooks = current.setdefault("hooks", {})
        # Sweep old managed commands from every pre-existing event first, preserving user hooks.
        for event, wrappers in list(hooks.items()):
            cleaned = []
            for wrapper in wrappers or []:
                if not isinstance(wrapper, dict): continue
                if "command" in wrapper:
                    if _managed_command(str(wrapper.get("command", "")), runtime_root): continue
                    cleaned.append(wrapper); continue
                values = [item for item in wrapper.get("hooks", []) if isinstance(item, dict) and not _managed_command(str(item.get("command", "")), runtime_root)]
                if values:
                    next_wrapper = dict(wrapper); next_wrapper["hooks"] = values; cleaned.append(next_wrapper)
            hooks[event] = cleaned
        for event, wrappers in fragment.get("hooks", {}).items(): hooks[event] = hooks.get(event, []) + wrappers
    if destination.exists(): _backup(destination, dry_run)
    if not dry_run: _json(destination, current)


def _managed_entrypoint(source: Path, canonical: Path, destinations: list[Path], dry_run: bool) -> None:
    begin, end = "<!-- agent-workflow v5 managed:start -->", "<!-- agent-workflow v5 managed:end -->"
    old_begin, old_end = "<!-- agent-workflow v4 managed:start -->", "<!-- agent-workflow v4 managed:end -->"
    prefixes = []
    for path in [canonical, *destinations]:
        if not path.is_file(): continue
        text = path.read_text(encoding="utf-8-sig")
        for start, finish in ((begin, end), (old_begin, old_end)):
            text = re.sub(rf"(?s)\r?\n?{re.escape(start)}.*?{re.escape(finish)}\r?\n?", "", text).strip()
        if text and text not in prefixes: prefixes.append(text)
    if len(prefixes) > 1: raise RuntimeError("conflicting unmanaged entrypoint content found; installation would overwrite user instructions")
    prefix = (prefixes[0] + "\n\n") if prefixes else ""
    content = prefix + begin + "\n" + source.read_text(encoding="utf-8-sig").strip() + "\n" + end + "\n"
    if dry_run: return
    if canonical.exists(): _backup(canonical, dry_run)
    _write(canonical, content)
    for destination in destinations: _write(destination, content)

def _claude_readonly_hooks(raw, name, runtime_root, python_executable):
    if name == "worker":
        return raw
    command = f'"{python_executable}" -X utf8 -u "{runtime_root / "agent_workflow.py"}" role-guard --platform Claude --role {name}'
    hook = "hooks:\n  PreToolUse:\n    - matcher: \"*\"\n      hooks:\n        - type: command\n          command: " + json.dumps(command) + "\n          timeout: 15"
    marker = re.search(r"(?ms)^---\s*\n(.*?)\n---\s*\n", raw)
    if not marker:
        raise RuntimeError(f"canonical agent is missing frontmatter: {name}")
    frontmatter = marker.group(1).rstrip() + "\n" + hook
    return "---\n" + frontmatter + "\n---\n" + raw[marker.end():]


def _write_agents(canonical, selected, claude, codex, antigravity, runtime_root, python_executable, dry_run):
    managed=[]
    for name in ("reviewer","adversarial","verifier","retrospective","worker"):
        source=canonical/"agents"/(name+".md")
        if not source.is_file(): raise RuntimeError(f"canonical agent is missing: {source}")
        raw=source.read_text(encoding="utf-8-sig"); body=re.sub(r"(?s)^---.*?---\s*", "", raw).strip(); match=re.search(r"(?m)^description:\s*(.+)$",raw); desc=(match.group(1).strip() if match else f"{name} agent").replace('"','\\"')
        targets=[]
        if "Claude" in selected:
            claude_raw = re.sub(r"(?m)^name:\s*.+$", f"name: agent-workflow-{name}", raw)
            targets.append((claude/"agents"/f"agent-workflow-{name}.md", _claude_readonly_hooks(claude_raw, name, runtime_root, python_executable)))
        if "Antigravity" in selected: targets.append((antigravity/"config"/"agents"/f"agent-workflow-{name}"/"agent.md",re.sub(r"(?m)^name:\s*.+$",f"name: agent-workflow-{name}",raw)))
        if "Codex" in selected:
            sandbox_mode = "workspace-write" if name == "worker" else "read-only"
            targets.append((codex/"agents"/f"agent-workflow-{name}.toml",f'# agent-workflow v5 managed agent\nname = "agent-workflow-{name}"\ndescription = "{desc}"\nsandbox_mode = "{sandbox_mode}"\ndeveloper_instructions = \'\'\'\n{body}\n\'\'\'\n'))
        for target,text in targets:
            if not dry_run: _write(target,text)
            managed.append({"path":str(target),"sha256":hashlib.sha256(text.encode("utf-8")).hexdigest(),"kind":"canonical-agent-adapter"})
    return managed

def _legacy_paths(args):
    legacy=Path(getattr(args,"legacy_root",args.canonical_root))
    return [Path(args.claude_target)/"agent-workflow",Path(args.codex_target)/"agent-workflow",legacy/"workflow",Path(args.claude_target)/"hooks"/"ai-workflow",Path(args.codex_target)/"hooks"/"ai-workflow"]

def _backup_legacy(args, dry_run):
    candidates=[p for p in _legacy_paths(args) if p.exists()]
    if not candidates:return
    root=Path(args.state_root)/"imports"/("v3-runtime-backup-"+time.strftime("%Y%m%d-%H%M%S"))
    for source in candidates:
        target=root/(str(source).replace(":","_").replace("\\","_").strip("_")+"-"+source.name)
        if not dry_run:
            target.parent.mkdir(parents=True,exist_ok=True); shutil.move(str(source),str(target))

def _link_skill_dir(source, target):
    if os.name == "nt":
        subprocess.run(["cmd", "/c", "mklink", "/J", str(target), str(source)], check=True, capture_output=True)
    else:
        target.symlink_to(source, target_is_directory=True)


PLATFORM_COPIED_SKILLS = (
    "workflow",
    "codebase-design",
    "diagnosing-bugs",
    "planning",
    "push-back",
    "learn",
    "tdd",
    "localization-tw",
    "eli5",
    "archify",
    "design-and-refine",
)


def _ensure_shared_skill_links(canonical, claude, selected, dry_run):
    # Skills outside the copied set are shared read-only from canonical/skills via a
    # junction/symlink; link every one so a newly added skill is picked up without a
    # manual per-skill step, and remove a link whose source skill no longer exists so
    # a removed skill does not linger forever in the platform's skills directory.
    if "Claude" not in selected: return
    skills_root = canonical / "skills"
    current = {p.name for p in skills_root.iterdir() if p.is_dir() and p.name not in PLATFORM_COPIED_SKILLS} if skills_root.is_dir() else set()
    claude_skills = claude / "skills"
    if not dry_run and claude_skills.is_dir():
        for target in sorted(claude_skills.iterdir()):
            is_reparse = getattr(os.path, "isjunction", lambda value: False)(target)
            if not (target.is_symlink() or is_reparse):
                continue  # a real directory might be user content; never touch it
            if target.name not in current:
                target.unlink()
    if dry_run or not skills_root.is_dir(): return
    for name in sorted(current):
        target = claude_skills / name
        is_reparse = getattr(os.path, "isjunction", lambda value: False)(target)
        if target.is_symlink() or is_reparse or target.exists(): continue
        target.parent.mkdir(parents=True, exist_ok=True)
        _link_skill_dir(skills_root / name, target)


def _skill_catalog(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    catalog = manifest.get("skills", {})
    if not isinstance(catalog, dict) or not catalog:
        raise RuntimeError("managed manifest must define a non-empty skills catalog")
    return catalog


def _prompt_skills(catalog: dict[str, dict[str, Any]]) -> set[str]:
    names = list(catalog)
    print("請選擇要安裝的 skills：")
    for index, name in enumerate(names, 1):
        description = str(catalog[name].get("description", "無說明"))
        required = "（必裝）" if catalog[name].get("required") is True else ""
        print(f"[{index}] {name}{required}：{description}")
    print("[0] 全部安裝")
    while True:
        answer = input("請輸入編號（可用逗號分隔）：").strip()
        if answer == "0":
            return set(names)
        try:
            indexes = {int(value.strip()) for value in answer.split(",") if value.strip()}
        except ValueError:
            indexes = set()
        if indexes and indexes.issubset(range(1, len(names) + 1)):
            return {names[index - 1] for index in indexes}
        print(f"輸入無效，請輸入 0 或 1～{len(names)} 的編號。")


def _resolve_skills(args: argparse.Namespace, manifest: dict[str, Any], previous_state: dict[str, Any]) -> set[str]:
    catalog = _skill_catalog(manifest)
    requested = args.skills
    if requested is None and args.action == "Repair":
        saved = previous_state.get("selected_skills")
        if isinstance(saved, list):
            requested = ",".join(str(item) for item in saved)
    if requested is None:
        interactive = args.action == "Install" and sys.stdin.isatty() and sys.stdout.isatty() and not args.non_interactive
        requested_names = _prompt_skills(catalog) if interactive else set(catalog)
    elif requested.strip().casefold() == "all":
        requested_names = set(catalog)
    else:
        requested_names = {item.strip() for item in requested.split(",") if item.strip()}
    unknown = sorted(requested_names - set(catalog))
    if unknown:
        raise RuntimeError(f"unknown skill(s): {', '.join(unknown)}")
    required = {name for name, metadata in catalog.items() if metadata.get("required") is True}
    return requested_names | required


def _install_platform_files(selected, selected_skills, canonical, claude, codex, antigravity, dry_run):
    managed=[]
    for skill in selected_skills:
        source=canonical/"skills"/skill
        for target in ([claude/"skills"/skill] if "Claude" in selected else [])+([codex/"skills"/skill] if "Codex" in selected else [])+([antigravity/"config"/"skills"/skill] if "Antigravity" in selected else []):
            if not source.is_dir(): continue
            if not dry_run:
                if target.exists() or target.is_symlink():
                    is_reparse=getattr(os.path,"isjunction",lambda value:False)(target)
                    if target.is_symlink() or is_reparse: target.unlink()
                    else: shutil.rmtree(target)
                target.parent.mkdir(parents=True,exist_ok=True); shutil.copytree(source,target)
            for file in source.rglob("*"):
                if file.is_file():
                    destination = target / file.relative_to(source)
                    managed.append({"path":str(destination),"sha256":_hash(file),"kind":"platform-skill"})
    return managed


def _remove_stale_skill_links(claude: Path, selected: set[str], dry_run: bool) -> None:
    if "Claude" not in selected:
        return
    skills_root = claude / "skills"
    if not skills_root.is_dir():
        return
    for target in sorted(skills_root.iterdir()):
        is_reparse = getattr(os, "isjunction", lambda value: False)(target)
        if (target.is_symlink() or is_reparse) and not target.exists() and not dry_run:
            target.unlink()

def _remove_managed_hooks(path, runtime_root, dry_run):
    if not path.is_file(): return
    try:data=json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError,json.JSONDecodeError):return
    marker=str(runtime_root).casefold()
    if "hooks" in data:
        for event,wrappers in list(data["hooks"].items()):
            kept=[]
            for wrapper in wrappers or []:
                command=str(wrapper.get("command","")) if isinstance(wrapper,dict) else ""
                if command and marker in command.casefold(): continue
                if isinstance(wrapper,dict) and isinstance(wrapper.get("hooks"),list): wrapper=dict(wrapper); wrapper["hooks"]=[x for x in wrapper["hooks"] if marker not in str(x.get("command","")).casefold()]
                if not isinstance(wrapper,dict) or wrapper.get("command") or wrapper.get("hooks"): kept.append(wrapper)
            data["hooks"][event]=kept
    if any(str(k).startswith("agent-workflow-") for k in data): data={k:v for k,v in data.items() if not str(k).startswith("agent-workflow-")}
    if not dry_run:_json(path,data)


def _prune_stale(previous: dict[str, str], files: list[dict[str, str]], managed_roots: list[Path], dry_run: bool) -> list[str]:
    """Remove managed files the current manifest no longer lists.

    Uses the exact same safety rule Uninstall already relies on: a stale path is
    only removed when its current on-disk hash still matches what the previous
    install recorded, so a file the user edited by hand is left alone (it would
    already have been flagged 'preserved-local-change' if it were still in the
    manifest; this only prunes files that dropped out of the manifest entirely).
    User data -- state/knowledge, state/projects, task directories, imports,
    activation.json -- is never in `previous` in the first place, since it is
    never written into managed-runtime.json.
    """
    current_paths = {item["path"] for item in files}
    removed: list[str] = []
    for path_str in sorted(set(previous) - current_paths):
        path = Path(path_str)
        expected = previous[path_str]
        if not path.is_file() or not expected or _hash(path) != expected:
            continue
        removed.append(path_str)
        if dry_run:
            continue
        path.unlink()
        parent = path.parent
        # Prune now-empty ancestor directories, but never touch a managed root itself
        # (e.g. `runtime/`, `canonical/`, a platform target directory) or anything above it.
        while any(root in parent.parents for root in managed_roots):
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent
    return removed


def install(args: argparse.Namespace) -> int:
    target = args.target_agent
    selected = {"Both": {"Claude", "Codex"}, "All": {"Claude", "Codex", "Antigravity"}}.get(target, {target})
    state = Path(args.state_root).expanduser().resolve(); runtime = state / "runtime"; canonical = Path(args.canonical_root).expanduser().resolve()
    claude, codex, antigravity = (Path(args.claude_target).expanduser().resolve(), Path(args.codex_target).expanduser().resolve(), Path(args.antigravity_target).expanduser().resolve())
    if args.action == "Status":
        print(json.dumps({"runtime_installed": (runtime / "agent_workflow.py").is_file(), "python": sys.executable, "runtime_root": str(runtime)}, ensure_ascii=False)); return 0
    if args.action == "Verify":
        good = (runtime / "agent_workflow.py").is_file() and sys.version_info >= (3, 11)
        print(json.dumps({"valid": good, "python": sys.executable, "python_version": list(sys.version_info[:3]), "runtime_root": str(runtime)}, ensure_ascii=False)); return 0 if good else 1
    state_file = state / "managed-runtime.json"
    previous = {}
    previous_state: dict[str, Any] = {}
    source_root = ROOT
    try:
        old=json.loads(state_file.read_text(encoding="utf-8")); previous_state=old; previous={str(item.get("path")):item.get("sha256","") for item in old.get("files",[])}
        recorded_source = Path(str(old.get("source", ""))).expanduser().resolve()
        # A repo checkout is the authoritative source when install.py is run from it.
        # Only an installed runtime needs to resolve its recorded canonical source.
        if ROOT == runtime and (recorded_source / "adapters" / "managed-manifest.json").is_file():
            source_root = recorded_source
    except (FileNotFoundError, json.JSONDecodeError): pass
    if args.action == "Uninstall":
        try: previous = json.loads(state_file.read_text(encoding="utf-8"))
        except FileNotFoundError: previous = {"files": []}
        for item in previous.get("files", []):
            path = Path(item.get("path", "")); expected = item.get("sha256", "")
            if not args.dry_run and path.is_file() and expected and _hash(path) == expected: path.unlink()
        _remove_managed_hooks(claude/"settings.json",runtime,args.dry_run); _remove_managed_hooks(codex/"hooks.json",runtime,args.dry_run); _remove_managed_hooks(antigravity/"config"/"hooks.json",runtime,args.dry_run)
        print("Managed runtime removed. Knowledge, projects, tasks, and imports were preserved."); return 0
    if args.action not in {"Install", "Repair"}: raise RuntimeError(f"unsupported action: {args.action}")
    if sys.version_info < (3, 11): raise RuntimeError("Python 3.11 or newer is required; install it and run install.py again")
    files: list[dict[str, str]] = []
    manifest = json.loads((source_root / "adapters" / "managed-manifest.json").read_text(encoding="utf-8-sig"))
    selected_skills = _resolve_skills(args, manifest, previous_state)
    force=args.action=="Repair"
    for relative in manifest["runtime"]:
        source = (source_root / ".agents" / relative) if relative.startswith(("agents/", "skills/")) else (source_root / relative)
        _copy(source, runtime / relative, files, args.dry_run, previous, force)
    # Canonical shared source lives once; platform copies are written from it during each install.
    for relative in ("agents/reviewer.md", "agents/adversarial.md", "agents/verifier.md", "agents/retrospective.md", "agents/worker.md", "agents/reviewer-code-smells.md"):
        _copy(source_root / ".agents" / relative, canonical / relative, files, args.dry_run, previous, force)
    # reviewer.md's relative link to reviewer-code-smells.md only resolves for Claude,
    # whose deployed agent file keeps the same directory shape as canonical/agents/.
    if "Claude" in selected:
        _copy(source_root / ".agents" / "agents" / "reviewer-code-smells.md", claude / "agents" / "reviewer-code-smells.md", files, args.dry_run, previous, force)
    source_skills = source_root / ".agents" / "skills"
    for source in source_skills.rglob("*"):
        if source.is_file(): _copy(source, canonical / "skills" / source.relative_to(source_skills), files, args.dry_run, previous, force)
    python_executable = Path(sys.executable).resolve()
    files.extend(_write_agents(canonical, selected, claude, codex, antigravity, runtime, python_executable, args.dry_run))
    files.extend(_install_platform_files(selected, selected_skills, canonical, claude, codex, antigravity, args.dry_run))
    _remove_stale_skill_links(claude, selected, args.dry_run)
    entry_targets = []
    if "Claude" in selected: entry_targets.append(claude / "CLAUDE.md")
    if "Codex" in selected: entry_targets.append(codex / "AGENTS.md")
    if "Antigravity" in selected: entry_targets.append(antigravity / "GEMINI.md")
    _managed_entrypoint(runtime / "AGENTS.md", canonical / "AGENTS.md", entry_targets, args.dry_run)
    if "Claude" in selected: _merge_hooks(source_root / "adapters/claude/settings.hooks.json", claude / "settings.json", runtime, python_executable, False, args.dry_run)
    if "Codex" in selected:
        _merge_hooks(source_root / "adapters/codex/hooks.json", codex / "hooks.json", runtime, python_executable, False, args.dry_run)
        _copy(source_root / "adapters/codex/execpolicy.rules", codex / "rules/agent-workflow.rules", files, args.dry_run, previous, force)
        if not args.dry_run:
            missing=untrusted(str(codex/"hooks.json"),str(codex/"config.toml"),str(runtime))
            if missing: print(f"[install] Codex has {len(missing)} untrusted agent-workflow hook(s); approve them before relying on the hook:")
            for key in missing: print(f"  - {key}")
    if "Antigravity" in selected: _merge_hooks(source_root / "adapters/antigravity/hooks.json", antigravity / "config/hooks.json", runtime, python_executable, True, args.dry_run)
    managed_roots = [runtime, canonical] + [root for name, root in
                     (("Claude", claude), ("Codex", codex), ("Antigravity", antigravity)) if name in selected]
    stale = _prune_stale(previous, files, managed_roots, args.dry_run)
    if stale:
        verb = "Would remove" if args.dry_run else "Removed"
        print(f"[install] {verb} {len(stale)} file(s) no longer in the manifest:")
        for path in stale: print(f"  - {path}")
    if not args.dry_run:
        _json(state_file, {"schema_version": 5, "installed_at": datetime.now(timezone.utc).isoformat(), "source": str(ROOT), "selected_skills": sorted(selected_skills), "files": files})
    _backup_legacy(args,args.dry_run)
    print(f"agent-workflow v5 {args.action} complete for {target}.")
    return 0


def main(argv: list[str] | None = None) -> int:
    home = Path.home()
    parser = argparse.ArgumentParser()
    parser.add_argument("--target-agent", "--agent", default="All", choices=("Claude", "Codex", "Antigravity", "Both", "All"))
    parser.add_argument("--claude-target", default=str(home / ".claude")); parser.add_argument("--codex-target", default=str(home / ".codex")); parser.add_argument("--antigravity-target", default=str(home / ".gemini"))
    parser.add_argument("--state-root", default=str(home / ".agent-workflow")); parser.add_argument("--canonical-root", default=str(home / ".agents")); parser.add_argument("--legacy-root", default=str(home / ".agents")); parser.add_argument("--action", default="Install", choices=("Install", "Status", "Repair", "Uninstall", "Verify")); parser.add_argument("--skills", help="all 或以逗號分隔的 skill 名稱"); parser.add_argument("--non-interactive", action="store_true"); parser.add_argument("--dry-run", action="store_true")
    return install(parser.parse_args(argv))


if __name__ == "__main__": raise SystemExit(main())
