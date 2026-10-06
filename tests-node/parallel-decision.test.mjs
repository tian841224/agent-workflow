import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cli = join(process.cwd(), "dist/agent-workflow.mjs");
const run = (args, input) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", input });
const ok = (result) => { assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout); };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "parallel-decision-"));
  const repo = join(root, "repo"), state = join(root, "state");
  mkdirSync(repo); mkdirSync(state);
  for (const args of [["init", "-q"], ["config", "user.name", "test"], ["config", "user.email", "test@example.invalid"]]) assert.equal(spawnSync("git", ["-C", repo, ...args]).status, 0);
  writeFileSync(join(repo, "base.txt"), "base\n");
  for (const args of [["add", "."], ["commit", "-qm", "base"]]) assert.equal(spawnSync("git", ["-C", repo, ...args]).status, 0);
  const plan = { repo_root: repo, parallel_reason: "Two substantial independent slices save time after handoff and integration.", min_files_per_worker: 999,
    workers: ["api", "ui"].map(id => ({ id, goal: id, completion_criteria: id + " checks pass", file_ownership: [id + ".txt"] })) };
  function action(action, value = plan, extra = []) {
    const path = join(state, "plan.json"); writeFileSync(path, JSON.stringify(value));
    return run(["orchestrate", "--protocol", "3", "--action", action, "--id", "batch", "--state-root", state, "--plan-path", path, ...extra]);
  }
  function parent(flags = [], overrides = {}, cases = "") {
    const dir = join(state, "20260101-000000-parent"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task.md"), "# Parent\n\n## Goal\n\nDeliver slices.\n\n## Scope\n\nIndependent work.\n\n## Completion criteria\n\n- [ ] checks pass\n" + cases);
    const init = ok(run(["task-init", "--task-path", dir, "--repo-root", repo, "--state-root", state], JSON.stringify({
      managed_change: true, code_change: false, task_type: "refactor", impact_scope: "file", impact_effect: "contract", impact_confidence: "high", risk_flags: flags, ...overrides
    })));
    plan.parent_task_path = join(dir, "task.json");
    ok(run(["approve-intent", "--task-path", dir, "--confirmed-by", "test"]));
    return { init, task: JSON.parse(readFileSync(plan.parent_task_path, "utf8")) };
  }
  return { root, repo, state, plan, action, parent };
}
function withFixture(fn) { const f = fixture(); try { fn(f); } finally { rmSync(f.root, { recursive: true, force: true }); } }

test("managed tasks emit no framework candidacy or mandatory subagent assessment", () => withFixture(f => {
  const { init, task } = f.parent();
  assert.equal(Object.hasOwn(init, "parallel_hint"), false);
  assert.doesNotMatch(JSON.stringify(init.next), /assess independent work|parallel_hint/);
  assert.ok(!init.procedures.some(path => path.endsWith("orchestration.md")));
  const assessed = ok(f.action("Assess"));
  assert.equal(assessed.eligible, true);
  for (const key of ["recommendation", "worthwhile", "parallel_reason"]) assert.equal(Object.hasOwn(assessed, key), false);
  assert.equal(existsSync(join(f.state, "orchestration")), false);
  assert.equal(assessed.worker_count, 2);
}));
test("optional legacy rationale does not select an execution mode", () => withFixture(f => {
  assert.equal(ok(f.action("Assess", { ...f.plan, parallel_reason: "" })).eligible, true);
  const withoutReason = { ...f.plan }; delete withoutReason.parallel_reason;
  assert.equal(ok(f.action("Assess", withoutReason)).eligible, true);
  assert.equal(ok(f.action("Assess", { ...f.plan, parallel_reason: " " })).eligible, true);
  const workers = f.plan.workers.map(w => ({ ...w, completion_criteria: "" }));
  assert.equal(ok(f.action("Assess", { ...f.plan, workers })).eligible, false);
}));
test("parent risk flags do not decide whether native subagents are used", () => {
  for (const flag of ["schema", "migration", "irreversible", "unclear_requirements"]) withFixture(f => {
    const { init } = f.parent([flag]);
    assert.equal(Object.hasOwn(init, "parallel_hint"), false);
    assert.equal(ok(f.action("Assess")).eligible, true);
    assert.equal(f.action("Prepare").status, 0);
  });
});
test("coordinator risk scopes reject malformed paths and ownership overlap in both directions", () => withFixture(f => {
  f.parent(["schema"]);
  for (const risk of [
    { flag: "schema", paths: [], reason: "independent" },
    { flag: "schema", paths: ["db"], reason: "" },
    { flag: "schema", paths: ["../escape"], reason: "independent" },
    { flag: "schema", paths: ["/escape"], reason: "independent" },
    { flag: "schema", paths: ["api.txt/child"], reason: "independent" },
    { flag: "schema", paths: ["api.txt"], reason: "independent" },
    { flag: "unclear_requirements", paths: ["db"], reason: "independent" },
    { flag: "schema", paths: "db", reason: "independent" },
    { flag: "schema", paths: ["."], reason: "independent" },
    { flag: "schema", paths: ["db/./migration.sql"], reason: "independent" },
    { flag: "schema", paths: ["db//migration.sql"], reason: "independent" },
    { flag: "schema", paths: ["db/../migration.sql"], reason: "independent" },
    { flag: "schema", paths: [42], reason: "independent" },
    { flag: "schema", paths: ["db"], reason: 42 }
  ]) {
    const plan = { ...f.plan, coordinator_risks: [risk] };
    assert.equal(ok(f.action("Assess", plan)).eligible, false, JSON.stringify(risk));
    assert.notEqual(f.action("Prepare", plan).status, 0, JSON.stringify(risk));
  }
  const plan = { ...f.plan, workers: f.plan.workers.map((w,i) => i ? w : { ...w, file_ownership: ["db/child"] }), coordinator_risks: [{ flag: "schema", paths: ["db"], reason: "coordinator owns ordered migration" }] };
  assert.equal(ok(f.action("Assess", plan)).eligible, false);
}));

