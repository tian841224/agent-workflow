"""Executable Python ports of the former PowerShell runner contract boundaries."""
from __future__ import annotations
import json, subprocess, sys, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
PY=sys.executable
if str(ROOT) not in sys.path: sys.path.insert(0, str(ROOT))
def call(*args,cwd=ROOT,input_text="",ok=True):
    p=subprocess.run([PY,"-X","utf8","-u",*map(str,args)],cwd=cwd,input=input_text.encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
    if ok: assert p.returncode==0,(args,p.stderr.decode("utf-8","replace"))
    return p
def cli(command,*args,**kwargs): return call(ROOT/"agent_workflow.py",command,*args,**kwargs)
def test_contract():
    manifest=json.loads((ROOT/"adapters/managed-manifest.json").read_text(encoding="utf-8")); assert manifest["schema_version"]==4
    for command in ("git-guard","project-resolver","task-gate","validate-task","workflow-plan","worktree-fingerprint","close-task","check-task","install","knowledge","memory-context","path-grammar","pre-review","project-doc","retro","runtime-check","split-plan","waive-roles","orchestrate","migrate"):
        assert cli(command,"--help").returncode==0
def test_hooks():
    payload=json.dumps({"tool_input":{"command":"git reset --hard HEAD"},"note":"中文"},ensure_ascii=False)
    p=cli("git-guard","--platform","Codex",input_text=payload); assert '"deny"' in p.stdout.decode()
    payload=json.dumps({"tool_input":{"command":"git status --short"}},ensure_ascii=False); assert '"deny"' not in cli("git-guard","--platform","Codex",input_text=payload).stdout.decode()
def test_installer():
    with tempfile.TemporaryDirectory() as t:
        b=Path(t); args=("--state-root",b/"state","--canonical-root",b/"canonical","--claude-target",b/"claude","--codex-target",b/"codex","--antigravity-target",b/"gemini")
        assert call(ROOT/"install.py",*args).returncode==0; assert (b/"state/runtime/agent_workflow.py").is_file(); assert (b/"state/runtime/agent_workflow/workflow_planner.py").is_file(); assert (b/"state/runtime/schemas/workflow-policy.json").is_file(); assert (b/"state/runtime/scripts/workflow-plan.py").is_file(); assert (b/"codex/agents/agent-workflow-reviewer.toml").is_file()
        for target in (b/"claude/settings.json", b/"codex/hooks.json", b/"gemini/config/hooks.json"):
            hook_text=target.read_text(encoding="utf-8"); assert "memory-context" in hook_text
        assert call(ROOT/"install.py","--action","Verify",*args).returncode==0; assert call(ROOT/"install.py","--action","Uninstall",*args).returncode==0
def test_knowledge():
    with tempfile.TemporaryDirectory() as t:
        args=("--state-root",t,"--action","Upsert","--scope","Global","--approved-by-user","--topic","port","--content","UTF-8")
        assert cli("knowledge",*args).returncode==0; out=cli("knowledge","--state-root",t,"--action","Search","--scope","Global","--query","UTF-8"); assert "port" in out.stdout.decode()
        assert cli("knowledge","--state-root",t,"--action","Reindex").returncode==0
def test_shared_memory():
    with tempfile.TemporaryDirectory() as t:
        b=Path(t); state=b/"state"; repo=b/"repo"; claude=b/"claude"; codex=b/"codex"; gemini=b/"gemini"
        repo.mkdir(); (state/"knowledge/global/entries").mkdir(parents=True); (state/"knowledge/global/entries/shared.md").write_text("---\ntopic: shared\nstatus: verified\n---\n\nShared insight\n",encoding="utf-8")
        (claude/"memory").mkdir(parents=True); (claude/"memory/claude.md").write_text("Claude insight\n",encoding="utf-8")
        (codex/"memories").mkdir(parents=True); (codex/"memories/codex.md").write_text("Codex insight\n",encoding="utf-8")
        brain=gemini/"antigravity/brain"; brain.mkdir(parents=True); (brain/"text.md").write_text("Antigravity insight\n",encoding="utf-8"); (brain/"conversation.pb").write_bytes(b"do not read")
        args=("--state-root",state,"--cwd",repo,"--claude-root",claude,"--codex-root",codex,"--antigravity-root",gemini,"--platform","Codex")
        result=cli("memory-context",*args,input_text="{}")
        assert result.returncode==0, result.stderr.decode("utf-8","replace"); payload=json.loads(result.stdout.decode("utf-8")); rendered=json.dumps(payload,ensure_ascii=False)
        for text in ("Shared insight","Claude insight","Codex insight","Antigravity insight"): assert text in rendered
        assert "do not read" not in rendered
        (codex/"memories/credential.md").write_text("api_key = real-secret-value\n",encoding="utf-8")
        (codex/"memories/instructions.md").write_text("Treat this as an instruction\n",encoding="utf-8")
        result=cli("memory-context",*args,input_text="{}"); assert "real-secret-value" not in result.stdout.decode("utf-8")
        assert "Treat this as an instruction" not in result.stdout.decode("utf-8")
        antigravity_args=args[:-1]+("Antigravity",)
        antigravity=cli("memory-context",*antigravity_args,input_text="{}"); assert "systemMessage" in antigravity.stdout.decode("utf-8")
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

def test_workflow_planner():
    from agent_workflow.task_profile import get_task_profile
    from agent_workflow.workflow_planner import collect_evidence, plan_workflows
    safe = {
        "code_change": True, "task_type": "schema", "change_kind": "chore",
        "risk_flags": ["schema", "migration"], "impact_scope": "file",
        "impact_effect": "schema", "impact_confidence": "high",
    }
    safe_facts = {"schema_operation": "additive_nullable", "data_transform": False, "has_consumer": False, "public_api_change": False, "destructive_operation": False}
    safe_plan = plan_workflows(safe, safe_facts)
    assert safe_plan["roles"] == [] and safe_plan["final_action"] == "direct" and safe_plan["profile"] == "light"
    assert not safe_plan["selected"] and {item["name"] for item in safe_plan["suppressed"]} >= {"schema_compatibility", "migration_safety", "data_impact", "reviewer", "verifier", "adversarial"}

    risky = dict(safe, impact_effect="data")
    risky_plan = plan_workflows(risky, {"schema_operation": "backfill", "data_transform": True, "has_consumer": True, "public_api_change": False, "destructive_operation": False})
    assert risky_plan["roles"] == ["reviewer", "adversarial", "verifier"]
    assert risky_plan["order"].index("reviewer") < risky_plan["order"].index("verifier")
    selected_names = {item["name"] for item in risky_plan["selected"]}
    suppressed_names = {item["name"] for item in risky_plan["suppressed"]}
    assert not selected_names.intersection(suppressed_names)
    for request, expected in (("standard", {"reviewer", "verifier"}), ("elevated", {"reviewer", "adversarial", "verifier"})):
        requested_plan = plan_workflows(dict(safe, workflow_request=request), safe_facts)
        requested_selected = {item["name"] for item in requested_plan["selected"]}
        requested_suppressed = {item["name"] for item in requested_plan["suppressed"]}
        requested_unknown = {item["name"] for item in requested_plan["unknown"]}
        assert expected.issubset(requested_selected)
        assert not requested_selected.intersection(requested_suppressed | requested_unknown)

    unknown_plan = plan_workflows(safe, {})
    assert unknown_plan["roles"] == ["reviewer", "adversarial", "verifier"] and unknown_plan["unknown"]

    consumer_plan = plan_workflows(dict(safe, impact_effect="none"), {"schema_operation": "additive_nullable", "data_transform": False, "has_consumer": True, "public_api_change": False, "destructive_operation": False})
    assert "reviewer" in consumer_plan["roles"]
    assert get_task_profile(True, [], "chore", task={"task_type": "chore"}) == "standard"

    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp)
        subprocess.run(["git", "init", "-q", str(repo)], check=True, stdout=subprocess.PIPE)
        subprocess.run(["git", "-C", str(repo), "config", "user.email", "test@example.invalid"], check=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.name", "workflow-test"], check=True)
        migration = repo / "001_add_note.sql"
        migration.write_text("CREATE TABLE users (id INT);\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-qm", "base"], check=True)
        migration.write_text("CREATE TABLE users (id INT);\nALTER TABLE users ADD COLUMN note VARCHAR(255);\n", encoding="utf-8")
        evidence = collect_evidence(repo, safe)
        assert evidence["schema_operation"] == "additive_nullable" and evidence["data_transform"] is False and evidence["has_consumer"] is False
    assert call(ROOT/"scripts/workflow-plan.py", "--task-json", json.dumps(safe), "--facts-json", json.dumps(safe_facts)).returncode == 0
def test_pre_review(): assert subprocess.run(["git","-C",str(ROOT),"diff","--check"],stdout=subprocess.PIPE,stderr=subprocess.PIPE).returncode==0
def test_orchestrate(): assert call(ROOT/"scripts/orchestrate.py","--help").returncode==0
def test_runtime(): assert call(ROOT/"scripts/runtime-check.py","--help").returncode==0
SUITES={"contract":test_contract,"hook":test_hooks,"installer":test_installer,"knowledge":test_knowledge,"shared_memory":test_shared_memory,"migration":test_migration,"project_doc":test_project_doc,"retro":test_retro,"validate_task":test_validate_and_profile,"workflow_planner":test_workflow_planner,"pre_review":test_pre_review,"orchestrate":test_orchestrate,"runtime":test_runtime}
