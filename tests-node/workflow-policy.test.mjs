import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { compile, loadPolicy, stepIds } from "./policy-compiler.mjs";

function withPolicy(mutate) {
  const policy = JSON.parse(readFileSync("schemas/workflow-policy.json", "utf8"));
  mutate(policy);
  const root = join(tmpdir(), `agent-workflow-policy-${process.pid}-${Date.now()}-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  const path = join(root, "workflow-policy.json");
  writeFileSync(path, JSON.stringify(policy));
  return path;
}

test("loadPolicy rejects a policy with a duplicate capability name", () => {
  const policyPath = withPolicy((policy) => { policy.capabilities.push({ ...policy.capabilities[0] }); });
  assert.throws(() => loadPolicy(policyPath), /duplicate capability name/);
});

test("loadPolicy rejects an order_after reference to an unknown capability", () => {
  const policyPath = withPolicy((policy) => { policy.capabilities[0].order_after = ["not_a_real_capability"]; });
  assert.throws(() => loadPolicy(policyPath), /order_after references unknown capability/);
});

test("loadPolicy rejects a condition object with no recognized operator", () => {
  const policyPath = withPolicy((policy) => { policy.capabilities.find((capability) => capability.steps.length).steps[0].when = [[{ made_up_operator: true }]]; });
  assert.throws(() => loadPolicy(policyPath), /workflow-policy schema invalid/);
});

test("the plan filters steps by impact_scope/impact_effect/task_type and rejects an unknown capability", () => {
  const small = compile({ workflow_request: ["execution_path_review"], impact_scope: "file", impact_effect: "local_behavior", task_type: "fix", risk_flags: [] });
  assert.deepEqual(stepIds(small, "execution_path_review"), ["EP1"]);
  const wide = compile({ workflow_request: ["execution_path_review"], impact_scope: "cross_project", impact_effect: "destructive", task_type: "refactor", risk_flags: [] });
  assert.deepEqual(stepIds(wide, "execution_path_review"), ["EP1", "EP2", "EP3", "EP4", "EP5"]);
  assert.throws(() => compile({ workflow_request: ["not_a_real_capability"] }), /unknown capability/);
});

test("a require_when-backed capability's evidence is required even with an empty workflow_request", () => {
  // schema_compatibility 的 require_when 由 risk_flags 內含 "schema" 觸發（schemas/workflow-policy.json）
  const plan = compile({ workflow_request: [], risk_flags: ["schema"], impact_scope: "file", impact_effect: "local_behavior", task_type: "fix" });
  assert.ok(plan.required.includes("schema_compatibility"), JSON.stringify(plan.required));
  // Its steps are analysis, not runtime proofs, so they steer the work through the checklist.
  assert.ok(plan.checklist.some((step) => step.id.startsWith("schema_compatibility.")), JSON.stringify(plan.checklist));
});

test("a local behavior flag stays focused while a boundary risk stays expanded", () => {
  const planFor = (risk_flags) => compile({ managed_change: true, workflow_request: [], risk_flags, impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high", task_type: "fix" });
  assert.equal(planFor(["behavior_change"]).exploration_profile, "focused");
  assert.equal(planFor(["contract"]).exploration_profile, "expanded");
});

test("a step whose workflow_facts are undeclared stays on the checklist instead of blocking the task", () => {
  const planFor = (workflow_facts) => compile({ managed_change: true, code_change: true, workflow_request: [], risk_flags: ["schema"], impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high", task_type: "fix", workflow_facts });
  // SC4 的 when 只看 fact "schema_constraint_change"；沒宣告時無法判定，留在 checklist 讓實作與 Reviewer 涵蓋，
  // 不進 gate 也不要求補分類；宣告為 false 才能證明不需要而移除。
  const undeclared = planFor({});
  assert.ok(stepIds(undeclared, "schema_compatibility").includes("SC4"));
  assert.ok(undeclared.checklist.some((step) => step.id === "schema_compatibility.SC4"), JSON.stringify(undeclared.checklist));
  assert.ok(!undeclared.required_evidence.includes("schema_compatibility.SC4"));
  assert.deepEqual(undeclared.classification_incomplete, []);
  assert.ok(stepIds(planFor({ schema_constraint_change: true }), "schema_compatibility").includes("SC4"));
  assert.ok(!stepIds(planFor({ schema_constraint_change: false }), "schema_compatibility").includes("SC4"));
});

test("changing task_type between two otherwise-identical plans changes plan_hash", () => {
  const base = { managed_change: true, code_change: true, workflow_request: [], risk_flags: [], impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high" };
  // mechanical is the task_type that drops the Reviewer, so it changes what the gate demands.
  assert.notEqual(compile({ ...base, task_type: "fix" }).plan_hash, compile({ ...base, task_type: "mechanical" }).plan_hash);
});

// managed_change is the sole workflow entry gate: a task explicitly marked managed_change: false
// (a stale/imported/legacy task, per workflow SKILL.md) must never actually start a capability or
// role no matter what workflow_request/risk_flags/workflow_facts it still carries, and must never
// be blocked on an incomplete classification it will never need to resolve.
test("managed_change: false bypasses every capability/role even with a stale workflow_request, risk_flags, and workflow_facts", () => {
  const stale = compile({
    managed_change: false, workflow_request: ["reviewer"], risk_flags: ["security", "authorization"],
    // impact_scope left undeclared: with managed_change:true this would make several capabilities
    // classification-incomplete; with managed_change:false it must not block anything at all.
    task_type: "fix", workflow_facts: { schema_constraint_change: true }
  });
  assert.deepEqual(stale.selected, []);
  assert.deepEqual(stale.required_evidence, []);
  assert.deepEqual(stale.classification_incomplete, []);
  assert.deepEqual(stale.checklist, []);
  // requested still reflects the raw workflow_request as diagnostics; it just never gets started.
  assert.deepEqual(stale.requested, ["reviewer"]);
  // The same classification with managed_change: true actually starts something, proving the empty
  // result above is a real bypass and not an artifact of the fixture itself.
  const managed = compile({
    managed_change: true, workflow_request: ["reviewer"], risk_flags: ["security", "authorization"],
    impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high", task_type: "fix", workflow_facts: { schema_constraint_change: true }
  });
  assert.ok(managed.selected.length > 0, JSON.stringify(managed));
  assert.ok(managed.required_evidence.includes("role.reviewer"), JSON.stringify(managed.required_evidence));
});

test("a high-confidence file-local financial fix explores focused but keeps its evidence; wider financial scope still expands", () => {
  const base = { workflow_request: [], task_type: "fix", impact_effect: "local_behavior", impact_confidence: "high", managed_change: true, code_change: true, risk_flags: ["financial"] };
  const local = compile({ ...base, impact_scope: "file" });
  assert.equal(local.exploration_profile, "focused");
  for (const name of ["mutation_validation", "data_impact", "reviewer"]) assert.ok(local.required.includes(name), name);
  assert.equal(compile({ ...base, impact_scope: "module" }).exploration_profile, "expanded");
});
