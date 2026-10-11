import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const cli = join(process.cwd(), "dist", "agent-workflow.mjs");
const isolatedEnv = { ...process.env };
delete isolatedEnv.CODEX_THREAD_ID;
const role = "agent-workflow-reader";
const subtask = (id, overrides = {}) => ({ id, role, scope: `Read the ${id} contract`, dependencies: [], read_paths: ["src/shared.ts"], write_paths: [], acceptance: [`Locate the ${id} evidence`], ...overrides });
const assessment = (overrides = {}) => ({ task_size: "large", mode: "parallel", parallel_benefit: "sufficient", reason: "Independent questions can be answered at the same time.", subtasks: [subtask("a"), subtask("b")], ...overrides });
const single = () => assessment({ task_size: "small", mode: "single", parallel_benefit: "insufficient", reason: "Only one bounded lookup is needed.", subtasks: [subtask("a")] });

function fixture(patch = {}, env = isolatedEnv) {
  const root = mkdtempSync(join(tmpdir(), "agent-workflow-codex-"));
  const directory = join(root, "20260101-000000-codex-test");
  mkdirSync(directory);
  const path = join(directory, "task.json");
  writeFileSync(join(directory, "task.md"), "# Codex delegation\n\n## Goal\n\nVerify native delegation gates.\n\n## Scope\n\nRead-only fixture contract.\n\n## Completion criteria\n\n- [ ] The fixture gate passes.\n");
  const run = (command, input, runEnv = env) => {
    const result = spawnSync(process.execPath, [cli, command, "--task-path", path, "--repo-root", process.cwd(), ...(command === "task-init" || command === "close-task" || command === "task-write" ? ["--state-root", join(root, "state")] : [])], { cwd: process.cwd(), input: input === undefined ? undefined : JSON.stringify(input), encoding: "utf8", env: runEnv });
    assert.ok(result.stdout.trim(), result.stderr);
    return { status: result.status, ...JSON.parse(result.stdout) };
  };
  const created = run("task-init", { code_change: false, managed_change: false, task_type: "read_only", ...patch });
  return { path, root, run, created, state: () => JSON.parse(readFileSync(path, "utf8")) };
}

function receipts(plan, { serial = false, ids = ["/root/a", "/root/b"] } = {}) {
  const base = Date.now() - 1000;
  const at = (tick) => new Date(base + tick).toISOString();
  const native_agents = plan.subtasks.map((item, index) => ({ agent_id: ids[index], subtask_id: item.id, role: item.role, scope: item.scope, spawned_at: at(serial ? index * 3 : 0), spawn_evidence: `spawn_agent returned ${ids[index]}` }));
  const observation = (tick, statuses) => ({ source: "list_agents", observed_at: at(tick), agents: statuses, evidence: JSON.stringify({ agents: statuses }) });
  const statuses = (status) => ids.map((agent_id) => ({ agent_id, status }));
  const observations = serial
    ? ids.flatMap((agent_id, index) => [observation(index * 3 + 1, [{ agent_id, status: "running" }]), observation(index * 3 + 2, [{ agent_id, status: "completed" }])])
    : [observation(1, statuses("running")), observation(2, statuses("completed"))];
  return { native_agents, observations };
}

test("Codex identification persists; assessment is a readiness gap and native work is a close gap", () => {
  const f = fixture({}, { ...isolatedEnv, CODEX_THREAD_ID: "fixture-native-thread" });
  assert.equal(f.created.valid, true);
  assert.equal(f.state().execution_platform, "Codex");
  assert.equal(f.created.readiness.ready, false);
  assert.ok(f.created.next.some((item) => /codex_delegation/.test(item.command)));
  assert.equal(f.run("task-gate", undefined, isolatedEnv).valid, false, "persisted platform must survive removal of the environment marker");
  assert.equal(f.run("close-task").valid, false);
  for (const execution_platform of ["Claude", null]) {
    const before = readFileSync(f.path, "utf8");
    const result = f.run("task-write", { execution_platform });
    assert.equal(result.valid, false);
    assert.match(result.errors.join(" "), /cannot be removed or changed once Codex/);
    assert.equal(readFileSync(f.path, "utf8"), before);
  }
  const planned = f.run("task-write", { codex_delegation: { assessment: single() } });
  assert.equal(planned.valid, true);
  assert.match(f.run("task-gate").errors.join(" "), /no fresh native agent ID/);
  assert.equal(f.run("task-write", { codex_delegation: receipts(single(), { ids: ["/root/a"] }) }).valid, true);
  assert.equal(f.run("task-gate").valid, true);
  assert.equal(f.run("close-task").valid, true);
});

