import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const cli = join(root, "dist", "agent-workflow.mjs");

test("workflow documents preserve focused work and the ordered slice loop", () => {
  const evidence = read(".agents/skills/workflow/evidence.md");
  const runtime = read("docs/modules/workflow-runtime.md");
  const readme = read("README.md");
  assert.match(evidence, /`focused` file-local work follows `implementation -> focused feedback` directly/);
  assert.match(readme, /直接走 `implementation -> focused feedback`/);
  assert.match(runtime, /expanded: ordered slice .*local feedback > next dependent slice > stable delivery/);
  assert.match(evidence, /goal, scope, acceptance\s+criteria, local verification command, and dependencies/);
  assert.match(evidence, /dependent slice waits until the previous\s+slice's local feedback passes/);
  assert.match(evidence, /After the slices are stable, run the\s+affected\/regression checks, Reviewer, and `delivery_validation\.DV1` final receipt in that order/);
  assert.match(evidence, /Do\s+not add a human approval or a second Reviewer to every slice/);

  const stable = runtime.indexOf("stable delivery");
  const regression = runtime.indexOf("affected/regression", stable);
  const reviewer = runtime.indexOf("Reviewer", regression);
  const dv1 = runtime.indexOf("DV1", reviewer);
  assert.ok(stable >= 0 && regression > stable && reviewer > regression && dv1 > reviewer, "final delivery gates must follow stable delivery");
});

test("active contract no longer exposes workflow cost artifacts, timing flags, or timing fields", () => {
  assert.equal(existsSync(join(root, "tests-node", "workflow-cost.test.mjs")), false);
  assert.equal(existsSync(join(root, "docs", "replay-benchmark.md")), false);
  const cliSource = read("src/cli.ts");
  assert.doesNotMatch(cliSource, /started-at|duration-ms/);
  const evidenceSource = read("src/lifecycle/evidence.ts");
  assert.doesNotMatch(evidenceSource, /started_at|duration_ms|startedAt|durationMs/);
  const schema = JSON.parse(read("schemas/task.schema.json"));
  assert.equal(schema.properties.schema_version.const, 5);
  const step = schema.$defs.stepEvidence;
  const executionRule = step.allOf.find((rule) => rule.if?.properties?.evidence_kind?.const === "execution");
  assert.deepEqual(executionRule.then.required.sort(), ["command", "cwd", "delivery_fingerprint", "delivery_mode", "delivery_paths", "exit_code", "output_digest"].sort());
  assert.equal(Object.hasOwn(step.properties, "started_at"), false);
  assert.equal(Object.hasOwn(step.properties, "duration_ms"), false);
  assert.doesNotMatch(readmeWithoutLegacyBenchmark(), /replay-benchmark|procedure budget/);
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

test("v4 execution evidence migrates to v5 once and preserves the original backup", () => {
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
  assert.equal(migrated.schema_version, 5);
  assert.equal(migrated.evidence[0].started_at, undefined);
  assert.equal(migrated.evidence[0].duration_ms, undefined);
  assert.ok(existsSync(join(firstBody.backup, "tasks", "project", "tasks", "timed", "task.json")));
  const once = readFileSync(join(task, "task.json"), "utf8");
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(join(task, "task.json"), "utf8"), once);
});
