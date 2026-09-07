import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const run = (args, input) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", input });
const plan = (task) => {
  const path = join(tmpdir(), `agent-workflow-policy-completeness-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(task));
  return JSON.parse(run(["workflow-plan", "--task-path", path]).stdout);
};

test("an undeclared impact_effect reports an incomplete classification for a capability that needs it", () => {
  const result = plan({ workflow_request: [], risk_flags: [], task_type: "fix", impact_scope: "cross_project", impact_confidence: "high" });
  // impact_scope already clears the reviewer threshold, so reviewer is required outright; the still-
  // undeclared impact_effect only leaves data_impact (which reads impact_effect) incomplete.
  const incomplete = result.classification_incomplete.find((entry) => entry.name === "data_impact");
  assert.ok(incomplete, JSON.stringify(result.classification_incomplete));
  assert.ok(incomplete.missing.includes("impact_effect"));
});

test("managed_change=true with an incomplete classification fails the gate; managed_change=false does not require it", () => {
  const root = join(tmpdir(), `agent-workflow-policy-completeness-gate-${process.pid}-${Date.now()}`);
  const task = join(root, "task");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Completeness\n\n## Goal\n\nVerify managed_change gates on incomplete classification.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  const path = join(task, "task.json");
  const base = { schema_version: 4, id: "20260101-000000-completeness", project_id: "0123456789abcdef", worktree_id: "0123456789abcdef", code_change: false, risk_flags: [], created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", state_revision: 1, plan_revision: 1, lifecycle: { status: "in_progress", transitions: [{ at: "2026-01-01T00:00:00.000Z", action: "create", from: "new", to: "in_progress", actor: "test" }] }, evidence: [], waivers: [], impact_scope: "cross_project" };
  writeFileSync(path, JSON.stringify({ ...base, managed_change: true }));
  const managedGated = JSON.parse(run(["task-gate", "--task-path", path]).stdout);
  assert.equal(managedGated.valid, false);
  assert.ok(managedGated.errors.some((error) => /workflow classification is incomplete/.test(error)), managedGated.errors.join("; "));

  writeFileSync(path, JSON.stringify({ ...base, managed_change: false }));
  const unmanagedGated = JSON.parse(run(["task-gate", "--task-path", path]).stdout);
  assert.ok(!unmanagedGated.errors.some((error) => /workflow classification is incomplete/.test(error)), unmanagedGated.errors.join("; "));
});

test("migration=true requires migration_safety and schema=true requires schema_compatibility", () => {
  const migration = plan({ workflow_request: [], risk_flags: ["migration"], task_type: "fix", impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high" });
  assert.ok(migration.required.includes("migration_safety"), JSON.stringify(migration.required));
  const schema = plan({ workflow_request: [], risk_flags: ["schema"], task_type: "fix", impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high" });
  assert.ok(schema.required.includes("schema_compatibility"), JSON.stringify(schema.required));
});

test("the mutation/security/operational risk flags each force their capability, and its runtime_execution steps", () => {
  const base = { workflow_request: [], task_type: "fix", impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high" };
  for (const [flag, capability] of [["financial", "mutation_validation"], ["irreversible", "mutation_validation"], ["security", "security_review"], ["authorization", "security_review"], ["operational", "operational_verification"]]) {
    const result = plan({ ...base, risk_flags: [flag] });
    assert.ok(result.required.includes(capability), `${flag} did not require ${capability}: ${JSON.stringify(result.required)}`);
  }
  // data_write is the deliberate exception: it draws data_impact, not the far more expensive
  // break-the-logic-and-watch-the-tests-fail pass that money and one-way changes pay for.
  const dataWrite = plan({ ...base, risk_flags: ["data_write"] });
  assert.ok(dataWrite.required.includes("data_impact"), JSON.stringify(dataWrite.required));
  assert.ok(!dataWrite.required.includes("mutation_validation"), JSON.stringify(dataWrite.required));
  // An attested claim must not be able to satisfy these: the proof-of-execution steps have to keep
  // declaring runtime_execution, which is what forces evidence-run rather than evidence-record.
  const policy = JSON.parse(readFileSync(join(process.cwd(), "schemas", "workflow-policy.json"), "utf8"));
  for (const [capability, step] of [["mutation_validation", "MV4"], ["operational_verification", "OV2"]]) {
    const declared = policy.capabilities.find((entry) => entry.name === capability).steps.find((entry) => entry.id === step);
    assert.equal(declared.runtime_execution, "required", `${capability}.${step} no longer requires runtime evidence`);
  }
});

test("test_integrity is required only by its risk flag, never by workflow_facts alone (the unknown-facts trap)", () => {
  // A plain fix with no risk flags at all: test_integrity must not appear as required or incomplete,
  // even though it is a real capability in the policy — this is the "unknown != required" invariant.
  const plain = plan({ workflow_request: [], risk_flags: [], task_type: "fix", impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high" });
  assert.ok(!plain.required.includes("test_integrity"), JSON.stringify(plain.required));
  assert.ok(!plain.classification_incomplete.some((entry) => entry.name === "test_integrity"), JSON.stringify(plain.classification_incomplete));

  // Declaring test_skipped alone, without the risk flag, still must not force it.
  const factOnly = plan({ workflow_request: [], risk_flags: [], task_type: "fix", impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high", workflow_facts: { test_skipped: true } });
  assert.ok(!factOnly.required.includes("test_integrity"), JSON.stringify(factOnly.required));

  // The risk flag is what forces it; the fact then decides which steps are expanded.
  const flagged = plan({ workflow_request: [], risk_flags: ["test_integrity"], task_type: "fix", impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high", workflow_facts: { test_skipped: true } });
  assert.ok(flagged.required.includes("test_integrity"), JSON.stringify(flagged.required));
  const capability = flagged.steps.find((entry) => entry.name === "test_integrity");
  assert.ok(capability.steps.some((step) => step.id === "TI2"));
});

// security and ui were the two flags that produced their own evidence capability (or, for ui, an
// explicit browser-verification rule) while never drawing the independent reviewer that reads the
// change back. They are exactly the cases where the agent verifying its own work is worth least.
test("the security and ui risk flags each require an independent reviewer, ordered after the evidence", () => {
  const base = { workflow_request: [], task_type: "fix", impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high", managed_change: true };
  for (const flag of ["security", "ui"]) {
    const result = plan({ ...base, risk_flags: [flag] });
    assert.ok(result.required.includes("reviewer"), `${flag} did not require reviewer: ${JSON.stringify(result.required)}`);
    // A review that runs before the evidence it is supposed to read back proves nothing, so the
    // reviewer has to sort last among everything selected.
    assert.equal(result.order.at(-1), "reviewer", `${flag}: ${JSON.stringify(result.order)}`);
  }
});