test("legacy and other-platform tasks retain their gate, while Codex child tasks do not recursively delegate", () => {
  const legacy = fixture();
  assert.equal(legacy.run("task-gate", undefined, { ...isolatedEnv, CODEX_THREAD_ID: "current-thread" }).valid, true);
  for (const execution_platform of ["Claude", "Antigravity"]) assert.equal(fixture({ execution_platform }).run("task-gate").valid, true);
  const child = fixture({ execution_platform: "Codex", subtask_role: "worker", parent_task_id: "20260101-000000-parent" });
  assert.equal(child.run("task-gate").valid, true);
  assert.equal(fixture({ execution_platform: "Codex", subtask_role: "worker" }).created.valid, false, "worker exemption must include its parent binding");
});

test("parallel snapshots permit overlapping reader files and reject completed sequential spawns", () => {
  const plan = assessment();
  const parallel = fixture({ execution_platform: "Codex", codex_delegation: { assessment: plan } });
  assert.equal(parallel.created.readiness.ready, true, "ready to dispatch without completed evidence");
  assert.equal(parallel.run("task-write", { codex_delegation: receipts(plan) }).valid, true);
  assert.equal(parallel.run("task-gate").valid, true);
  const serial = fixture({ execution_platform: "Codex", codex_delegation: { assessment: plan } });
  assert.equal(serial.run("task-write", { codex_delegation: receipts(plan, { serial: true }) }).valid, true);
  assert.match(serial.run("task-gate").errors.join(" "), /sequential spawns do not prove overlap/);
});

test("assessment enforces decision, dependencies and exclusive writes without requiring a fixed role chain", () => {
  const invalid = [
    [assessment({ mode: "sequential" }), /must run in parallel/],
    [assessment({ subtasks: [subtask("a", { dependencies: ["missing"] }), subtask("b")] }), /unknown dependency/],
    [assessment({ subtasks: [subtask("a", { dependencies: ["b"] }), subtask("b", { dependencies: ["a"] })] }), /dependency cycle/],
    [assessment({ subtasks: [subtask("a", { write_paths: ["src/a.ts"] }), subtask("b")] }), /must be read-only/],
    [assessment({ subtasks: [subtask("a", { role: "agent-workflow-worker", write_paths: ["src/"] }), subtask("b", { role: "agent-workflow-worker", write_paths: ["src/a.ts"] })] }), /write ownership overlaps/]
  ];
  if (process.platform === "win32") invalid.push([assessment({ subtasks: [subtask("a", { role: "agent-workflow-worker", write_paths: ["SRC/A.ts"] }), subtask("b", { role: "agent-workflow-worker", write_paths: ["src/a.ts"] })] }), /write ownership overlaps/]);
  for (const [plan, expected] of invalid) {
    const f = fixture({ execution_platform: "Codex", codex_delegation: { assessment: plan } });
    assert.equal(f.created.valid, true);
    assert.match(f.run("task-gate").errors.join(" "), expected);
  }
  const bounded = single();
  bounded.subtasks[0] = subtask("a", { role: "agent-workflow-worker", write_paths: ["src/a.ts"] });
  assert.equal(fixture({ execution_platform: "Codex", codex_delegation: { assessment: bounded } }).created.readiness.ready, true);
  for (const path of ["../src", "./src", "src/../other", "src//a", "src/*"]) {
    const invalidPath = single(); invalidPath.subtasks[0].read_paths = [path];
    assert.equal(fixture({ execution_platform: "Codex", codex_delegation: { assessment: invalidPath } }).created.valid, false, path);
  }
});

test("assessment round trips invalidate old observations; append-only receipts cannot supply freshness metadata", () => {
  const plan = assessment();
  const f = fixture({ execution_platform: "Codex", codex_delegation: { assessment: plan } });
  assert.equal(f.run("task-write", { codex_delegation: receipts(plan) }).valid, true);
  const original = f.state();
  assert.equal(f.run("task-gate").valid, true);
  assert.equal(f.run("task-write", { codex_delegation: { observations: [] } }).valid, true);
  assert.equal(f.state().codex_delegation.assessment_revision, 1);
  assert.equal(f.run("task-write", { codex_delegation: { assessment: { ...plan, reason: "Reassess the ownership and dependency boundaries." } } }).valid, true);
  assert.equal(f.run("task-write", { codex_delegation: { assessment: plan } }).valid, true);
  assert.equal(f.state().codex_delegation.assessment_revision, 3);
  assert.match(f.run("task-gate").errors.join(" "), /no fresh native agent ID/);
  assert.equal(f.state().codex_delegation.native_agents.length, original.codex_delegation.native_agents.length);
  assert.equal(f.run("task-write", { codex_delegation: receipts(plan) }).valid, false, "old native IDs cannot be restamped into a new assessment");
  assert.equal(f.run("task-write", { codex_delegation: { assessment_revision: 1 } }).valid, false);
  assert.equal(f.run("task-write", { codex_delegation: { native_agents: [{ ...receipts(plan).native_agents[0], agent_id: "/root/forged", assessment_hash: "a".repeat(64) }] } }).valid, false);
});

