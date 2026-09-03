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
  // 單次 migrate-state 會把 v1 task.md 一路遷到最新 schema（v1→v2→v3 在同一次呼叫內串接執行）
  assert.equal(migratedJson.schema_version, 3);
  assert.equal(migratedJson.evidence[0].kind, "legacy-unverified");
  assert.ok(existsSync(join(task, "task.md")));
  const migratedMd = readFileSync(join(task, "task.md"), "utf8");
  assert.doesNotMatch(migratedMd, /^---/);
  assert.match(migratedMd, /legacy intent/);
});

test("a schema_version 2 frozen task migrates to schema_version 3 with intent_approval and stale evidence", () => {
  const root = join(tmpdir(), `agent-workflow-migration-v3-${process.pid}-${Date.now()}`);
  const task = join(root, "projects", "project", "tasks", "frozen-task"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Frozen task\n\n## Goal\n\nMigrate this task to schema v3.\n");
  writeFileSync(join(task, "task.json"), JSON.stringify({
    schema_version: 2, id: "frozen-task",
    lifecycle: { status: "frozen", frozen_at: "2026-01-01T00:00:00.000Z", transitions: [] },
    evidence: [{ kind: "legacy-unverified", verified: false }]
  }));
  const result = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "migrate-state", "--state-root", root], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).migrated, true);
  const migrated = JSON.parse(readFileSync(join(task, "task.json"), "utf8"));
  assert.equal(migrated.schema_version, 3);
  assert.equal(migrated.lifecycle.status, "in_progress");
  assert.equal(migrated.lifecycle.frozen_at, undefined);
  assert.ok(migrated.intent_approval);
  assert.equal(migrated.intent_approval.confirmed_at, "2026-01-01T00:00:00.000Z");
  assert.ok(Number.isInteger(migrated.state_revision));
  assert.ok(Number.isInteger(migrated.plan_revision));
  assert.equal(migrated.evidence[0].status, "stale");
});
