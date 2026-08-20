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
    from agent_workflow.workflow_planner import collect_evidence, decision_projection, plan_workflows

    def names(plan, key): return {item["name"] if isinstance(item, dict) else item for item in plan[key]}
    def steps(plan, name): return {step["id"] for item in plan["selected"] if item["name"] == name for step in item["steps"]}

    schema_task = {
        "code_change": True, "task_type": "schema", "change_kind": "chore",
        "risk_flags": ["schema", "migration"], "impact_scope": "file",
        "impact_effect": "schema", "impact_confidence": "high",
    }
    proven_safe = {"schema_operation": "additive_nullable", "schema_constraint_change": False,
                   "data_transform": False, "has_consumer": False, "public_api_change": False,
                   "destructive_operation": False, "logic_change": False}

    # observed evidence proves there is nothing to check -> no capability at all
    direct = plan_workflows(schema_task, proven_safe)
    assert direct["selected"] == [] and direct["roles"] == [] and direct["final_action"] == "direct"
    assert direct["profile"] == "direct"
    assert names(direct, "suppressed") >= {"schema_compatibility", "migration_safety", "data_impact", "reviewer", "verifier", "adversarial"}

    # the very same claims declared by the agent may not suppress anything
    declared = plan_workflows(dict(schema_task, **proven_safe), {})
    assert {"reviewer", "verifier"}.issubset(set(declared["roles"]))
    assert names(declared, "unknown") >= {"reviewer", "verifier"}
    assert not names(declared, "selected").intersection(names(declared, "suppressed"))

    # an observed consumer escalates a task the agent called harmless
    consumer = plan_workflows(dict(schema_task, impact_effect="none"), dict(proven_safe, has_consumer=True))
    assert "reviewer" in consumer["roles"] and "schema_compatibility" in names(consumer, "selected")

    # free role combinations: verifier alone
    fix_task = {"code_change": True, "task_type": "fix", "change_kind": "fix", "risk_flags": [],
                "impact_scope": "file", "impact_effect": "local_behavior"}
    verifier_only = plan_workflows(fix_task, {"logic_change": False, "has_consumer": False, "public_api_change": True})
    assert verifier_only["roles"] == ["verifier"] and verifier_only["profile"] == "standard"

    # free role combinations: adversarial + verifier without reviewer
    money_task = {"code_change": True, "task_type": "chore", "change_kind": "chore",
                  "risk_flags": ["financial"], "impact_scope": "file", "impact_effect": "data"}
    pair = plan_workflows(money_task, {"logic_change": False, "has_consumer": False, "public_api_change": True,
                                       "data_transform": True, "destructive_operation": False})
    assert pair["roles"] == ["adversarial", "verifier"]
    assert steps(pair, "data_impact") == {"DI1", "DI2", "DI4", "DI5"}

    # inner selection scales with scope and effect
    observed_logic = {"logic_change": True, "has_consumer": True, "public_api_change": True}
    small = plan_workflows({"code_change": True, "task_type": "refactor", "change_kind": "refactor",
                            "risk_flags": [], "impact_scope": "file", "impact_effect": "local_behavior"}, observed_logic)
    big = plan_workflows({"code_change": True, "task_type": "refactor", "change_kind": "refactor",
                          "risk_flags": [], "impact_scope": "cross_project", "impact_effect": "shared_behavior"}, observed_logic)
    assert steps(small, "execution_path_review") == {"EP1", "EP4"}
    assert steps(big, "execution_path_review") == {"EP1", "EP2", "EP3", "EP4", "EP5"}

    # an ordinary local fix must stay exactly as cheap as the legacy standard profile:
    # two roles, no evidence step to write up
    light_fix = plan_workflows({"code_change": True, "task_type": "fix", "change_kind": "fix", "risk_flags": [],
                                "impact_scope": "file", "impact_effect": "local_behavior"}, observed_logic)
    assert light_fix["roles"] == ["reviewer", "verifier"]
    assert sum(len(item["steps"]) for item in light_fix["selected"]) == 0

    # a data-changing migration may never lose the verifier
    migration = plan_workflows({"code_change": True, "task_type": "migration", "change_kind": "chore",
                                "risk_flags": ["migration", "irreversible"], "impact_scope": "module", "impact_effect": "data"},
                               {"schema_operation": "changed", "schema_constraint_change": True, "data_transform": True,
                                "destructive_operation": True, "has_consumer": True, "public_api_change": False, "logic_change": False})
    assert {"adversarial", "verifier"}.issubset(set(migration["roles"]))
    # ordering survives an absent intermediate: verifier follows reviewer without adversarial
    assert big["roles"] == ["reviewer", "verifier"]
    assert big["order"].index("execution_path_review") < big["order"].index("reviewer") < big["order"].index("verifier")

    # workflow_request is a capability floor the planner may not drop
    requested = plan_workflows(dict(schema_task, workflow_request=["verifier", "reviewer"]), proven_safe)
    assert {"reviewer", "verifier"}.issubset(set(requested["roles"]))
    assert not names(requested, "selected").intersection(names(requested, "suppressed"))

    # high risk without evidence still reaches adversarial
    risky = plan_workflows(dict(schema_task, impact_effect="data"), {})
    assert risky["roles"] == ["reviewer", "adversarial", "verifier"]
    assert risky["order"].index("reviewer") < risky["order"].index("verifier")
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
        evidence = collect_evidence(repo, schema_task)
        assert evidence["schema_operation"] == "additive_nullable" and evidence["data_transform"] is False
        assert evidence["logic_change"] is False and evidence["has_consumer"] is False
        # DDL that does not live in a .sql file must not qualify for the additive shortcut
        embedded = repo / "store.go"
        embedded.write_text("package store\n\nconst up = `ALTER TABLE users ADD COLUMN note TEXT`\n", encoding="utf-8")
        mixed = collect_evidence(repo, schema_task)
        assert mixed["schema_operation"] == "unknown" and mixed["logic_change"] is True
        plan = plan_workflows(schema_task, mixed)
        assert "schema_compatibility" in names(plan, "selected")

    assert call(ROOT / "scripts/workflow-plan.py", "--task-json", json.dumps(schema_task),
                "--facts-json", json.dumps(proven_safe)).returncode == 0
    assert decision_projection(direct)["selected"] == []

