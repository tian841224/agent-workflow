import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

test("install writes a standalone Node runtime and required skills", () => {
  const root = join(tmpdir(), `agent-workflow-test-${process.pid}-${Date.now()}`);
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
  const installed = run(["install", "--non-interactive", "--skills", "workflow", "--state-root", join(root, "state"), "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(JSON.parse(installed.stdout).ok, true);
  assert.ok(existsSync(join(root, "state", "runtime", "agent-workflow.mjs")));
  assert.ok(existsSync(join(root, "codex", "skills", "workflow", "SKILL.md")));
  assert.match(run(["verify", "--state-root", join(root, "state")]).stdout, /"valid":true/);
});

test("repair removes legacy runtime files after replacing the bundle", () => {
  const root = join(tmpdir(), `agent-workflow-repair-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(run(["install", "--non-interactive", "--state-root", state, "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")]).status, 0);
  const stale = join(state, "runtime", "agent_workflow", "installer.py");
  mkdirSync(join(state, "runtime", "agent_workflow"), { recursive: true });
  writeFileSync(stale, "legacy python runtime");
  assert.equal(run(["repair", "--non-interactive", "--state-root", state, "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")]).status, 0);
  assert.ok(!existsSync(stale));
});

test("repeated repairs do not duplicate a platform's own managed hooks (Windows backslash paths)", () => {
  const root = join(tmpdir(), `agent-workflow-repair-dedupe-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const claudeTarget = join(root, "claude");
  const targets = ["--claude-target", claudeTarget, "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")];
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(run(["install", "--non-interactive", "--state-root", state, ...targets]).status, 0);
  assert.equal(run(["repair", "--non-interactive", "--state-root", state, ...targets]).status, 0);
  assert.equal(run(["repair", "--non-interactive", "--state-root", state, ...targets]).status, 0);
  const preToolUse = JSON.stringify(JSON.parse(readFileSync(join(claudeTarget, "settings.json"), "utf8")).hooks.PreToolUse);
  assert.equal((preToolUse.match(/git-guard --platform Claude/g) || []).length, 1);
});

test("repair preserves a platform's own Stop hook (agent-workflow manages no Stop hook today)", () => {
  const root = join(tmpdir(), `agent-workflow-stop-merge-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const claudeTarget = join(root, "claude");
  const targets = ["--claude-target", claudeTarget, "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")];
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(run(["install", "--non-interactive", "--state-root", state, ...targets]).status, 0);
  const settingsPath = join(claudeTarget, "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.hooks.Stop = [...(settings.hooks.Stop || []), { hooks: [{ type: "agent", prompt: "user's own stop hook" }] }];
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  assert.equal(run(["repair", "--non-interactive", "--state-root", state, ...targets]).status, 0);
  const stopHooks = JSON.stringify(JSON.parse(readFileSync(settingsPath, "utf8")).hooks.Stop);
  assert.match(stopHooks, /user's own stop hook/);
});

test("repair sweeps retired Antigravity lifecycle hooks and keeps the user's own", () => {
  const root = join(tmpdir(), `agent-workflow-antigravity-sweep-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const antigravityTarget = join(root, "gemini");
  const targets = ["--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", antigravityTarget];
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(run(["install", "--non-interactive", "--state-root", state, ...targets]).status, 0);
  const hooksPath = join(antigravityTarget, "config", "hooks.json");
  // An install from a build that still targeted SessionStart/SessionEnd — events Antigravity no
  // longer supports. Repair has to sweep them without a dedicated migration, and without touching
  // whatever the user configured themselves.
  writeFileSync(hooksPath, JSON.stringify({
    "agent-workflow-memory-context": { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "legacy memory-context" }] }] },
    "agent-workflow-git-guard": { SessionEnd: [{ matcher: "*", hooks: [{ type: "command", command: "legacy skill-guard --event SessionEnd" }] }] },
    "user-own-hook": { Stop: [{ matcher: "*", hooks: [{ type: "command", command: "user's own stop hook" }] }] }
  }, null, 2));
  assert.equal(run(["repair", "--non-interactive", "--state-root", state, ...targets]).status, 0);
  const repaired = JSON.parse(readFileSync(hooksPath, "utf8"));
  const managed = JSON.stringify(Object.fromEntries(Object.entries(repaired).filter(([name]) => name.startsWith("agent-workflow-"))));
  assert.doesNotMatch(managed, /SessionStart|SessionEnd/);
  assert.ok(repaired["agent-workflow-memory-context"].PreInvocation, "repair must install the PreInvocation memory hook");
  assert.match(JSON.stringify(repaired["user-own-hook"]), /user's own stop hook/);
});
