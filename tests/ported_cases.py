"""Executable Python ports of the former PowerShell runner contract boundaries."""
from __future__ import annotations
import json, os, shutil, subprocess, sys, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
PY=sys.executable
if str(ROOT) not in sys.path: sys.path.insert(0, str(ROOT))
def call(*args,cwd=ROOT,input_text="",ok=True):
    p=subprocess.run([PY,"-X","utf8","-u",*map(str,args)],cwd=cwd,input=input_text.encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120)
    if ok: assert p.returncode==0,(args,p.stderr.decode("utf-8","replace"))
    return p
def cli(command,*args,**kwargs): return call(ROOT/"agent_workflow.py",command,*args,**kwargs)
def test_contract():
    manifest=json.loads((ROOT/"adapters/managed-manifest.json").read_text(encoding="utf-8")); assert manifest["schema_version"]==4
    assert "adapters/managed-manifest.json" in manifest["runtime"]
    for command in ("git-guard","project-resolver","task-gate","validate-task","worktree-fingerprint","close-task","check-task","install","knowledge","memory-context","pre-review","project-doc","retro","runtime-check","split-plan","waive-roles","orchestrate","workflow-plan"):
        assert cli(command,"--help").returncode==0
    # every flag actually written in docs must be argparse's real double-dash lowercase form,
    # never PowerShell-style single-dash (docs previously drifted to -Action/-Query etc.,
    # which argparse parses as a cluster of short options and rejects outright)
    with tempfile.TemporaryDirectory() as t:
        result = cli("waive-roles", "--task-path", str(Path(t) / "missing.md"), "--reason", "x", ok=False)
        assert result.returncode != 0
        message = result.stdout.decode("utf-8", "replace") + result.stderr.decode("utf-8", "replace")
        assert "--confirmed-by-user is required" in message, message
