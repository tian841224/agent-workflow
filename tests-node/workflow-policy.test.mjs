import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

test("workflow-plan filters steps by impact_scope/impact_effect/change_kind and rejects an unknown capability", () => {
  const root = join(tmpdir(), `agent-workflow-plan-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const run = (task) => { const path = join(root, `${crypto.randomUUID()}.json`); writeFileSync(path, JSON.stringify(task)); return spawnSync(process.execPath, ["dist/agent-workflow.mjs", "workflow-plan", "--task-path", path], { cwd: process.cwd(), encoding: "utf8" }); };
  const small = JSON.parse(run({ workflow_request: ["execution_path_review"], impact_scope: "file", impact_effect: "local_behavior", change_kind: "fix", risk_flags: [] }).stdout);
  assert.deepEqual(small.steps.find((capability) => capability.name === "execution_path_review").steps.map((step) => step.id), ["EP1"]);
  const wide = JSON.parse(run({ workflow_request: ["execution_path_review"], impact_scope: "cross_project", impact_effect: "destructive", change_kind: "refactor", risk_flags: [] }).stdout);
  assert.deepEqual(wide.steps.find((capability) => capability.name === "execution_path_review").steps.map((step) => step.id), ["EP1", "EP2", "EP3", "EP4", "EP5"]);
  const bad = run({ workflow_request: ["not_a_real_capability"] });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout, /unknown capability/);
});

test("a require_when-backed capability's evidence is required even with an empty workflow_request", () => {
  const root = join(tmpdir(), `agent-workflow-plan-require-when-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const path = join(root, "task.json");
  // schema_compatibility 的 require_when 由 risk_flags 內含 "schema" 觸發（schemas/workflow-policy.json）
  writeFileSync(path, JSON.stringify({ workflow_request: [], risk_flags: ["schema"], impact_scope: "file", impact_effect: "local_behavior", change_kind: "fix" }));
  const plan = JSON.parse(spawnSync(process.execPath, ["dist/agent-workflow.mjs", "workflow-plan", "--task-path", path], { cwd: process.cwd(), encoding: "utf8" }).stdout);
  assert.ok(plan.required_evidence.some((id) => id.startsWith("schema_compatibility.")), JSON.stringify(plan.required_evidence));
});

test("an unknown workflow_facts key keeps a step whose when-clause references that fact (tri-state unknown)", () => {
  const root = join(tmpdir(), `agent-workflow-plan-unknown-fact-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const path = join(root, "task.json");
  // SC4 的 when 只看 fact "schema_constraint_change"；沒有帶這個 fact 時應保持在 unknown（保留該步驟）
  writeFileSync(path, JSON.stringify({ workflow_request: [], risk_flags: ["schema"], impact_scope: "file", impact_effect: "local_behavior", change_kind: "fix", workflow_facts: {} }));
  const plan = JSON.parse(spawnSync(process.execPath, ["dist/agent-workflow.mjs", "workflow-plan", "--task-path", path], { cwd: process.cwd(), encoding: "utf8" }).stdout);
  const schemaCompatibility = plan.steps.find((capability) => capability.name === "schema_compatibility");
  assert.ok(schemaCompatibility.steps.some((step) => step.id === "SC4"));
});

test("changing change_kind between two otherwise-identical workflow-plan calls changes requirements_hash", () => {
  const root = join(tmpdir(), `agent-workflow-plan-hash-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const base = { workflow_request: [], risk_flags: [], impact_scope: "file", impact_effect: "local_behavior" };
  const planFor = (change_kind) => { const path = join(root, `${change_kind}.json`); writeFileSync(path, JSON.stringify({ ...base, change_kind })); return JSON.parse(spawnSync(process.execPath, ["dist/agent-workflow.mjs", "workflow-plan", "--task-path", path], { cwd: process.cwd(), encoding: "utf8" }).stdout); };
  const fix = planFor("fix");
  const refactor = planFor("refactor");
  assert.notEqual(fix.requirements_hash, refactor.requirements_hash);
});