test("focused code tasks with two acceptance cases can split one-file work packages", () => withFixture(f => {
  const cases = "\n### Acceptance cases\n\n" + ["API", "UI"].map((name, index) => `- **AC${index + 1}** ${name}\n  - Given ${name}\n  - When checked\n  - Then passes\n  - Verify: \`node --version\`\n`).join("");
  const { init } = f.parent([], { code_change: true, impact_effect: "local_behavior" }, cases);
  assert.equal(init.plan.exploration_profile, "focused");
  assert.equal(Object.hasOwn(init, "parallel_hint"), false);
  assert.ok(!init.procedures.some(path => path.endsWith("orchestration.md")));
  f.plan.workers.forEach((worker, index) => { worker.acceptance = [`AC${index + 1}`]; worker.planned_files = [worker.file_ownership[0]]; });
  assert.equal(ok(f.action("Assess")).eligible, true);
}));

test("schema validation rejects coerced decision fields and worker parents cannot resplit", () => withFixture(f => {
  assert.equal(ok(f.action("Assess", { ...f.plan, parallel_reason: 42 })).eligible, false);
  assert.equal(ok(f.action("Assess", { ...f.plan, coordinator_risks: "schema" })).eligible, false);
  for (const scope of [".", "api.txt/./child", "api.txt//child"]) {
    const workers = f.plan.workers.map((worker, index) => index ? worker : { ...worker, file_ownership: [scope] });
    assert.equal(ok(f.action("Assess", { ...f.plan, workers })).eligible, false, scope);
  }
  const { init } = f.parent([], { subtask_role: "worker", parent_task_id: "20260101-000000-owner" });
  assert.equal(Object.hasOwn(init, "parallel_hint"), false);
  assert.ok(!init.procedures.some(path => path.endsWith("orchestration.md")));
  assert.equal(ok(f.action("Assess")).eligible, false);
}));

