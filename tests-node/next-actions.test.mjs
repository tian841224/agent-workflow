import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { compile } from "./policy-compiler.mjs";
import { sourceModule } from "./source-module.mjs";

const { nextActions } = await sourceModule("src/lifecycle/next.ts");
const task = join(tmpdir(), "task", "task.json");
const gate = (missing, errors = ["gate failed"]) => ({ valid: false, status: "in_progress", missing, errors });
const declared = (command) => JSON.parse(command.match(/echo '(.*)' \|/)[1].replaceAll("<value>", "true"));

test("a classification action nests workflow_facts the way task-write accepts them", () => {
  const [action] = nextActions(task, "/repo", gate([{ kind: "classification", fields: ["impact_scope", "workflow_facts.public_api"] }]));
  assert.match(action.command, /agent-workflow task-write/);
  assert.deepEqual(declared(action.command), { impact_scope: true, workflow_facts: { public_api: true } });
});

test("an undecided proof names the facts that settle it before asking for its run", () => {
  const actions = nextActions(task, "/repo", gate([{ kind: "proof", id: "custom.CX1", title: "runs when public", undecided_by: ["workflow_facts.public_api"] }]));
  assert.deepEqual(declared(actions[0].command), { workflow_facts: { public_api: true } });
  assert.match(actions[0].why, /custom\.CX1/);
  assert.ok(actions.some((action) => /evidence-run .*--requirement-id custom\.CX1/.test(action.command)), JSON.stringify(actions));
});

test("an invalid gate with no scripted gap still returns a next step", () => {
  const actions = nextActions(task, "/repo", gate([], ["code task has no base_commit; task delivery baseline is missing"]));
  assert.equal(actions.length, 1);
  assert.match(actions[0].command, /agent-workflow task-report/);
  assert.match(actions[0].why, /base_commit/);
});

test("a runtime step the classification cannot decide stays a proof and carries undecided_by", () => {
  const policy = JSON.parse(readFileSync("schemas/workflow-policy.json", "utf8"));
  const regression = policy.capabilities.find((capability) => capability.name === "regression_validation");
  regression.steps.push({ id: "RV9", title: "public surface smoke run", runtime_execution: "required", when: [[{ fact: "has_consumer", equals: [true] }]] });
  const root = join(tmpdir(), `agent-workflow-next-policy-${process.pid}-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "workflow-policy.json"), JSON.stringify(policy));
  const base = { managed_change: true, code_change: true, task_type: "fix", impact_scope: "multi_module", impact_effect: "contract", impact_confidence: "high", risk_flags: [], workflow_request: ["regression_validation"] };
  const undecided = compile(base, join(root, "workflow-policy.json"));
  const proof = undecided.proofs.find((step) => step.id === "regression_validation.RV9");
  assert.deepEqual(proof?.undecided_by, ["workflow_facts.has_consumer"], JSON.stringify(undecided.proofs));
  assert.ok(undecided.required_evidence.includes("regression_validation.RV9"));
  const ruledOut = compile({ ...base, workflow_facts: { has_consumer: false } }, join(root, "workflow-policy.json"));
  assert.ok(!ruledOut.required_evidence.includes("regression_validation.RV9"));
});
