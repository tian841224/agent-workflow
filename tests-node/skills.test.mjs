import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const cli = join(process.cwd(), "dist", "agent-workflow.mjs");
const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: "utf8" });

test("skill list merges managed-manifest.json's core/optional catalog with skills-lock.json source info", () => {
  const rows = JSON.parse(run(["skill", "--action", "List"]).stdout).skills;
  const workflow = rows.find((row) => row.name === "workflow");
  assert.equal(workflow.required, true);
  assert.equal(workflow.present, true);
  const hallmark = rows.find((row) => row.name === "hallmark");
  assert.equal(hallmark.required, false);
  assert.equal(hallmark.source, "nutlope/hallmark");
});

test("skill verify reports no-op for an unlocked skill and a definite mismatch/match for a locked one", () => {
  const unlocked = JSON.parse(run(["skill", "--action", "Verify", "--name", "workflow"]).stdout);
  assert.equal(unlocked.valid, true);
  assert.match(unlocked.note, /no skills-lock\.json entry/);
});

test("skill install/verify/remove round-trips a locally vendored skill through skills-lock.json", () => {
  const root = join(tmpdir(), `agent-workflow-skill-pkg-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  cpSync(join(process.cwd(), "adapters"), join(root, "adapters"), { recursive: true });
  writeFileSync(join(root, "skills-lock.json"), JSON.stringify({ version: 1, skills: {} }));
  const source = join(tmpdir(), `agent-workflow-skill-source-${process.pid}-${Date.now()}`);
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "---\nname: scratch\n---\n\nhello\n");

  const installed = JSON.parse(run(["skill", "--action", "Install", "--name", "scratch-test", "--from", source, "--source", "local/test", "--source-type", "local", "--root", root]).stdout);
  assert.equal(installed.valid, true);
  const verifiedOk = JSON.parse(run(["skill", "--action", "Verify", "--name", "scratch-test", "--root", root]).stdout);
  assert.equal(verifiedOk.valid, true);
  assert.equal(verifiedOk.current_hash, verifiedOk.locked_hash);

  writeFileSync(join(root, ".agents", "skills", "scratch-test", "SKILL.md"), "---\nname: scratch\n---\n\nmutated\n");
  const verifiedDrifted = JSON.parse(run(["skill", "--action", "Verify", "--name", "scratch-test", "--root", root]).stdout);
  assert.equal(verifiedDrifted.valid, false);
  assert.notEqual(verifiedDrifted.current_hash, verifiedDrifted.locked_hash);

  const removed = JSON.parse(run(["skill", "--action", "Remove", "--name", "scratch-test", "--root", root]).stdout);
  assert.equal(removed.valid, true);
  const lock = JSON.parse(readFileSync(join(root, "skills-lock.json"), "utf8"));
  assert.equal(lock.skills["scratch-test"], undefined);
});
