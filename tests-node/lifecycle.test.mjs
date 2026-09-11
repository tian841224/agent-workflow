import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

// task.schema.json requires a fully-populated v3 shape (project_id/worktree_id as 16-hex ids,
// id matching the task-id pattern, no unknown top-level keys) before task-gate will validate it.
function validTask(overrides = {}) {
  return {
    schema_version: 5,
    id: "20260101-000000-gate-test",
    project_id: "0123456789abcdef",
    worktree_id: "0123456789abcdef",
    code_change: true,
    managed_change: true,
    risk_flags: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    state_revision: 1,
    plan_revision: 1,
    lifecycle: { status: "in_progress", transitions: [{ at: new Date().toISOString(), action: "create", from: "new", to: "in_progress", actor: "test" }] },
    evidence: [],
    waivers: [],
    ...overrides
  };
}

test("task-gate recomputes required evidence at gate time and a matching waiver satisfies one requirement", () => {
  const root = join(tmpdir(), `agent-workflow-gate-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Gate test\n\n## Goal\n\nVerify runtime-compiled required evidence.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const write = (state) => writeFileSync(join(task, "task.json"), JSON.stringify(state));
  write(validTask({ workflow_request: ["reviewer"], impact_scope: "file" }));
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
  const gated = JSON.parse(run(["task-gate", "--task-path", join(task, "task.json")]).stdout);
  assert.equal(gated.valid, false);
  assert.ok(gated.errors.some((error) => error.includes("role.reviewer")));
  const waived = run(["waive", "--task", join(task, "task.json"), "--confirmed-by-user", "user said skip reviewer", "--requirement-id", "role.reviewer"]);
  assert.equal(waived.status, 0, waived.stderr);
  const regated = JSON.parse(run(["task-gate", "--task-path", join(task, "task.json")]).stdout);
  assert.ok(!regated.errors.some((error) => error.includes("role.reviewer")));
});

test("task-gate is a pure read: it never writes to task.json", () => {
  const root = join(tmpdir(), `agent-workflow-gate-pure-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Gate purity\n\n## Goal\n\nVerify task-gate never mutates task.json.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const path = join(task, "task.json");
  writeFileSync(path, JSON.stringify(validTask()));
  const before = readFileSync(path);
  const mtimeBefore = statSync(path).mtimeMs;
  const result = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "task-gate", "--task-path", path], { cwd: process.cwd(), encoding: "utf8" });
  assert.ok(typeof JSON.parse(result.stdout).valid === "boolean", result.stderr);
  const after = readFileSync(path);
  assert.ok(before.equals(after));
  assert.equal(statSync(path).mtimeMs, mtimeBefore);
});