def test_posix_wrapper():
    sh = shutil.which("sh")
    if not sh:
        return  # no POSIX shell available on this machine to exercise the wrapper with
    p = subprocess.run([sh, str(ROOT/"agent-workflow"), "task-gate", "--help"],
                       cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
    assert p.returncode == 0, p.stderr.decode("utf-8", "replace")
def test_hot_path_imports():
    # Hooks on the PreToolUse path must not eagerly pull in modules only a
    # different command needs -- that cost is paid on every single tool call.
    result=subprocess.run([PY,"-X","utf8","-u","-c",
        "import sys,runpy;"
        "sys.argv=['agent_workflow.py','git-guard','--platform','Codex'];"
        "import io; sys.stdin=io.TextIOWrapper(io.BytesIO(b'{\"tool_input\":{\"command\":\"git status\"}}'), encoding='utf-8');"
        "runpy.run_path(r'"+str(ROOT/"agent_workflow.py")+"', run_name='__main__');"
        "assert 'dataclasses' not in sys.modules, 'dataclasses should not be imported on the git-guard hot path';"
        "assert 'agent_workflow.workflow' not in sys.modules, 'workflow planning should not load for git-guard';"
    ],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
    assert result.returncode==0,(result.stdout.decode("utf-8","replace"),result.stderr.decode("utf-8","replace"))
def test_hooks():
    payload=json.dumps({"tool_input":{"command":"git reset --hard HEAD"},"note":"中文"},ensure_ascii=False)
    p=cli("git-guard","--platform","Codex",input_text=payload); assert '"deny"' in p.stdout.decode()
    payload=json.dumps({"tool_input":{"command":"git status --short"}},ensure_ascii=False); assert '"deny"' not in cli("git-guard","--platform","Codex",input_text=payload).stdout.decode()
def test_installer():
    with tempfile.TemporaryDirectory() as t:
        b=Path(t); args=("--state-root",b/"state","--canonical-root",b/"canonical","--claude-target",b/"claude","--codex-target",b/"codex","--antigravity-target",b/"gemini")
        # a stale UserPromptSubmit hook (pre-dating the SessionStart-only memory-context
        # design) must self-heal on install: _merge_hooks sweeps any command containing
        # the runtime path before re-merging the current fragment.
        claude_dir = b / "claude"; claude_dir.mkdir(parents=True)
        runtime_dir = b / "state" / "runtime"
        stale = {"hooks": {"UserPromptSubmit": [{"hooks": [{"type": "command",
            "command": f'"python" -u "{runtime_dir}\\agent_workflow.py" memory-context --platform Claude --event UserPromptSubmit'}]}]}}
        (claude_dir / "settings.json").write_text(json.dumps(stale), encoding="utf-8")
        assert call(ROOT/"install.py",*args).returncode==0; assert (b/"state/runtime/agent_workflow.py").is_file(); assert (b/"state/runtime/agent_workflow/workflow.py").is_file(); assert (b/"state/runtime/agent_workflow/workflow_plan.py").is_file(); assert (b/"state/runtime/schemas/workflow-policy.json").is_file(); assert (b/"codex/agents/agent-workflow-reviewer.toml").is_file()
        for target in (b/"claude/settings.json", b/"codex/hooks.json", b/"gemini/config/hooks.json"):
            hook_text=target.read_text(encoding="utf-8"); assert "memory-context" in hook_text
        after = json.loads((claude_dir / "settings.json").read_text(encoding="utf-8"))
        assert not after["hooks"].get("UserPromptSubmit"), after["hooks"].get("UserPromptSubmit")
        for target in (b/"codex/hooks.json", b/"gemini/config/hooks.json"):
            assert "UserPromptSubmit" not in target.read_text(encoding="utf-8")
        # the tdd skill is mandatory reading per workflow/SKILL.md and reviewer.md on every
        # platform, not just Claude -- it must actually be installed everywhere, not just
        # linked/copied for Claude
        assert (b/"claude/skills/tdd/SKILL.md").is_file()
        assert (b/"codex/skills/tdd/SKILL.md").is_file()
        assert (b/"gemini/config/skills/tdd/SKILL.md").is_file()
        for skill in ("codebase-design", "diagnosing-bugs", "planning", "push-back"):
            assert (b/"claude/skills"/skill/"SKILL.md").is_file()
            assert (b/"codex/skills"/skill/"SKILL.md").is_file()
            assert (b/"gemini/config/skills"/skill/"SKILL.md").is_file()
        assert (b/"gemini/config/skills/localization-tw/SKILL.md").is_file()
        for target in (b/"claude/skills/eli5/SKILL.md", b/"codex/skills/eli5/SKILL.md", b/"gemini/config/skills/eli5/SKILL.md"):
            assert target.is_file()
        for target in (b/"claude/skills/archify/SKILL.md", b/"codex/skills/archify/bin/archify.mjs", b/"gemini/config/skills/archify/schemas/architecture.schema.json"):
            assert target.is_file()
        for target in (b/"claude/skills/design-and-refine/SKILL.md", b/"codex/skills/design-and-refine/skills/design-lab/SKILL.md", b/"gemini/config/skills/design-and-refine/templates/feedback/FeedbackOverlay.tsx"):
            assert target.is_file()
        # a skill removed from source must have its stale Claude junction cleaned up on
        # the next install, not linger forever
        ghost = claude_dir/"skills"/"ghost-skill"
        (canonical_skills:=b/"canonical"/"skills"/"ghost-skill").mkdir(parents=True)
        (canonical_skills/"SKILL.md").write_text("---\nname: ghost-skill\n---\nghost\n", encoding="utf-8")
        if os.name == "nt":
            subprocess.run(["cmd","/c","mklink","/J",str(ghost),str(canonical_skills)],check=True,capture_output=True)
        else:
            ghost.symlink_to(canonical_skills, target_is_directory=True)
        shutil.rmtree(canonical_skills)
        assert call(ROOT/"install.py","--action","Repair",*args).returncode==0
        assert not ghost.exists() and not ghost.is_symlink(), "stale skill junction was not cleaned up"

        # Install/Repair must converge the managed tree to exactly the current manifest:
        # a file that dropped out of the manifest since the last install gets removed,
        # but only when untouched; a user-edited file with the same fate is preserved.
        # User data outside the manifest (knowledge, in this case) is never touched.
        import hashlib as _hashlib
        def _sha(p): return _hashlib.sha256(p.read_bytes()).hexdigest()
        keep_entry = b/"state"/"knowledge"/"global"/"entries"/"keep.md"
        keep_entry.parent.mkdir(parents=True, exist_ok=True)
        keep_entry.write_text("---\ntopic: keep\n---\nkeep me\n", encoding="utf-8")
        ghost_file = b/"state"/"runtime"/"agent_workflow"/"ghost_module.py"
        ghost_file.write_text("# no longer in the manifest\n", encoding="utf-8")
        edited_file = b/"state"/"runtime"/"agent_workflow"/"edited_ghost.py"
        edited_file.write_text("# will be user-edited before the fact is recorded\n", encoding="utf-8")
        manifest_path = b/"state"/"managed-runtime.json"
        manifest_data = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest_data["files"].append({"path": str(ghost_file), "sha256": _sha(ghost_file), "kind": "runtime"})
        manifest_data["files"].append({"path": str(edited_file), "sha256": _sha(edited_file), "kind": "runtime"})
        manifest_path.write_text(json.dumps(manifest_data), encoding="utf-8")
        edited_file.write_text("# user changed this after install recorded its hash\n", encoding="utf-8")
        preview = call(ROOT/"install.py","--action","Repair","--dry-run",*args)
        assert "ghost_module.py" in preview.stdout.decode("utf-8","replace"), preview.stdout
        assert ghost_file.is_file(), "dry-run must not delete anything"
        assert call(ROOT/"install.py","--action","Repair",*args).returncode==0
        assert not ghost_file.exists(), "a file no longer in the manifest was not pruned"
        assert edited_file.is_file(), "a user-edited file must never be silently deleted"
        assert edited_file.read_text(encoding="utf-8") == "# user changed this after install recorded its hash\n"
        assert keep_entry.is_file(), "user knowledge must survive Repair untouched"

        # An explicit skill selection is persisted and removes previously managed
        # platform skills that are no longer selected.
        assert call(ROOT/"install.py","--action","Repair","--skills","workflow,planning",*args).returncode==0
        selected_state = json.loads(manifest_path.read_text(encoding="utf-8"))
        assert selected_state["selected_skills"] == ["clean-comments", "codebase-design", "grill-me", "learn", "planning", "push-back", "tdd", "workflow"]
        assert (b/"claude/skills/workflow/SKILL.md").is_file()
        assert (b/"claude/skills/planning/SKILL.md").is_file()
        assert not (b/"claude/skills/architecture-review/SKILL.md").exists()
        # Repair without --skills reuses the previous selection.
        assert call(ROOT/"install.py","--action","Repair",*args).returncode==0
        assert (b/"codex/skills/tdd/SKILL.md").is_file()
        assert call(ROOT/"install.py","--skills","missing-skill",*args,ok=False).returncode != 0

        assert call(ROOT/"install.py","--action","Verify",*args).returncode==0; assert call(ROOT/"install.py","--action","Uninstall",*args).returncode==0
def test_knowledge():
    with tempfile.TemporaryDirectory() as t:
        args=("--state-root",t,"--action","Upsert","--scope","Global","--approved-by-user","--topic","port","--content","UTF-8")
        assert cli("knowledge",*args).returncode==0; out=cli("knowledge","--state-root",t,"--action","Search","--scope","Global","--query","UTF-8"); assert "port" in out.stdout.decode()
        metadata = (Path(t) / "knowledge" / "global" / "entries" / "port.md").read_text(encoding="utf-8")
        for field in ("id", "topic", "scope", "project_id", "origin", "status", "content_sha256", "relationships", "created_at", "updated_at"):
            assert f"{field}:" in metadata, metadata
        learned = cli("learn", "--action", "Capture", "--state-root", t, "--project-id", "0123456789abcdef", "--kind", "pitfall", "--topic", "scope-filter", "--content", "project entries live under projects/<id>/knowledge/entries")
        assert learned.returncode == 0, learned.stderr.decode("utf-8", "replace")
        learned_path = Path(json.loads(learned.stdout.decode("utf-8"))["path"])
        learned_metadata = learned_path.read_text(encoding="utf-8")
        assert "origin: native" in learned_metadata and "relationships: []" in learned_metadata, learned_metadata
        assert cli("knowledge","--state-root",t,"--action","Reindex").returncode==0
        # the store's convention is that the first body line is a self-contained summary;
        # Search's excerpt must reflect that line, not the last line of the raw file
        multi_args=("--state-root",t,"--action","Upsert","--scope","Global","--approved-by-user","--topic","multi-line","--content","first line summary\nsecond line detail\nthird line detail")
        assert cli("knowledge",*multi_args).returncode==0
        found=json.loads(cli("knowledge","--state-root",t,"--action","Search","--scope","Global","--query","summary").stdout.decode("utf-8"))
        assert any(item["excerpt"]=="first line summary" for item in found), found
        project = Path(t) / "projects" / "0123456789abcdef" / "knowledge" / "entries"
        project.mkdir(parents=True, exist_ok=True)
        (project / "project.md").write_text("---\ntopic: project-topic\nstatus: verified\n---\n\nproject summary\n", encoding="utf-8")
        project_result = json.loads(cli("knowledge", "--state-root", t, "--action", "Search", "--scope", "Project", "--query", "project summary").stdout.decode("utf-8"))
        assert len(project_result) == 1 and project_result[0]["topic"] == "project-topic", project_result
        filtered = json.loads(cli("knowledge", "--state-root", t, "--action", "Search", "--scope", "Global", "--topic", "port").stdout.decode("utf-8"))
        assert len(filtered) == 1 and filtered[0]["topic"] == "port", filtered
        assert cli("knowledge", "--state-root", t, "--action", "Reindex", "--scope", "All").returncode == 0
        all_index = json.loads((Path(t) / "knowledge" / "index.json").read_text(encoding="utf-8"))
        assert all_index["scope"] == "all" and any("/projects/" in item["path"].replace("\\", "/") for item in all_index["entries"]), all_index
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
def test_memory_quota_and_pollution():
    from agent_workflow.memory_context import collect_memory, render_context, DEFAULT_MAX_CONTEXT_CHARS, GLOBAL_QUOTA
    with tempfile.TemporaryDirectory() as t:
        b=Path(t); state=b/"state"; repo=b/"repo"; claude=b/"claude"; codex=b/"codex"; gemini=b/"gemini"
        repo.mkdir(parents=True)
        global_entries = state/"knowledge/global/entries"; global_entries.mkdir(parents=True)
        # more entries than the global quota, each with a real source_path so none are
        # flagged as polluted
        for i in range(GLOBAL_QUOTA + 4):
            (global_entries/f"g{i}.md").write_text(
                f"---\ntopic: g{i}\nstatus: verified\nsource_path: C:\\\\real\\\\place\\\\g{i}.md\n---\n\nGlobal insight {i}\n", encoding="utf-8")
        # a curated entry imported from an excluded source path must never render, even
        # though it lives in the curated store like a legitimate entry
        (global_entries/"polluted.md").write_text(
            "---\ntopic: polluted\nstatus: verified\nsource_path: C:\\\\Users\\\\x\\\\.codex\\\\memories\\\\rollout_summaries\\\\r.md\n---\n\nShould never render\n", encoding="utf-8")
        (claude/"memory").mkdir(parents=True)
        args=("--state-root",state,"--cwd",repo,"--claude-root",claude,"--codex-root",codex,"--antigravity-root",gemini,"--platform","Codex")
        result=cli("memory-context",*args,input_text="{}")
        payload=json.loads(result.stdout.decode("utf-8")); rendered=json.dumps(payload,ensure_ascii=False)
        assert "Should never render" not in rendered
        rendered_count=sum(1 for i in range(GLOBAL_QUOTA + 4) if f"Global insight {i}" in rendered)
        assert rendered_count <= GLOBAL_QUOTA, rendered_count
        assert len(rendered) < DEFAULT_MAX_CONTEXT_CHARS * 3
def test_project_doc():
    with tempfile.TemporaryDirectory() as t:
        d=Path(t)/"docs"; d.mkdir(); doc=d/"module.md"; doc.write_text("---\ndoc_type: module\ncovers: [src/]\n---\n\n"+"\n".join(f"## {x}\ncontent" for x in ("Responsibility","Entrypoints","Flow","Shared state","Invariants and gotchas","Unverified")),encoding="utf-8"); assert cli("project-doc","--action","Check","--doc",doc).returncode==0; assert cli("project-doc","--action","List","--repo-root",t).returncode==0
def test_project_doc_decision_and_glossary():
    with tempfile.TemporaryDirectory() as t:
        root=Path(t); subprocess.run(["git","init","-q",str(root)],check=True,stdout=subprocess.PIPE)
        subprocess.run(["git","-C",str(root),"config","user.email","test@example.invalid"],check=True)
        subprocess.run(["git","-C",str(root),"config","user.name","workflow-test"],check=True)
        (root/"src").mkdir(); (root/"src"/"money.py").write_text("AMOUNT = 1\n",encoding="utf-8")
        d=root/"docs"; d.mkdir(); (d/"decisions").mkdir()
        decision=d/"decisions"/"decimal-money.md"
        decision.write_text("---\ndoc_type: decision\ncovers: [\"src/money.py\"]\n---\n\n"+"\n".join(f"## {x}\ncontent" for x in ("Context","Decision","Alternatives","Consequences")),encoding="utf-8")
        glossary=d/"glossary.md"
        glossary.write_text("---\ndoc_type: glossary\n---\n\n## Terms\ncontent",encoding="utf-8")
        subprocess.run(["git","-C",str(root),"add","."],check=True)
        subprocess.run(["git","-C",str(root),"commit","-qm","base"],check=True)
        assert cli("project-doc","--action","Check","--doc",decision).returncode==0
        assert cli("project-doc","--action","Check","--doc",glossary).returncode==0
        # a decision doc missing 'covers' must fail Check; glossary is exempt
        bare_decision=d/"decisions"/"bare.md"
        bare_decision.write_text("---\ndoc_type: decision\ncovers: []\n---\n\n"+"\n".join(f"## {x}\ncontent" for x in ("Context","Decision","Alternatives","Consequences")),encoding="utf-8")
        bare_issues=json.loads(cli("project-doc","--action","Check","--doc",bare_decision).stdout.decode("utf-8"))[0]["issues"]
        assert any("covers" in issue for issue in bare_issues), bare_issues
        # glossary always attaches to Lookup regardless of the query path, like architecture/dataflow
        lookup=json.loads(cli("project-doc","--action","Lookup","--repo-root",str(root),"--paths","src/other.py").stdout.decode("utf-8"))
        assert any(item["path"]==str(glossary) for item in lookup["docs"]), lookup
        # covers a decision doc traces to: touching the covered file after the doc's commit marks it stale
        (root/"src"/"money.py").write_text("AMOUNT = 2  # changed after the decision doc\n",encoding="utf-8")
        subprocess.run(["git","-C",str(root),"add","."],check=True)
        subprocess.run(["git","-C",str(root),"commit","-qm","touch covered file"],check=True)
        stale=json.loads(cli("project-doc","--action","Stale","--repo-root",str(root)).stdout.decode("utf-8"))
        assert any(item["path"]==str(decision) and item["stale"] for item in stale), stale
def test_retro():
    with tempfile.TemporaryDirectory() as t:
        assert cli("retro", "--action", "List", "--state-root", t).returncode == 0
        task = Path(t) / "task.md"
        task.write_text("---\nid: 20260823-123456-real-task\n---\n\n## Retrospective result\n- introduced_by: abc1234\n- classification: regression\n- miss_category: test_gap\n- gap_evidence: task gate\n", encoding="utf-8")
        recorded = json.loads(cli("retro", "--action", "Record", "--state-root", t, "--task-path", task, "--proposed-change", "add regression test").stdout.decode("utf-8"))
        index = json.loads((Path(t) / "retro" / "index.json").read_text(encoding="utf-8"))
        assert index["entries"][0]["task_id"] == "20260823-123456-real-task", index
        assert cli("retro", "--action", "Resolve", "--state-root", t, "--id", recorded["id"], "--status", "applied", "--note", "implemented").returncode == 0
        finding = (Path(t) / "retro" / "findings" / f"{recorded['id']}.md").read_text(encoding="utf-8")
        assert "status: applied" in finding and "resolved_at:" in finding and 'resolution_note: "implemented"' in finding, finding
def test_validate_and_profile():
    from agent_workflow.validate_task import ownership_reason
    assert ownership_reason("src/pricing/handler.py")==""
    assert ownership_reason("../escape.py")!=""
    assert ownership_reason("/abs/path.py")!=""

def test_step_matrix():
    from agent_workflow.workflow import manual_plan, suggested_capabilities

    def steps(plan, name):
        return {step["id"] for item in plan["selected"] if item["name"] == name for step in item["steps"]}

    file_fix = {"code_change": True, "change_kind": "fix", "risk_flags": [],
                "impact_scope": "file", "impact_effect": "local_behavior",
                "workflow_request": ["execution_path_review"]}
    assert steps(manual_plan(file_fix), "execution_path_review") == {"EP1"}

    cross_refactor = {"code_change": True, "change_kind": "refactor", "risk_flags": [],
                      "impact_scope": "cross_project", "impact_effect": "shared_behavior",
                      "workflow_request": ["execution_path_review"]}
    assert steps(manual_plan(cross_refactor), "execution_path_review") == {"EP1", "EP2", "EP3", "EP4", "EP5"}

    design_task = {"code_change": True, "change_kind": "refactor", "risk_flags": [],
                   "impact_scope": "module", "impact_effect": "shared_behavior",
                   "workflow_request": ["codebase_design", "reviewer"],
                   "workflow_facts": json.dumps({"improves_testability": True})}
    design_plan = manual_plan(design_task)
    assert steps(design_plan, "codebase_design") == {"CD1", "CD2", "CD3", "CD4"}
    assert design_plan["order"] == ["codebase_design", "reviewer"]

    isolated_design = dict(design_task, change_kind="chore", impact_scope="file",
                           workflow_facts=json.dumps({"changes_module_interface": False,
                                                      "introduces_adapter": False,
                                                      "improves_testability": False}))
    assert steps(manual_plan(isolated_design), "codebase_design") == {"CD1"}

    diagnosis_task = {"code_change": True, "change_kind": "fix", "risk_flags": [],
                      "impact_scope": "module", "impact_effect": "local_behavior",
                      "workflow_request": ["bug_diagnosis", "tdd", "reviewer", "verifier"]}
    diagnosis_plan = manual_plan(diagnosis_task)
    assert steps(diagnosis_plan, "bug_diagnosis") == {"BD1", "BD2", "BD3", "BD4", "BD5"}
    assert steps(diagnosis_plan, "tdd") == {"TD1", "TD2", "TD3", "TD4"}
    assert diagnosis_plan["order"] == ["bug_diagnosis", "tdd", "reviewer", "verifier"]

    fix_candidates = suggested_capabilities(diagnosis_task)
    assert [item["name"] for item in fix_candidates] == ["bug_diagnosis", "tdd"]
    assert all(item["reason"] for item in fix_candidates)

    behavior_refactor = {"code_change": True, "change_kind": "refactor", "risk_flags": ["behavior_change"],
                         "impact_scope": "module", "impact_effect": "shared_behavior",
                         "workflow_request": []}
    assert [item["name"] for item in suggested_capabilities(behavior_refactor)] == ["codebase_design", "tdd"]

    docs_task = {"code_change": False, "task_type": "docs", "risk_flags": [], "workflow_request": []}
    assert suggested_capabilities(docs_task) == []

    # a declared fact keeps a step alive even when it would otherwise be dropped:
    # SC4 only fires on schema_constraint_change == true
    schema_task = {"code_change": True, "change_kind": "chore", "risk_flags": [],
                  "impact_scope": "file", "impact_effect": "schema",
                  "workflow_request": ["schema_compatibility"],
                  "workflow_facts": json.dumps({"schema_constraint_change": True})}
    assert "SC4" in steps(manual_plan(schema_task), "schema_compatibility")
    schema_task_no_fact = dict(schema_task); del schema_task_no_fact["workflow_facts"]
    # an undeclared fact never proves a step false -- SC4 stays in, unproven is not "no"
    assert "SC4" in steps(manual_plan(schema_task_no_fact), "schema_compatibility")

def test_workflow_gate():
    from agent_workflow.workflow import manual_plan

    def write_task(repo, data, body):
        lines = []
        for key, value in data.items():
            if isinstance(value, bool): lines.append(f"{key}: {'true' if value else 'false'}")
            elif isinstance(value, list): lines.append(f"{key}: [{', '.join(map(str, value))}]")
            else: lines.append(f"{key}: {value}")
        path = repo / "task.md"
        path.write_text("---\n" + "\n".join(lines) + "\n---\n\n# Task\n" + body, encoding="utf-8")
        return path

    def run(path, repo):
        result = call(ROOT / "agent_workflow.py", "task-gate", "--task-path", path, "--cwd", repo, "--mode", "Stop", ok=False)
        return json.loads(result.stdout.decode("utf-8", "replace"))["issues"]

    base = {
        "id": "20260820-101010-gate-case", "project_id": "0123456789abcdef",
        "worktree_id": "fedcba9876543210", "status": "in_progress", "code_change": True,
        "risk_flags": [], "task_type": "schema", "change_kind": "chore",
        "impact_scope": "file", "impact_effect": "schema", "impact_confidence": "high",
        "workflow_mode": "main", "workflow_request": ["reviewer", "verifier"],
        "created_at": "2026-08-20T10:10:10+08:00", "updated_at": "2026-08-20T10:10:10+08:00",
    }
    common = ("\n## Goal\nadd a column\n\n## Scope\none migration file\n\n"
              "## Completion criteria\n- [x] column exists\n\n## Validation results\n- pre-review: PASS\n")

    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp)

        plan = manual_plan(base)
        assert plan["roles"] == ["reviewer", "verifier"]

        passing_review = ("\n## Reviewer result\n- result: PASS\n" +
                          "".join(f"- {name}: PASS\n" for name in
                                  ("Architecture consistency", "Code quality and conventions", "Data consistency",
                                   "Security", "Risk and compatibility", "Performance",
                                   "Flow and impact completeness", "Failure modes and observability")) +
                          "\n## Verifier result\n- PASS\n")
        complete = write_task(repo, base, common + passing_review)
        assert run(complete, repo) == []

        incomplete = write_task(repo, base, common)
        issues = run(incomplete, repo)
        assert any("Reviewer result" in issue for issue in issues)
        assert any("Verifier result" in issue for issue in issues)

        # a capability not in workflow_request is not required: adversarial-free task closes
        # cleanly without an Adversarial result section
        assert not any("Adversarial" in issue for issue in issues)

        # an evidence capability in workflow_request demands its steps be written up
        evidence_data = dict(base, workflow_request=["execution_path_review", "reviewer", "verifier"])
        evidence_plan = manual_plan(evidence_data)
        assert "execution_path_review" in {item["name"] for item in evidence_plan["selected"]}
        no_evidence = write_task(repo, evidence_data, common + passing_review)
        evidence_issues = run(no_evidence, repo)
        assert any("evidence line" in issue for issue in evidence_issues)

        # an empty workflow_request (main conversation judged the task isolated) still
        # has to write down that judgment call in Impact surface
        bare_data = dict(base, workflow_request=[])
        bare_plan = manual_plan(bare_data)
        assert bare_plan["selected"] == []
        bare_no_surface = write_task(repo, bare_data, common)
        assert any("Impact surface" in issue for issue in run(bare_no_surface, repo))
        bare_with_surface = write_task(repo, bare_data, common + "\n## Impact surface\nisolated, no consumer\n")
        assert not any("Impact surface" in issue for issue in run(bare_with_surface, repo))

def test_legacy_compat():
    # A task written before workflow_mode: main still gets the same floor it always had:
    # reviewer + verifier, with no separate migration step and no legacy planner.
    def write_task(repo, data, body):
        lines = []
        for key, value in data.items():
            if isinstance(value, bool): lines.append(f"{key}: {'true' if value else 'false'}")
            elif isinstance(value, list): lines.append(f"{key}: [{', '.join(map(str, value))}]")
            else: lines.append(f"{key}: {value}")
        path = repo / "task.md"
        path.write_text("---\n" + "\n".join(lines) + "\n---\n\n# Task\n" + body, encoding="utf-8")
        return path

    base = {
        "id": "20260820-101011-legacy-case", "project_id": "0123456789abcdef",
        "worktree_id": "fedcba9876543210", "status": "in_progress", "code_change": True,
        "risk_flags": [], "change_kind": "fix",
        "created_at": "2026-08-20T10:10:11+08:00", "updated_at": "2026-08-20T10:10:11+08:00",
    }
    common = "\n## Goal\nfix\n\n## Scope\nsource\n\n## Completion criteria\n- [x] done\n\n## Validation results\n- pre-review: PASS\n"
    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp)
        incomplete = write_task(repo, base, common)
        result = call(ROOT / "agent_workflow.py", "task-gate", "--task-path", incomplete, "--cwd", repo, "--mode", "Stop", ok=False)
        issues = json.loads(result.stdout.decode("utf-8", "replace"))["issues"]
        assert any("Reviewer result" in issue for issue in issues)
        assert any("Verifier result" in issue for issue in issues)