def test_workflow_gate():
    from agent_workflow.workflow_planner import plan_task

    def record(plan):
        return json.dumps({
            "final_action": plan["final_action"],
            "selected": [{"name": item["name"], "kind": item["kind"], "steps": [step["id"] for step in item["steps"]]}
                         for item in plan["selected"]],
            "suppressed": [item["name"] for item in plan["suppressed"]],
            "unknown": [item["name"] for item in plan["unknown"]],
        }, ensure_ascii=False, separators=(",", ":"))

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
        "risk_flags": ["schema"], "task_type": "schema", "change_kind": "chore",
        "impact_scope": "file", "impact_effect": "schema", "impact_confidence": "high",
        "created_at": "2026-08-20T10:10:10+08:00", "updated_at": "2026-08-20T10:10:10+08:00",
    }
    common = ("\n## Goal\nadd a column\n\n## Scope\none migration file\n\n"
              "## Completion criteria\n- [x] column exists\n\n## Validation results\n- pre-review: PASS\n")

    with tempfile.TemporaryDirectory() as temp:
        repo = Path(temp)
        subprocess.run(["git", "init", "-q", str(repo)], check=True, stdout=subprocess.PIPE)
        subprocess.run(["git", "-C", str(repo), "config", "user.email", "test@example.invalid"], check=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.name", "workflow-test"], check=True)
        (repo / "001_add_note.sql").write_text("CREATE TABLE users (id INT);\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-qm", "base"], check=True)
        (repo / "001_add_note.sql").write_text(
            "CREATE TABLE users (id INT);\nALTER TABLE users ADD COLUMN note VARCHAR(255);\n", encoding="utf-8")

        plan = plan_task(base, cwd=repo)
        assert plan["final_action"] == "direct" and plan["roles"] == []
        data = dict(base, workflow_profile=plan["profile"], workflow_decision=record(plan))

        # proven-safe change closes without any role, but must justify the suppression
        light = write_task(repo, data, common + "\n## Impact surface\nadditive nullable column, no consumer found\n")
        assert run(light, repo) == []

        # the suppression justification is not optional
        no_surface = write_task(repo, data, common)
        assert any("Impact surface" in issue for issue in run(no_surface, repo))

        # a decision record that does not reproduce the planner result is rejected
        tampered = dict(data, workflow_decision=json.dumps(
            {"final_action": "direct", "selected": [], "suppressed": ["reviewer"], "unknown": []},
            separators=(",", ":")))
        assert any("does not match the canonical planner" in issue for issue in run(write_task(repo, tampered, common + "\n## Impact surface\nx\n"), repo))

        # once real code changes, capabilities come back and their step evidence is demanded
        (repo / "store.go").write_text("package store\n\nfunc Note() string { return \"note\" }\n", encoding="utf-8")
        heavy_plan = plan_task(base, cwd=repo)
        assert heavy_plan["roles"] and "reviewer" in heavy_plan["roles"]
        heavy = write_task(repo, dict(base, workflow_profile=heavy_plan["profile"], workflow_decision=record(heavy_plan)),
                           common + "\n## Impact surface\nx\n")
        issues = run(heavy, repo)
        assert any("evidence line" in issue for issue in issues)
        assert any("Reviewer result" in issue for issue in issues)
        selected_roles = set(heavy_plan["roles"])
        for absent in {"reviewer", "adversarial", "verifier"} - selected_roles:
            assert not any(absent.capitalize() + " result" in issue for issue in issues)