test("a waiver recorded against one plan_hash does not satisfy the same requirement_id after the hash shifts", () => {
  const root = join(tmpdir(), `agent-workflow-gate-stale-waiver-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Stale waiver\n\n## Goal\n\nVerify a waiver does not survive a plan_hash shift.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const path = join(task, "task.json");
  const write = (state) => writeFileSync(path, JSON.stringify(state));
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
  write(validTask({ workflow_request: ["reviewer"], impact_scope: "file" }));
  const waived = run(["waive", "--task", path, "--confirmed-by-user", "user said skip reviewer", "--requirement-id", "role.reviewer"]);
  assert.equal(waived.status, 0, waived.stderr);
  const satisfied = JSON.parse(run(["task-gate", "--task-path", path]).stdout);
  assert.ok(!satisfied.errors.some((error) => error.includes("role.reviewer")));
  // impact_scope 改變 plan_hash（見 compileWorkflowPlan），舊 waiver 不應再滿足同一個 requirement_id
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.impact_scope = "module";
  write(state);
  const regated = JSON.parse(run(["task-gate", "--task-path", path]).stdout);
  assert.ok(regated.errors.some((error) => error.includes("role.reviewer")));
});

test("task-init creates a schema-valid task.json and refuses to overwrite an existing one", () => {
  const root = join(tmpdir(), `agent-workflow-task-init-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo"); mkdirSync(repo, { recursive: true });
  const vcs = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  vcs(["init", "-q"]); vcs(["config", "user.email", "t@e.com"]); vcs(["config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), "one"); vcs(["add", "."]); vcs(["commit", "-q", "-m", "init"]);
  const task = join(root, "20260101-000000-init-test"); mkdirSync(task, { recursive: true });
  const path = join(task, "task.json");
  const run = (args, input) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", input });
  const created = run(["task-init", "--task-path", path, "--repo-root", repo], JSON.stringify({ code_change: true, task_type: "fix" }));
  assert.equal(created.status, 0, created.stderr);
  const state = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(state.schema_version, 5);
  assert.equal(state.code_change, true);
  assert.equal(state.lifecycle.status, "in_progress");
  assert.equal(state.base_commit, vcs(["rev-parse", "HEAD"]).stdout.trim());
  const again = run(["task-init", "--task-path", path], "{}");
  assert.notEqual(again.status, 0);
  assert.match(JSON.parse(again.stdout).errors[0], /already exists/);
});

test("task-init refuses a dirty worktree for a code task unless --adopt-current-diff is passed", () => {
  const root = join(tmpdir(), `agent-workflow-task-init-dirty-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo"); mkdirSync(repo, { recursive: true });
  const vcs = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  vcs(["init", "-q"]); vcs(["config", "user.email", "t@e.com"]); vcs(["config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), "one"); vcs(["add", "."]); vcs(["commit", "-q", "-m", "init"]);
  writeFileSync(join(repo, "file.txt"), "two"); // uncommitted change
  const task1 = join(root, "20260101-000000-dirty-1"); mkdirSync(task1, { recursive: true });
  const run = (args, input) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", input });
  const refused = run(["task-init", "--task-path", join(task1, "task.json"), "--repo-root", repo], JSON.stringify({ code_change: true, task_type: "fix" }));
  assert.notEqual(refused.status, 0);
  assert.match(JSON.parse(refused.stdout).errors[0], /uncommitted changes/);
  const task2 = join(root, "20260101-000000-dirty-2"); mkdirSync(task2, { recursive: true });
  const adopted = run(["task-init", "--task-path", join(task2, "task.json"), "--repo-root", repo, "--adopt-current-diff"], JSON.stringify({ code_change: true, task_type: "fix" }));
  assert.equal(adopted.status, 0, adopted.stderr);
  const state = JSON.parse(readFileSync(join(task2, "task.json"), "utf8"));
  assert.equal(state.base_commit, vcs(["rev-parse", "HEAD"]).stdout.trim());
});

test("task-init refuses a second active code task in the same worktree", () => {
  const root = join(tmpdir(), `agent-workflow-task-init-lease-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo"); mkdirSync(repo, { recursive: true });
  const vcs = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  vcs(["init", "-q"]); vcs(["config", "user.email", "t@e.com"]); vcs(["config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), "one"); vcs(["add", "."]); vcs(["commit", "-q", "-m", "init"]);
  const state = join(root, "state");
  const run = (args, input) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", input });
  const task1 = join(root, "20260101-000000-lease-1"); mkdirSync(task1, { recursive: true });
  const first = run(["task-init", "--task-path", join(task1, "task.json"), "--repo-root", repo, "--state-root", state], JSON.stringify({ code_change: true, task_type: "fix" }));
  assert.equal(first.status, 0, first.stderr);
  const task2 = join(root, "20260101-000000-lease-2"); mkdirSync(task2, { recursive: true });
  const second = run(["task-init", "--task-path", join(task2, "task.json"), "--repo-root", repo, "--state-root", state], JSON.stringify({ code_change: true, task_type: "fix" }));
  assert.notEqual(second.status, 0);
  assert.match(JSON.parse(second.stdout).errors[0], /active code task/);
  // pause/block still hold the lease (a paused task can resume); supersede does not, so the lease
  // self-heals the moment the first task leaves in_progress/paused/blocked.
  assert.equal(run(["supersede", "--task", join(task1, "task.json")]).status, 0);
  const third = run(["task-init", "--task-path", join(task2, "task.json"), "--repo-root", repo, "--state-root", state], JSON.stringify({ code_change: true, task_type: "fix" }));
  assert.equal(third.status, 0, third.stderr);
});

// "Cannot determine lease state" must never be read as "no conflict": a corrupt lease/candidate, a
// lease bound to the wrong worktree, a task_id mismatch, or an unrecognized lifecycle.status must
// all block a new code task rather than silently letting it activate.
test("worktree lease fails closed on corruption/mismatch, and only reclaims a provably stale lease", () => {
  const root = join(tmpdir(), `agent-workflow-lease-fail-closed-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo"); mkdirSync(repo, { recursive: true });
  const vcs = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  vcs(["init", "-q"]); vcs(["config", "user.email", "t@e.com"]); vcs(["config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), "one"); vcs(["add", "."]); vcs(["commit", "-q", "-m", "init"]);
  const state = join(root, "state");
  const run = (args, input) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", input });
  const newTask = () => { const t = join(root, `20260101-000000-lease-${Math.random().toString(36).slice(2)}`); mkdirSync(t, { recursive: true }); return t; };
  // project-resolver doesn't expose worktree_id, so derive the real lease path from a genuine
  // activation instead of recomputing the hash ourselves.
  const seed = newTask();
  const seeded = run(["task-init", "--task-path", join(seed, "task.json"), "--repo-root", repo, "--state-root", state], JSON.stringify({ code_change: true, task_type: "fix" }));
  assert.equal(seeded.status, 0, seeded.stdout);
  const worktreeId = JSON.parse(readFileSync(join(seed, "task.json"), "utf8")).worktree_id;
  const leasePath = join(state, "worktree-leases", `${worktreeId}.json`);
  assert.equal(run(["supersede", "--task", join(seed, "task.json")]).status, 0);
  const attemptDenied = (pattern) => {
    const t = newTask();
    const result = run(["task-init", "--task-path", join(t, "task.json"), "--repo-root", repo, "--state-root", state], JSON.stringify({ code_change: true, task_type: "fix" }));
    assert.notEqual(result.status, 0, JSON.stringify(result.stdout));
    assert.match(JSON.parse(result.stdout).errors[0], pattern);
  };
  // Corrupt lease JSON.
  mkdirSync(join(state, "worktree-leases"), { recursive: true });
  writeFileSync(leasePath, "{not json");
  attemptDenied(/lease is corrupt/);
  // Lease bound to a different worktree_id than its own filename implies.
  const candidateTask = newTask();
  writeFileSync(leasePath, JSON.stringify({ worktree_id: "0".repeat(16), task_id: "20260101-000000-elsewhere", task_path: join(candidateTask, "task.json"), acquired_at: new Date().toISOString() }));
  attemptDenied(/bound to worktree_id/);
  // Lease points at a task.json that does not exist -> reclaimable, not a conflict.
  writeFileSync(leasePath, JSON.stringify({ worktree_id: worktreeId, task_id: "20260101-000000-gone", task_path: join(root, "nope", "task.json"), acquired_at: new Date().toISOString() }));
  {
    const t = newTask();
    const result = run(["task-init", "--task-path", join(t, "task.json"), "--repo-root", repo, "--state-root", state], JSON.stringify({ code_change: true, task_type: "fix" }));
    assert.equal(result.status, 0, JSON.stringify(result.stdout));
    assert.equal(run(["supersede", "--task", join(t, "task.json")]).status, 0);
  }
  // Lease's task_path exists but is corrupt JSON.
  const corruptCandidate = newTask();
  writeFileSync(join(corruptCandidate, "task.json"), "{not json");
  writeFileSync(leasePath, JSON.stringify({ worktree_id: worktreeId, task_id: "20260101-000000-corrupt", task_path: join(corruptCandidate, "task.json"), acquired_at: new Date().toISOString() }));
  attemptDenied(/task referenced by worktree lease is corrupt/);
  // Lease's task_id does not match the id actually recorded in the candidate task.json.
  const mismatchCandidate = newTask();
  writeFileSync(join(mismatchCandidate, "task.json"), JSON.stringify(validTask({ id: "20260101-000000-actual-id", lifecycle: { status: "in_progress", transitions: [] } })));
  writeFileSync(leasePath, JSON.stringify({ worktree_id: worktreeId, task_id: "20260101-000000-claimed-id", task_path: join(mismatchCandidate, "task.json"), acquired_at: new Date().toISOString() }));
  attemptDenied(/task_id.*does not match/);
  // Candidate task.json has a lifecycle.status this runtime does not recognize as active or terminal.
  const weirdStatusCandidate = newTask();
  writeFileSync(join(weirdStatusCandidate, "task.json"), JSON.stringify(validTask({ id: "20260101-000000-weird-status", lifecycle: { status: "quantum", transitions: [] } })));
  writeFileSync(leasePath, JSON.stringify({ worktree_id: worktreeId, task_id: "20260101-000000-weird-status", task_path: join(weirdStatusCandidate, "task.json"), acquired_at: new Date().toISOString() }));
  attemptDenied(/neither a recognized active nor terminal state/);
  // Candidate task.json is genuinely closed -> reclaimable.
  const closedCandidate = newTask();
  writeFileSync(join(closedCandidate, "task.json"), JSON.stringify(validTask({ id: "20260101-000000-closed-candidate", lifecycle: { status: "closed", transitions: [] } })));
  writeFileSync(leasePath, JSON.stringify({ worktree_id: worktreeId, task_id: "20260101-000000-closed-candidate", task_path: join(closedCandidate, "task.json"), acquired_at: new Date().toISOString() }));
  {
    const t = newTask();
    const result = run(["task-init", "--task-path", join(t, "task.json"), "--repo-root", repo, "--state-root", state], JSON.stringify({ code_change: true, task_type: "fix" }));
    assert.equal(result.status, 0, JSON.stringify(result.stdout));
  }
});

test("concurrent task-init calls on the same worktree never let two code tasks both acquire the lease", async () => {
  const root = join(tmpdir(), `agent-workflow-lease-race-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo"); mkdirSync(repo, { recursive: true });
  const vcs = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  vcs(["init", "-q"]); vcs(["config", "user.email", "t@e.com"]); vcs(["config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), "one"); vcs(["add", "."]); vcs(["commit", "-q", "-m", "init"]);
  const state = join(root, "state");
  const { spawn } = await import("node:child_process");
  const runAsync = (args, input) => new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd() });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (code) => resolvePromise({ code, stdout }));
    child.stdin.write(input); child.stdin.end();
  });
  // Both tasks race to activate against the same worktree; activeLeaseConflict + writeLease must
  // be atomic across them, or both can pass the conflict check before either lease write lands.
  const attempts = 6;
  const results = await Promise.all(Array.from({ length: attempts }, (_unused, index) => {
    const task = join(root, `20260101-000000-race-${index}`); mkdirSync(task, { recursive: true });
    return runAsync(
      ["task-init", "--task-path", join(task, "task.json"), "--repo-root", repo, "--state-root", state],
      JSON.stringify({ code_change: true, task_type: "fix" })
    ).then((result) => ({ ...result, task }));
  }));
  const succeeded = results.filter((result) => result.code === 0);
  assert.equal(succeeded.length, 1, JSON.stringify(results.map((result) => result.stdout)));
  const activeTasks = results.filter((result) => {
    const path = join(result.task, "task.json");
    if (!existsSync(path)) return false;
    const written = JSON.parse(readFileSync(path, "utf8"));
    return ["in_progress", "paused", "blocked"].includes(written.lifecycle?.status);
  });
  assert.equal(activeTasks.length, 1);
  const lease = JSON.parse(readFileSync(join(state, "worktree-leases", `${JSON.parse(readFileSync(join(activeTasks[0].task, "task.json"), "utf8")).worktree_id}.json`), "utf8"));
  assert.equal(lease.task_path, join(activeTasks[0].task, "task.json"));
});

test("task-init rejects a runtime-managed field and a patch that fails schema", () => {
  const root = join(tmpdir(), `agent-workflow-task-init-invalid-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  const path = join(task, "task.json");
  const run = (input) => JSON.parse(spawnSync(process.execPath, ["dist/agent-workflow.mjs", "task-init", "--task-path", path], { cwd: process.cwd(), encoding: "utf8", input }).stdout);
  const managed = run(JSON.stringify({ state_revision: 99 }));
  assert.equal(managed.valid, false);
  assert.match(managed.errors[0], /runtime-managed/);
  const invalid = run(JSON.stringify({ code_change: "yes" }));
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors[0], /fails schema/);
  // base_commit is the delivery baseline activateCodeTask derives from HEAD; a patch must not be able
  // to plant an arbitrary one and defeat that guarantee.
  const spoofed = run(JSON.stringify({ base_commit: "1".repeat(40) }));
  assert.equal(spoofed.valid, false);
  assert.match(spoofed.errors[0], /runtime-managed/);
});

// task-init switched from a blocklist (CREATE_MANAGED_KEYS) to an allowlist (TASK_INIT_WRITABLE_FIELDS)
// specifically because the blocklist missed these four fields: a caller could otherwise plant a fake
// task id, forge runtime/attested evidence, or forge an intent_approval it never actually obtained.
test("task-init rejects injected id, evidence, intent_approval, and model_profile", () => {
  const root = join(tmpdir(), `agent-workflow-task-init-forge-${process.pid}-${Date.now()}`);
  const run = (input) => {
    const task = join(root, `task-${Math.random().toString(36).slice(2)}`); mkdirSync(task, { recursive: true });
    const path = join(task, "task.json");
    return JSON.parse(spawnSync(process.execPath, ["dist/agent-workflow.mjs", "task-init", "--task-path", path], { cwd: process.cwd(), encoding: "utf8", input }).stdout);
  };
  const forgedId = run(JSON.stringify({ id: "20260101-000000-not-the-real-dir-name" }));
  assert.equal(forgedId.valid, false);
  assert.match(forgedId.errors[0], /not writable via task-init/);
  const forgedEvidence = run(JSON.stringify({ evidence: [{ kind: "step", id: "baseline_validation.BV2", status: "recorded", trust_level: "runtime", evidence_kind: "execution", exit_code: 0 }] }));
  assert.equal(forgedEvidence.valid, false);
  assert.match(forgedEvidence.errors[0], /not writable via task-init/);
  const forgedIntent = run(JSON.stringify({ intent_approval: { intent_hash: "a".repeat(64), confirmed_at: new Date().toISOString(), confirmed_by: "attacker", source: "user" } }));
  assert.equal(forgedIntent.valid, false);
  assert.match(forgedIntent.errors[0], /not writable via task-init/);
  const forgedModelProfile = run(JSON.stringify({ model_profile: "cheap_read" }));
  assert.equal(forgedModelProfile.valid, false);
  assert.match(forgedModelProfile.errors[0], /not writable via task-init/);
});

test("task-init still accepts legitimate worker/classification metadata", () => {
  const root = join(tmpdir(), `agent-workflow-task-init-legit-${process.pid}-${Date.now()}`);
  const task = join(root, "20260101-000000-legit-task"); mkdirSync(task, { recursive: true });
  const path = join(task, "task.json");
  const result = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "task-init", "--task-path", path], {
    cwd: process.cwd(), encoding: "utf8",
    input: JSON.stringify({
      code_change: false, managed_change: true, workflow_mode: "main", task_type: "fix",
      impact_scope: "module", impact_effect: "local_behavior", impact_confidence: "high",
      risk_flags: ["behavior_change"], workflow_facts: {}, workflow_request: ["reviewer"], workflow_decision: "noted"
    })
  });
  assert.equal(result.status, 0, result.stdout);
  const state = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(state.task_type, "fix");
  assert.deepEqual(state.risk_flags, ["behavior_change"]);
  assert.equal(state.evidence.length, 0);
  assert.equal(state.intent_approval, undefined);
});

test("task-init rejects project_docs read and digest writes outside Remember", () => {
  const root = join(tmpdir(), `agent-workflow-task-init-project-docs-boundary-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  const path = join(task, "task.json");
  const result = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "task-init", "--task-path", path], {
    cwd: process.cwd(), encoding: "utf8", input: JSON.stringify({ project_docs: { read: ["docs/architecture.md"], digests: [] } })
  });
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).errors[0], /project_docs\.read\/project_docs\.digests/);
});

test("task-write merges fields through the lock, bumps plan_revision on a classification change, and rejects lifecycle edits", () => {
  const root = join(tmpdir(), `agent-workflow-task-write-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  const path = join(task, "task.json");
  const run = (args, input) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", input });
  writeFileSync(path, JSON.stringify(validTask()));
  const wrote = run(["task-write", "--task-path", path], JSON.stringify({ task_type: "fix", risk_flags: ["data_write"] }));
  assert.equal(wrote.status, 0, wrote.stderr);
  const state = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(state.task_type, "fix");
  assert.deepEqual(state.risk_flags, ["data_write"]);
  assert.equal(state.plan_revision, 2);
  assert.equal(state.state_revision, 2);
  const blocked = run(["task-write", "--task-path", path], JSON.stringify({ lifecycle: { status: "closed" } }));
  assert.notEqual(blocked.status, 0);
  assert.match(JSON.parse(blocked.stdout).errors[0], /not writable via task-write/);
});

test("task-write project_docs updates preserve read/digests and return no compiled plan", () => {
  const root = join(tmpdir(), `agent-workflow-task-write-project-docs-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  const path = join(task, "task.json");
  const digest = "a".repeat(64);
  writeFileSync(path, JSON.stringify(validTask({
    project_docs: { read: ["docs/architecture.md"], updated: ["none - no document change"], digests: [{ path: "docs/architecture.md", content_sha256: digest }] }
  })));
  const result = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "task-write", "--task-path", path], {
    cwd: process.cwd(), encoding: "utf8", input: JSON.stringify({ project_docs: { updated: ["docs/workflow-runtime.md"] } })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)).sort(), ["state_revision", "task", "valid"]);
  const state = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(state.project_docs, {
    read: ["docs/architecture.md"], updated: ["docs/workflow-runtime.md"], digests: [{ path: "docs/architecture.md", content_sha256: digest }]
  });
});

