import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js");
const addFormats = require("ajv-formats");
const cli = join(process.cwd(), "dist", "agent-workflow.mjs");

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: "utf8", ...options });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-protocol-"));
  const repo = join(root, "repo");
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  spawnSync("git", ["init", "-q", repo]);
  git(repo, ["config", "user.name", "test"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "base"]);
  writeFileSync(join(repo, "dirty.txt"), "keep parent dirty\n");
  return { root, repo, state };
}

function planFile(state, repo, parentTaskPath = undefined) {
  const path = join(state, "plan.json");
  writeFileSync(path, JSON.stringify({ repo_root: repo, ...(parentTaskPath ? { parent_task_path: parentTaskPath } : {}), workers: [
    { id: "api", goal: "change the API slice", completion_criteria: "API checks pass", file_ownership: ["api.txt"] },
    { id: "ui", goal: "change the UI slice", completion_criteria: "UI checks pass", file_ownership: ["ui.txt"] }
  ] }));
  return path;
}

function prepare(fixtureValue) {
  const result = run(["orchestrate", "--protocol", "3", "--action", "Prepare", "--id", "batch", "--state-root", fixtureValue.state, "--plan-path", planFile(fixtureValue.state, fixtureValue.repo)]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).batch;
}

function validateState(state) {
  const schema = JSON.parse(readFileSync(join(process.cwd(), "schemas", "orchestration.schema.json"), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.ok(validate(state), JSON.stringify(validate.errors));
}

test("protocol 3 preserves a dirty parent and applies two owned worker artifacts", () => {
  const value = fixture();
  try {
    const prepared = prepare(value);
    validateState(prepared);
    for (const worker of prepared.workers) {
      writeFileSync(join(worker.worktree, `${worker.id}.txt`), `${worker.id}\n`);
      const bound = run(["orchestrate", "--protocol", "3", "--action", "Bind", "--id", "batch", "--state-root", value.state, "--worker-id", worker.id, "--run-id", `${worker.id}-run`, "--platform", "test", "--workspace", worker.worktree]);
      assert.equal(bound.status, 0, bound.stderr);
      const checked = run(["worker-check", "--assignment-path", worker.packet_path, "--cwd", worker.worktree]);
      assert.equal(checked.status, 0, checked.stderr);
      const executed = run(["worker-exec", "--assignment-path", worker.packet_path, "--cwd", worker.worktree, "--", process.execPath, "-e", "process.stdout.write('worker-ok')"]);
      assert.equal(executed.status, 0, executed.stderr);
      assert.equal(JSON.parse(executed.stdout).stdout, "worker-ok");
      const resultPath = join(value.state, `${worker.id}-result.json`);
      writeFileSync(resultPath, JSON.stringify({ status: "completed", run_id: `${worker.id}-run`, validation: "pass" }));
      const collected = run(["orchestrate", "--protocol", "3", "--action", "Collect", "--id", "batch", "--state-root", value.state, "--worker-id", worker.id, "--result-path", resultPath]);
      assert.equal(collected.status, 0, collected.stderr);
    }
    assert.equal(run(["orchestrate", "--protocol", "3", "--action", "Integrate", "--id", "batch", "--state-root", value.state]).status, 0);
    const applied = run(["orchestrate", "--protocol", "3", "--action", "Apply", "--id", "batch", "--state-root", value.state]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(readFileSync(join(value.repo, "api.txt"), "utf8"), "api\n");
    assert.equal(readFileSync(join(value.repo, "ui.txt"), "utf8"), "ui\n");
    assert.equal(readFileSync(join(value.repo, "dirty.txt"), "utf8"), "keep parent dirty\n");
    const cleaned = run(["orchestrate", "--protocol", "3", "--action", "Cleanup", "--id", "batch", "--state-root", value.state]);
    assert.equal(cleaned.status, 0, cleaned.stderr);
    validateState(JSON.parse(readFileSync(join(value.state, "orchestration", "v3", "batch", "state.json"), "utf8")));
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("protocol 3 blocks parent drift and allows explicit cancel cleanup", () => {
  const value = fixture();
  try {
    const prepared = prepare(value);
    for (const worker of prepared.workers) {
      writeFileSync(join(worker.worktree, `${worker.id}.txt`), `${worker.id}\n`);
      assert.equal(run(["orchestrate", "--protocol", "3", "--action", "Bind", "--id", "batch", "--state-root", value.state, "--worker-id", worker.id, "--run-id", `${worker.id}-run`, "--platform", "test", "--workspace", worker.worktree]).status, 0);
      const resultPath = join(value.state, `${worker.id}-result.json`);
      writeFileSync(resultPath, JSON.stringify({ status: "completed", run_id: `${worker.id}-run` }));
      assert.equal(run(["orchestrate", "--protocol", "3", "--action", "Collect", "--id", "batch", "--state-root", value.state, "--worker-id", worker.id, "--result-path", resultPath]).status, 0);
    }
    assert.equal(run(["orchestrate", "--protocol", "3", "--action", "Integrate", "--id", "batch", "--state-root", value.state]).status, 0);
    writeFileSync(join(value.repo, "parent-edit.txt"), "do not overwrite\n");
    const applied = run(["orchestrate", "--protocol", "3", "--action", "Apply", "--id", "batch", "--state-root", value.state]);
    assert.notEqual(applied.status, 0);
    assert.match(applied.stderr, /parent workspace changed/);
    assert.equal(run(["orchestrate", "--protocol", "3", "--action", "Cancel", "--id", "batch", "--state-root", value.state]).status, 0);
    assert.equal(run(["orchestrate", "--protocol", "3", "--action", "Cleanup", "--id", "batch", "--state-root", value.state]).status, 0);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("protocol 3 rejects overlapping or dependent worker plans", () => {
  const value = fixture();
  try {
    const path = join(value.state, "invalid.json");
    writeFileSync(path, JSON.stringify({ repo_root: value.repo, has_order_dependency: true, workers: [
      { id: "one", goal: "one", completion_criteria: "one", file_ownership: ["src"] },
      { id: "two", goal: "two", completion_criteria: "two", file_ownership: ["src/api"] }
    ] }));
    const result = run(["orchestrate", "--protocol", "3", "--action", "Prepare", "--id", "invalid", "--state-root", value.state, "--plan-path", path]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /order dependency|ownership overlaps/);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("protocol 3 assesses a plan without creating state or worktrees", () => {
  const value = fixture();
  try {
    const result = run(["orchestrate", "--protocol", "3", "--action", "Assess", "--id", "assess", "--state-root", value.state, "--plan-path", planFile(value.state, value.repo)]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).eligible, true);
    assert.equal(JSON.parse(result.stdout).worker_count, 2);
    assert.equal(readFileSync(join(value.repo, "dirty.txt"), "utf8"), "keep parent dirty\n");
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});

test("protocol 3 preserves a frozen parent intent in child packets", () => {
  const value = fixture();
  try {
    const parentDir = join(value.state, "projects", "parent", "tasks", "20260918-000000-parent");
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(join(parentDir, "task.md"), "# Parent\n\n## Goal\n\nDeliver the parent change.\n\n## Scope\n\nAPI and UI slices.\n\n## Completion criteria\n\n- [ ] parent validation passes\n");
    const init = run(["task-init", "--task-path", parentDir, "--repo-root", value.repo, "--state-root", value.state], { input: JSON.stringify({ code_change: false, managed_change: true, task_type: "feature", impact_scope: "module", impact_effect: "contract", impact_confidence: "high", risk_flags: ["contract"] }) });
    assert.equal(init.status, 0, init.stderr);
    const approved = run(["approve-intent", "--task-path", parentDir, "--confirmed-by", "test"]);
    assert.equal(approved.status, 0, approved.stderr);
    const parentState = JSON.parse(readFileSync(join(parentDir, "task.json"), "utf8"));
    const prepared = run(["orchestrate", "--protocol", "3", "--action", "Prepare", "--id", "parent-batch", "--state-root", value.state, "--plan-path", planFile(value.state, value.repo, join(parentDir, "task.json"))]);
    assert.equal(prepared.status, 0, prepared.stderr);
    const batch = JSON.parse(prepared.stdout).batch;
    for (const worker of batch.workers) {
      const packet = JSON.parse(readFileSync(worker.packet_path, "utf8"));
      assert.equal(packet.intent_hash, parentState.intent_approval.intent_hash);
      assert.deepEqual(packet.classification.risk_flags, ["contract"]);
    }
    assert.equal(run(["orchestrate", "--protocol", "3", "--action", "Cleanup", "--id", "parent-batch", "--state-root", value.state]).status, 0);
  } finally { rmSync(value.root, { recursive: true, force: true }); }
});
