"""Single UTF-8 Python test entrypoint for the migrated runtime."""
from __future__ import annotations
from pathlib import Path
import json, tempfile
try:
    from .run_hook_tests import main as hook_main
except ImportError:
    from run_hook_tests import main as hook_main
import subprocess, sys

def main() -> int:
    root=Path(__file__).resolve().parent.parent
    result=hook_main()
    if result: return result
    try:
        from .ported_cases import SUITES
    except ImportError:
        from ported_cases import SUITES
    for name, suite in SUITES.items():
        suite()
        print(f"ported {name} tests passed")
    with tempfile.TemporaryDirectory(prefix="agent-workflow-python-") as temp:
        root_temp=Path(temp); state=root_temp/"state"; claude=root_temp/"claude"; codex=root_temp/"codex"; repos=root_temp/"repos"
        (claude/"memory").mkdir(parents=True); (codex/"memories").mkdir(parents=True); repos.mkdir()
        (claude/"memory"/"one.md").write_text("# one\n",encoding="utf-8"); (codex/"memories"/"two.md").write_text("# two\n",encoding="utf-8")
        run_id="python-test"; subprocess.run([sys.executable,str(root/"migrate-v3.py"),"--action","Inventory","--state-root",str(state),"--claude-root",str(claude),"--codex-root",str(codex),"--repo-search-root",str(repos),"--run-id",run_id],check=True,stdout=subprocess.PIPE)
        subprocess.run([sys.executable,str(root/"migrate-v3.py"),"--action","Stage","--state-root",str(state),"--run-id",run_id],check=True,stdout=subprocess.PIPE)
        subprocess.run([sys.executable,str(root/"migrate-v3.py"),"--action","Validate","--state-root",str(state),"--run-id",run_id],check=True,stdout=subprocess.PIPE)
        manifest=json.loads((state/"imports"/run_id/"manifest.json").read_text(encoding="utf-8")); subprocess.run([sys.executable,str(root/"migrate-v3.py"),"--action","Activate","--state-root",str(state),"--run-id",run_id,"--accept-unresolved-manifest-hash",manifest["manifest_hash"]],check=True,stdout=subprocess.PIPE)
        assert (state/"activation.json").is_file() and (state/"knowledge"/"global"/"index.json").is_file()
    print("migration activation contract passed")
    with tempfile.TemporaryDirectory(prefix="agent-workflow-contract-") as temp:
        sandbox=Path(temp); state=sandbox/"state"; state.mkdir(); task=state/"task.md"
        task.write_text("---\nid: 20260819-123456-test\nproject_id: fedcba9876543210\nworktree_id: 0123456789abcdef\nstatus: in_progress\ncode_change: true\nrisk_flags: []\nchange_kind: fix\ncreated_at: 2026-08-19T12:34:56+08:00\nupdated_at: 2026-08-19T12:34:56+08:00\n---\n\n# Fix\n\n## Goal\nfix\n\n## Scope\nsource\n\n## Completion criteria\n- [x] done\n\n## Validation results\n- pre-review: PASS\n\n## Reviewer result\n- result: PASS\n- Architecture consistency: PASS\n- Code quality and conventions: PASS\n- Data consistency: PASS\n- Security: PASS\n- Risk and compatibility: PASS\n- Performance: PASS\n- Flow and impact completeness: PASS\n- Failure modes and observability: PASS\n\n## Verifier result\n- PASS\n",encoding="utf-8")
        gate=subprocess.run([sys.executable,str(root/"agent_workflow.py"),"task-gate","--task-path",str(task),"--mode","Stop","--cwd",str(sandbox)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        assert gate.returncode==0 and not json.loads(gate.stdout).get("issues"), gate.stderr.decode("utf-8","replace")+gate.stdout.decode("utf-8","replace")
        profile=subprocess.run([sys.executable,str(root/"scripts"/"task-profile.py"),"--code-change","--change-kind","fix"],stdout=subprocess.PIPE,check=True)
        assert json.loads(profile.stdout)["profile"]=="standard"
        knowledge=subprocess.run([sys.executable,str(root/"agent_workflow.py"),"knowledge","--action","Upsert","--scope","Global","--topic","test-topic","--content","UTF-8","--state-root",str(state)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        assert knowledge.returncode!=0
        retro=subprocess.run([sys.executable,str(root/"agent_workflow.py"),"retro","--action","List","--state-root",str(state)],stdout=subprocess.PIPE,check=True)
        assert json.loads(retro.stdout)==[]
        declared_task = sandbox/"declared-safe-task.md"
        from agent_workflow.workflow_planner import plan_task
        declared_facts = json.dumps({"logic_change": False, "data_transform": False, "has_consumer": False, "public_api_change": False, "destructive_operation": False})
        declared_data = {"code_change": True, "task_type": "chore", "change_kind": "chore", "risk_flags": [], "impact_scope": "file", "impact_effect": "none", "impact_confidence": "high", "workflow_facts": declared_facts}
        declared_plan = plan_task(declared_data, cwd=str(sandbox))
        # Facts the agent declared about itself must never suppress a role.
        assert "reviewer" in declared_plan["roles"] and "verifier" in declared_plan["roles"], declared_plan["roles"]
        decision = json.dumps({"final_action": declared_plan["final_action"], "selected": [{"name": item["name"], "kind": item["kind"], "steps": [step["id"] for step in item["steps"]]} for item in declared_plan["selected"]], "suppressed": [item["name"] for item in declared_plan["suppressed"]], "unknown": [item["name"] for item in declared_plan["unknown"]]}, separators=(",", ":"))
        declared_frontmatter = "\n".join([
            "---", "id: 20260819-123457-declared", "project_id: fedcba9876543210", "worktree_id: 0123456789abcdef", "status: in_progress", "code_change: true", "task_type: chore", "change_kind: chore", "risk_flags: []", "impact_scope: file", "impact_effect: none", "impact_confidence: high", "workflow_profile: " + declared_plan["profile"], "workflow_facts: " + declared_facts, "workflow_decision: " + decision, "created_at: 2026-08-19T12:34:56+08:00", "updated_at: 2026-08-19T12:34:56+08:00", "---", "", "# Declared", "", "## Goal", "declared", "", "## Scope", "source", "", "## Completion criteria", "- [x] done", "", "## Validation results", "- pre-review: PASS", ""])
        declared_task.write_text(declared_frontmatter, encoding="utf-8")
        declared_gate = subprocess.run([sys.executable, str(root/"agent_workflow.py"), "task-gate", "--task-path", str(declared_task), "--mode", "Stop", "--cwd", str(sandbox)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        declared_issues = json.loads(declared_gate.stdout)["issues"]
        assert any("Reviewer result is missing" in issue for issue in declared_issues), declared_issues
        assert any("Verifier result is missing" in issue for issue in declared_issues), declared_issues
        tampered_task = sandbox/"tampered-task.md"
        tampered_task.write_text(declared_frontmatter.replace('"unknown":[', '"unknown":["reviewer","forged",'), encoding="utf-8")
        tampered_gate = subprocess.run([sys.executable, str(root/"agent_workflow.py"), "task-gate", "--task-path", str(tampered_task), "--mode", "Stop", "--cwd", str(sandbox)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        assert any("workflow_decision" in issue for issue in json.loads(tampered_gate.stdout)["issues"])
    print("task profile/gate/knowledge/retro contracts passed")
    checks=[("compile",[sys.executable,"-m","compileall","-q",str(root/"agent_workflow"),str(root/"scripts")]),
            ("contract",[sys.executable,str(root/"agent_workflow.py"),"project-doc","--action","Check","--doc",str(root/"README.md")]),
            ("migration",[sys.executable,str(root/"migrate-v3.py"),"--help"]),
            ("orchestration",[sys.executable,str(root/"scripts"/"orchestrate.py"),"--help"])]
    for name, command in checks:
        completed=subprocess.run(command,cwd=root,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
        if completed.returncode:
            sys.stderr.write(f"{name} failed\n"+completed.stderr.decode("utf-8","replace")); return completed.returncode
        print(f"{name} passed")
    print("all Python test runners passed"); return 0

if __name__ == "__main__": raise SystemExit(main())
