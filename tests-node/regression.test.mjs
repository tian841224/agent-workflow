import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const cli = join(process.cwd(), "dist", "agent-workflow.mjs");
const run = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: "utf8", ...options });
const guard = (kind, payload) => run([kind, "--platform", "Claude"], { input: JSON.stringify(payload) });
const vcs = (repo, args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });

test("a v2 task carrying retired fields and no transition history migrates into a writable v4 task", () => {
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
  assert.equal(migrated.schema_version, 4);
  assert.equal(migrated.change_kind, undefined);
  assert.equal(migrated.complexity_hint, undefined);
  assert.equal(migrated.roles_waived, undefined);
  assert.ok(migrated.lifecycle.transitions.length >= 1);
  const wrote = run(["task-write", "--task-path", join(task, "task.json")], { input: JSON.stringify({ task_type: "fix" }) });
  assert.equal(wrote.status, 0, wrote.stdout);
  const superseded = run(["supersede", "--task", join(task, "task.json")]);
  assert.equal(superseded.status, 0, superseded.stderr);
});

// isReadOnly used to invert a write-name blocklist, so any editor or filesystem tool whose name
// missed /(write|edit|delete|rename)/ was treated as a read wherever it pointed.
const WRITE_TOOLS = ["str_replace", "create_file", "mcp__fs__move_file", "apply_diff", "insert_lines"];
for (const tool of WRITE_TOOLS) {
  test(`skill-guard treats ${tool} as a write when it targets .agents`, () => {
    const result = guard("skill-guard", { tool_name: tool, session_id: "s1", tool_input: { file_path: join(".agents", "skills", "workflow", "SKILL.md") } });
    assert.match(result.stdout, /"permissionDecision":"deny"/);
  });
  test(`task-guard treats ${tool} as a write when it targets task.json`, () => {
    const result = guard("git-guard", { tool_name: tool, session_id: "s1", tool_input: { file_path: join("tasks", "t", "task.json") } });
    assert.match(result.stdout, /task-guard/);
  });
}

test("a read tool pointed at protected content is still allowed", () => {
  for (const tool of ["read", "read_file", "mcp__fs__list_directory"]) {
    const result = guard("skill-guard", { tool_name: tool, session_id: "s1", tool_input: { file_path: join(".agents", "skills", "workflow", "SKILL.md") } });
    assert.doesNotMatch(result.stdout, /permissionDecision":"deny/, tool);
  }
});

