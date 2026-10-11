import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const IMPORTS = ["@~/.agents/AGENTS.md", "@agent-workflow/delegation.md"];
const BEGIN = "<!-- agent-workflow v7 managed:start -->";
const END = "<!-- agent-workflow v7 managed:end -->";
const count = (text, needle) => text.split(needle).length - 1;

// Every install gets its own home, so canonical files and entry files never touch the real user home.
function fixture(label) {
  const root = join(tmpdir(), `agent-workflow-entrypoint-content-${label}-${process.pid}-${Date.now()}`);
  const paths = { state: join(root, "state"), claude: join(root, "claude"), codex: join(root, "codex"), gemini: join(root, "gemini") };
  const env = { ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home") };
  const run = (action, extra = []) => {
    const result = spawnSync(process.execPath, [join(process.cwd(), "dist", "agent-workflow.mjs"), action, "--non-interactive", "--state-root", paths.state,
      "--claude-target", paths.claude, "--codex-target", paths.codex, "--antigravity-target", paths.gemini, ...extra], { cwd: process.cwd(), encoding: "utf8", env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result;
  };
  return { run, entries: { canonical: join(root, "home", ".agents", "AGENTS.md"), claude: join(paths.claude, "CLAUDE.md"), codex: join(paths.codex, "AGENTS.md"), gemini: join(paths.gemini, "GEMINI.md") } };
}
const read = (path) => readFileSync(path, "utf8");
const managedLines = (path) => {
  const text = read(path);
  assert.equal(count(text, BEGIN), 1, `${path} has exactly one managed block`);
  assert.equal(count(text, END), 1, `${path} has exactly one managed block end`);
  return text.match(/<!-- agent-workflow v7 managed:start -->\n([\s\S]*?)\n<!-- agent-workflow v7 managed:end -->/)[1].split("\n").filter(Boolean);
};

test("AC1 each platform entry file keeps only its own custom content on repair", () => {
  const target = fixture("ac1");
  target.run("install");
  const marks = { claude: "CLAUDE-ONLY-MARK", codex: "CODEX-ONLY-MARK", gemini: "GEMINI-ONLY-MARK" };
  for (const [name, mark] of Object.entries(marks)) appendFileSync(target.entries[name], `\n## Custom\n\n- ${mark}\n`);
  target.run("repair");
  for (const [name, mark] of Object.entries(marks)) {
    const text = read(target.entries[name]);
    assert.equal(count(text, mark), 1, `${name} keeps its own content once`);
    for (const other of Object.values(marks).filter((value) => value !== mark)) assert.equal(text.includes(other), false, `${name} has no ${other}`);
  }
  const canonical = read(target.entries.canonical);
  for (const mark of Object.values(marks)) assert.equal(canonical.includes(mark), false, `canonical has no ${mark}`);
});

test("AC2 custom content in one entry file stays there exactly once across repeated repairs", () => {
  const target = fixture("ac2");
  target.run("install");
  appendFileSync(target.entries.gemini, "\n## Custom\n\n- GEMINI-ONLY-MARK\n");
  target.run("repair");
  target.run("repair");
  assert.equal(count(read(target.entries.gemini), "GEMINI-ONLY-MARK"), 1);
  for (const name of ["claude", "codex", "canonical"]) assert.equal(read(target.entries[name]).includes("GEMINI-ONLY-MARK"), false, name);
});

test("AC3 installing Claude after Codex does not copy the Codex custom content into CLAUDE.md", () => {
  const target = fixture("ac3");
  target.run("install", ["--target-agent", "Codex"]);
  appendFileSync(target.entries.codex, "\n## Custom\n\n- CODEX-ONLY-MARK\n");
  target.run("install", ["--target-agent", "Claude"]);
  assert.equal(read(target.entries.claude), `${BEGIN}\n${IMPORTS.join("\n")}\n${END}\n`);
  assert.equal(count(read(target.entries.codex), "CODEX-ONLY-MARK"), 1);
});

test("AC4 content before and after the managed block is kept once and the block stays a single import block", () => {
  const target = fixture("ac4");
  target.run("install");
  writeFileSync(target.entries.claude, `BEFORE-MARK\n\n${BEGIN}\n${IMPORTS.join("\n")}\n${END}\n\nAFTER-MARK\n`);
  target.run("repair");
  target.run("repair");
  const text = read(target.entries.claude);
  assert.equal(count(text, "BEFORE-MARK"), 1);
  assert.equal(count(text, "AFTER-MARK"), 1);
  assert.deepEqual(managedLines(target.entries.claude), IMPORTS);
  assert.ok(text.indexOf("AFTER-MARK") < text.indexOf(BEGIN), "custom content sits before the managed block");
});

test("AC5 custom content in the canonical entry file stays there and reaches no platform entry file", () => {
  const target = fixture("ac5");
  target.run("install");
  appendFileSync(target.entries.canonical, "\n## Custom\n\n- CANONICAL-ONLY-MARK\n");
  target.run("repair");
  assert.equal(count(read(target.entries.canonical), "CANONICAL-ONLY-MARK"), 1);
  for (const name of ["claude", "codex", "gemini"]) assert.equal(read(target.entries[name]).includes("CANONICAL-ONLY-MARK"), false, name);
});