def test_symbol_evidence():
    from agent_workflow.workflow_planner import collect_evidence, plan_workflows

    def repo_at(temp, files):
        repo = Path(temp)
        subprocess.run(["git", "init", "-q", str(repo)], check=True, stdout=subprocess.PIPE)
        subprocess.run(["git", "-C", str(repo), "config", "user.email", "test@example.invalid"], check=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.name", "workflow-test"], check=True)
        for name, text in files.items():
            path = repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-qm", "base"], check=True)
        return repo

    isolated = {
        "internal/pricing.go": (
            "package internal\n\n"
            "func calculateBonusRate(level int) float64 {\n\treturn float64(level) * 1.5\n}\n\n"
            "func Describe(level int) float64 {\n\treturn calculateBonusRate(level)\n}\n"),
        "cmd/app.go": "package cmd\n\nfunc Boot() int {\n\treturn 1\n}\n",
    }
    with tempfile.TemporaryDirectory() as temp:
        repo = repo_at(temp, isolated)
        (repo / "internal/pricing.go").write_text(
            "package internal\n\n"
            "func calculateBonusRate(level int) float64 {\n\treturn float64(level) * 2.0\n}\n\n"
            "func Describe(level int) float64 {\n\treturn calculateBonusRate(level)\n}\n", encoding="utf-8")
        evidence = collect_evidence(repo, {"task_type": "fix"})
        # the changed symbol has no call site outside its own file
        assert evidence["symbol_reach"] == "none", evidence
        assert evidence["has_consumer"] is False, evidence
        assert evidence["logic_change"] is True

    shared = {
        "svc/payment.go": (
            "package svc\n\nfunc ProcessPaymentBatch(ids []string) error {\n\treturn nil\n}\n"),
        "api/handler.go": (
            "package api\n\nimport \"x/svc\"\n\n"
            "func Route() error {\n\treturn svc.ProcessPaymentBatch(nil)\n}\n"),
    }
    with tempfile.TemporaryDirectory() as temp:
        repo = repo_at(temp, shared)
        (repo / "svc/payment.go").write_text(
            "package svc\n\nfunc ProcessPaymentBatch(ids []string) error {\n\tif len(ids) == 0 {\n\t\treturn nil\n\t}\n\treturn nil\n}\n",
            encoding="utf-8")
        evidence = collect_evidence(repo, {"task_type": "fix"})
        assert evidence["symbol_reach"] == "multi_module", evidence
        assert evidence["has_consumer"] is True

        # an agent understating the blast radius gets upgraded by the observed call sites
        understated = {"code_change": True, "task_type": "fix", "change_kind": "fix", "risk_flags": [],
                       "impact_scope": "file", "impact_effect": "local_behavior"}
        plan = plan_workflows(understated, evidence)
        names = {item["name"] for item in plan["selected"]}
        assert "execution_path_review" in names, plan["selected"]
        epr = {step["id"] for item in plan["selected"] if item["name"] == "execution_path_review" for step in item["steps"]}
        assert {"EP2", "EP5"}.issubset(epr), epr

        # the same task without observed evidence stays at the declared scope
        bare = plan_workflows(understated, {"logic_change": True})
        assert "execution_path_review" not in {item["name"] for item in bare["selected"]}

def test_dimension_waiver():
    from agent_workflow.task_gate import gate
    from agent_workflow.workflow_planner import plan_task

    DIMENSIONS = ("Architecture consistency", "Code quality and conventions", "Data consistency",
                  "Security", "Risk and compatibility", "Performance",
                  "Flow and impact completeness", "Failure modes and observability")

    def build(temp, body):
        repo = Path(temp)
        subprocess.run(["git", "init", "-q", str(repo)], check=True, stdout=subprocess.PIPE)
        subprocess.run(["git", "-C", str(repo), "config", "user.email", "test@example.invalid"], check=True)
        subprocess.run(["git", "-C", str(repo), "config", "user.name", "workflow-test"], check=True)
        (repo / "internal").mkdir(parents=True, exist_ok=True)
        (repo / "internal/pricing.go").write_text(
            "package internal\n\nfunc calculateBonusRate(level int) float64 {\n\treturn float64(level) * 1.5\n}\n",
            encoding="utf-8")
        subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-qm", "base"], check=True)
        (repo / "internal/pricing.go").write_text(body, encoding="utf-8")
        return repo

    pure = ("package internal\n\nfunc calculateBonusRate(level int) float64 {\n"
            "\tadjusted := float64(level) * 2.0\n\treturn adjusted\n}\n")
    persisted = ("package internal\n\nfunc calculateBonusRate(level int) float64 {\n"
                 "\tadjusted := float64(level) * 2.0\n"
                 "\tdb.Exec(\"UPDATE players SET bonus_rate = ?\", adjusted)\n\treturn adjusted\n}\n")

    task = {"id": "20260820-101010-waiver-case", "project_id": "0123456789abcdef",
            "worktree_id": "fedcba9876543210", "status": "in_progress", "code_change": True,
            "risk_flags": [], "task_type": "fix", "change_kind": "fix", "impact_scope": "file",
            "impact_effect": "local_behavior", "impact_confidence": "high",
            "created_at": "2026-08-20T10:10:10+08:00", "updated_at": "2026-08-20T10:10:10+08:00"}

    def waived_of(plan):
        return {name for item in plan["selected"] if item["name"] == "reviewer"
                for name in item.get("waived_dimensions", [])}

    with tempfile.TemporaryDirectory() as temp:
        repo = build(temp, pure)
        plan = plan_task(task, cwd=repo)
        assert plan["facts"]["shared_state_write"]["value"] is False
        assert waived_of(plan) == {"Architecture consistency"}, plan["selected"]

    with tempfile.TemporaryDirectory() as temp:
        repo = build(temp, persisted)
        plan = plan_task(task, cwd=repo)
        # writing a shared row is coupling no call-site search can see: nothing may be waived
        assert plan["facts"]["shared_state_write"]["value"] is True
        assert waived_of(plan) == set(), plan["selected"]

    def write_and_gate(repo, plan, review_lines):
        decision = json.dumps({
            "final_action": plan["final_action"],
            "selected": [{"name": item["name"], "kind": item["kind"], "steps": [s["id"] for s in item["steps"]],
                          "waived_dimensions": item.get("waived_dimensions", [])} for item in plan["selected"]],
            "suppressed": [item["name"] for item in plan["suppressed"]],
            "unknown": [item["name"] for item in plan["unknown"]]}, separators=(",", ":"))
        frontmatter = dict(task, workflow_profile=plan["profile"], workflow_decision=decision)
        lines = []
        for key, value in frontmatter.items():
            if isinstance(value, bool): lines.append(f"{key}: {'true' if value else 'false'}")
            elif isinstance(value, list): lines.append(f"{key}: [{', '.join(map(str, value))}]")
            else: lines.append(f"{key}: {value}")
        path = repo / "task.md"
        path.write_text("---\n" + "\n".join(lines) + "\n---\n\n# Waiver\n\n## Goal\ntune a rate\n\n"
                        "## Scope\none private helper\n\n## Completion criteria\n- [x] rate updated\n\n"
                        "## Validation results\n- pre-review: PASS\n\n## Impact surface\nno call site outside the file\n\n"
                        "## Reviewer result\n- result: PASS\n" + review_lines +
                        "\n## Verifier result\n- PASS\n", encoding="utf-8")
        return gate(str(path), cwd=str(repo))["issues"]

    with tempfile.TemporaryDirectory() as temp:
        repo = build(temp, pure)
        plan = plan_task(task, cwd=repo)

        passing = "".join(f"- {name}: PASS\n" for name in DIMENSIONS)
        assert write_and_gate(repo, plan, passing) == []

        waived_ok = "".join(f"- {name}: " + ("N/A - 無外部呼叫端\n" if name == "Architecture consistency" else "PASS\n")
                            for name in DIMENSIONS)
        assert write_and_gate(repo, plan, waived_ok) == []

        # a waived N/A still has to say why
        bare = "".join(f"- {name}: " + ("N/A\n" if name == "Architecture consistency" else "PASS\n")
                       for name in DIMENSIONS)
        assert any("Architecture consistency" in issue for issue in write_and_gate(repo, plan, bare))

        # the impact dimension is never waived, whatever the reason given
        impact = "".join(f"- {name}: " + ("N/A - 沒人呼叫\n" if name == "Flow and impact completeness" else "PASS\n")
                         for name in DIMENSIONS)
        assert any("Flow and impact completeness" in issue for issue in write_and_gate(repo, plan, impact))

def test_pre_review(): assert subprocess.run(["git","-C",str(ROOT),"diff","--check"],stdout=subprocess.PIPE,stderr=subprocess.PIPE).returncode==0
def test_orchestrate(): assert call(ROOT/"scripts/orchestrate.py","--help").returncode==0
def test_runtime(): assert call(ROOT/"scripts/runtime-check.py","--help").returncode==0
SUITES={"contract":test_contract,"hook":test_hooks,"installer":test_installer,"knowledge":test_knowledge,"shared_memory":test_shared_memory,"migration":test_migration,"project_doc":test_project_doc,"retro":test_retro,"validate_task":test_validate_and_profile,"workflow_planner":test_workflow_planner,"workflow_gate":test_workflow_gate,"symbol_evidence":test_symbol_evidence,"dimension_waiver":test_dimension_waiver,"pre_review":test_pre_review,"orchestrate":test_orchestrate,"runtime":test_runtime}
