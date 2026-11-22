import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const cli = join(process.cwd(), "dist", "agent-workflow.mjs");
// install writes canonical skills under the home directory, so each install gets its own.
const isolatedHome = (root) => ({ ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home") });
let installedRoot;
let policy;
test.before(() => {
  installedRoot = join(tmpdir(), `agent-workflow-locale-hooks-${process.pid}-${Date.now()}`);
  const install = spawnSync(process.execPath, [cli, "install", "--non-interactive", "--state-root", join(installedRoot, "state"), "--claude-target", join(installedRoot, "claude"), "--codex-target", join(installedRoot, "codex"), "--antigravity-target", join(installedRoot, "gemini")], { cwd: process.cwd(), encoding: "utf8", env: isolatedHome(installedRoot) });
  assert.equal(install.status, 0, install.stderr);
  policy = JSON.parse(readFileSync(join(installedRoot, "state", "runtime", "localization-tw-policy.json"), "utf8"));
  assert.ok(policy.rules.length > 0);
  assert.ok(policy.terms.length > 0);
});

function assertPolicy(context, includeRules = true) {
  for (const rule of policy.rules) assert.equal(context.includes(`- ${rule}`), includeRules);
  for (const term of policy.terms) assert.ok(context.includes(`${term.avoid}→${term.use}`));
}

function hookContext(root, platform, payload, command = "locale-context") {
  return spawnSync(process.execPath, [join(process.cwd(), "dist", "agent-workflow-hook.mjs"), command, "--platform", platform, "--state-root", join(root, "state")], { cwd: process.cwd(), encoding: "utf8", input: JSON.stringify(payload) });
}

test("locale-context injects the installed policy with each submitted prompt", () => {
  const claude = hookContext(installedRoot, "Claude", { hook_event_name: "UserPromptSubmit", prompt: "改一下 README" });
  assert.equal(claude.status, 0, claude.stderr);
  const output = JSON.parse(claude.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, "UserPromptSubmit");
  assertPolicy(output.additionalContext);
  assert.equal(JSON.parse(hookContext(installedRoot, "Codex", {}).stdout).hookSpecificOutput.hookEventName, "UserPromptSubmit");
});

test("locale-context injects the core rules once per session and the vocabulary every time", () => {
  const session = `locale-once-${process.pid}-${Date.now()}`;
  const context = (payload) => JSON.parse(hookContext(installedRoot, "Claude", { hook_event_name: "UserPromptSubmit", ...payload }).stdout).hookSpecificOutput.additionalContext;
  const first = context({ session_id: session });
  assertPolicy(first);
  const second = context({ session_id: session });
  assertPolicy(second, false);
  assertPolicy(context({ session_id: `${session}-other` }));
  // Without a session id there is nothing to remember against, so every call carries the rules.
  for (let call = 0; call < 2; call++) assertPolicy(context({}));
});

test("locale-context on Antigravity injects only on the first invocation", () => {
  const first = JSON.parse(hookContext(installedRoot, "Antigravity", { invocationNum: 0 }).stdout);
  assertPolicy(first.injectSteps[0].ephemeralMessage);
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
