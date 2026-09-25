import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { compile, stepIds } from "./policy-compiler.mjs";
import { sourceModule } from "./source-module.mjs";

const cli = join(process.cwd(), "dist", "agent-workflow.mjs");
const run = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: "utf8", ...options });
const guard = (kind, payload) => run([kind, "--platform", "Claude"], { input: JSON.stringify(payload) });
const vcs = (repo, args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });

test("a v2 task carrying retired fields and no transition history migrates into a writable v5 task", () => {
  const root = join(tmpdir(), `agent-workflow-migrate-roundtrip-${process.pid}-${Date.now()}`);
  const task = join(root, "projects", "p", "tasks", "20260101-000000-legacy");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Legacy\n\n## Goal\n\nMigrated task.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  writeFileSync(join(task, "task.json"), JSON.stringify({
    schema_version: 2,
    id: "20260101-000000-legacy",
    change_kind: "fix",
    complexity_hint: ["multi_path"],
    roles_waived: "someone said so",
    code_change: true,
    risk_flags: [],
    lifecycle: { status: "frozen", frozen_at: "2026-01-01T00:00:00.000Z" },
    evidence: [{ kind: "role", id: "role.reviewer", verified: true }],
    waivers: [{ at: "2026-01-01T00:00:00.000Z", actor: "cli" }]
  }));
  assert.equal(run(["migrate-state", "--state-root", root]).status, 0);
  const migrated = JSON.parse(readFileSync(join(task, "task.json"), "utf8"));
  assert.equal(migrated.schema_version, 6);
  assert.equal(migrated.change_kind, undefined);
  assert.equal(migrated.complexity_hint, undefined);
  assert.equal(migrated.roles_waived, undefined);
  assert.ok(migrated.lifecycle.transitions.length >= 1);
  const wrote = run(["task-write", "--task-path", join(task, "task.json")], { input: JSON.stringify({ task_type: "fix" }) });
  assert.equal(wrote.status, 0, wrote.stdout);
  const superseded = run(["supersede", "--task", join(task, "task.json")]);
  assert.equal(superseded.status, 0, superseded.stderr);
});

test("git global options are consumed before the subcommand, and quoted prose is not an invocation", () => {
  // An ordinary mutation with a global option consumed ahead of its subcommand is deferred to
  // the platform's own approval flow, same as one without a global option.
  for (const command of ["git --no-pager log --oneline -5", "git --git-dir=.git rev-parse HEAD", `grep -n "git push" README.md`, "git --no-pager push origin main"]) {
    const result = guard("git-guard", { tool_name: "bash", session_id: "s1", tool_input: { command } });
    assert.doesNotMatch(result.stdout, /permissionDecision":"deny/, command);
  }
});

// -c can point git at an arbitrary alias, hook or pager; --exec-path relocates the helper binaries;
// --namespace re-points ref resolution. None can be stripped and ignored, so the subcommand behind
// them is never reached. --git-dir/--work-tree stay parseable but may not leave the project.
test("git options that alter execution are denied outright, and a repository location outside the project is too", () => {
  for (const command of [
    "git -c core.pager=cat status",
    "git -c include.path=/tmp/evil status",
    "git --exec-path=/tmp/fake status",
    "git --namespace=other log",
    "git --git-dir=/tmp/elsewhere/.git status",
    "git --work-tree /tmp/elsewhere status"
  ]) {
    assert.match(guard("git-guard", { tool_name: "bash", session_id: "s1", tool_input: { command } }).stdout, /permissionDecision":"deny/, command);
  }
});

test("evidence recency is compared as instants, not as strings", async () => {
  const { latestEvidence } = await sourceModule(join("src", "lifecycle", "evidence.ts"));
  // "09:00+08:00" is 01:00Z — earlier than the 05:00Z entry, but later as a plain string. If recency
  // were compared as strings the older passing run would wrongly mask the later failing one.
  const run = (at, exit_code) => ({ kind: "step", id: "acceptance.AC1", status: "recorded", evidence_kind: "execution", trust_level: "runtime", at, exit_code });
  const latest = latestEvidence([run("2026-01-01T09:00:00.000+08:00", 0), run("2026-01-01T05:00:00.000Z", 1)], "acceptance.AC1");
  assert.equal(latest.exit_code, 1);
});

