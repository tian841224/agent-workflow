import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

// Canonical skills always land under the user's home, so every install gets its own home.
const isolatedHome = (root) => ({ ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home") });
const SHARED_RULE = /硬護欄/;
// The file name, the title and two body phrases that no shared document uses.
const DELEGATION_TRACE = /delegation\.md|派工規則|保留這些工作|主對話直接處理/;
const IMPORTS = ["@~/.agents/AGENTS.md", "@agent-workflow/delegation.md"];

// `source` is the checkout the installer runs from; a sandbox copy lets a test change the source.
function fixture(label, source = process.cwd()) {
  const root = join(tmpdir(), `agent-workflow-claude-delegation-${label}-${process.pid}-${Date.now()}`);
  const paths = { root, state: join(root, "state"), claude: join(root, "claude"), codex: join(root, "codex"), gemini: join(root, "gemini"), canonical: join(root, "home", ".agents") };
  const run = (action, extra = [], claude = paths.claude) => spawnSync(process.execPath, [join(source, "dist", "agent-workflow.mjs"), action, "--non-interactive", "--state-root", paths.state,
    "--claude-target", claude, "--codex-target", paths.codex, "--antigravity-target", paths.gemini, ...extra],
  { cwd: source, encoding: "utf8", env: isolatedHome(root) });
  return { ...paths, run, delegation: join(paths.claude, "agent-workflow", "delegation.md"), claudeEntry: join(paths.claude, "CLAUDE.md") };
}
function sandboxSource(label) {
  const source = join(tmpdir(), `agent-workflow-claude-delegation-source-${label}-${process.pid}-${Date.now()}`);
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
const managedLines = (entry) => {
  const block = readFileSync(entry, "utf8").match(/<!-- agent-workflow v7 managed:start -->\n([\s\S]*?)\n<!-- agent-workflow v7 managed:end -->/);
  assert.ok(block, `${entry} has no managed block`);
  return block[1].split("\n").filter(Boolean);
};

// The Codex block is a pointer to the canonical file followed by the coordinator instructions; it carries no shared rule text.
function assertCodexEntrypoint(entry, canonicalFile) {
  assert.doesNotMatch(readFileSync(canonicalFile, "utf8"), /^## Codex 任務委派$/m);
  const pointer = `開始任何工作前，先完整讀取 \`${canonicalFile}\` 並遵守其中的共用規則；本檔只補充 Codex 專屬規則。`;
  const supplement = readFileSync(join("adapters", "codex", "coordinator.md"), "utf8").trim();
  assert.equal(entry, `<!-- agent-workflow v7 managed:start -->\n${pointer}\n\n${supplement}\n<!-- agent-workflow v7 managed:end -->\n`);
  assert.doesNotMatch(entry, SHARED_RULE);
}

test("AC1 the Claude entrypoint imports the canonical rules instead of carrying a copy", () => {
  const target = installed("ac1");
  assert.deepEqual(managedLines(target.claudeEntry), IMPORTS);
  assert.doesNotMatch(readFileSync(target.claudeEntry, "utf8"), SHARED_RULE);
  assert.match(readFileSync(join(target.canonical, "AGENTS.md"), "utf8"), SHARED_RULE);
});

test("AC2 the delegation rule and the Claude model settings exist only under the Claude root", () => {
  const target = installed("ac2");
  assert.ok(existsSync(target.delegation));
  // Antigravity has a rule of its own under the same file name, so the Claude rule is recognised by its content.
  const rule = readFileSync(join("adapters", "claude", "delegation.md"), "utf8");
  const others = ["AGENTS.md", join("adapters", "antigravity", "delegation.md"), join("adapters", "codex", "coordinator.md")].map((path) => readFileSync(path, "utf8"));
  const claudeOnly = rule.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length >= 25 && !others.some((other) => other.includes(line)));
  assert.ok(claudeOnly.length > 0);
  const carriesRule = (file) => { const content = readFileSync(file, "utf8"); return claudeOnly.some((line) => content.includes(line)); };
  for (const root of [target.codex, target.gemini, target.canonical, target.state]) {
    const found = files(root);
    assert.ok(found.length, `${root} was installed`);
    assert.deepEqual(found.filter(carriesRule), [], root);
  }
  // The whole install, including the runtime and state every platform shares, holds exactly one copy.
  assert.deepEqual(files(target.root).filter(carriesRule), [target.delegation]);
  // Canonical retains the shared body; Codex points at it and adds only its coordinator instructions.
  assert.match(readFileSync(join(target.canonical, "AGENTS.md"), "utf8"), SHARED_RULE);
  assertCodexEntrypoint(readFileSync(join(target.codex, "AGENTS.md"), "utf8"), join(target.canonical, "AGENTS.md"));
  const definitions = files(join(target.codex, "agents")).filter((file) => file.endsWith(".toml"));
  assert.ok(definitions.length >= 2, "Codex has its worker and reader definitions");
  for (const file of definitions) assert.doesNotMatch(readFileSync(file, "utf8"), /^(model|effort)\s*=|sonnet|opus|haiku/m, file);
});

test("AC3 a Codex-only install lays down no Claude delegation rule", () => {
  const target = installed("ac3", ["--target-agent", "Codex"]);
  assert.deepEqual(files(target.root).filter((file) => /delegation\.md$/.test(file)), []);
  assert.equal(existsSync(target.claudeEntry), false);
  const entry = readFileSync(join(target.codex, "AGENTS.md"), "utf8");
  assertCodexEntrypoint(entry, join(target.canonical, "AGENTS.md"));
  for (const heading of [/^## 分流$/m, /^## 硬護欄$/m, /^## 程式碼註解$/m]) assert.doesNotMatch(entry, heading);
  assert.doesNotMatch(entry, DELEGATION_TRACE);
});

test("AC4 the Claude worker is pinned to sonnet at high effort and Claude installs no reader of its own", () => {
  const target = installed("ac4");
  const worker = readFileSync(join(target.claude, "agents", "agent-workflow-worker.md"), "utf8").split("\n---\n")[0];
  assert.match(worker, /^model: sonnet$/m);
  assert.match(worker, /^effort: high$/m);
  // Large reads go to the built-in Explore agent; a second read-only searcher would only overlap it.
  assert.equal(existsSync(join(target.claude, "agents", "agent-workflow-reader.md")), false);
});

test("AC5 the delegation rule maps only the shared dispatch cases and defers when to dispatch to the shared rule", () => {
  const target = installed("ac5");
  const rule = readFileSync(target.delegation, "utf8");
  const rows = rule.split(/\r?\n/).filter((line) => /^\| (?!---|派工情況)/.test(line));
  assert.equal(rows.length, 3, rows.join("\n"));
  assert.match(rule, /\| [^|]*大量讀取[^|]*\| `Explore` \| 派工時指定 `model: haiku`/);
  assert.match(rule, /\| [^|]*平行實作[^|]*\| `agent-workflow-worker` \| sonnet、high/);
  assert.match(rule, /\| 複審 \| `general-purpose` \|[^|]*`model: opus`、`effort: high`/);
  assert.doesNotMatch(rule, /`Plan`|10 行/);
  assert.match(rule, /共用入口的「Subagent」段落/);
  assert.match(readFileSync(join(target.canonical, "AGENTS.md"), "utf8"), /^## Subagent$/m);
});

test("AC6 repair keeps the user's own Claude rules and does not repeat the imports", () => {
  const target = installed("ac6");
  appendFileSync(target.claudeEntry, "\n## My rules\n\n- my own claude rule\n");
  for (let round = 0; round < 2; round += 1) ok(target.run("repair"));
  const entry = readFileSync(target.claudeEntry, "utf8");
  assert.equal(entry.match(/my own claude rule/g).length, 1);
  assert.equal(entry.match(/^@~\/\.agents\/AGENTS\.md$/gm).length, 1);
  assert.equal(entry.match(/^@agent-workflow\/delegation\.md$/gm).length, 1);
  assert.deepEqual(managedLines(target.claudeEntry), IMPORTS);
  for (const path of [join(target.codex, "AGENTS.md"), join(target.gemini, "GEMINI.md"), join(target.canonical, "AGENTS.md")]) {
    assert.ok(!readFileSync(path, "utf8").includes("my own claude rule"), path);
  }
});

test("AC7 verify reports a modified delegation rule", () => {
  const target = installed("ac7");
  assert.match(target.run("verify").stdout, /"valid":true/);
  appendFileSync(target.delegation, "\n- tampered\n");
  const verified = target.run("verify");
  assert.notEqual(verified.status, 0);
  const errors = JSON.parse(verified.stdout).errors;
  assert.ok(errors.some((error) => /managed file hash mismatch: .*delegation\.md$/.test(error)), JSON.stringify(errors));
});

test("uninstall keeps the delegation rule that the remaining Claude entrypoint imports", () => {
  const target = installed("uninstall");
  ok(target.run("uninstall"));
  assert.ok(existsSync(target.delegation));
  assert.deepEqual(managedLines(target.claudeEntry), IMPORTS);
  assert.equal(existsSync(join(target.claude, "agents", "agent-workflow-worker.md")), false);
});

test("a Codex-only repair keeps the installed Claude rule and its record", () => {
  const target = installed("single-platform");
  ok(target.run("repair", ["--target-agent", "Codex"]));
  assert.ok(existsSync(target.delegation));
  assert.match(target.run("verify").stdout, /"valid":true/);
});

test("moving the Claude target removes the rule from the old root and installs it in the new one", () => {
  const target = installed("relocation");
  const moved = join(target.root, "claude-moved");
  ok(target.run("repair", [], moved));
  assert.equal(existsSync(target.delegation), false);
  assert.ok(existsSync(join(moved, "agent-workflow", "delegation.md")));
  assert.deepEqual(managedLines(join(moved, "CLAUDE.md")), IMPORTS);
  assert.match(target.run("verify").stdout, /"valid":true/);
});

test("a dry run writes neither the Claude entrypoint nor the delegation rule", () => {
  const target = fixture("dry-run");
  ok(target.run("install", ["--dry-run"]));
  assert.equal(existsSync(target.claudeEntry), false);
  assert.equal(existsSync(target.delegation), false);
});

test("an entrypoint that carries a copied body is rewritten to the imports", () => {
  const target = fixture("upgrade");
  mkdirSync(target.claude, { recursive: true });
  writeFileSync(target.claudeEntry, "<!-- agent-workflow v7 managed:start -->\n# agent-workflow\n\ncopied shared body\n<!-- agent-workflow v7 managed:end -->\n");
  ok(target.run("install"));
  assert.deepEqual(managedLines(target.claudeEntry), IMPORTS);
  assert.doesNotMatch(readFileSync(target.claudeEntry, "utf8"), /copied shared body/);
});

test("a source without the delegation rule imports only the canonical entrypoint and drops an installed rule", () => {
  const source = sandboxSource("missing-rule");
  const target = fixture("missing-rule", source);
  ok(target.run("install"));
  assert.ok(existsSync(target.delegation));
  rmSync(join(source, "adapters", "claude", "delegation.md"));
  ok(target.run("repair"));
  assert.deepEqual(managedLines(target.claudeEntry), ["@~/.agents/AGENTS.md"]);
  assert.equal(existsSync(target.delegation), false);
  assert.match(target.run("verify").stdout, /"valid":true/);
});

test("AC4 repair removes a Codex agent definition the source no longer declares", () => {
  const source = sandboxSource("dropped-agent");
  const config = join(source, "adapters", "codex", "managed-config.json");
  const original = readFileSync(config, "utf8");
  const extended = JSON.parse(original);
  writeFileSync(join(source, "adapters", "codex", "agents", "retired.md"), "---\nname: retired\ndescription: A role a later source drops.\n---\n\nRetired role.\n");
  extended.agents.retired = { source: "adapters/codex/agents/retired.md", sandbox_mode: "read-only", instructions_source: "adapters/codex/agents/subagent.md" };
  writeFileSync(config, JSON.stringify(extended));
  const target = fixture("dropped-agent", source);
  ok(target.run("install"));
  const retired = join(target.codex, "agents", "agent-workflow-retired.toml");
  assert.ok(existsSync(retired));
  writeFileSync(config, original);
  ok(target.run("repair"));
  assert.equal(existsSync(retired), false);
  assert.equal(existsSync(join(target.codex, "agents", "agent-workflow-planner.toml")), false);
  assert.match(target.run("verify").stdout, /"valid":true/);
});
