import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { after, test } from "node:test";

// Codex-only instruction sources; each must reach `<Codex root>` alone and never a shared location.
const CODEX_SOURCES = {
  coordinator: join("adapters", "codex", "coordinator.md")
};
const MIN_LINE = 25;
const created = [];

// Follows links, because a platform skills directory exposes the shared skills through junctions.
function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const full = join(directory, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}
const read = (path) => readFileSync(path, "utf8");

function fixture(label) {
  const root = join(tmpdir(), `agent-workflow-platform-isolation-${label}-${process.pid}-${Date.now()}`);
  created.push(root);
  const paths = { root, state: join(root, "state"), claude: join(root, "claude"), codex: join(root, "codex"), gemini: join(root, "gemini"), home: join(root, "home") };
  const env = { ...process.env, HOME: paths.home, USERPROFILE: paths.home };
  const run = (action, extra = []) => spawnSync(process.execPath, [join(process.cwd(), "dist", "agent-workflow.mjs"), action, "--non-interactive", "--state-root", paths.state,
    "--claude-target", paths.claude, "--codex-target", paths.codex, "--antigravity-target", paths.gemini, ...extra],
  { cwd: process.cwd(), encoding: "utf8", env });
  return { ...paths, canonical: join(paths.home, ".agents"), runtimeAdapters: join(paths.state, "runtime", "adapters"), run };
}
function installed(label, extra = []) {
  const target = fixture(label);
  const result = target.run("install", extra);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return target;
}

// Text that every platform legitimately shares; a Codex source line that also appears here is not Codex-only.
function sharedText() {
  const sources = ["AGENTS.md", join("adapters", "claude", "delegation.md"), ...files(".agents")];
  return sources.filter((file) => existsSync(file)).map(read).join("\n");
}
function codexOnlyLines() {
  const shared = sharedText();
  const lines = {};
  for (const [name, source] of Object.entries(CODEX_SOURCES)) {
    lines[name] = [...new Set(read(source).split("\n").map((line) => line.trim()).filter((line) => line.length >= MIN_LINE && !shared.includes(line)))];
  }
  return lines;
}
const allLines = (lines) => Object.values(lines).flat();
function leaks(roots, lines) {
  const found = [];
  for (const root of roots) {
    for (const file of files(root)) {
      const text = read(file);
      for (const line of lines) if (text.includes(line)) found.push(`${file}: ${line}`);
    }
  }
  return found;
}

after(() => { for (const root of created) rmSync(root, { recursive: true, force: true }); });

test("every Codex instruction source has text that no shared source carries", () => {
  const lines = codexOnlyLines();
  for (const name of Object.keys(CODEX_SOURCES)) assert.ok(lines[name].length >= 1, `${CODEX_SOURCES[name]} has no Codex-only line`);
});

test("Codex-only instructions reach the Codex root alone", () => {
  const lines = codexOnlyLines();
  const target = installed("roots");
  assert.deepEqual(leaks([target.claude, target.gemini, target.canonical, target.state], allLines(lines)), []);
  const entry = read(join(target.codex, "AGENTS.md"));
  for (const line of lines.coordinator) assert.ok(entry.includes(line), `Codex AGENTS.md lacks: ${line}`);
});

test("the shared runtime keeps common manifests without private Codex adapter files", () => {
  const target = installed("runtime");
  assert.ok(existsSync(target.runtimeAdapters), "the shared runtime holds adapters");
  assert.deepEqual(files(target.runtimeAdapters).filter((file) => /\.md$/i.test(file)), []);
  assert.ok(existsSync(join(target.runtimeAdapters, "managed-manifest.json")));
  assert.equal(existsSync(join(target.runtimeAdapters, "codex")), false);
  assert.ok(existsSync(join(target.codex, "hooks.json")));
});

test("a Claude-only install leaves no Codex-only line anywhere", () => {
  const lines = codexOnlyLines();
  const target = installed("claude-only", ["--target-agent", "Claude"]);
  assert.ok(files(target.claude).length, "Claude was installed");
  assert.equal(existsSync(target.codex), false);
  assert.deepEqual(leaks([target.root], allLines(lines)), []);
});

test("repair removes an instruction Markdown copy that an earlier install left in the shared runtime", () => {
  const target = installed("stale");
  const stale = join(target.runtimeAdapters, "codex", "coordinator.md");
  mkdirSync(dirname(stale), { recursive: true });
  writeFileSync(stale, read(CODEX_SOURCES.coordinator));
  assert.ok(existsSync(stale));
  const repaired = target.run("repair");
  assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
  assert.equal(existsSync(stale), false);
  assert.match(target.run("verify").stdout, /"valid":true/);
});
