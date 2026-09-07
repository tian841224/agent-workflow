import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// Golden tests: each fixture pairs one plausible classification with the plan the policy actually
// compiles for it today, captured from a real run rather than read off the schema. Condition groups
// (AND inside a group, OR across groups) plus unknown-handling make the result non-obvious, so the
// point here is to notice when a policy edit changes an unrelated scenario's plan.
const cli = join(process.cwd(), "dist", "agent-workflow.mjs");
const fixtureDir = join(process.cwd(), "tests-node", "fixtures", "policy-scenarios");
const plan = (task) => JSON.parse(spawnSync(process.execPath, [cli, "workflow-plan"], { cwd: process.cwd(), encoding: "utf8", input: JSON.stringify(task) }).stdout);

const fixtures = readdirSync(fixtureDir).filter((name) => name.endsWith(".json")).sort();
assert.equal(fixtures.length, 12, `expected 12 policy scenarios, found ${fixtures.length}`);

for (const file of fixtures) {
  const fixture = JSON.parse(readFileSync(join(fixtureDir, file), "utf8"));
  test(`policy scenario: ${fixture.scenario}`, () => {
    const compiled = plan(fixture.task);
    assert.deepEqual([...compiled.required].sort(), fixture.expected.required);
    assert.deepEqual([...compiled.required_evidence].sort(), fixture.expected.required_evidence);
    assert.deepEqual(compiled.classification_incomplete, fixture.expected.classification_incomplete);
    assert.deepEqual(compiled.step_classification_incomplete, fixture.expected.step_classification_incomplete);
  });
}

// An unmanaged task is the negative space the whole policy rests on: it must pull in nothing at all,
// baseline_validation included, or a docs/read-only bypass would still owe evidence.
test("an unmanaged task requires no capability at all", () => {
  const docOnly = JSON.parse(readFileSync(join(fixtureDir, "doc-only.json"), "utf8"));
  assert.equal(docOnly.task.managed_change, false);
  assert.deepEqual(docOnly.expected.required, []);
  assert.deepEqual(docOnly.expected.required_evidence, []);
});

// The whole point of gating on classification rather than on managed_change: a change the agent
// has looked at, understands, and can point at one file for owes the runtime nothing. Everything it
// still runs — tests, review, diagnosis — is its own call, made in the task, not forced by the gate.
test("a confident, local, risk-free managed change requires no capability", () => {
  for (const name of ["normal-bugfix", "local-feature"]) {
    const fixture = JSON.parse(readFileSync(join(fixtureDir, `${name}.json`), "utf8"));
    assert.equal(fixture.task.managed_change, true);
    assert.deepEqual(fixture.expected.required, [], name);
    assert.deepEqual(fixture.expected.required_evidence, [], name);
  }
});

// Lowering confidence is what buys the extra checks, and it costs the agent nothing to do — the
// counterpart to the freedom above is that admitting uncertainty actually changes the plan.
test("a change the agent is unsure about pulls in impact discovery and baseline validation", () => {
  const fixture = JSON.parse(readFileSync(join(fixtureDir, "uncertain-local-change.json"), "utf8"));
  assert.equal(fixture.task.impact_confidence, "medium");
  assert.deepEqual(fixture.expected.required, ["baseline_validation", "impact_discovery"]);
});

// Deliberately breaking working logic to prove the tests catch it is priced for money and one-way
// changes. Ordinary persistence is data_impact's job, and pinning that here keeps the cheaper path
// from silently drifting back onto every write.
test("an ordinary data write is covered by data impact, not by mutation validation", () => {
  const fixture = JSON.parse(readFileSync(join(fixtureDir, "ordinary-data-write.json"), "utf8"));
  assert.deepEqual(fixture.task.risk_flags, ["data_write"]);
  assert.ok(fixture.expected.required.includes("data_impact"));
  assert.ok(!fixture.expected.required.includes("mutation_validation"), JSON.stringify(fixture.expected.required));
});

// compileWorkflowPlan reports runtime-required keys through runtime_required_evidence, which the
// workflow-plan command does not surface; the durable contract a scenario can pin is that the
// financial flag selects MV4 and that MV4 still declares runtime_execution, which is what forces
// `evidence-run` rather than an attested `evidence-record`.
test("the financial scenario selects the mutation step that must be executed, not attested", () => {
  const financial = JSON.parse(readFileSync(join(fixtureDir, "financial-mutation.json"), "utf8"));
  assert.ok(financial.expected.required_evidence.includes("mutation_validation.MV4"), JSON.stringify(financial.expected.required_evidence));
  const policy = JSON.parse(readFileSync(join(process.cwd(), "schemas", "workflow-policy.json"), "utf8"));
  const step = policy.capabilities.find((entry) => entry.name === "mutation_validation").steps.find((entry) => entry.id === "MV4");
  assert.equal(step.runtime_execution, "required");
});