test("git global options are consumed before the subcommand, and quoted prose is not an invocation", () => {
  for (const command of ["git --no-pager log --oneline -5", "git --git-dir=.git rev-parse HEAD", `grep -n "git push" README.md`]) {
    const result = guard("git-guard", { tool_name: "bash", session_id: "s1", tool_input: { command } });
    assert.doesNotMatch(result.stdout, /permissionDecision":"deny/, command);
  }
  assert.match(guard("git-guard", { tool_name: "bash", session_id: "s1", tool_input: { command: "git --no-pager push origin main" } }).stdout, /permissionDecision":"deny/);
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

test("the read-only allowlist covers the usual inspection tools but not their writing modes", () => {
  const probe = (command) => guard("skill-guard", { tool_name: "bash", session_id: "s1", tool_input: { command } }).stdout;
  for (const command of ["jq . .agents/x.json", "less .agents/skills/workflow/SKILL.md", "head -20 .agents/skills/workflow/SKILL.md", "certutil -hashfile .agents/skills/workflow/SKILL.md SHA256"]) {
    assert.doesNotMatch(probe(command), /permissionDecision":"deny/, command);
  }
  // awk and sed are general interpreters with write paths no flag check can enumerate (`print > f`,
  // `w`, `s///w`), and certutil is a general certificate tool — only its -hashfile mode is a read.
  for (const command of [
    "sed -n 1,20p .agents/skills/workflow/SKILL.md",
    "sed -i s/a/b/ .agents/skills/workflow/SKILL.md",
    "awk 'NR<5' .agents/skills/workflow/SKILL.md",
    "certutil -decode .agents/in.b64 .agents/skills/workflow/SKILL.md",
    "find .agents -name '*.md' -delete"
  ]) {
    assert.match(probe(command), /permissionDecision":"deny/, command);
  }
});

test("evidence recency is compared as instants, not as strings", () => {
  const root = join(tmpdir(), `agent-workflow-evidence-tz-${process.pid}-${Date.now()}`);
  const task = join(root, "task");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Timezone\n\n## Goal\n\nVerify instant comparison.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const path = join(task, "task.json");
  const base = {
    schema_version: 4, id: "20260101-000000-tz", project_id: "0123456789abcdef", worktree_id: "0123456789abcdef",
    code_change: true, risk_flags: [], created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    state_revision: 1, plan_revision: 1,
    lifecycle: { status: "in_progress", transitions: [{ at: "2026-01-01T00:00:00.000Z", action: "create", from: "new", to: "in_progress", actor: "test" }] },
    waivers: [], workflow_request: ["impact_discovery"], impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high", task_type: "fix"
  };
  writeFileSync(path, JSON.stringify({ ...base, evidence: [] }));
  const hash = JSON.parse(run(["workflow-plan", "--task-path", path]).stdout).plan_hash;
  // "09:00+08:00" is 01:00Z — earlier than the 05:00Z entry, but later as a plain string. The stale
  // (wrong plan_hash) entry is the chronologically later one; if recency were compared as strings
  // the fresh matching entry would wrongly win instead.
  const step = (planHash, at) => ({ kind: "step", id: "impact_discovery.ID1", status: "recorded", at, plan_hash: planHash, intent_hash: "1".repeat(64), summary: "entry" });
  writeFileSync(path, JSON.stringify({ ...base, evidence: [step(hash, "2026-01-01T09:00:00.000+08:00"), step("0".repeat(64), "2026-01-01T05:00:00.000Z")] }));
  const gated = JSON.parse(run(["task-gate", "--task-path", path]).stdout);
  assert.ok(gated.errors.some((error) => error.includes("impact_discovery.ID1")), gated.errors.join("; "));
});

test("a non-classification write leaves plan_revision alone so role evidence survives it", () => {
  const root = join(tmpdir(), `agent-workflow-plan-revision-${process.pid}-${Date.now()}`);
  const task = join(root, "20260101-000000-revision");
  mkdirSync(task, { recursive: true });
  const path = join(task, "task.json");
  assert.equal(run(["task-init", "--task-path", path], { input: JSON.stringify({ task_type: "fix" }) }).status, 0);
  const before = JSON.parse(readFileSync(path, "utf8")).plan_revision;
  assert.equal(run(["task-write", "--task-path", path], { input: JSON.stringify({ workflow_decision: "no capability needed" }) }).status, 0);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).plan_revision, before);
  assert.equal(run(["task-write", "--task-path", path], { input: JSON.stringify({ impact_scope: "module" }) }).status, 0);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).plan_revision, before + 1);
});

test("impact_scope_at_least matches exactly at the threshold", () => {
  const root = join(tmpdir(), `agent-workflow-rank-boundary-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const planFor = (impact_scope) => {
    const path = join(root, `${impact_scope}.json`);
    writeFileSync(path, JSON.stringify({ workflow_request: [], risk_flags: [], task_type: "fix", impact_scope, impact_effect: "local_behavior", impact_confidence: "high" }));
    return JSON.parse(run(["workflow-plan", "--task-path", path]).stdout);
  };
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
  const root = join(tmpdir(), `agent-workflow-task-type-widen-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const path = join(root, "task.json");
  writeFileSync(path, JSON.stringify({
    workflow_request: ["execution_path_review", "codebase_design"],
    risk_flags: [], task_type: "schema", impact_scope: "module", impact_effect: "schema", impact_confidence: "high",
    workflow_facts: { changes_module_interface: false, improves_testability: false }
  }));
  const steps = JSON.parse(run(["workflow-plan", "--task-path", path]).stdout).steps;
  const idsFor = (name) => steps.find((capability) => capability.name === name).steps.map((step) => step.id);
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
