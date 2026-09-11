import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

test("migration preserves a task backup and marks legacy evidence unverified", () => {
  const root = join(tmpdir(), `agent-workflow-migration-${process.pid}-${Date.now()}`);
  const task = join(root, "projects", "project", "tasks", "legacy"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "---\nid: legacy\nstatus: in_progress\n---\n\nlegacy intent\n");
  const result = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "migrate-state", "--state-root", root], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).migrated, true);
  const migratedJson = JSON.parse(readFileSync(join(task, "task.json"), "utf8"));
  // 單次 migrate-state 會把 v1 task.md 一路遷到最新 schema（v1→v2→v3→v4→v5 在同一次呼叫內串接執行）
  assert.equal(migratedJson.schema_version, 5);
  assert.equal(migratedJson.evidence[0].kind, "legacy-unverified");
  assert.equal(migratedJson.evidence[0].status, "needs_reverification");
  assert.ok(existsSync(join(task, "task.md")));
  const migratedMd = readFileSync(join(task, "task.md"), "utf8");
  assert.doesNotMatch(migratedMd, /^---/);
  assert.match(migratedMd, /legacy intent/);
});

test("a schema_version 2 frozen task migrates to schema_version 5 with intent_approval cleared and legacy-unverified evidence", () => {
  const root = join(tmpdir(), `agent-workflow-migration-v3-${process.pid}-${Date.now()}`);
  const task = join(root, "projects", "project", "tasks", "frozen-task"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Frozen task\n\n## Goal\n\nMigrate this task to schema v5.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  writeFileSync(join(task, "task.json"), JSON.stringify({
    schema_version: 2, id: "frozen-task",
    lifecycle: { status: "frozen", frozen_at: "2026-01-01T00:00:00.000Z", transitions: [] },
    evidence: [{ kind: "legacy-unverified", verified: false }]
  }));
  const result = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "migrate-state", "--state-root", root], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).migrated, true);
  const migrated = JSON.parse(readFileSync(join(task, "task.json"), "utf8"));
  assert.equal(migrated.schema_version, 5);
  assert.equal(migrated.lifecycle.status, "in_progress");
  assert.equal(migrated.lifecycle.frozen_at, undefined);
  // v3's intent_approval (populated by the v2->v3 step from frozen_at) cannot be safely reinterpreted
  // as v4's intent_hash (a different hash over different content), so v3->v4 clears it — a real
  // re-approve-intent is required, not a silently-carried-over approval.
  assert.equal(migrated.intent_approval, null);
  assert.ok(Number.isInteger(migrated.state_revision));
  assert.ok(Number.isInteger(migrated.plan_revision));
  assert.equal(migrated.evidence[0].kind, "legacy-unverified");
  assert.equal(migrated.evidence[0].status, "needs_reverification");
});

test("re-running migrate-state against an already-migrated task.json produces no further change", () => {
  const root = join(tmpdir(), `agent-workflow-migration-idempotent-${process.pid}-${Date.now()}`);
  const task = join(root, "projects", "project", "tasks", "frozen-task"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Frozen task\n\n## Goal\n\nMigrate this task to schema v5.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
  writeFileSync(join(task, "task.json"), JSON.stringify({
    schema_version: 2, id: "frozen-task",
    lifecycle: { status: "frozen", frozen_at: "2026-01-01T00:00:00.000Z", transitions: [] },
    evidence: [{ kind: "legacy-unverified", verified: false }]
  }));
  const run = () => spawnSync(process.execPath, ["dist/agent-workflow.mjs", "migrate-state", "--state-root", root], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(run().status, 0);
  const once = readFileSync(join(task, "task.json"), "utf8");
  assert.equal(run().status, 0);
  const twice = readFileSync(join(task, "task.json"), "utf8");
  assert.equal(once, twice, "a second migrate-state run must not touch an already-v5 task.json");
});

test("schema v4 execution evidence migrates to v5 with a backup and without timing fields", () => {
  const root = join(tmpdir(), `agent-workflow-migration-v4-v5-${process.pid}-${Date.now()}`);
  const task = join(root, "projects", "project", "tasks", "timed-task"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Timed task\n\n## Goal\n\nStrip obsolete execution timing fields.\n\n## Scope\n\nMigration fixture.\n\n## Completion criteria\n\n- [ ] fixture is migrated\n");
  const legacy = {
    schema_version: 4, id: "timed-task", evidence: [{ kind: "step", id: "delivery_validation.DV1", status: "recorded", at: "2026-01-01T00:00:00.000Z", plan_hash: "a".repeat(64), plan_revision: 1, intent_hash: "b".repeat(64), summary: "legacy execution", evidence_kind: "execution", command: "npm test", cwd: ".", exit_code: 0, started_at: "2026-01-01T00:00:00.000Z", duration_ms: 42, output_digest: "c".repeat(64), delivery_mode: "workspace", delivery_paths: ["src"], delivery_fingerprint: "d".repeat(64) }]
  };
  writeFileSync(join(task, "task.json"), JSON.stringify(legacy));
  const beforeDryRun = readFileSync(join(task, "task.json"), "utf8");
  const dryRun = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "migrate-state", "--state-root", root, "--dry-run"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).migrated_schema_v5, 1);
  assert.equal(readFileSync(join(task, "task.json"), "utf8"), beforeDryRun);
  assert.equal(existsSync(JSON.parse(dryRun.stdout).backup), false);
  const result = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "migrate-state", "--state-root", root], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.migrated_schema_v5, 1);
  const migrated = JSON.parse(readFileSync(join(task, "task.json"), "utf8"));
  assert.equal(migrated.schema_version, 5);
  assert.equal(migrated.evidence[0].started_at, undefined);
  assert.equal(migrated.evidence[0].duration_ms, undefined);
  const backup = join(output.backup, "tasks", "project", "tasks", "timed-task", "task.json");
  assert.ok(existsSync(backup), `missing migration backup: ${backup}`);
  const preserved = JSON.parse(readFileSync(backup, "utf8"));
  assert.equal(preserved.evidence[0].started_at, legacy.evidence[0].started_at);
  const once = readFileSync(join(task, "task.json"), "utf8");
  const second = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "migrate-state", "--state-root", root], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).migrated_schema_v5, 0);
  assert.equal(readFileSync(join(task, "task.json"), "utf8"), once);
});
