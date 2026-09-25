import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const cli = join(process.cwd(), "dist", "agent-workflow.mjs");
// install writes canonical skills under the home directory, so each install gets its own.
const isolatedHome = (root) => ({ ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home") });
let installedRoot;
test.before(() => {
  installedRoot = join(tmpdir(), `agent-workflow-locale-hooks-${process.pid}-${Date.now()}`);
  const install = spawnSync(process.execPath, [cli, "install", "--non-interactive", "--state-root", join(installedRoot, "state"), "--claude-target", join(installedRoot, "claude"), "--codex-target", join(installedRoot, "codex"), "--antigravity-target", join(installedRoot, "gemini")], { cwd: process.cwd(), encoding: "utf8", env: isolatedHome(installedRoot) });
  assert.equal(install.status, 0, install.stderr);
});

function hookContext(root, platform, payload, command = "locale-context") {
  return spawnSync(process.execPath, [join(process.cwd(), "dist", "agent-workflow-hook.mjs"), command, "--platform", platform, "--state-root", join(root, "state")], { cwd: process.cwd(), encoding: "utf8", input: JSON.stringify(payload) });
}

test("locale-context injects the vocabulary with each submitted prompt, including 落地", () => {
  const claude = hookContext(installedRoot, "Claude", { hook_event_name: "UserPromptSubmit", prompt: "改一下 README" });
  assert.equal(claude.status, 0, claude.stderr);
  const output = JSON.parse(claude.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, "UserPromptSubmit");
  assert.match(output.additionalContext, /localization-tw skill（輸出任何中文前先讀完/);
  assert.match(output.additionalContext, /- 使用臺灣慣用繁體中文/, "the skill's core rules are injected, not only the vocabulary");
  assert.match(output.additionalContext, /落地→實作／上線／導入/);
  assert.match(output.additionalContext, /緩存→快取/);
  assert.doesNotMatch(output.additionalContext, /數據→|通過→|項目→/, "context-dependent terms stay out of the per-prompt list");
  assert.equal(JSON.parse(hookContext(installedRoot, "Codex", {}).stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");
});

test("locale-context on Antigravity injects only on the first invocation", () => {
  const first = JSON.parse(hookContext(installedRoot, "Antigravity", { invocationNum: 0 }).stdout);
  assert.match(first.injectSteps[0].ephemeralMessage, /落地→/);
  assert.deepEqual(JSON.parse(hookContext(installedRoot, "Antigravity", { invocationNum: 2 }).stdout), { injectSteps: [] });
  assert.deepEqual(JSON.parse(hookContext(installedRoot, "Antigravity", {}).stdout), { injectSteps: [] });
});

test("there is no after-reply lint: the retired locale-lint hook command is rejected", () => {
  const result = hookContext(installedRoot, "Claude", { last_assistant_message: "運行服務器" }, "locale-lint");
  assert.equal(result.status, 2);
  assert.equal(result.stdout.trim(), "");
});

test("locale-context is a no-op with exit 0 when no localization policy is installed", () => {
  const root = join(tmpdir(), `agent-workflow-locale-none-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const install = spawnSync(process.execPath, [cli, "install", "--non-interactive", "--skills", "workflow", "--state-root", state, "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")], { cwd: process.cwd(), encoding: "utf8", env: isolatedHome(root) });
  assert.equal(install.status, 0, install.stderr);
  // localization-tw is a required skill, so every install writes the policy and no --skills value
  // can exclude it; deleting it is the only way to reach the state this degradation path covers.
  const policy = join(state, "runtime", "localization-tw-policy.json");
  assert.ok(existsSync(policy), "the installer is expected to write the policy for a required skill");
  rmSync(policy);
  const result = hookContext(root, "Claude", { hook_event_name: "UserPromptSubmit" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "");
});
