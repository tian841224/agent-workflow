import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

// Two enforcement layers, deliberately not the same layer: task.schema.json owns the shape of what
// lands on disk, the runtime owns the transitions between two shapes that are each valid on their
// own. These tests pin which invariant lives where, so neither side silently drops one.
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js");
const addFormats = require("ajv-formats");
const cli = join(process.cwd(), "dist", "agent-workflow.mjs");
const run = (args, input) => spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: "utf8", input });

function validatorFor(definition) {
  const schema = JSON.parse(readFileSync(join(process.cwd(), "schemas", "task.schema.json"), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema, "task");
  return ajv.compile(definition ? { $ref: `task#/$defs/${definition}` } : { $ref: "task" });
}

const HASH = "a".repeat(64);
const waiver = (overrides = {}) => ({ at: "2026-01-01T00:00:00.000Z", actor: "cli", confirmed_by_user: "user said skip", requirement_id: "role.reviewer", plan_hash: HASH, intent_hash: HASH, ...overrides });
const stepEvidence = (overrides = {}) => ({ kind: "step", id: "baseline_validation.BV1", status: "recorded", at: "2026-01-01T00:00:00.000Z", plan_hash: HASH, intent_hash: HASH, summary: "ran the suite", ...overrides });

// A waiver without intent_hash cannot be checked against the task.md it was granted for, so it would
// survive a rewrite of the Goal/Scope it was justified by.
test("a waiver missing intent_hash fails schema validation", () => {
  const validate = validatorFor("waiver");
  assert.equal(validate(waiver()), true, JSON.stringify(validate.errors));
  const { intent_hash, ...withoutIntentHash } = waiver();
  assert.equal(validate(withoutIntentHash), false);
  assert.ok(validate.errors.some((error) => /intent_hash/.test(error.message || "")), JSON.stringify(validate.errors));
});

// evidence_kind is a discriminator, not a label: execution evidence has to carry the six fields that
// make a run reproducible, and analysis evidence must not borrow any of them to look like one.
test("stepEvidence's evidence_kind discriminated union rejects a half-filled execution record", () => {
  const validate = validatorFor("stepEvidence");
  const execution = stepEvidence({ evidence_kind: "execution", command: "npm test", cwd: ".", exit_code: 0, started_at: "2026-01-01T00:00:00.000Z", duration_ms: 10, output_digest: HASH });
  assert.equal(validate(execution), true, JSON.stringify(validate.errors));
  for (const field of ["command", "cwd", "exit_code", "started_at", "duration_ms", "output_digest"]) {
    const { [field]: _dropped, ...missing } = execution;
    assert.equal(validate(missing), false, `execution evidence without ${field} was accepted`);
  }
});

test("stepEvidence rejects analysis evidence carrying a stray execution field", () => {
  const validate = validatorFor("stepEvidence");
  assert.equal(validate(stepEvidence({ evidence_kind: "analysis" })), true, JSON.stringify(validate.errors));
  for (const [field, value] of [["exit_code", 0], ["command", "npm test"], ["output_digest", HASH]]) {
    assert.equal(validate(stepEvidence({ evidence_kind: "analysis", [field]: value })), false, `analysis evidence carrying ${field} was accepted`);
  }
});

// The classification downgrade guard is intentionally NOT a schema constraint: both the before and
// the after state are individually schema-valid, so only the runtime, which sees both, can refuse
// the move. code_change: true with managed_change: false is a legitimate resting state (a code task
// the workflow does not manage), which is exactly why the schema cannot be the one to judge it.
test("the classification downgrade guard lives in the runtime, not in the schema", () => {
  const validate = validatorFor("");
  const state = {
    schema_version: 4, id: "20260101-000000-parity", project_id: "0123456789abcdef", worktree_id: "0123456789abcdef",
    code_change: true, managed_change: false, risk_flags: [], created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    state_revision: 1, plan_revision: 1,
    lifecycle: { status: "in_progress", transitions: [{ at: "2026-01-01T00:00:00.000Z", action: "create", from: "new", to: "in_progress", actor: "test" }] },
    evidence: [], waivers: []
  };
  assert.equal(validate(state), true, JSON.stringify(validate.errors));

  const root = join(tmpdir(), `agent-workflow-parity-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const path = join(root, "task.json");
  writeFileSync(join(root, "task.md"), "# Parity\n\n## Goal\n\nVerify the runtime downgrade guard.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  writeFileSync(path, JSON.stringify({ ...state, code_change: false, managed_change: true }));
  const downgraded = JSON.parse(run(["task-write", "--task-path", path], JSON.stringify({ managed_change: false })).stdout);
  assert.equal(downgraded.valid, false);
  assert.ok(downgraded.errors.some((error) => /managed_change cannot transition from true back to false/.test(error)), downgraded.errors.join("; "));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).managed_change, true);
});