def test_parallel_orchestration():
    from agent_workflow.orchestrate import assess_repository, capture_patch, integrate_patches, launch, snapshot, snapshot_matches

    with tempfile.TemporaryDirectory() as temp:
        dispatcher = Path(temp) / "dispatcher.py"
        dispatcher.write_text(
            "import json, sys\n"
            "request = json.load(sys.stdin)\n"
            "print(json.dumps({'accepted': True, 'dispatch_id': request['worker_id'], 'worker_root': request['worktree'], 'parent_task_id': request['parent_task_id']}))\n",
            encoding="utf-8",
        )
        previous = os.environ.get("AGENT_WORKFLOW_CODEX_DISPATCH_COMMAND")
        os.environ["AGENT_WORKFLOW_CODEX_DISPATCH_COMMAND"] = f'"{PY}" "{dispatcher}"'
        try:
            requested_root = Path(temp) / "native-worker"
            reply = launch("Codex", {"parent_task_id": "parent", "worker_id": "alpha", "worktree": str(requested_root)})
            assert reply == {"accepted": True, "dispatch_id": "alpha", "worker_root": str(requested_root.resolve())}
        finally:
            if previous is None:
                os.environ.pop("AGENT_WORKFLOW_CODEX_DISPATCH_COMMAND", None)
            else:
                os.environ["AGENT_WORKFLOW_CODEX_DISPATCH_COMMAND"] = previous

        repo = Path(temp) / "repo"
        subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.email", "test@example.invalid"], check=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.name", "workflow-test"], check=True)
        (repo / "src").mkdir(); (repo / "src" / "base.py").write_text("BASE = 1\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-qm", "base"], check=True)
        base = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], check=True, text=True, stdout=subprocess.PIPE).stdout.strip()
        plan = {"shared_persistent_state": False, "has_order_dependency": False,
                "workers": [{"id": "alpha", "title": "alpha", "goal": "implement alpha", "completion_criteria": ["alpha"], "file_ownership": ["src/alpha.py"]},
                            {"id": "beta", "title": "beta", "goal": "implement beta", "completion_criteria": ["beta"], "file_ownership": ["src/beta.py"]}]}
        assert assess_repository(repo, plan, "Codex")["eligible"]
        (repo / "dirty.py").write_text("dirty\n", encoding="utf-8")
        dirty_snapshot = snapshot(repo)
        assert snapshot_matches(repo, dirty_snapshot)
        assert (repo / "dirty.py").exists()

        worker_root = Path(temp) / "worker"
        subprocess.run(["git", "-C", str(repo), "worktree", "add", "--detach", str(worker_root), dirty_snapshot["base_commit"]], check=True, stdout=subprocess.PIPE)
        (worker_root / "src" / "alpha.py").write_text("ALPHA = 1\n", encoding="utf-8")
        delivery = capture_patch(worker_root, dirty_snapshot["base_commit"], ["src/alpha.py"], Path(temp) / "delivery.patch")
        assert delivery["changed_paths"] == ["src/alpha.py"]
        assert delivery["sha256"]
        assert not (repo / "src" / "alpha.py").exists()

        integration = Path(temp) / "integration"
        combined = integrate_patches(repo, dirty_snapshot["base_commit"], [delivery], integration, Path(temp) / "combined.patch")
        assert combined["status"] == "ready"
        assert (repo / "src" / "alpha.py").exists() is False
        assert subprocess.run(["git", "-C", str(repo), "apply", "--check", str(combined["patch"])], stdout=subprocess.PIPE, stderr=subprocess.PIPE).returncode == 0
        (repo / "dirty.py").write_text("changed after snapshot\n", encoding="utf-8")
        assert not snapshot_matches(repo, dirty_snapshot)