test("native snapshots require known distinct IDs, role/scope matching and latest terminal observations", () => {
  const plan = assessment();
  const variants = [
    [(data) => { data.native_agents[1].role = "agent-workflow-worker"; }, /role and scope/],
    [(data) => { data.observations[0].agents[1].agent_id = "/root/unknown"; }, /unknown agent ID/],
    [(data) => { data.observations[0].agents[1].agent_id = data.observations[0].agents[0].agent_id; }, /repeats agent ID/],
    [(data) => { data.native_agents[1].subtask_id = "a"; data.native_agents[1].scope = plan.subtasks[0].scope; }, /at least two running agent IDs/],
    [(data) => { data.observations.pop(); }, /observed terminal status/],
    [(data) => { data.observations[1].agents[1].status = "running"; }, /observed terminal status/],
    [(data) => { data.observations[1].observed_at = data.native_agents[0].spawned_at; }, /chronological/]
  ];
  for (const [change, expected] of variants) {
    const f = fixture({ execution_platform: "Codex", codex_delegation: { assessment: plan } });
    const data = receipts(plan); change(data);
    assert.equal(f.run("task-write", { codex_delegation: data }).valid, true);
    assert.match(f.run("task-gate").errors.join(" "), expected);
  }
  const repeated = fixture({ execution_platform: "Codex", codex_delegation: { assessment: plan } });
  assert.equal(repeated.run("task-write", { codex_delegation: receipts(plan, { ids: ["/root/a", "/root/a"] }) }).valid, false);
});

test("a failed native attempt can be replaced; concurrent attempts of one subtask cannot prove parallelism", () => {
  const plan = single();
  const f = fixture({ execution_platform: "Codex", codex_delegation: { assessment: plan } });
  const first = receipts(plan, { ids: ["/root/failed"] });
  first.observations[1].agents[0].status = "failed";
  assert.equal(f.run("task-write", { codex_delegation: first }).valid, true);
  assert.match(f.run("task-gate").errors.join(" "), /at least one observed completed/);
  assert.equal(f.run("task-write", { codex_delegation: receipts(plan, { ids: ["/root/retry"] }) }).valid, true);
  assert.equal(f.run("task-gate").valid, true);
  const running = { source: "list_agents", observed_at: new Date().toISOString(), agents: [{ agent_id: "/root/retry", status: "running" }], evidence: "native followup is running" };
  assert.equal(f.run("task-write", { codex_delegation: { observations: [running] } }).valid, true);
  assert.match(f.run("task-gate").errors.join(" "), /observed terminal status/, "an old completion cannot conceal the latest running status");
  assert.equal(f.run("task-write", { codex_delegation: { observations: [{ ...running, observed_at: new Date().toISOString(), agents: [{ agent_id: "/root/retry", status: "completed" }] }] } }).valid, true);
  assert.equal(f.run("task-gate").valid, true);
});

test("sequential decisions need a real reason and dependencies must complete before the next spawn", () => {
  const plan = assessment({ mode: "sequential", reason: "The second lookup consumes the first lookup's contract result.", subtasks: [subtask("a"), subtask("b", { dependencies: ["a"] })] });
  const f = fixture({ execution_platform: "Codex", codex_delegation: { assessment: plan } });
  assert.equal(f.created.readiness.ready, true);
  assert.equal(f.run("task-write", { codex_delegation: receipts(plan, { serial: true }) }).valid, true);
  assert.equal(f.run("task-gate").valid, true);
  const early = fixture({ execution_platform: "Codex", codex_delegation: { assessment: plan } });
  assert.equal(early.run("task-write", { codex_delegation: receipts(plan) }).valid, true);
  assert.match(early.run("task-gate").errors.join(" "), /before dependency a completed/);
  const blank = assessment({ mode: "sequential", parallel_benefit: "insufficient", reason: "  " });
  assert.equal(fixture({ execution_platform: "Codex", codex_delegation: { assessment: blank } }).created.valid, false);
});

test("missing task.md keeps the intent gate but does not falsely stale native observations", () => {
  const plan = single();
  const f = fixture({ execution_platform: "Codex", codex_delegation: { assessment: plan } });
  rmSync(join(dirname(f.path), "task.md"));
  assert.equal(f.run("task-write", { codex_delegation: receipts(plan, { ids: ["/root/intent-missing"] }) }).valid, true);
  const gate = f.run("task-gate");
  assert.equal(gate.valid, false, "missing intent remains a gate failure");
  assert.match(gate.errors.join(" "), /task.md requires human intent/);
  assert.ok(!gate.errors.some((error) => /no fresh native agent ID/.test(error)), gate.errors.join("; "));
});
