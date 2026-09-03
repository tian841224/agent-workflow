import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const run = (args) => spawnSync(process.execPath, [join(process.cwd(), "dist", "agent-workflow.mjs"), ...args], { cwd: process.cwd(), encoding: "utf8" });
const fixturePath = join(process.cwd(), "tests-node", "fixtures", "policy-matrix.json");

// The dangerous workflow-policy regression is not a crash, it is a gate that quietly stops being
// selected. This pins what every kind of task must run across the sampled classification matrix, so
// a policy edit shows up as a digest diff naming the task_type it changed. When a diff is intended,
// run `agent-workflow policy-matrix --mode rows --task-type <type>` to see what moved, then update the fixture.
test("the compiled workflow policy still selects what the recorded matrix says it selects", () => {
  const expected = JSON.parse(readFileSync(fixturePath, "utf8"));
  const actual = JSON.parse(run(["policy-matrix"]).stdout);
  assert.equal(actual.rows, expected.rows, "the sampled matrix changed size; the sampling dimensions moved");
  for (const taskType of Object.keys(expected.digests)) {
    assert.equal(actual.digests[taskType], expected.digests[taskType], `capability/step selection changed for task_type: ${taskType}`);
  }
  assert.deepEqual(Object.keys(actual.digests).sort(), Object.keys(expected.digests).sort());
});

// The change_kind -> task_type collapse mapped a 4-value enum onto a 10-value one. These are the
// equivalences that collapse has to preserve, recorded explicitly rather than rediscovered one
// broken step at a time.
const FEATURE_LIKE = ["feature", "refactor", "schema", "migration"];
const STEPS_REQUIRING_FEATURE_LIKE = [["execution_path_review", "EP4"], ["codebase_design", "CD2"], ["codebase_design", "CD4"]];
test("every feature-like task_type keeps the steps the old change_kind: feature would have selected", () => {
  const rows = FEATURE_LIKE.concat("chore").flatMap((taskType) => JSON.parse(run(["policy-matrix", "--mode", "rows", "--task-type", taskType]).stdout));
  for (const taskType of FEATURE_LIKE) {
    // facts2 declares every fact false and impact_scope is the lowest rank, so every other group in
    // these steps' when-clauses is a proven no_match: task_type is the only thing that can select them.
    const row = rows.find((entry) => entry.key === `${taskType}|file|local_behavior|high|risk0|facts2`);
    assert.ok(row, `${taskType} row missing`);
    for (const [capability, step] of STEPS_REQUIRING_FEATURE_LIKE) {
      assert.ok(row.steps[capability].includes(step), `${taskType} lost ${capability}.${step}: ${row.steps[capability].join(",")}`);
    }
  }
  const chore = rows.find((entry) => entry.key === "chore|file|local_behavior|high|risk0|facts2");
  for (const [capability, step] of STEPS_REQUIRING_FEATURE_LIKE) {
    assert.equal(chore.steps[capability].includes(step), false, `chore should not select ${capability}.${step}`);
  }
});
