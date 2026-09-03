import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

// task.schema.json requires a fully-populated v3 shape (project_id/worktree_id as 16-hex ids,
// id matching the task-id pattern, no unknown top-level keys) before task-gate will validate it.
function validTask(overrides = {}) {
  return {
    schema_version: 3,
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

test("a waiver recorded against one requirements_hash does not satisfy the same requirement_id after the hash shifts", () => {
  const root = join(tmpdir(), `agent-workflow-gate-stale-waiver-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Stale waiver\n\n## Goal\n\nVerify a waiver does not survive a requirements_hash shift.\n");
  const path = join(task, "task.json");
  const write = (state) => writeFileSync(path, JSON.stringify(state));
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
  write(validTask({ workflow_request: ["reviewer"], impact_scope: "file" }));
  const waived = run(["waive", "--task", path, "--confirmed-by-user", "user said skip reviewer", "--requirement-id", "role.reviewer"]);
  assert.equal(waived.status, 0, waived.stderr);
  const satisfied = JSON.parse(run(["task-gate", "--task-path", path]).stdout);
  assert.ok(!satisfied.errors.some((error) => error.includes("role.reviewer")));
  // impact_scope 改變 requirements_hash（見 compileWorkflowPlan），舊 waiver 不應再滿足同一個 requirement_id
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.impact_scope = "module";
  write(state);
  const regated = JSON.parse(run(["task-gate", "--task-path", path]).stdout);
  assert.ok(regated.errors.some((error) => error.includes("role.reviewer")));
});