test("task-write rejects direct project_docs read and digest updates", () => {
  const root = join(tmpdir(), `agent-workflow-task-write-project-docs-boundary-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  const path = join(task, "task.json");
  writeFileSync(path, JSON.stringify(validTask()));
  const result = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "task-write", "--task-path", path], {
    cwd: process.cwd(), encoding: "utf8", input: JSON.stringify({ project_docs: { read: ["docs/architecture.md"], digests: [] } })
  });
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).errors[0], /project_docs\.read\/project_docs\.digests/);
});

test("managed_change is part of plan identity: flipping it changes plan_hash and bumps plan_revision", () => {
  const root = join(tmpdir(), `agent-workflow-managed-change-plan-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Managed change\n\n## Goal\n\nVerify managed_change reaches plan_hash.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const path = join(task, "task.json");
  writeFileSync(path, JSON.stringify(validTask({ code_change: false, managed_change: false })));
  const run = (args, input) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", input });
  const before = JSON.parse(readFileSync(path, "utf8"));
  const beforePlan = JSON.parse(run(["workflow-plan", "--task-path", path]).stdout);
  const changed = run(["task-write", "--task-path", path], JSON.stringify({ managed_change: true }));
  assert.equal(changed.status, 0, changed.stderr);
  const after = JSON.parse(readFileSync(path, "utf8"));
  const afterPlan = JSON.parse(run(["workflow-plan", "--task-path", path]).stdout);
  assert.equal(after.managed_change, true);
  assert.equal(after.plan_revision, before.plan_revision + 1);
  assert.notEqual(beforePlan.plan_hash, afterPlan.plan_hash);
});

test("task-write refuses a patch that would make task.json fail schema", () => {
  const root = join(tmpdir(), `agent-workflow-task-write-invalid-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  const path = join(task, "task.json");
  writeFileSync(path, JSON.stringify(validTask()));
  const result = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "task-write", "--task-path", path], { cwd: process.cwd(), encoding: "utf8", input: JSON.stringify({ impact_scope: "not_a_real_scope" }) });
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).errors[0], /fails schema/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).impact_scope, undefined);
});

test("workflow-plan and task-gate compute the same plan_hash for the same task.json", () => {
  const root = join(tmpdir(), `agent-workflow-gate-hash-parity-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Hash parity\n\n## Goal\n\nVerify plan_hash matches across commands.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const path = join(task, "task.json");
  writeFileSync(path, JSON.stringify(validTask({ workflow_request: ["reviewer"], impact_scope: "file" })));
  const run = (args) => JSON.parse(spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" }).stdout);
  const plan = run(["workflow-plan", "--task-path", path]);
  const gated = run(["task-gate", "--task-path", path]);
  assert.equal(plan.plan_hash, gated.compiled.plan_hash);
});

test("concurrent transitions against the same task.json never lose an update (lock contention integrity)", async () => {
  const root = join(tmpdir(), `agent-workflow-lock-contention-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  const path = join(task, "task.json");
  writeFileSync(path, JSON.stringify(validTask()));
  const { spawn } = await import("node:child_process");
  const runAsync = (args) => new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd() });
    child.on("close", (code) => resolvePromise(code));
  });
  const attempts = 8;
  const results = await Promise.all(Array.from({ length: attempts }, () => runAsync(["pause", "--task", path])));
  // 每次呼叫都會經過 allowed-transition 檢查（in_progress -> paused 只成功一次），其餘因狀態不符而失敗，
  // 但 state_revision 必須恰好只被真正成功的那次 mutateTask 呼叫遞增一次，藉此驗證 lock 沒有遺失更新
  const succeeded = results.filter((code) => code === 0).length;
  const state = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(succeeded, 1);
  assert.equal(state.state_revision, 2);
  assert.equal(state.lifecycle.status, "paused");
});

test("task-write activates a code task on false -> true: dirty tree is refused, --adopt-current-diff records base_commit", () => {
  const root = join(tmpdir(), `agent-workflow-task-write-activate-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo"); mkdirSync(repo, { recursive: true });
  const vcs = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  vcs(["init", "-q"]); vcs(["config", "user.email", "t@e.com"]); vcs(["config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), "one"); vcs(["add", "."]); vcs(["commit", "-q", "-m", "init"]);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  const path = join(task, "task.json");
  writeFileSync(path, JSON.stringify(validTask({ code_change: false })));
  const run = (args, input) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", input });
  writeFileSync(join(repo, "file.txt"), "two"); // uncommitted change
  const refused = run(["task-write", "--task-path", path, "--repo-root", repo], JSON.stringify({ code_change: true }));
  assert.notEqual(refused.status, 0);
  assert.match(JSON.parse(refused.stdout).errors[0], /uncommitted changes/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).code_change, false);
  const activated = run(["task-write", "--task-path", path, "--repo-root", repo, "--adopt-current-diff"], JSON.stringify({ code_change: true }));
  assert.equal(activated.status, 0, activated.stderr);
  const state = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(state.code_change, true);
  assert.equal(state.base_commit, vcs(["rev-parse", "HEAD"]).stdout.trim());
});

test("task-write backfills base_commit for a legacy code task created without one", () => {
  const root = join(tmpdir(), `agent-workflow-task-write-backfill-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo"); mkdirSync(repo, { recursive: true });
  const vcs = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  vcs(["init", "-q"]); vcs(["config", "user.email", "t@e.com"]); vcs(["config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), "one"); vcs(["add", "."]); vcs(["commit", "-q", "-m", "init"]);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  const path = join(task, "task.json");
  writeFileSync(path, JSON.stringify(validTask())); // code_change: true, no base_commit — an older-runtime task
  const run = (args, input) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", input });
  writeFileSync(join(repo, "file.txt"), "two"); // uncommitted work in flight, same as this task's real delivery
  const backfilled = run(["task-write", "--task-path", path, "--repo-root", repo, "--adopt-current-diff"], JSON.stringify({ code_change: true }));
  assert.equal(backfilled.status, 0, backfilled.stderr);
  const state = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(state.base_commit, vcs(["rev-parse", "HEAD"]).stdout.trim());
});

test("task-write refuses code_change true -> false", () => {
  const root = join(tmpdir(), `agent-workflow-task-write-no-deactivate-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  const path = join(task, "task.json");
  writeFileSync(path, JSON.stringify(validTask({ base_commit: "0".repeat(40) })));
  const result = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "task-write", "--task-path", path], { cwd: process.cwd(), encoding: "utf8", input: JSON.stringify({ code_change: false }) });
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).errors[0], /cannot transition from true back to false/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).code_change, true);
});

// A downgrade shrinks what the gate can demand, so it must never be an ordinary task-write. Only
// reclassify performs one, and only with an explicit user confirmation and a reason on record.
test("task-write refuses the two protected classification downgrades; reclassify performs them and records why", () => {
  const root = join(tmpdir(), `agent-workflow-reclassify-${process.pid}-${Date.now()}`);
  const run = (args, input) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", input });
  const cases = [
    [{ managed_change: false }, /managed_change cannot transition from true back to false/],
    [{ risk_flags: ["ui"] }, /risk_flags cannot be removed: data_write/]
  ];
  for (const [index, [patch, expected]] of cases.entries()) {
    const task = join(root, `case-${index}`); mkdirSync(task, { recursive: true });
    const path = join(task, "task.json");
    writeFileSync(path, JSON.stringify(validTask({ managed_change: true, risk_flags: ["data_write", "ui"], impact_confidence: "high" })));
    const refused = run(["task-write", "--task-path", path], JSON.stringify(patch));
    assert.notEqual(refused.status, 0, JSON.stringify(patch));
    assert.match(JSON.parse(refused.stdout).errors[0], expected);
    const unconfirmed = run(["reclassify", "--task-path", path, "--reason", "re-assessed"], JSON.stringify(patch));
    assert.notEqual(unconfirmed.status, 0);
    assert.match(JSON.parse(unconfirmed.stdout).errors[0], /--confirmed-by-user/);
    const done = run(["reclassify", "--task-path", path, "--confirmed-by-user", "user re-assessed", "--reason", "scope shrank"], JSON.stringify(patch));
    assert.equal(done.status, 0, done.stdout);
    const state = JSON.parse(readFileSync(path, "utf8"));
    for (const [field, value] of Object.entries(patch)) assert.deepEqual(state[field], value);
    assert.match(state.workflow_decision, /reclassify at=.*actor=cli confirmed_by_user=user re-assessed reason=scope shrank/);
  }
});

// The observed-execution counterpart to evidence-record: the runtime runs the command and writes
// down what it saw, so exit_code and the output digest cannot be asserted by the agent.
test("evidence-run records runtime-trusted execution evidence, and a failing command is not satisfied evidence", () => {
  const root = join(tmpdir(), `agent-workflow-evidence-run-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Run\n\n## Goal\n\nVerify evidence-run.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const path = join(task, "task.json");
  // medium confidence is what draws baseline_validation here: a confident local change requires no
  // capability at all, so BV2 would not be a selected step to record against.
  writeFileSync(path, JSON.stringify(validTask({ managed_change: true, workflow_request: [], impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "medium", task_type: "fix" })));
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
  const record = (...trailing) => run(["evidence-run", "--task-path", path, "--requirement-id", "baseline_validation.BV2", "--summary", "ran the check", "--", ...trailing]);
  assert.equal(record(process.execPath, "-e", "console.log('ok')").status, 0);
  const first = JSON.parse(readFileSync(path, "utf8")).evidence.at(-1);
  assert.equal(first.trust_level, "runtime");
  assert.equal(first.evidence_kind, "execution");
  assert.equal(first.exit_code, 0);
  assert.match(first.output_digest, /^[a-f0-9]{64}$/);
  // BV2 declares runtime_execution, so an evidence-record claim can never satisfy it.
  const attested = run(["evidence-record", "--task-path", path, "--requirement-id", "baseline_validation.BV2", "--summary", "I ran it, honest"]);
  assert.equal(attested.status, 0, attested.stdout);
  const gated = JSON.parse(run(["task-gate", "--task-path", path]).stdout);
  assert.ok(gated.errors.some((error) => /baseline_validation\.BV2/.test(error)), gated.errors.join("; "));
  // A recorded non-zero exit is a failure that was written down, not a pass.
  assert.equal(record(process.execPath, "-e", "process.exit(3)").status, 0);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).evidence.at(-1).exit_code, 3);
  const failed = JSON.parse(run(["task-gate", "--task-path", path]).stdout);
  assert.ok(failed.errors.some((error) => /baseline_validation\.BV2/.test(error)), failed.errors.join("; "));
});

test("one evidence-run can satisfy multiple selected steps in one command", () => {
  const root = join(tmpdir(), `agent-workflow-evidence-run-batch-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Batch\n\n## Goal\n\nVerify batched evidence.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] one command records two steps\n");
  const path = join(task, "task.json");
  writeFileSync(path, JSON.stringify(validTask({ managed_change: true, workflow_request: [], impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "medium", task_type: "fix" })));
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
  const result = run(["evidence-run", "--task-path", path, "--requirement-id", "baseline_validation.BV1", "--requirement-id", "baseline_validation.BV2", "--summary", "one command covers both selected steps", "--", process.execPath, "-e", "console.log('batch')"]);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.ids, ["baseline_validation.BV1", "baseline_validation.BV2"]);
  const state = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(state.state_revision, 2, "a batch should take one state revision");
  assert.deepEqual(state.evidence.map((entry) => entry.id), ["baseline_validation.BV1", "baseline_validation.BV2"]);
  assert.equal(state.evidence[0].output_digest, state.evidence[1].output_digest);
  assert.equal(state.evidence[0].at, state.evidence[1].at);
});

// evidence-run's plan/intent freshness must be checked against the freshest on-disk state inside the
// file lock at write time, not only just before the (potentially slow) command spawns: a task
// reclassified while the command is still running must be rejected once the command finishes, not
// silently accepted because the pre-spawn snapshot still looked fresh at that earlier moment.
test("evidence-run rejects its own write when the task was reclassified while its command was still running", async () => {
  const root = join(tmpdir(), `agent-workflow-evidence-run-freshness-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Freshness\n\n## Goal\n\nVerify evidence-run freshness.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const path = join(task, "task.json");
  // Keep baseline_validation selected before the command starts; the concurrent risk update then
  // changes the plan while the process is running, which is the freshness race under test.
  writeFileSync(path, JSON.stringify(validTask({ managed_change: true, workflow_request: [], impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "medium", task_type: "fix", risk_flags: [] })));
  const run = (args, input) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", input });
  const { spawn } = await import("node:child_process");
  const evidenceRunAsync = () => new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["dist/agent-workflow.mjs", "evidence-run", "--task-path", path, "--requirement-id", "baseline_validation.BV2", "--summary", "ran the check", "--", process.execPath, "-e", "setTimeout(()=>{}, 700)"], { cwd: process.cwd() });
    let stdout = ""; child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.on("close", (code) => resolvePromise({ code, stdout }));
  });
  const before = JSON.parse(readFileSync(path, "utf8"));
  const pending = evidenceRunAsync();
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  // Lands well before the 700ms command finishes: this reclassification changes plan_hash without
  // being a downgrade, so task-write accepts it outright.
  const reclassified = run(["task-write", "--task-path", path], JSON.stringify({ risk_flags: ["operational"] }));
  assert.equal(reclassified.status, 0, reclassified.stdout);
  const afterReclassify = JSON.parse(readFileSync(path, "utf8"));
  assert.notEqual(afterReclassify.state_revision, before.state_revision);
  const result = await pending;
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(JSON.parse(result.stdout).errors[0], /task changed during evidence-run, re-run required/);
  // The rejected write must not have landed: no new evidence entry, state_revision unchanged since
  // the reclassification.
  const final = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(final.evidence.length, 0);
  assert.equal(final.state_revision, afterReclassify.state_revision);
});

test("task-init binds project_id/worktree_id to the real repo, not the task's storage directory", () => {
  const root = join(tmpdir(), `agent-workflow-task-init-identity-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo"); mkdirSync(repo, { recursive: true });
  const vcs = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  vcs(["init", "-q"]); vcs(["config", "user.email", "t@e.com"]); vcs(["config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), "one"); vcs(["add", "."]); vcs(["commit", "-q", "-m", "init"]);
  // The task directory lives entirely outside the repo, as it does in real usage.
  const task = join(root, "state", "20260101-000000-identity-test"); mkdirSync(task, { recursive: true });
  const path = join(task, "task.json");
  const run = (args, input) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", input });
  const resolved = JSON.parse(run(["project-resolver", "--path", repo, "--state-root", join(root, "state")]).stdout);
  const created = run(["task-init", "--task-path", path, "--repo-root", repo], JSON.stringify({ code_change: false }));
  assert.equal(created.status, 0, created.stderr);
  const state = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(state.project_id, resolved.project_id);
});

test("pause and block both resume back to in_progress", () => {
  const root = join(tmpdir(), `agent-workflow-resume-${process.pid}-${Date.now()}`);
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
  for (const [away, back] of [["pause", "resume"], ["block", "resume"]]) {
    const task = join(root, away); mkdirSync(task, { recursive: true });
    const path = join(task, "task.json");
    writeFileSync(path, JSON.stringify(validTask()));
    assert.equal(run([away, "--task", path]).status, 0);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).lifecycle.status, away === "pause" ? "paused" : "blocked");
    assert.equal(run([back, "--task", path]).status, 0);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).lifecycle.status, "in_progress");
  }
});