def test_register_native():
    # The host-native path (e.g. Claude Code's Agent tool with isolation: "worktree") creates
    # worker worktrees and runs them itself -- orchestrate.py never calls Init or launch() for
    # these. RegisterNative just needs to pick up already-finished worktrees and feed them
    # through the same Collect -> Integrate -> Apply -> Cleanup lifecycle as subprocess dispatch.
    import argparse
    from agent_workflow.orchestrate import register_native, collect, integrate, apply as orchestrate_apply, cleanup
    from agent_workflow.project_resolver import resolve_project

    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp) / "repo"
        subprocess.run(["git", "init", "-q", "-b", "main", str(repo)], check=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.email", "test@example.invalid"], check=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.name", "workflow-test"], check=True)
        (repo / "src").mkdir(); (repo / "src" / "base.py").write_text("BASE = 1\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-qm", "base"], check=True)
        base = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], check=True, text=True, stdout=subprocess.PIPE).stdout.strip()

        state_root = Path(temp) / "state"
        resolved = resolve_project(str(repo), str(state_root), True, [], "")
        task_dir = Path(resolved["task_root"]) / "coordinator"
        task_dir.mkdir(parents=True)
        (task_dir / "task.md").write_text(
            "---\nid: coordinator\n" f"worktree_id: {resolved['worktree_id']}\n"
            "status: in_progress\nsubtask_role: coordinator\nintegration_status: pending\n---\n\n# Task\n",
            encoding="utf-8")

        worker_a, worker_b = Path(temp) / "worker-a", Path(temp) / "worker-b"
        subprocess.run(["git", "-C", str(repo), "worktree", "add", "--detach", str(worker_a), base], check=True, stdout=subprocess.PIPE)
        subprocess.run(["git", "-C", str(repo), "worktree", "add", "--detach", str(worker_b), base], check=True, stdout=subprocess.PIPE)
        (worker_a / "src" / "alpha.py").write_text("ALPHA = 1\n", encoding="utf-8")
        (worker_b / "src" / "beta.py").write_text("BETA = 1\n", encoding="utf-8")

        workers_path = Path(temp) / "workers.json"
        workers_path.write_text(json.dumps([
            {"id": "alpha", "title": "alpha", "goal": "implement alpha", "completion_criteria": ["alpha"],
             "file_ownership": ["src/alpha.py"], "worktree": str(worker_a), "base_commit": base},
            {"id": "beta", "title": "beta", "goal": "implement beta", "completion_criteria": ["beta"],
             "file_ownership": ["src/beta.py"], "worktree": str(worker_b), "base_commit": base},
        ]), encoding="utf-8")

        def ns(action, **extra):
            defaults = dict(action=action, path=str(repo), state_root=str(state_root), plan_path="", platform="Claude",
                             worker_id="", worker_root="", reason="", local_check=[], workers_path="", base_commit="")
            defaults.update(extra)
            return argparse.Namespace(**defaults)

        register_native(ns("RegisterNative", workers_path=str(workers_path), base_commit=base))
        collect(ns("Collect"))
        integrate(ns("Integrate"))
        orchestrate_apply(ns("Apply"))
        cleanup(ns("Cleanup"))

        assert (repo / "src" / "alpha.py").read_text(encoding="utf-8") == "ALPHA = 1\n"
        assert (repo / "src" / "beta.py").read_text(encoding="utf-8") == "BETA = 1\n"
        record = json.loads((task_dir / "orchestration.json").read_text(encoding="utf-8"))
        assert record["dispatch_mode"] == "native"
        # Collect already removes each worker's worktree once its patch is captured, so by the
        # time Cleanup runs there is nothing left for it to do -- workers stay "applied".
        assert all(worker["status"] == "applied" and worker["worktree_cleaned"] for worker in record["workers"])
        assert not Path(record["workers"][0]["worktree"]).exists()

def test_pre_review(): assert subprocess.run(["git","-C",str(ROOT),"diff","--check"],stdout=subprocess.PIPE,stderr=subprocess.PIPE).returncode==0
def test_orchestrate(): assert cli("orchestrate","--help").returncode==0
def test_runtime(): assert cli("runtime-check","--help").returncode==0
SUITES={"contract":test_contract,"posix_wrapper":test_posix_wrapper,"hot_path_imports":test_hot_path_imports,"hook":test_hooks,"installer":test_installer,"knowledge":test_knowledge,"shared_memory":test_shared_memory,"memory_quota":test_memory_quota_and_pollution,"project_doc":test_project_doc,"project_doc_decision_glossary":test_project_doc_decision_and_glossary,"retro":test_retro,"validate_task":test_validate_and_profile,"step_matrix":test_step_matrix,"workflow_gate":test_workflow_gate,"legacy_compat":test_legacy_compat,"parallel_orchestration":test_parallel_orchestration,"register_native":test_register_native,"pre_review":test_pre_review,"orchestrate":test_orchestrate,"runtime":test_runtime}
