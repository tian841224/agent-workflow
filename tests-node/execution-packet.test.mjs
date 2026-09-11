import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const cli = join(process.cwd(), "dist", "agent-workflow.mjs");
const run = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: "utf8", ...options });
const vcs = (repo, args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });

test("execution-packet is the complete worker execution contract", () => {
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
  writeFileSync(join(task, "task.md"), "# Test\n\n## Goal\n\nVerify the execution packet end to end.\n\n## Scope\n\nChange the payment module only.\n\n## Completion criteria\n\n- [ ] payment behavior is preserved\n- [ ] regression tests pass\n");
  const init = run(["task-init", "--task-path", task, "--repo-root", repo], {
    input: JSON.stringify({
      code_change: true, managed_change: true, workflow_mode: "main",
      task_type: "refactor", impact_scope: "multi_module", impact_effect: "shared_behavior", impact_confidence: "high",
      risk_flags: [], workflow_facts: { testable_behavior_change: true }, workflow_request: ["reviewer"],
      subtask_role: "worker", parent_task_id: "20260101-000000-parent-task", file_ownership: ["src/payment/", "tests/payment/"]
    })
  });
  assert.equal(init.status, 0, init.stdout);
  const result = run(["execution-packet", "--task-path", task, "--repo-root", repo]);
  assert.equal(result.status, 0, result.stderr);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.intent.goal, "Verify the execution packet end to end.");
  assert.equal(packet.intent.scope, "Change the payment module only.");
  assert.match(packet.intent.completion_criteria, /payment behavior is preserved/);
  assert.equal(packet.classification.code_change, true);
  assert.equal(packet.classification.managed_change, true);
  assert.equal(packet.classification.workflow_mode, "main");
  assert.equal(packet.classification.impact_confidence, "high");
  assert.equal(packet.classification.workflow_facts.testable_behavior_change, true);
  assert.equal(packet.constraints.repo_root, repo);
  assert.deepEqual(packet.constraints.file_ownership, ["src/payment/", "tests/payment/"]);
  assert.equal(packet.constraints.subtask_role, "worker");
  assert.equal(packet.constraints.parent_task_id, "20260101-000000-parent-task");
  assert.match(packet.constraints.base_commit, /^[a-f0-9]{40}$/);
  assert.ok(packet.workflow.selected.includes("reviewer"));
  assert.ok(packet.workflow.selected.includes("execution_path_review"));
  assert.ok(packet.workflow.capabilities.some((capability) => capability.name === "execution_path_review"));
  // The packet carries selected steps directly; workers receive the concise evidence procedure
  // instead of reopening the full policy, while reviewer keeps its dedicated review pointer.
  assert.ok(packet.procedures.includes(".agents/skills/workflow/review.md"));
  assert.ok(packet.procedures.includes(".agents/skills/workflow/evidence.md"));
  assert.ok(packet.procedures.includes(".agents/skills/workflow/elevated.md"));
  assert.ok(packet.procedures.includes(".agents/agents/worker.md"));
  assert.ok(packet.procedures.includes(".agents/skills/project-docs/SKILL.md"));
  assert.ok(packet.required_evidence.includes("role.reviewer"));
  assert.match(packet.plan_hash, /^[a-f0-9]{64}$/);
  assert.equal(packet.plan_revision, 1);
  assert.match(packet.intent_hash, /^[a-f0-9]{64}$/);
});

test("execution-packet reports a missing task state instead of throwing", () => {
  const missing = run(["execution-packet", "--task-path", join(tmpdir(), `agent-workflow-execution-packet-missing-${process.pid}-${Date.now()}`)]);
  const body = JSON.parse(missing.stdout);
  assert.equal(body.valid, false);
  assert.equal(missing.status, 1);
});

test("execution-packet skips project docs for focused file-local behavior changes", () => {
  const root = join(tmpdir(), `agent-workflow-execution-packet-local-docs-${process.pid}-${Date.now()}`);
  const { repo, task } = setupPreflightTask(root);
  const result = run(["execution-packet", "--task-path", task, "--repo-root", repo]);
  assert.equal(result.status, 0, result.stdout);
  const packet = JSON.parse(result.stdout);
  assert.equal(packet.workflow.exploration_profile, "focused");
  assert.ok(!packet.procedures.includes(".agents/skills/project-docs/SKILL.md"), JSON.stringify(packet.procedures));
});

test("execution-packet keeps the explicit managed_change bypass procedure-free", () => {
  const root = join(tmpdir(), `agent-workflow-execution-packet-unmanaged-${process.pid}-${Date.now()}`);
  const { repo, task } = setupPreflightTask(root);
  const reclassified = run(["reclassify", "--task-path", task, "--confirmed-by-user", "user", "--reason", "workflow bypass"] , { input: JSON.stringify({ managed_change: false }) });
  assert.equal(reclassified.status, 0, reclassified.stdout);
  const result = run(["execution-packet", "--task-path", task, "--repo-root", repo]);
  assert.equal(result.status, 0, result.stdout);
  const packet = JSON.parse(result.stdout);
  assert.deepEqual(packet.workflow.selected, []);
  assert.deepEqual(packet.procedures, []);
});