test("completion-only legacy workers retain criteria across both Retry paths", () => withFixture(f => {
  const legacyPlan = { ...f.plan };
  delete legacyPlan.parallel_reason;
  const batch = ok(f.action("Prepare", legacyPlan)).batch;
  const statePath = join(f.state, "orchestration", "v3", "batch", "state.json");
  const legacyState = JSON.parse(readFileSync(statePath, "utf8"));
  delete legacyState.plan.parallel_reason;
  delete legacyState.plan.coordinator_risks;
  writeFileSync(statePath, JSON.stringify(legacyState));
  const worker = batch.workers[0];
  const criteria = f.plan.workers[0].completion_criteria;
  for (const withPlan of [false, true]) {
    ok(f.action("Bind", f.plan, ["--worker-id", worker.id, "--run-id", "run", "--platform", "test"]));
    const result = join(f.state, "blocked.json");
    writeFileSync(result, JSON.stringify({ status: "blocked", run_id: "run" }));
    ok(f.action("Collect", f.plan, ["--worker-id", worker.id, "--result-path", result]));
    const retried = withPlan
      ? ok(f.action("Retry", legacyPlan, ["--worker-id", worker.id])).batch
      : ok(run(["orchestrate", "--action", "Retry", "--id", "batch", "--state-root", f.state, "--worker-id", worker.id])).batch;
    const packet = JSON.parse(readFileSync(retried.workers[0].packet_path, "utf8"));
    assert.equal(packet.assignment.completion_criteria, criteria);
  }
}));
test("scoped risk packets prevent recursive orchestration and preserve scopes on Retry", () => withFixture(f => {
  f.parent(["schema"], {}, "\n### Acceptance cases\n\n- **AC1** API\n  - Given API\n  - When checked\n  - Then passes\n  - Verify: `node --version`\n- **AC2** UI\n  - Given UI\n  - When checked\n  - Then passes\n  - Verify: `node --version`\n");
  f.plan.workers[0].acceptance = ["AC1"]; f.plan.workers[1].acceptance = ["AC2"];
  f.plan.coordinator_risks = [{ flag: "schema", paths: ["db"], reason: "coordinator migrates after independent slices" }];
  f.plan.shared_files = ["contract.txt"];
  assert.equal(ok(f.action("Assess")).eligible, true);
  const batch = ok(f.action("Prepare")).batch;
  for (const worker of batch.workers) {
    const packet = JSON.parse(readFileSync(worker.packet_path, "utf8"));
    const child = JSON.parse(readFileSync(worker.task_path, "utf8"));
    assert.equal(child.subtask_role, "worker");
    assert.ok(!packet.procedures.some(path => path.endsWith("orchestration.md")));
    assert.deepEqual(packet.assignment.shared_files_read_only.sort(), ["contract.txt", "db"]);
  }
  const worker = batch.workers[0];
  ok(f.action("Bind", f.plan, ["--worker-id", worker.id, "--run-id", "run", "--platform", "test"]));
  const result = join(f.state, "blocked.json"); writeFileSync(result, JSON.stringify({ status: "blocked", run_id: "run" }));
  ok(f.action("Collect", f.plan, ["--worker-id", worker.id, "--result-path", result]));
  const widened = { ...f.plan, coordinator_risks: [], workers: f.plan.workers.map(w => w.id === worker.id ? { ...w, file_ownership: ["db"] } : w) };
  const denied = f.action("Retry", widened, ["--worker-id", worker.id]); assert.notEqual(denied.status, 0); assert.match(denied.stderr, /overlaps/);
  const retried = ok(f.action("Retry", f.plan, ["--worker-id", worker.id])).batch;
  const packet = JSON.parse(readFileSync(retried.workers[0].packet_path, "utf8"));
  assert.deepEqual(packet.assignment.shared_files_read_only.sort(), ["contract.txt", "db"]);
  assert.equal(packet.assignment.attempt, 2);
}));
test("parent acceptance distribution rejects omitted duplicated and unknown cases", () => withFixture(f => {
  f.parent([], {}, "\n### Acceptance cases\n\n- **AC1** API\n  - Given API\n  - When checked\n  - Then passes\n  - Verify: `node --version`\n- **AC2** UI\n  - Given UI\n  - When checked\n  - Then passes\n  - Verify: `node --version`\n");
  f.plan.workers[0].acceptance = ["AC1"]; f.plan.workers[1].acceptance = ["AC2"];
  assert.equal(ok(f.action("Assess")).eligible, true);
  for (const ids of [[], ["AC1"], ["AC3"]]) {
    const plan = { ...f.plan, workers: [f.plan.workers[0], { ...f.plan.workers[1], acceptance: ids }] };
    assert.equal(ok(f.action("Assess", plan)).eligible, false);
    assert.notEqual(f.action("Prepare", plan).status, 0);
  }
}));
test("legacy plans prepare without new optional decision fields", () => withFixture(f => {
  const { parallel_reason, ...legacy } = f.plan;
  const batch = ok(f.action("Prepare", legacy)).batch;
  assert.equal(batch.workers.length, 2);
}));

test("agent can choose one worker while split integrity remains mandatory", () => withFixture(f => {
  const single = { ...f.plan, max_workers: 1, workers: [f.plan.workers[0]] };
  delete single.parallel_reason;
  assert.equal(ok(f.action("Assess", single)).eligible, true);
  assert.equal(ok(f.action("Prepare", single)).batch.workers.length, 1);
  for (const overrides of [{has_order_dependency:true}, {shared_persistent_state:true}, {workers:[]}, {max_workers:0}]) {
    assert.equal(ok(f.action("Assess", {...f.plan, ...overrides})).eligible, false);
  }
  const overlapping = {...f.plan, workers:f.plan.workers.map(w => ({...w, file_ownership:["same.txt"]}))};
  assert.equal(ok(f.action("Assess", overlapping)).eligible, false);
  for (const scopes of [["src/", "src/file.ts"], ["src/", "src"], ["src/file.ts", "src/"], ["src", "src/"]]) {
    const plan = { ...f.plan, workers: f.plan.workers.map((worker, index) => ({ ...worker, planned_files: [], file_ownership: [scopes[index]] })) };
    assert.match(ok(f.action("Assess", plan)).errors.join(";"), /ownership overlaps/);
    assert.notEqual(f.action("Prepare", plan).status, 0);
  }
}));
