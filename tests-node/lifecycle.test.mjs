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
    schema_version: 4,
    id: "20260101-000000-gate-test",
    project_id: "0123456789abcdef",
    worktree_id: "0123456789abcdef",
    code_change: true,
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
  writeFileSync(join(task, "task.md"), "# Gate test\n\n## Goal\n\nVerify runtime-compiled required evidence.\n");
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
  writeFileSync(join(task, "task.md"), "# Gate purity\n\n## Goal\n\nVerify task-gate never mutates task.json.\n");
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
  writeFileSync(join(task, "task.md"), "# Stale waiver\n\n## Goal\n\nVerify a waiver does not survive a plan_hash shift.\n");
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
  assert.equal(state.schema_version, 4);
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
  writeFileSync(join(task, "task.md"), "# Hash parity\n\n## Goal\n\nVerify plan_hash matches across commands.\n");
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