// A worker must never start from a packet whose premise is already wrong: unresolved
// classification, an empty Goal, a non-in_progress task, or (for a freeze-required flag) a stale
// intent approval. This is a preflight only — it must not demand post-implementation evidence.
function setupPreflightTask(root, overrides = {}) {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  vcs(repo, ["init", "-q"]);
  vcs(repo, ["config", "user.email", "t@e.com"]);
  vcs(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "f.txt"), "one");
  vcs(repo, ["add", "."]);
  vcs(repo, ["commit", "-q", "-m", "init"]);
  const task = join(root, "20260101-000000-preflight");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), overrides.taskMd ?? "# Test\n\n## Goal\n\nDo the thing.\n\n## Scope\n\nJust this.\n\n## Completion criteria\n\n- [ ] done\n");
  const init = run(["task-init", "--task-path", task, "--repo-root", repo], {
    input: JSON.stringify({
      code_change: true, managed_change: true, workflow_mode: "main", task_type: "fix",
      impact_scope: "file", impact_effect: "local_behavior", impact_confidence: overrides.impact_confidence ?? "high",
      risk_flags: overrides.risk_flags ?? [], workflow_request: []
    })
  });
  assert.equal(init.status, 0, init.stdout);
  return { repo, task };
}

test("execution-packet rejects a task whose lifecycle.status is not in_progress", () => {
  const root = join(tmpdir(), `agent-workflow-execution-packet-preflight-status-${process.pid}-${Date.now()}`);
  const { repo, task } = setupPreflightTask(root);
  assert.equal(run(["pause", "--task", task]).status, 0);
  const result = run(["execution-packet", "--task-path", task, "--repo-root", repo]);
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).errors[0], /lifecycle\.status must be 'in_progress'/);
});

test("execution-packet rejects a task with an empty Goal section", () => {
  const root = join(tmpdir(), `agent-workflow-execution-packet-preflight-goal-${process.pid}-${Date.now()}`);
  const { repo, task } = setupPreflightTask(root, { taskMd: "# Test\n\n## Goal\n\n## Scope\n\nJust this.\n\n## Completion criteria\n\n- [ ] done\n" });
  const result = run(["execution-packet", "--task-path", task, "--repo-root", repo]);
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).errors[0], /Goal.*empty|task\.md intent is invalid/);
});

test("execution-packet rejects a task with incomplete classification", () => {
  const root = join(tmpdir(), `agent-workflow-execution-packet-preflight-classification-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo"); mkdirSync(repo, { recursive: true });
  vcs(repo, ["init", "-q"]); vcs(repo, ["config", "user.email", "t@e.com"]); vcs(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "f.txt"), "one"); vcs(repo, ["add", "."]); vcs(repo, ["commit", "-q", "-m", "init"]);
  const task = join(root, "20260101-000000-preflight-classification"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Test\n\n## Goal\n\nDo the thing.\n\n## Scope\n\nJust this.\n\n## Completion criteria\n\n- [ ] done\n");
  // impact_scope cross_project already requires reviewer/execution_path_review outright, but leaving
  // impact_effect undeclared leaves data_impact classification-incomplete (see policy-completeness.test.mjs).
  const init = run(["task-init", "--task-path", task, "--repo-root", repo], {
    input: JSON.stringify({ code_change: true, managed_change: true, workflow_mode: "main", task_type: "fix", impact_scope: "cross_project", impact_confidence: "high", risk_flags: [], workflow_request: [] })
  });
  assert.equal(init.status, 0, init.stdout);
  const plan = JSON.parse(run(["workflow-plan", "--task-path", task]).stdout);
  assert.ok(plan.classification_incomplete.some((entry) => entry.name === "data_impact"), JSON.stringify(plan.classification_incomplete));
  const result = run(["execution-packet", "--task-path", task, "--repo-root", repo]);
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout).errors[0], /workflow classification is incomplete/);
});

test("execution-packet rejects a freeze-required task with a stale intent approval", () => {
  const root = join(tmpdir(), `agent-workflow-execution-packet-preflight-intent-${process.pid}-${Date.now()}`);
  const { repo, task } = setupPreflightTask(root, { risk_flags: ["contract"] });
  const reclassified = run(["reclassify", "--task-path", task, "--confirmed-by-user", "user", "--reason", "scoped"], { input: "{}" });
  assert.equal(reclassified.status, 0, reclassified.stdout);
  const noApproval = run(["execution-packet", "--task-path", task, "--repo-root", repo]);
  assert.notEqual(noApproval.status, 0);
  assert.match(JSON.parse(noApproval.stdout).errors.join(";"), /intent_approval is required/);
  assert.equal(run(["approve-intent", "--task-path", task, "--confirmed-by", "user", "--as-user"]).status, 0);
  const approved = run(["execution-packet", "--task-path", task, "--repo-root", repo]);
  assert.equal(approved.status, 0, approved.stdout);
  writeFileSync(join(task, "task.md"), "# Test\n\n## Goal\n\nDo a DIFFERENT thing.\n\n## Scope\n\nJust this.\n\n## Completion criteria\n\n- [ ] done\n");
  const stale = run(["execution-packet", "--task-path", task, "--repo-root", repo]);
  assert.notEqual(stale.status, 0);
  assert.match(JSON.parse(stale.stdout).errors.join(";"), /intent_approval\.intent_hash is stale/);
});
