import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const cli = join(process.cwd(), "dist", "agent-workflow.mjs");
const run = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: "utf8", ...options });
const vcs = (repo, args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const scenario = (name) => JSON.parse(readFileSync(join(process.cwd(), "tests-node", "fixtures", "policy-scenarios", `${name}.json`), "utf8")).task;

const EVIDENCE = ".agents/skills/workflow/evidence.md";
const EXPANDED = ".agents/skills/workflow/elevated.md";
const REVIEW = ".agents/skills/workflow/review.md";
const WORKER = ".agents/agents/worker.md";
const PROJECT_DOCS = ".agents/skills/project-docs/SKILL.md";
const OPERATIONAL = ".agents/skills/operational-verification/SKILL.md";

// Standing documents every task reads before the packet is even compiled. They are inside the budget
// so that moving a rule between standing context and a procedure nets out instead of reading as
// growth: an earlier version billed procedures alone, and relocating the run-tests invocation out of
// workflow/SKILL.md into evidence.md tripped every budget while cutting the real per-task cost.
const STANDING = ["AGENTS.md", ".agents/skills/workflow/SKILL.md"];

// A cost regression guard, not a total workflow benchmark: it measures the documents an agent reads
// for one task. The bytes a project-doc Lookup actually reads, CLI round trips and rework re-reads
// stay outside it, so a passing budget is not a claim that the end-to-end task got cheaper.
//
// The invariant is that quality and safety outcomes never drop — not that the step and capability
// counts only grow. Merging capabilities or retiring a duplicated one is allowed once equivalent
// verification evidence covers what it used to cover; a single evidence-run already satisfies several
// requirement ids. Each entry therefore pins the capabilities and roles this scenario must still
// reach, and the ceiling on the bytes it may cost to reach them.
//
// `code_change` means application source code, so a config or deployment task keeps it false and
// never pulls in the project-docs procedure.
const BUDGETS = [
  { name: "doc-only", task: { ...scenario("doc-only"), code_change: false }, capabilities: [], roles: 0, procedures: [], bytes: 3500 },
  { name: "normal-bugfix", task: { ...scenario("normal-bugfix"), code_change: true }, capabilities: ["delivery_validation"], roles: 0, procedures: [EVIDENCE, PROJECT_DOCS], bytes: 9900 },
  { name: "focused-worker", task: { ...scenario("normal-bugfix"), code_change: true, subtask_role: "worker", parent_task_id: "20260101-000000-parent-task", file_ownership: ["src/"] }, capabilities: ["delivery_validation"], roles: 0, procedures: [EVIDENCE, PROJECT_DOCS, WORKER], bytes: 13100 },
  { name: "cross-module-refactor", task: { ...scenario("cross-module-refactor"), code_change: true }, capabilities: ["baseline_validation", "delivery_validation", "execution_path_review", "regression_validation", "reviewer"], roles: 1, procedures: [EVIDENCE, EXPANDED, PROJECT_DOCS, REVIEW], bytes: 16700 },
  { name: "deployment-config", task: { ...scenario("deployment-config"), code_change: false }, capabilities: ["baseline_validation", "delivery_validation", "operational_verification"], roles: 0, procedures: [EVIDENCE, EXPANDED, OPERATIONAL], bytes: 10100 }
];

function packetFor(root, budget) {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  vcs(repo, ["init", "-q"]);
  vcs(repo, ["config", "user.email", "t@e.com"]);
  vcs(repo, ["config", "user.name", "t"]);
  writeFileSync(join(repo, "f.txt"), "one");
  vcs(repo, ["add", "."]);
  vcs(repo, ["commit", "-q", "-m", "init"]);
  const task = join(root, `20260101-000000-cost-${budget.name}`);
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Cost budget\n\n## Goal\n\nMeasure the compiled workflow cost.\n\n## Scope\n\nOne scenario only.\n\n## Completion criteria\n\n- [ ] the packet compiles\n");
  const init = run(["task-init", "--task-path", task, "--repo-root", repo], { input: JSON.stringify(budget.task) });
  assert.equal(init.status, 0, init.stdout);
  const result = run(["execution-packet", "--task-path", task, "--repo-root", repo]);
  assert.equal(result.status, 0, result.stdout);
  return JSON.parse(result.stdout);
}

for (const budget of BUDGETS) {
  test(`procedure budget: ${budget.name}`, () => {
    const root = join(tmpdir(), `agent-workflow-cost-${budget.name}-${process.pid}-${Date.now()}`);
    const packet = packetFor(root, budget);
    for (const capability of budget.capabilities) assert.ok(packet.workflow.selected.includes(capability), `${budget.name} no longer selects ${capability}: ${JSON.stringify(packet.workflow.selected)}`);
    assert.equal(packet.required_evidence.filter((id) => id.startsWith("role.")).length, budget.roles);
    assert.deepEqual([...packet.procedures].sort(), [...budget.procedures].sort());
    const bytes = [...STANDING, ...packet.procedures].reduce((total, path) => total + statSync(join(process.cwd(), path)).size, 0);
    assert.ok(bytes <= budget.bytes, `${budget.name} standing + procedure bytes ${bytes} exceed the ${budget.bytes} budget`);
  });
}

// The gates that force `evidence-run` rather than an attested claim. Retiring one of these ids means
// the result it stands for is proven somewhere else, or it is no longer proven at all.
test("runtime-required evidence steps stay runtime-required", () => {
  const policy = JSON.parse(readFileSync(join(process.cwd(), "schemas", "workflow-policy.json"), "utf8"));
  const declared = new Set();
  for (const capability of policy.capabilities) {
    for (const step of capability.steps || []) {
      if (capability.runtime_execution === "required" || step.runtime_execution === "required") declared.add(`${capability.name}.${step.id}`);
    }
  }
  for (const id of ["delivery_validation.DV1", "baseline_validation.BV2", "regression_validation.RV3", "mutation_validation.MV4", "operational_verification.OV2"]) {
    assert.ok(declared.has(id), `${id} no longer requires runtime evidence: ${JSON.stringify([...declared])}`);
  }
});
