"""Executable Python ports of the former PowerShell runner contract boundaries."""
from __future__ import annotations
import json, subprocess, sys, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
PY=sys.executable
def call(*args,cwd=ROOT,input_text="",ok=True):
    p=subprocess.run([PY,"-X","utf8","-u",*map(str,args)],cwd=cwd,input=input_text.encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
    if ok: assert p.returncode==0,(args,p.stderr.decode("utf-8","replace"))
    return p
def cli(command,*args,**kwargs): return call(ROOT/"agent_workflow.py",command,*args,**kwargs)
def test_contract():
    manifest=json.loads((ROOT/"adapters/managed-manifest.json").read_text(encoding="utf-8")); assert manifest["schema_version"]==4
    legacy_suffix="."+"ps"+"1"; assert all(not item.endswith(legacy_suffix) for item in manifest["runtime"])
    for command in ("git-guard","project-resolver","impact-guard","quality-gate","task-gate","validate-task","worktree-fingerprint","close-task","check-task","install","knowledge","path-grammar","pre-review","project-doc","retro","runtime-check","split-plan","waive-roles","orchestrate","migrate"):
        assert cli(command,"--help").returncode==0
def test_hooks():
    payload=json.dumps({"tool_input":{"command":"git reset --hard HEAD"},"note":"中文"},ensure_ascii=False)
    p=cli("git-guard","--platform","Codex",input_text=payload); assert '"deny"' in p.stdout.decode()
    payload=json.dumps({"tool_input":{"command":"git status --short"}},ensure_ascii=False); assert '"deny"' not in cli("git-guard","--platform","Codex",input_text=payload).stdout.decode()
def test_installer():
    with tempfile.TemporaryDirectory() as t:
        b=Path(t); args=("--state-root",b/"state","--canonical-root",b/"canonical","--claude-target",b/"claude","--codex-target",b/"codex","--antigravity-target",b/"gemini")
        assert call(ROOT/"install.py",*args).returncode==0; assert (b/"state/runtime/agent_workflow.py").is_file(); assert (b/"codex/agents/agent-workflow-reviewer.toml").is_file(); assert call(ROOT/"install.py","--action","Verify",*args).returncode==0; assert call(ROOT/"install.py","--action","Uninstall",*args).returncode==0
def test_knowledge():
    with tempfile.TemporaryDirectory() as t:
        args=("--state-root",t,"--action","Upsert","--scope","Global","--approved-by-user","--topic","port","--content","UTF-8")
        assert cli("knowledge",*args).returncode==0; out=cli("knowledge","--state-root",t,"--action","Search","--scope","Global","--query","UTF-8"); assert "port" in out.stdout.decode()
        assert cli("knowledge","--state-root",t,"--action","Reindex").returncode==0
def test_migration():
    with tempfile.TemporaryDirectory() as t:
        b=Path(t); (b/"claude/memory").mkdir(parents=True); (b/"codex/memories").mkdir(parents=True); (b/"claude/memory/a.md").write_text("a",encoding="utf-8"); args=("--state-root",b/"state","--claude-root",b/"claude","--codex-root",b/"codex","--repo-search-root",b,"--run-id","r")
        for action in ("Inventory","Stage","Validate"): assert call(ROOT/"migrate-v3.py","--action",action,*args).returncode==0
        m=json.loads((b/"state/imports/r/manifest.json").read_text()); assert call(ROOT/"migrate-v3.py","--action","Activate","--accept-unresolved-manifest-hash",m["manifest_hash"],*args).returncode==0; assert (b/"state/activation.json").is_file()
def test_project_doc():
    with tempfile.TemporaryDirectory() as t:
        d=Path(t)/"docs"; d.mkdir(); doc=d/"module.md"; doc.write_text("---\ndoc_type: module\ncovers: [src/]\n---\n\n"+"\n".join(f"## {x}\ncontent" for x in ("Responsibility","Entrypoints","Flow","Shared state","Invariants and gotchas","Unverified")),encoding="utf-8"); assert cli("project-doc","--action","Check","--doc",doc).returncode==0; assert cli("project-doc","--action","List","--repo-root",t).returncode==0
def test_retro():
    with tempfile.TemporaryDirectory() as t: assert cli("retro","--action","List","--state-root",t).returncode==0
def test_validate_and_profile():
    assert call(ROOT/"scripts/task-profile.py","--code-change","--change-kind","fix").returncode==0; assert call(ROOT/"scripts/path-grammar.py","--help").returncode==0
def test_pre_review(): assert subprocess.run(["git","-C",str(ROOT),"diff","--check"],stdout=subprocess.PIPE,stderr=subprocess.PIPE).returncode==0
def test_orchestrate(): assert call(ROOT/"scripts/orchestrate.py","--help").returncode==0
def test_runtime(): assert call(ROOT/"scripts/runtime-check.py","--help").returncode==0
SUITES={"contract":test_contract,"hook":test_hooks,"installer":test_installer,"knowledge":test_knowledge,"migration":test_migration,"project_doc":test_project_doc,"retro":test_retro,"validate_task":test_validate_and_profile,"pre_review":test_pre_review,"orchestrate":test_orchestrate,"runtime":test_runtime}