// Regression for the TOCTOU window: the old downgrade check read `before` outside the file lock, so
// a writer racing a concurrent classification upgrade could see the pre-upgrade value and slip its
// downgrade through once it finally took the lock. The fix re-reads `current` inside the lock
// (mutateJsonState), so every writer's authorization check is against the freshest on-disk state at
// the moment it actually mutates — a sequential-only test cannot distinguish this from the old code,
// since both agree when nothing races. This fires many task-write calls at once from the same
// pre-race state and checks the invariant holds regardless of how the OS schedules them.
test("concurrent task-write cannot let a stale writer undo a classification upgrade (TOCTOU regression)", async () => {
  const root = join(tmpdir(), `agent-workflow-downgrade-race-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const path = join(root, "task.json");
  const { spawn } = await import("node:child_process");
  const runAsync = (input) => new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["dist/agent-workflow.mjs", "task-write", "--task-path", path], { cwd: process.cwd() });
    child.on("close", (code) => resolvePromise(code));
    child.stdin.write(input); child.stdin.end();
  });

  // Case 1: managed_change starts false; one writer flips it to true while many stale writers race
  // to (re)confirm false. Whichever order the OS picks, the true-write must win and stick.
  writeFileSync(path, JSON.stringify(validTask({ managed_change: false, risk_flags: [], impact_confidence: "high" })));
  const managedResults = await Promise.all([
    runAsync(JSON.stringify({ managed_change: true })),
    ...Array.from({ length: 9 }, () => runAsync(JSON.stringify({ managed_change: false })))
  ]);
  assert.equal(managedResults[0], 0);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).managed_change, true);

  // Case 2: risk_flags starts without "security"; one writer adds it while many stale writers race
  // to overwrite risk_flags back to an empty list. The flag must never end up dropped.
  writeFileSync(path, JSON.stringify(validTask({ managed_change: true, risk_flags: [], impact_confidence: "high" })));
  const flagResults = await Promise.all([
    runAsync(JSON.stringify({ risk_flags: ["security"] })),
    ...Array.from({ length: 9 }, () => runAsync(JSON.stringify({ risk_flags: [] })))
  ]);
  assert.equal(flagResults[0], 0);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).risk_flags, ["security"]);

  // impact_confidence is deliberately absent from this race: it is not a protected field, because
  // lowering it raises what the gate demands rather than shrinking it. Whichever writer lands last
  // wins, and that is the intended behaviour — see the freely-revisable test below.
});

// The gate charges for uncertainty (medium/low draws impact_discovery and baseline_validation), so
// an agent that discovers it understands less than it thought must be able to say so without asking
// the user for permission first. Requiring a user-confirmed reclassify to *raise* the bar is exactly
// backwards, and this pins that the runtime does not do it in either direction.
test("impact_confidence is freely revisable in both directions, and each change moves plan_revision", () => {
  const root = join(tmpdir(), `agent-workflow-confidence-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const path = join(root, "task.json");
  writeFileSync(path, JSON.stringify(validTask({ managed_change: true, risk_flags: [], impact_confidence: "high" })));
  const run = (input) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", "task-write", "--task-path", path], { cwd: process.cwd(), encoding: "utf8", input });
  let revision = JSON.parse(readFileSync(path, "utf8")).plan_revision;
  for (const confidence of ["medium", "low", "high"]) {
    const result = run(JSON.stringify({ impact_confidence: confidence }));
    assert.equal(result.status, 0, result.stdout);
    const state = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(state.impact_confidence, confidence);
    assert.ok(state.plan_revision > revision, `plan_revision did not move for ${confidence}`);
    revision = state.plan_revision;
  }
});

// plan_hash is a pure function of current classification fields, so a classification round-trip
// (e.g. managed_change true -> false -> true, with nothing else changed) restores the exact same
// plan_hash even though the task's actual state moved through two more reclassifications in
// between. plan_hash alone therefore is not proof that step evidence is still fresh; plan_revision
// (bumped every time plan_hash changes, never reused) must also match, exactly like role evidence
// already requires via roleFreshnessErrors.
test("step evidence recorded before a classification round-trip does not satisfy the gate afterward, even though plan_hash reverts", () => {
  const root = join(tmpdir(), `agent-workflow-plan-revision-replay-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Replay\n\n## Goal\n\nVerify plan_revision closes the plan_hash replay gap.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const path = join(task, "task.json");
  const run = (args, input) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", input });
  writeFileSync(path, JSON.stringify(validTask({ managed_change: true, workflow_request: [], impact_scope: "cross_project", impact_effect: "destructive", impact_confidence: "medium", task_type: "fix", risk_flags: [] })));
  const record = run(["evidence-record", "--task-path", path, "--requirement-id", "impact_discovery.ID1", "--summary", "recorded before the round-trip"]);
  assert.equal(record.status, 0, record.stdout);
  const planHashBefore = JSON.parse(readFileSync(path, "utf8")).evidence.at(-1).plan_hash;
  const toFalse = run(["reclassify", "--task-path", path, "--confirmed-by-user", "user re-assessed", "--reason", "testing round-trip"], JSON.stringify({ managed_change: false }));
  assert.equal(toFalse.status, 0, toFalse.stdout);
  const backToTrue = run(["reclassify", "--task-path", path, "--confirmed-by-user", "user re-assessed", "--reason", "testing round-trip"], JSON.stringify({ managed_change: true }));
  assert.equal(backToTrue.status, 0, backToTrue.stdout);
  const after = JSON.parse(readFileSync(path, "utf8"));
  const planHashAfter = JSON.parse(run(["workflow-plan", "--task-path", path]).stdout).plan_hash;
  assert.equal(planHashAfter, planHashBefore, "the round-trip must actually reproduce the same plan_hash for this to be a meaningful test");
  assert.notEqual(after.plan_revision, JSON.parse(readFileSync(path, "utf8")).evidence[0].plan_revision, "plan_revision must have moved even though plan_hash reverted");
  const gated = JSON.parse(run(["task-gate", "--task-path", path]).stdout);
  assert.ok(gated.errors.some((error) => /impact_discovery\.ID1/.test(error) && /plan revision/.test(error)), gated.errors.join("; "));
});

// A terminal task is a dead end in the transition table: nothing moves it back to in_progress, so
// anything written to it afterwards can never be gated, reviewed or closed again — it would sit in
// the record looking like part of a live task. Every mutating command has to refuse, not just the
// ones that happen to run the transition table.
for (const terminal of ["closed", "superseded"]) {
  test(`a ${terminal} task refuses every state mutation`, () => {
    const root = join(tmpdir(), `agent-workflow-terminal-${terminal}-${process.pid}-${Date.now()}`);
    const task = join(root, "task"); mkdirSync(task, { recursive: true });
    writeFileSync(join(task, "task.md"), "# Terminal\n\n## Goal\n\nVerify terminal tasks are immutable.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
    const path = join(task, "task.json");
    const run = (args, input) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", input });
    const state = validTask({ managed_change: true, workflow_request: ["reviewer"], impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "medium", task_type: "fix", risk_flags: [] });
    state.lifecycle = { status: terminal, transitions: [{ at: "2026-01-01T00:00:00.000Z", action: terminal === "closed" ? "close" : "supersede", from: "in_progress", to: terminal, actor: "test" }] };
    const mutations = [
      [["task-write", "--task-path", path], JSON.stringify({ impact_confidence: "low" })],
      [["reclassify", "--task-path", path, "--confirmed-by-user", "user re-assessed", "--reason", "late edit"], JSON.stringify({ impact_confidence: "low" })],
      [["approve-intent", "--task-path", path, "--confirmed-by", "user"], undefined],
      [["evidence-record", "--task-path", path, "--requirement-id", "baseline_validation.BV1", "--summary", "late claim"], undefined],
      [["evidence-run", "--task-path", path, "--requirement-id", "baseline_validation.BV2", "--summary", "late run", "--", process.execPath, "-e", "0"], undefined],
      [["review-record", "--task-path", path, "--role", "reviewer", "--result", "pass", "--summary", "late review"], undefined],
      [["waive", "--task", path, "--confirmed-by-user", "user said skip", "--requirement-id", "role.reviewer"], undefined]
    ];
    for (const [args, input] of mutations) {
      writeFileSync(path, JSON.stringify(state));
      const before = readFileSync(path, "utf8");
      const result = run(args, input);
      assert.notEqual(result.status, 0, `${args[0]} was accepted on a ${terminal} task: ${result.stdout}`);
      assert.match(result.stdout + result.stderr, new RegExp(`task is ${terminal}`), args[0]);
      assert.equal(readFileSync(path, "utf8"), before, `${args[0]} modified a ${terminal} task`);
    }
  });
}

// paused/blocked mean the work is not currently running, so validation evidence recorded against one
// describes a state nobody is maintaining. Classification is the deliberate exception: revising what
// the task claims about itself is often exactly why it is blocked.
test("a paused or blocked task accepts classification writes but no validation evidence until it resumes", () => {
  const root = join(tmpdir(), `agent-workflow-paused-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Paused\n\n## Goal\n\nVerify paused tasks cannot accumulate evidence.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const path = join(task, "task.json");
  const run = (args, input) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", input });
  writeFileSync(path, JSON.stringify(validTask({ managed_change: true, workflow_request: [], impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "medium", task_type: "fix", risk_flags: [] })));
  for (const status of ["pause", "block"]) {
    const moved = run([status, "--task", path]);
    assert.equal(moved.status, 0, moved.stdout);
    const refused = run(["evidence-record", "--task-path", path, "--requirement-id", "baseline_validation.BV1", "--summary", "recorded while parked"]);
    assert.notEqual(refused.status, 0, refused.stdout);
    assert.match(JSON.parse(refused.stdout).errors[0], /run 'agent-workflow resume/);
    // Classification still moves: the task has to be able to describe itself while parked.
    const rewritten = run(["task-write", "--task-path", path], JSON.stringify({ impact_confidence: "low" }));
    assert.equal(rewritten.status, 0, rewritten.stdout);
    const resumed = run(["resume", "--task", path]);
    assert.equal(resumed.status, 0, resumed.stdout);
  }
  const recorded = run(["evidence-record", "--task-path", path, "--requirement-id", "baseline_validation.BV1", "--summary", "recorded while running"]);
  assert.equal(recorded.status, 0, recorded.stdout);
});

// The waiver counterpart to the step-evidence replay test above: plan_hash is a pure function of the
// classification, so a round-trip restores it exactly. Without plan_revision, a waiver the user
// granted against one plan would silently come back to life on a plan they never saw.
test("a waiver does not survive a classification round-trip that restores the same plan_hash", () => {
  const root = join(tmpdir(), `agent-workflow-waiver-replay-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Waiver replay\n\n## Goal\n\nVerify waivers cannot be revived by a plan round-trip.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const path = join(task, "task.json");
  const run = (args, input) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", input });
  writeFileSync(path, JSON.stringify(validTask({ code_change: false, managed_change: true, workflow_request: ["reviewer"], impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high", task_type: "fix", risk_flags: [] })));
  const waived = run(["waive", "--task", path, "--confirmed-by-user", "user said skip reviewer", "--requirement-id", "role.reviewer"]);
  assert.equal(waived.status, 0, waived.stderr);
  const planHashBefore = JSON.parse(readFileSync(path, "utf8")).waivers.at(-1).plan_hash;
  assert.ok(!JSON.parse(run(["task-gate", "--task-path", path]).stdout).errors.some((error) => error.includes("role.reviewer")));
  for (const confidence of ["medium", "high"]) {
    const rewritten = run(["task-write", "--task-path", path], JSON.stringify({ impact_confidence: confidence }));
    assert.equal(rewritten.status, 0, rewritten.stdout);
  }
  assert.equal(JSON.parse(run(["workflow-plan", "--task-path", path]).stdout).plan_hash, planHashBefore, "the round-trip must reproduce the same plan_hash for this to be a meaningful test");
  const regated = JSON.parse(run(["task-gate", "--task-path", path]).stdout);
  assert.ok(regated.errors.some((error) => error.includes("role.reviewer")), regated.errors.join("; "));
});

// Waivers written before plan_revision existed cannot distinguish a plan that never moved from one
// that moved away and back, so the gate has to treat them as stale rather than trust them.
test("a waiver recorded without plan_revision no longer satisfies the gate", () => {
  const root = join(tmpdir(), `agent-workflow-waiver-legacy-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Legacy waiver\n\n## Goal\n\nVerify pre-plan_revision waivers are stale.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const path = join(task, "task.json");
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
  writeFileSync(path, JSON.stringify(validTask({ code_change: false, managed_change: true, workflow_request: ["reviewer"], impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high", task_type: "fix", risk_flags: [] })));
  const waived = run(["waive", "--task", path, "--confirmed-by-user", "user said skip reviewer", "--requirement-id", "role.reviewer"]);
  assert.equal(waived.status, 0, waived.stderr);
  const state = JSON.parse(readFileSync(path, "utf8"));
  delete state.waivers.at(-1).plan_revision;
  writeFileSync(path, JSON.stringify(state));
  const regated = JSON.parse(run(["task-gate", "--task-path", path]).stdout);
  assert.ok(regated.errors.some((error) => error.includes("role.reviewer")), regated.errors.join("; "));
});
