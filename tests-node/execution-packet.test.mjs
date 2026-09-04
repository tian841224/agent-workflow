import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const cli = join(process.cwd(), "dist", "agent-workflow.mjs");
const run = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: "utf8", ...options });
const vcs = (repo, args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });

test("execution-packet bundles intent, classification, selected capabilities and their procedure pointers", () => {
  const root = join(tmpdir(), `agent-workflow-execution-packet-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  vcs(repo, ["init", "-q"]);
  vcs(repo, ["config", "user.email", "t@e.com"]);
  vcs(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "f.txt"), "one");
  vcs(repo, ["add", "."]);
  vcs(repo, ["commit", "-q", "-m", "init"]);
  const task = join(root, "20260101-000000-execution-packet");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Test\n\n## Goal\n\nVerify the execution packet end to end.\n");
  const init = run(["task-init", "--task-path", task, "--repo-root", repo], {
    input: JSON.stringify({ code_change: true, managed_change: true, task_type: "refactor", impact_scope: "multi_module", impact_effect: "shared_behavior", impact_confidence: "high", risk_flags: [], workflow_request: ["reviewer"] })
  });
  assert.equal(init.status, 0, init.stdout);
  const packet = JSON.parse(run(["execution-packet", "--task-path", task]).stdout);
  assert.equal(packet.intent.goal, "Verify the execution packet end to end.");
  assert.deepEqual(packet.classification, { task_type: "refactor", impact_scope: "multi_module", impact_effect: "shared_behavior", risk_flags: [] });
  assert.ok(packet.workflow.selected.includes("reviewer"));
  assert.ok(packet.workflow.selected.includes("execution_path_review"));
  // reviewer has a named pointer; execution_path_review falls back to the policy itself.
  assert.ok(packet.procedures.includes(".agents/skills/workflow/SKILL.md"));
  assert.ok(packet.procedures.includes("schemas/workflow-policy.json"));
  assert.ok(packet.required_evidence.includes("role.reviewer"));
});

test("execution-packet reports a missing task state instead of throwing", () => {
  const missing = run(["execution-packet", "--task-path", join(tmpdir(), `agent-workflow-execution-packet-missing-${process.pid}-${Date.now()}`)]);
  const body = JSON.parse(missing.stdout);
  assert.equal(body.valid, false);
  assert.equal(missing.status, 1);
});
