import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

function sourceFiles(directory) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) result.push(full);
  }
  return result;
}

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const cli = join(root, "dist", "agent-workflow.mjs");

test("workflow documents preserve focused work and the ordered slice loop", () => {
  const evidence = read(".agents/skills/workflow/evidence.md");
  const review = read(".agents/skills/workflow/review.md");
  const runtime = read("docs/modules/workflow-runtime.md");
  const readme = read("README.md");
  assert.match(evidence, /`focused` file-local work follows `implementation -> focused feedback` directly/);
  assert.match(readme, /直接走 `implementation -> focused feedback`/);
  assert.match(runtime, /expanded: ordered slice .*local feedback > next dependent slice > all slices complete/);
  assert.match(evidence, /goal, scope, acceptance\s+criteria, local verification command, and dependencies/);
  assert.match(evidence, /Before the first formal evidence batch, reuse the compiled plan/);
  assert.match(evidence, /classification_incomplete/);
  assert.match(evidence, /dependent slice waits until the previous\s+slice's local feedback passes/);
  assert.match(evidence, /`evidence-run` the affected\/regression checks, batching every requirement id that command covers,\s+including `delivery_validation\.DV1`/);
  assert.match(evidence, /Read-only\s+review leaves the receipt reusable/);
  assert.match(evidence, /Do\s+not add a human approval or a second Reviewer to every slice/);
  assert.match(evidence, /Each\s+slice receives local feedback only/);
  assert.match(evidence, /timing in \[review\.md\]\(review\.md\)/);
  assert.equal((evidence.match(/^## Finalization$/gm) || []).length, 1, "the final sequence has one owner section");
  assert.match(review, /正式 Reviewer 以整個 task 的穩定交付為單位執行/);
  assert.match(review, /第一輪 `pre-review` 快照/);
  assert.match(review, /需要獨立發布、不可逆外部操作或不可回溯前提的範圍，建立獨立 task/);
  assert.match(review, /暫停或恢復同一 task 不會改變這個 review boundary/);

  const stable = runtime.indexOf("all slices complete");
  const regression = runtime.indexOf("affected/regression", stable);
  const reviewer = runtime.indexOf("Reviewer", regression);
  const dv1 = runtime.indexOf("DV1", regression);
  const close = runtime.indexOf("close-task", reviewer);
  assert.ok(stable >= 0 && regression > stable && dv1 > regression && reviewer > dv1 && close > reviewer, "stable validation can cover DV1 before read-only review and gated close");
  assert.doesNotMatch(runtime, /> task-gate > close-task/);
});

test("active contract no longer exposes workflow cost artifacts, timing flags, or timing fields", () => {
  assert.equal(existsSync(join(root, "tests-node", "workflow-cost.test.mjs")), false);
  assert.equal(existsSync(join(root, "docs", "replay-benchmark.md")), false);
  const cliSource = read("src/cli.ts");
  assert.doesNotMatch(cliSource, /started-at|duration-ms/);
  const evidenceSource = read("src/lifecycle/evidence.ts");
  assert.doesNotMatch(evidenceSource, /started_at|duration_ms|startedAt|durationMs/);
  const schema = JSON.parse(read("schemas/task.schema.json"));
  assert.equal(schema.properties.schema_version.const, 6);
  const step = schema.$defs.stepEvidence;
  const executionRule = step.allOf.find((rule) => rule.if?.properties?.evidence_kind?.const === "execution");
  assert.deepEqual(executionRule.then.required.sort(), ["command", "cwd", "delivery_fingerprint", "delivery_mode", "delivery_paths", "exit_code", "output_digest"].sort());
  assert.equal(Object.hasOwn(step.properties, "started_at"), false);
  assert.equal(Object.hasOwn(step.properties, "duration_ms"), false);
  assert.doesNotMatch(readmeWithoutLegacyBenchmark(), /replay-benchmark|procedure budget/);
  // workflow_mode/model_profile/validation_profile were legacy-compatibility or inert fields with
  // no active plan_hash or gate consumer; schema v6 drops them from the active contract.
  for (const field of ["workflow_mode", "model_profile", "validation_profile"]) assert.equal(Object.hasOwn(schema.properties, field), false, field);
});

function readmeWithoutLegacyBenchmark() {
  return read("README.md");
}

test("removed evidence CLI flags are rejected by the active parser", () => {
  const result = spawnSync(process.execPath, [cli, "evidence-record", "--started-at", "2026-01-01T00:00:00.000Z"], { cwd: root, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown option\(s\).*--started-at/);
  const duration = spawnSync(process.execPath, [cli, "evidence-record", "--duration-ms", "10"], { cwd: root, encoding: "utf8" });
  assert.notEqual(duration.status, 0);
  assert.match(duration.stderr, /Unknown option\(s\).*--duration-ms/);
});

test("v4 execution evidence migrates to the latest schema once and preserves the original backup", () => {
  const stateRoot = join(tmpdir(), `agent-workflow-flow-migration-${process.pid}-${Date.now()}`);
  const task = join(stateRoot, "projects", "project", "tasks", "timed");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Migration\n\n## Goal\n\nMigrate evidence.\n\n## Scope\n\nFixture.\n\n## Completion criteria\n\n- [ ] migrated\n");
  const legacy = { schema_version: 4, id: "timed", evidence: [{ kind: "step", evidence_kind: "execution", id: "delivery_validation.DV1", status: "recorded", at: "2026-01-01T00:00:00.000Z", plan_hash: "a".repeat(64), plan_revision: 1, intent_hash: "b".repeat(64), summary: "legacy", command: "node", cwd: ".", exit_code: 0, started_at: "2026-01-01T00:00:00.000Z", duration_ms: 10, output_digest: "c".repeat(64), delivery_mode: "workspace", delivery_paths: ["src"], delivery_fingerprint: "d".repeat(64) }] };
  writeFileSync(join(task, "task.json"), JSON.stringify(legacy));
  const run = () => spawnSync(process.execPath, [cli, "migrate-state", "--state-root", stateRoot], { cwd: root, encoding: "utf8" });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const firstBody = JSON.parse(first.stdout);
  const migrated = JSON.parse(readFileSync(join(task, "task.json"), "utf8"));
  assert.equal(migrated.schema_version, 6);
  assert.equal(migrated.evidence[0].started_at, undefined);
  assert.equal(migrated.evidence[0].duration_ms, undefined);
  assert.ok(existsSync(join(firstBody.backup, "tasks", "project", "tasks", "timed", "task.json")));
  const once = readFileSync(join(task, "task.json"), "utf8");
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(join(task, "task.json"), "utf8"), once);
});

test("lifecycle finalization stays a single authority: only transitions.ts closes a task, orchestration never imports the gate", () => {
  const closers = sourceFiles(join(root, "src"))
    .filter((file) => file !== join(root, "src", "lifecycle", "transitions.ts"))
    .filter((file) => /applyTransition\(\s*[^)]*"close"|transitionTask\([^)]*"close"/.test(readFileSync(file, "utf8")));
  assert.deepEqual(closers, [], "only lifecycle/transitions.ts may drive the close transition");

  const protocol = read("src/orchestration/protocol.ts");
  assert.doesNotMatch(protocol, /lifecycle\/task-gate/, "orchestration must not re-evaluate the gate itself; the parent coordinator runs task-gate after Apply");
});
