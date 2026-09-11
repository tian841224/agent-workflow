import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
const vcs = (repo, args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });

function validTask(overrides = {}) {
  return {
    schema_version: 5,
    id: "20260101-000000-evidence-test",
    project_id: "0123456789abcdef",
    worktree_id: "0123456789abcdef",
    code_change: true,
    managed_change: true,
    risk_flags: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    state_revision: 1,
    plan_revision: 1,
    lifecycle: { status: "in_progress", transitions: [{ at: "2026-01-01T00:00:00.000Z", action: "create", from: "new", to: "in_progress", actor: "test" }] },
    evidence: [],
    waivers: [],
    ...overrides
  };
}

test("a delivery reaching outside file_ownership is an ownership violation, not something review may ignore", () => {
  const root = join(tmpdir(), `agent-workflow-ownership-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  vcs(repo, ["init", "-q"]);
  vcs(repo, ["config", "user.email", "t@e.com"]);
  vcs(repo, ["config", "user.name", "t"]);
  mkdirSync(join(repo, "src", "payment"), { recursive: true });
  mkdirSync(join(repo, "src", "shared"), { recursive: true });
  writeFileSync(join(repo, "src", "payment", "service.ts"), "one");
  writeFileSync(join(repo, "src", "shared", "money.ts"), "one");
  vcs(repo, ["add", "."]);
  vcs(repo, ["commit", "-q", "-m", "init"]);
  const head = vcs(repo, ["rev-parse", "HEAD"]).stdout.trim();
  const task = join(root, "state", "task");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Ownership\n\n## Goal\n\nVerify the ownership boundary is enforced.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const path = join(task, "task.json");
  // managed_change: false keeps the gate focused on ownership — a managed task additionally owes
  // baseline_validation evidence and a decidable classification for every selected step.
  const state = validTask({ managed_change: false, workflow_request: [], impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high", task_type: "fix", file_ownership: ["src/payment/"], base_commit: head });
  writeFileSync(path, JSON.stringify(state));
  const gate = () => JSON.parse(run(["task-gate", "--task-path", path, "--repo-root", repo]).stdout);
  writeFileSync(join(repo, "src", "payment", "service.ts"), "two");
  assert.equal(gate().valid, true, JSON.stringify(gate().errors));
  writeFileSync(join(repo, "src", "shared", "money.ts"), "two");
  const violated = gate();
  assert.equal(violated.valid, false);
  assert.ok(violated.errors.some((error) => /ownership violation.*src\/shared\/money\.ts/.test(error)), violated.errors.join("; "));
});

test("a renamed or deleted path counts as delivered even though it is no longer on disk", () => {
  const root = join(tmpdir(), `agent-workflow-rename-delete-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  vcs(repo, ["init", "-q"]);
  vcs(repo, ["config", "user.email", "t@e.com"]);
  vcs(repo, ["config", "user.name", "t"]);
  mkdirSync(join(repo, "owned"), { recursive: true });
  writeFileSync(join(repo, "owned", "keep.ts"), "one");
  writeFileSync(join(repo, "moved.ts"), "one");
  writeFileSync(join(repo, "removed.ts"), "one");
  vcs(repo, ["add", "."]);
  vcs(repo, ["commit", "-q", "-m", "init"]);
  const head = vcs(repo, ["rev-parse", "HEAD"]).stdout.trim();
  const task = join(root, "state", "task");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Rename\n\n## Goal\n\nVerify renames and deletes are delivered paths.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const path = join(task, "task.json");
  writeFileSync(path, JSON.stringify(validTask({ workflow_request: [], impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high", task_type: "refactor", file_ownership: ["owned/"], base_commit: head })));
  const gate = () => JSON.parse(run(["task-gate", "--task-path", path, "--repo-root", repo]).stdout);
  vcs(repo, ["mv", "moved.ts", join("owned", "moved.ts")]);
  const renamed = gate();
  // The rename's source side sits outside owned/, so it has to surface even though the file is gone.
  assert.ok(renamed.errors.some((error) => /ownership violation.*moved\.ts/.test(error)), renamed.errors.join("; "));
  vcs(repo, ["checkout", "--", "."]);
  vcs(repo, ["rm", "-q", "removed.ts"]);
  const deleted = gate();
  assert.ok(deleted.errors.some((error) => /ownership violation.*removed\.ts/.test(error)), deleted.errors.join("; "));
});

test("role evidence survives a commit of the reviewed work and goes stale when the reviewed diff changes", () => {
  const root = join(tmpdir(), `agent-workflow-role-freshness-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  vcs(repo, ["init", "-q"]);
  vcs(repo, ["config", "user.email", "t@e.com"]);
  vcs(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "reviewed.txt"), "one");
  writeFileSync(join(repo, "unrelated.txt"), "one");
  vcs(repo, ["add", "."]);
  vcs(repo, ["commit", "-q", "-m", "init"]);
  const head = vcs(repo, ["rev-parse", "HEAD"]).stdout.trim();
  // The task directory lives in the state root, outside the repo, exactly as a real one does.
  const task = join(root, "state", "task");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Freshness\n\n## Goal\n\nVerify diff-scoped role evidence.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const path = join(task, "task.json");
  // managed_change: true with the minimum delivery receipt waived for this role-freshness fixture,
  // so the only thing left to go stale is role.reviewer.
  const classification = { managed_change: true, workflow_request: ["reviewer"], impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high", task_type: "fix", base_commit: head };
  const reviewedPaths = "reviewed.txt,unrelated.txt";
  const scopedDigest = () => JSON.parse(run(["worktree-fingerprint", "--path", repo, "--base", head, "--paths", reviewedPaths]).stdout).reviewed_diff_sha256;
  writeFileSync(path, JSON.stringify(validTask(classification)));
  const planHash = JSON.parse(run(["workflow-plan", "--task-path", path]).stdout).plan_hash;
  const intentHash = JSON.parse(run(["approve-intent", "--task-path", path, "--confirmed-by", "test"]).stdout).intent_hash;
  writeFileSync(join(repo, "reviewed.txt"), "two");
  const baselineStep = (id, trustLevel) => ({ kind: "step", id: `baseline_validation.${id}`, status: "recorded", at: "2026-01-01T00:00:00.000Z", plan_hash: planHash, plan_revision: 1, intent_hash: intentHash, actor: "test", summary: "stub", trust_level: trustLevel });
  const evidence = [
    baselineStep("BV1", "attested"), baselineStep("BV2", "runtime"), baselineStep("BV3", "attested"),
    { kind: "role", id: "role.reviewer", result: "pass", at: "2026-01-01T00:00:00.000Z", plan_hash: planHash, intent_hash: intentHash, plan_revision: 1, reviewed_base: head, reviewed_paths: reviewedPaths.split(","), reviewed_diff_sha256: scopedDigest(), delivery_hash: "0".repeat(64) }
  ];
  const waiver = { at: "2026-01-01T00:00:00.000Z", actor: "test", confirmed_by_user: "test", requirement_id: "delivery_validation.DV1", plan_hash: planHash, plan_revision: 1, intent_hash: intentHash };
  writeFileSync(path, JSON.stringify(validTask({ ...classification, evidence, waivers: [waiver] })));
  const gate = () => JSON.parse(run(["task-gate", "--task-path", path, "--repo-root", repo]).stdout);
  assert.equal(gate().valid, true, JSON.stringify(gate().errors));
  // Committing the reviewed work leaves the tree identical to what was reviewed. A HEAD-based
  // workspace fingerprint invalidated on the commit itself; a reviewed_base digest does not.
  vcs(repo, ["add", "."]);
  vcs(repo, ["commit", "-q", "-m", "deliver"]);
  assert.equal(gate().valid, true, "committing the reviewed work must not invalidate the review");
  writeFileSync(join(repo, "reviewed.txt"), "three");
  const stale = gate();
  assert.equal(stale.valid, false);
  assert.ok(stale.errors.some((error) => /reviewed diff changed/.test(error)), stale.errors.join("; "));
});

test("role evidence that skips a delivered path is rejected even when its own digest still matches", () => {
  const root = join(tmpdir(), `agent-workflow-role-coverage-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  vcs(repo, ["init", "-q"]);
  vcs(repo, ["config", "user.email", "t@e.com"]);
  vcs(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "reviewed.txt"), "one");
  writeFileSync(join(repo, "skipped.txt"), "one");
  vcs(repo, ["add", "."]);
  vcs(repo, ["commit", "-q", "-m", "init"]);
  const head = vcs(repo, ["rev-parse", "HEAD"]).stdout.trim();
  const task = join(root, "state", "task");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Coverage\n\n## Goal\n\nVerify the reviewed scope must cover the delivery.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const path = join(task, "task.json");
  const classification = { workflow_request: ["reviewer"], impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high", task_type: "fix" };
  writeFileSync(path, JSON.stringify(validTask(classification)));
  const planHash = JSON.parse(run(["workflow-plan", "--task-path", path]).stdout).plan_hash;
  const intentHash = JSON.parse(run(["approve-intent", "--task-path", path, "--confirmed-by", "test"]).stdout).intent_hash;
  writeFileSync(join(repo, "skipped.txt"), "two");
  const digest = JSON.parse(run(["worktree-fingerprint", "--path", repo, "--base", head, "--paths", "reviewed.txt"]).stdout).reviewed_diff_sha256;
  writeFileSync(path, JSON.stringify(validTask({
    ...classification,
    evidence: [{ kind: "role", id: "role.reviewer", result: "pass", at: "2026-01-01T00:00:00.000Z", plan_hash: planHash, intent_hash: intentHash, plan_revision: 1, reviewed_base: head, reviewed_paths: ["reviewed.txt"], reviewed_diff_sha256: digest, delivery_hash: "0".repeat(64) }]
  })));
  const gated = JSON.parse(run(["task-gate", "--task-path", path, "--repo-root", repo]).stdout);
  assert.equal(gated.valid, false);
  assert.ok(gated.errors.some((error) => /does not cover every changed path.*skipped\.txt/.test(error)), gated.errors.join("; "));
});

// Step evidence has no pass/fail state (status is always "recorded" — the agent completed the
// analysis, that is not a verdict); only role evidence carries a verdict, so that is what exercises
// "the newest entry for a requirement wins, even when it is worse than an earlier one".
test("a later failing role evidence entry overrides an earlier passing one for the same requirement", () => {
  const root = join(tmpdir(), `agent-workflow-latest-evidence-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const vcsHere = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  vcsHere(["init", "-q"]); vcsHere(["config", "user.email", "t@e.com"]); vcsHere(["config", "user.name", "t"]);
  writeFileSync(join(repo, "reviewed.txt"), "one");
  vcsHere(["add", "."]); vcsHere(["commit", "-q", "-m", "init"]);
  const head = vcsHere(["rev-parse", "HEAD"]).stdout.trim();
  const task = join(root, "state", "task");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Latest evidence\n\n## Goal\n\nVerify newest-wins evidence selection.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const path = join(task, "task.json");
  const classification = { workflow_request: ["reviewer"], impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high", task_type: "fix" };
  writeFileSync(path, JSON.stringify(validTask(classification)));
  const planHash = JSON.parse(run(["workflow-plan", "--task-path", path]).stdout).plan_hash;
  const digest = JSON.parse(run(["worktree-fingerprint", "--path", repo, "--base", head, "--paths", "reviewed.txt"]).stdout).reviewed_diff_sha256;
  const role = (result, at) => ({ kind: "role", id: "role.reviewer", result, at, plan_hash: planHash, intent_hash: "1".repeat(64), plan_revision: 1, reviewed_base: head, reviewed_paths: ["reviewed.txt"], reviewed_diff_sha256: digest, delivery_hash: "0".repeat(64) });
  writeFileSync(path, JSON.stringify(validTask({ ...classification, evidence: [role("pass", "2026-01-01T00:00:00.000Z"), role("fail", "2026-01-02T00:00:00.000Z")] })));
  const gated = JSON.parse(run(["task-gate", "--task-path", path, "--repo-root", repo]).stdout);
  assert.ok(gated.errors.some((error) => error.includes("role.reviewer")), gated.errors.join("; "));
});

test("runtime evidence becomes stale when the delivered worktree changes after validation", () => {
  const root = join(tmpdir(), `agent-workflow-delivery-freshness-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  vcs(repo, ["init", "-q"]); vcs(repo, ["config", "user.email", "t@e.com"]); vcs(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "tracked.txt"), "one");
  vcs(repo, ["add", "."]); vcs(repo, ["commit", "-q", "-m", "init"]);
  const head = vcs(repo, ["rev-parse", "HEAD"]).stdout.trim();
  const task = join(root, "state", "task"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Delivery freshness\n\n## Goal\n\nVerify runtime evidence follows the delivered diff.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] stale delivery is rejected\n");
  const path = join(task, "task.json");
  const classification = { code_change: true, managed_change: true, task_type: "fix", impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high", risk_flags: [], workflow_request: [], base_commit: head };
  writeFileSync(path, JSON.stringify(validTask(classification)));
  writeFileSync(join(repo, "tracked.txt"), "two");
  const recorded = run(["evidence-run", "--task-path", path, "--cwd", repo, "--requirement-id", "delivery_validation.DV1", "--summary", "targeted delivery check", "--", process.execPath, "-e", "process.stdout.write('ok')"]);
  assert.equal(recorded.status, 0, recorded.stdout || recorded.stderr);
  const gate = () => JSON.parse(run(["task-gate", "--task-path", path, "--repo-root", repo]).stdout);
  assert.equal(gate().valid, true, JSON.stringify(gate().errors));
  writeFileSync(join(repo, "tracked.txt"), "three");
  const stale = gate();
  assert.equal(stale.valid, false);
  assert.ok(stale.errors.some((error) => /execution evidence is stale/.test(error)), stale.errors.join("; "));
  writeFileSync(join(repo, "added.txt"), "new");
  assert.ok(gate().errors.some((error) => /execution evidence is stale/.test(error)));
});

test("task-write refuses to write evidence at all — it is not a classification field", () => {
  const root = join(tmpdir(), `agent-workflow-evidence-shape-${process.pid}-${Date.now()}`);
  const task = join(root, "task");
  mkdirSync(task, { recursive: true });
  const path = join(task, "task.json");
  writeFileSync(path, JSON.stringify(validTask()));
  const result = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "task-write", "--task-path", path], {
    cwd: process.cwd(), encoding: "utf8", input: JSON.stringify({ evidence: [{ kind: "role", id: "role.reviewer", result: "pass" }] })
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /not writable via task-write/);
});

test("task-gate rejects a task.json whose evidence entry does not match any evidence shape", () => {
  const root = join(tmpdir(), `agent-workflow-evidence-shape-gate-${process.pid}-${Date.now()}`);
  const task = join(root, "task");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Shape\n\n## Goal\n\nVerify a malformed evidence entry fails schema at gate time.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const path = join(task, "task.json");
  writeFileSync(path, JSON.stringify(validTask({ evidence: [{ kind: "role", id: "role.reviewer", verified: true }] })));
  const gated = JSON.parse(run(["task-gate", "--task-path", path]).stdout);
  assert.equal(gated.valid, false);
  assert.ok(gated.errors.some((error) => /task\.json/.test(error)), gated.errors.join("; "));
});

test("an undeclared impact_scope reports an incomplete classification instead of silently forcing every capability", () => {
  const root = join(tmpdir(), `agent-workflow-unknown-scope-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const path = join(root, "task.json");
  writeFileSync(path, JSON.stringify({ workflow_request: [], risk_flags: [], task_type: "fix", impact_effect: "local_behavior", impact_confidence: "high" }));
  const plan = JSON.parse(run(["workflow-plan", "--task-path", path]).stdout);
  assert.equal(plan.required.includes("reviewer"), false);
  const incomplete = plan.classification_incomplete.find((entry) => entry.name === "reviewer");
  assert.ok(incomplete, JSON.stringify(plan.classification_incomplete));
  assert.deepEqual(incomplete.missing, ["impact_scope"]);
});

test("a declared impact_scope that clears the threshold still forces the capability", () => {
  const root = join(tmpdir(), `agent-workflow-known-scope-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const path = join(root, "task.json");
  writeFileSync(path, JSON.stringify({ workflow_request: [], managed_change: true, risk_flags: [], task_type: "fix", impact_scope: "cross_project", impact_effect: "local_behavior", impact_confidence: "high" }));
  const plan = JSON.parse(run(["workflow-plan", "--task-path", path]).stdout);
  assert.ok(plan.required.includes("reviewer"));
  assert.deepEqual(plan.classification_incomplete, []);
});

test("task-gate blocks on an incomplete classification and names the missing field", () => {
  const root = join(tmpdir(), `agent-workflow-gate-incomplete-${process.pid}-${Date.now()}`);
  const task = join(root, "task");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Incomplete\n\n## Goal\n\nVerify the gate reports incomplete classification.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const path = join(task, "task.json");
  writeFileSync(path, JSON.stringify(validTask({ task_type: "fix", impact_effect: "local_behavior", impact_confidence: "high" })));
  const gated = JSON.parse(run(["task-gate", "--task-path", path]).stdout);
  assert.equal(gated.valid, false);
  assert.ok(gated.errors.some((error) => /classification is incomplete.*impact_scope/.test(error)), gated.errors.join("; "));
});

test("a waiver without a requirement id is refused", () => {
  const root = join(tmpdir(), `agent-workflow-waiver-id-${process.pid}-${Date.now()}`);
  const task = join(root, "task");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Waiver\n\n## Goal\n\nVerify waivers name a requirement.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const path = join(task, "task.json");
  writeFileSync(path, JSON.stringify(validTask({ workflow_request: ["reviewer"], impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high", task_type: "fix" })));
  const result = run(["waive", "--task", path, "--confirmed-by-user", "user approved"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requirement-id/);
});
