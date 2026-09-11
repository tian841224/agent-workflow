import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const cli = join(process.cwd(), "dist", "agent-workflow.mjs");
const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: "utf8" });

test("skill list merges managed-manifest.json's core/optional catalog with optional lock source info", () => {
  const rows = JSON.parse(run(["skill", "--action", "List"]).stdout).skills;
  const workflow = rows.find((row) => row.name === "workflow");
  assert.equal(workflow.required, true);
  assert.equal(workflow.present, true);
  const hallmark = rows.find((row) => row.name === "hallmark");
  assert.equal(hallmark.required, false);
  assert.equal(hallmark.source, undefined, "locally customized Hallmark must not claim upstream lock parity");
});

test("skill verify reports no-op for unlocked framework and locally customized skills", () => {
  const workflow = JSON.parse(run(["skill", "--action", "Verify", "--name", "workflow"]).stdout);
  assert.equal(workflow.valid, true);
  assert.match(workflow.note, /no skills-lock\.json entry/);
  const hallmark = JSON.parse(run(["skill", "--action", "Verify", "--name", "hallmark"]).stdout);
  assert.equal(hallmark.valid, true);
  assert.match(hallmark.note, /no skills-lock\.json entry/);
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

// v5 shipped a managed file that the installer's hard-coded list never learned about: the repo
// looked correct while a fresh install came out missing it. This keeps the catalog and the on-disk
// skill directories a strict parity set in both directions.
test("managed-manifest catalog and .agents/skills stay a parity set in both directions", () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "adapters", "managed-manifest.json"), "utf8"));
  const catalog = manifest.skills;
  const unmanaged = new Set(manifest.unmanaged_skills || []);

  for (const [name, meta] of Object.entries(catalog)) {
    assert.equal(typeof meta.required, "boolean", `${name} must declare required`);
    assert.ok(existsSync(join(process.cwd(), ".agents", "skills", name, "SKILL.md")), `manifest lists ${name} but .agents/skills/${name}/SKILL.md is missing`);
  }

  const onDisk = readdirSync(join(process.cwd(), ".agents", "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(process.cwd(), ".agents", "skills", entry.name, "SKILL.md")))
    .map((entry) => entry.name);
  for (const name of onDisk) {
    assert.ok(catalog[name] || unmanaged.has(name), `.agents/skills/${name} is neither in the manifest catalog nor listed in unmanaged_skills`);
  }
  for (const name of unmanaged) {
    assert.equal(catalog[name], undefined, `${name} is listed both as unmanaged and in the catalog`);
    assert.ok(onDisk.includes(name), `unmanaged_skills lists ${name} but no such skill directory exists`);
  }
});