test("a non-classification write leaves plan_revision alone so role evidence survives it", () => {
  const root = join(tmpdir(), `agent-workflow-plan-revision-${process.pid}-${Date.now()}`);
  const task = join(root, "20260101-000000-revision");
  mkdirSync(task, { recursive: true });
  const path = join(task, "task.json");
  assert.equal(run(["task-init", "--task-path", path], { input: JSON.stringify({ task_type: "fix", managed_change: true, code_change: false, impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high" }) }).status, 0);
  const before = JSON.parse(readFileSync(path, "utf8")).plan_revision;
  assert.equal(run(["task-write", "--task-path", path], { input: JSON.stringify({ workflow_decision: "no capability needed" }) }).status, 0);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).plan_revision, before);
  // plan_revision follows plan_hash, which moves only when the gate items do: multi_module pulls in the Reviewer.
  assert.equal(run(["task-write", "--task-path", path], { input: JSON.stringify({ impact_scope: "multi_module" }) }).status, 0);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).plan_revision, before + 1);
});

test("impact_scope_at_least matches exactly at the threshold", () => {
  // code_change: false isolates the scope threshold from the rule that every code change gets a Reviewer.
  const planFor = (impact_scope) => compile({ managed_change: true, code_change: false, workflow_request: [], risk_flags: [], task_type: "fix", impact_scope, impact_effect: "local_behavior", impact_confidence: "high" });
  assert.ok(planFor("multi_module").required.includes("reviewer"), "at the threshold");
  assert.equal(planFor("module").required.includes("reviewer"), false, "one rank below");
});

test("a waiver naming a requirement the plan does not have is refused", () => {
  const root = join(tmpdir(), `agent-workflow-waive-unknown-${process.pid}-${Date.now()}`);
  const task = join(root, "task");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Waiver\n\n## Goal\n\nVerify waiver ids are checked.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const path = join(task, "task.json");
  writeFileSync(path, JSON.stringify({
    schema_version: 3, id: "20260101-000000-waive", project_id: "0123456789abcdef", worktree_id: "0123456789abcdef",
    code_change: true, risk_flags: [], created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    state_revision: 1, plan_revision: 1,
    lifecycle: { status: "in_progress", transitions: [{ at: "2026-01-01T00:00:00.000Z", action: "create", from: "new", to: "in_progress", actor: "test" }] },
    evidence: [], waivers: [], workflow_request: ["reviewer"], impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high", task_type: "fix"
  }));
  const result = run(["waive", "--task", path, "--confirmed-by-user", "ok", "--requirement-id", "role.reviwer"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a required evidence id/);
});

test("contract-lint sees commands inside fenced blocks and honours a rule-scoped allow marker", () => {
  const root = join(tmpdir(), `agent-workflow-lint-fence-${process.pid}-${Date.now()}`);
  mkdirSync(join(root, "schemas"), { recursive: true });
  mkdirSync(join(root, "templates"), { recursive: true });
  mkdirSync(join(root, ".agents", "skills", "workflow"), { recursive: true });
  for (const schema of ["workflow-policy.json", "task.schema.json"]) writeFileSync(join(root, "schemas", schema), readFileSync(join(process.cwd(), "schemas", schema)));
  writeFileSync(join(root, ".agents", "skills", "workflow", "SKILL.md"), readFileSync(join(process.cwd(), ".agents", "skills", "workflow", "SKILL.md")));
  writeFileSync(join(root, "templates", "task.md"), [
    "```text",
    "agent-workflow frobnicate --now",
    "node dist/agent-workflow.mjs quuxify",
    "```",
    "change_kind stays here on purpose <!-- contract-lint:allow=retired-name -->",
    "complexity_hint is not excused here <!-- contract-lint:allow=unknown-command -->"
  ].join("\n"));
  const findings = JSON.parse(run(["contract-lint", "--root", root]).stdout).findings;
  const details = findings.map((finding) => finding.detail).join(" | ");
  assert.ok(details.includes("frobnicate"), details);
  assert.ok(details.includes("quuxify"), details);
  assert.equal(findings.filter((finding) => finding.line === 5).length, 0, details);
  assert.ok(findings.some((finding) => finding.line === 6 && finding.rule === "retired-name"), details);
});

test("the documented learn invocation round-trips into memory-context", () => {
  const root = join(tmpdir(), `agent-workflow-learn-roundtrip-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  vcs(repo, ["init", "-q"]);
  vcs(repo, ["config", "user.email", "t@e.com"]);
  vcs(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), "x");
  vcs(repo, ["add", "file.txt"]);
  vcs(repo, ["commit", "-q", "-m", "init"]);
  const state = join(root, "state");
  // Exactly the command line .agents/skills/learn/SKILL.md documents: no --status, no --project-id.
  const captured = run(["learn", "--action", "Capture", "--cwd", repo, "--scope", "Project", "--kind", "decision", "--topic", "round-trip", "--content", "ROUNDTRIP_DISTINCTIVE_TEXT", "--source-event", "user-correction", "--state-root", state]);
  assert.equal(captured.status, 0, captured.stderr);
  // Capture only ever creates needs_verification; knowledge-verify is the sole path to verified.
  const confirmed = run(["knowledge-verify", "--cwd", repo, "--state-root", state, "--id", JSON.parse(captured.stdout).id, "--source-path", join(repo, "file.txt")]);
  assert.equal(confirmed.status, 0, confirmed.stderr);
  assert.match(run(["memory-context", "--platform", "Claude", "--state-root", state, "--cwd", repo]).stdout, /ROUNDTRIP_DISTINCTIVE_TEXT/);
});

test("concurrent task-write processes each land exactly one revision through the lock", async () => {
  const root = join(tmpdir(), `agent-workflow-concurrent-${process.pid}-${Date.now()}`);
  const task = join(root, "20260101-000000-concurrent");
  mkdirSync(task, { recursive: true });
  const path = join(task, "task.json");
  assert.equal(run(["task-init", "--task-path", path], { input: JSON.stringify({ task_type: "fix" }) }).status, 0);
  const write = (value) => new Promise((resolveWriter) => {
    const child = spawn(process.execPath, [cli, "task-write", "--task-path", path], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (code) => resolveWriter({ code, stdout }));
    child.stdin.end(JSON.stringify({ workflow_decision: `decision-${value}` }));
  });
  const writers = await Promise.all(["a", "b", "c", "d"].map(write));
  for (const writer of writers) assert.equal(writer.code, 0, writer.stdout);
  const state = JSON.parse(readFileSync(path, "utf8"));
  // A lost update would leave a revision below 5; a double-count would push it above.
  assert.equal(state.state_revision, 5, "one revision per write plus the initial state");
  assert.match(String(state.workflow_decision), /^decision-[abcd]$/);
});

test("a schema task keeps the error-path and design steps the old change_kind collapse would have dropped", () => {
  const plan = compile({
    workflow_request: ["execution_path_review", "codebase_design"],
    risk_flags: [], task_type: "schema", impact_scope: "module", impact_effect: "schema", impact_confidence: "high",
    workflow_facts: { changes_module_interface: false, improves_testability: false }
  });
  const idsFor = (name) => stepIds(plan, name);
  assert.ok(idsFor("execution_path_review").includes("EP4"), idsFor("execution_path_review").join(","));
  assert.ok(idsFor("codebase_design").includes("CD2"), idsFor("codebase_design").join(","));
  assert.ok(idsFor("codebase_design").includes("CD4"), idsFor("codebase_design").join(","));
});

// risk-flags.md used to tell agents to remove a mis-set flag by editing task.json directly, which
// task-write and the hook both reject; the only downgrade path is an explicit reclassify.
test("risk-flags.md routes flag removal through reclassify instead of a direct task edit", () => {
  const doc = readFileSync(join(process.cwd(), ".agents", "skills", "workflow", "risk-flags.md"), "utf8");
  assert.match(doc, /reclassify --confirmed-by-user/);
  assert.doesNotMatch(doc, /編輯[^。；]{0,20}task[^。；]{0,20}(?:拿掉|移除)/);
});

test("impact_confidence stays a task-write field in the docs and in the reclassify comment", () => {
  const selection = readFileSync(join(process.cwd(), ".agents", "skills", "workflow", "capability-selection.md"), "utf8");
  const selectionClauses = selection.split("。").filter((part) => part.includes("`impact_confidence`"));
  assert.ok(selectionClauses.some((part) => part.includes("`task-write`")), "capability-selection.md no longer offers task-write for impact_confidence");
  assert.ok(!selectionClauses.some((part) => part.includes("reclassify")), "capability-selection.md drags reclassify into impact_confidence");

  // The clause is the doc's whole statement about impact_confidence: it must offer task-write and
  // must not drag in reclassify's user-confirmation requirement.
  const doc = readFileSync(join(process.cwd(), "docs", "architecture.md"), "utf8");
  const clause = doc.split("；").find((part) => part.includes("`impact_confidence`"));
  assert.ok(clause, "architecture.md no longer states anything about impact_confidence");
  assert.match(clause, /`task-write`/);
  assert.doesNotMatch(clause, /--confirmed-by-user/);

  const source = readFileSync(join(process.cwd(), "src", "lifecycle", "transitions.ts"), "utf8");
  assert.doesNotMatch(source, /lower impact_confidence/);
});

// item 21: retro is retired; a regression finding is now one more `cause` value in review-cause,
// not a second persistent escalation store.
test("retro is no longer a recognized CLI command", () => {
  const result = run(["retro"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown command: retro/);
});

test("review-cause records a regression at round 1 with a required miss_category, validating against the schema", () => {
  const root = join(tmpdir(), `agent-workflow-review-cause-regression-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const task = join(root, "20260101-000000-regression-cause"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.json"), JSON.stringify({ id: "20260101-000000-regression-cause" }));

  const missing = run(["review-cause", "--action", "Record", "--cause", "regression", "--round", "1", "--evidence", "missed a caller", "--task-path", task, "--state-root", state]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--miss-category/);

  const recorded = run(["review-cause", "--action", "Record", "--cause", "regression", "--round", "1", "--evidence", "missed a caller", "--miss-category", "execution_path", "--proposed-change", "widen the impact map search", "--task-path", task, "--state-root", state]);
  assert.equal(recorded.status, 0, recorded.stderr);
  const body = JSON.parse(recorded.stdout);
  assert.equal(body.cause, "regression");
  assert.equal(body.remedy_kind, "framework_change");

  const listed = JSON.parse(run(["review-cause", "--action", "List", "--state-root", state, "--cause", "regression"]).stdout);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].miss_category, "execution_path");
  assert.equal(listed[0].proposed_change, "widen the impact map search");

  const { Ajv2020 } = createRequire(import.meta.url)("ajv/dist/2020.js");
  const addFormats = createRequire(import.meta.url)("ajv-formats");
  const ajv = new Ajv2020({ allErrors: true, strict: false }); addFormats(ajv);
  const schema = JSON.parse(readFileSync(join(process.cwd(), "schemas", "review-cause.schema.json"), "utf8"));
  const validate = ajv.compile(schema);
  assert.ok(validate(listed[0]), JSON.stringify(validate.errors));
});

test("a non-regression cause still requires round >= 2", () => {
  const root = join(tmpdir(), `agent-workflow-review-cause-round-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const task = join(root, "20260101-000000-round-cause"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.json"), JSON.stringify({ id: "20260101-000000-round-cause" }));
  const tooEarly = run(["review-cause", "--action", "Record", "--cause", "doc_gap", "--round", "1", "--evidence", "no doc covers this path", "--task-path", task, "--state-root", state]);
  assert.notEqual(tooEarly.status, 0);
  const ok = run(["review-cause", "--action", "Record", "--cause", "doc_gap", "--round", "2", "--evidence", "no doc covers this path", "--task-path", task, "--state-root", state]);
  assert.equal(ok.status, 0, ok.stderr);
});
