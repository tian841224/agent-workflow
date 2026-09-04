import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const experimental = { ...process.env, AGENT_WORKFLOW_ORCHESTRATION_EXPERIMENTAL: "1" };
const run = (action, root, extraEnv = experimental) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", "orchestrate", "--action", action, "--id", "demo", "--state-root", root], { cwd: process.cwd(), encoding: "utf8", env: extraEnv });
const freshRoot = (suffix) => join(tmpdir(), `agent-workflow-orchestration-${suffix}-${process.pid}-${Date.now()}`);

test("split -> executing -> integrating -> integrated -> cleaned is a valid full path", () => {
  const root = freshRoot("full-path");
  for (const action of ["Init", "WorkerReady", "Integrate", "Apply", "Cleanup"]) assert.equal(run(action, root).status, 0, action);
  const state = JSON.parse(run("Status", root).stdout);
  assert.equal(state.phase, "cleaned");
});

test("executing cannot jump straight to cleaned, skipping integrate", () => {
  const root = freshRoot("skip-integrate");
  assert.equal(run("Init", root).status, 0);
  assert.equal(run("WorkerReady", root).status, 0);
  const skipped = run("Cleanup", root);
  assert.notEqual(skipped.status, 0);
  assert.match(skipped.stderr, /invalid OrchestrationEngine transition/);
});

test("a failed worker can still reach cleaned", () => {
  const root = freshRoot("failed-cleanup");
  assert.equal(run("Init", root).status, 0);
  assert.equal(run("WorkerReady", root).status, 0);
  assert.equal(run("WorkerFailed", root).status, 0);
  const cleaned = run("Cleanup", root);
  assert.equal(cleaned.status, 0, cleaned.stderr);
  assert.equal(JSON.parse(cleaned.stdout).phase, "cleaned");
});

test("cleaned is a dead end: nothing transitions out of it, including re-running cleanup", () => {
  const root = freshRoot("dead-end");
  for (const action of ["Init", "WorkerReady", "Integrate", "Apply", "Cleanup"]) assert.equal(run(action, root).status, 0, action);
  for (const action of ["Init", "WorkerReady", "Cleanup"]) assert.notEqual(run(action, root).status, 0, `${action} should be refused once cleaned`);
});

test("an integrated patch cannot be applied a second time", () => {
  const root = freshRoot("no-double-apply");
  for (const action of ["Init", "WorkerReady", "Integrate", "Apply"]) assert.equal(run(action, root).status, 0, action);
  assert.notEqual(run("Apply", root).status, 0);
});

test("split requires the experimental flag but RegisterNative (host-created worktree) does not", () => {
  const root = freshRoot("experimental-gate");
  const withoutFlag = run("Init", root, process.env);
  assert.notEqual(withoutFlag.status, 0);
  assert.match(withoutFlag.stderr, /Experimental/);
  const registerNative = run("RegisterNative", root, process.env);
  assert.equal(registerNative.status, 0, registerNative.stderr);
});
