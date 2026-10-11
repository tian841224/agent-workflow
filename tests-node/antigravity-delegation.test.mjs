import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

// Canonical skills always land under the user's home, so every install gets its own home.
const isolatedHome = (root) => ({ ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home") });
const SHARED_RULE = /硬護欄/;
const RULE_SOURCE = join("adapters", "antigravity", "delegation.md");
const RULE_IMPORT = "@agent-workflow/delegation.md";
const longLines = (path) => readFileSync(path, "utf8").split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length >= 25);
// Lines of the Antigravity rule that no shared entry and no other platform's rule carries.
const OTHER_SOURCES = ["AGENTS.md", join("adapters", "claude", "delegation.md"), join("adapters", "codex", "coordinator.md")].map((path) => readFileSync(path, "utf8"));
const ANTIGRAVITY_ONLY = longLines(RULE_SOURCE).filter((line) => !OTHER_SOURCES.some((other) => other.includes(line)));

// `source` is the checkout the installer runs from; a sandbox copy lets a test change the source.
function fixture(label, source = process.cwd()) {
  const root = join(tmpdir(), `agent-workflow-antigravity-delegation-${label}-${process.pid}-${Date.now()}`);
  const paths = { root, state: join(root, "state"), claude: join(root, "claude"), codex: join(root, "codex"), gemini: join(root, "gemini"), canonical: join(root, "home", ".agents") };
  const run = (action, extra = [], gemini = paths.gemini) => spawnSync(process.execPath, [join(source, "dist", "agent-workflow.mjs"), action, "--non-interactive", "--state-root", paths.state,
    "--claude-target", paths.claude, "--codex-target", paths.codex, "--antigravity-target", gemini, ...extra],
  { cwd: source, encoding: "utf8", env: isolatedHome(root) });
  return { ...paths, run, rule: join(paths.gemini, "agent-workflow", "delegation.md"), entry: join(paths.gemini, "GEMINI.md") };
}
function sandboxSource(label) {
  const source = join(tmpdir(), `agent-workflow-antigravity-delegation-source-${label}-${process.pid}-${Date.now()}`);
  mkdirSync(join(source, "dist"), { recursive: true });
  for (const bundle of ["agent-workflow.mjs", "agent-workflow-hook.mjs"]) copyFileSync(join("dist", bundle), join(source, "dist", bundle));
  for (const folder of ["adapters", "schemas", ".agents"]) cpSync(folder, join(source, folder), { recursive: true });
  copyFileSync("AGENTS.md", join(source, "AGENTS.md"));
  return source;
}
const ok = (result) => { assert.equal(result.status, 0, result.stdout + result.stderr); return result; };
function installed(label, extra = []) {
  const target = fixture(label);
  ok(target.run("install", extra));
  return target;
}
// Follows links, because a platform skills directory exposes the shared skills through junctions.
function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const full = join(directory, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}
const leaks = (roots) => roots.flatMap(files).filter((file) => { const content = readFileSync(file, "utf8"); return ANTIGRAVITY_ONLY.some((line) => content.includes(line)); });
const managedLines = (entry) => {
  const block = readFileSync(entry, "utf8").match(/<!-- agent-workflow v7 managed:start -->\n([\s\S]*?)\n<!-- agent-workflow v7 managed:end -->/);
  assert.ok(block, `${entry} has no managed block`);
  return block[1].split("\n").filter(Boolean);
};
// Antigravity resolves a reference against the rule file's directory, so the shared rules are named by a relative path.
const sharedImport = (entry, canonical) => `@${relative(dirname(entry), join(canonical, "AGENTS.md")).replaceAll("\\", "/")}`;

test("the Antigravity rule has lines of its own to look for", () => {
  assert.ok(ANTIGRAVITY_ONLY.length > 0);
});

test("the Antigravity entrypoint references the canonical rules and its own rule instead of carrying a copy", () => {
  const target = installed("entry");
  assert.equal(readFileSync(target.rule, "utf8"), readFileSync(RULE_SOURCE, "utf8"));
  const lines = managedLines(target.entry);
  assert.deepEqual(lines, [sharedImport(target.entry, target.canonical), RULE_IMPORT]);
  assert.doesNotMatch(readFileSync(target.entry, "utf8"), SHARED_RULE);
  for (const line of lines) assert.ok(statSync(resolve(dirname(target.entry), line.slice(1))).isFile(), `${line} resolves to a file`);
  assert.match(readFileSync(join(target.canonical, "AGENTS.md"), "utf8"), SHARED_RULE);
});

test("the Antigravity rule exists only under the Antigravity root", () => {
  const target = installed("isolation");
  assert.deepEqual(leaks([target.claude, target.codex, target.canonical, target.state]), []);
  assert.deepEqual(leaks([target.root]), [target.rule]);
});

test("an install that leaves Antigravity out lays down no Antigravity rule", () => {
  for (const platform of ["Claude", "Codex"]) {
    const target = installed(`without-${platform.toLowerCase()}`, ["--target-agent", platform]);
    assert.deepEqual(leaks([target.root]), [], platform);
    assert.equal(existsSync(join(target.gemini, "agent-workflow")), false, platform);
    assert.equal(existsSync(target.entry), false, platform);
  }
});

test("repair keeps the user's own Antigravity rules and does not repeat the references", () => {
  const target = installed("repair");
  appendFileSync(target.entry, "\n## My rules\n\n- my own antigravity rule\n");
  for (let round = 0; round < 2; round += 1) ok(target.run("repair"));
  const entry = readFileSync(target.entry, "utf8");
  assert.equal(entry.match(/my own antigravity rule/g).length, 1);
  assert.deepEqual(managedLines(target.entry), [sharedImport(target.entry, target.canonical), RULE_IMPORT]);
  assert.equal(entry.match(/managed:start/g).length, 1);
  for (const path of [join(target.claude, "CLAUDE.md"), join(target.codex, "AGENTS.md"), join(target.canonical, "AGENTS.md")]) assert.ok(!readFileSync(path, "utf8").includes("my own antigravity rule"), path);
});

test("verify reports a modified Antigravity rule", () => {
  const target = installed("verify");
  assert.match(target.run("verify").stdout, /"valid":true/);
  appendFileSync(target.rule, "\n- tampered\n");
  const verified = target.run("verify");
  assert.notEqual(verified.status, 0);
  const errors = JSON.parse(verified.stdout).errors;
  assert.ok(errors.some((error) => error === `managed file hash mismatch: ${target.rule}`), JSON.stringify(errors));
});

test("uninstall keeps the Antigravity rule that the remaining entrypoint references", () => {
  const target = installed("uninstall");
  ok(target.run("uninstall"));
  assert.ok(existsSync(target.rule));
  assert.deepEqual(managedLines(target.entry), [sharedImport(target.entry, target.canonical), RULE_IMPORT]);
});

test("a source without the Antigravity rule references only the canonical rules and drops an installed rule", () => {
  const source = sandboxSource("missing-rule");
  const target = fixture("missing-rule", source);
  ok(target.run("install"));
  assert.ok(existsSync(target.rule));
  rmSync(join(source, "adapters", "antigravity", "delegation.md"));
  ok(target.run("repair"));
  assert.deepEqual(managedLines(target.entry), [sharedImport(target.entry, target.canonical)]);
  assert.equal(existsSync(target.rule), false);
  assert.match(target.run("verify").stdout, /"valid":true/);
});

test("moving the Antigravity target removes the rule from the old root and installs it in the new one", () => {
  const target = installed("relocation");
  const moved = join(target.root, "nested", "gemini-moved");
  ok(target.run("repair", [], moved));
  assert.equal(existsSync(target.rule), false);
  assert.ok(existsSync(join(moved, "agent-workflow", "delegation.md")));
  const entry = join(moved, "GEMINI.md");
  const lines = managedLines(entry);
  assert.deepEqual(lines, [sharedImport(entry, target.canonical), RULE_IMPORT]);
  for (const line of lines) assert.ok(statSync(resolve(dirname(entry), line.slice(1))).isFile(), `${line} resolves to a file`);
  assert.match(target.run("verify").stdout, /"valid":true/);
});
