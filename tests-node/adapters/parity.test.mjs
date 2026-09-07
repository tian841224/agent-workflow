import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { OPERATIONS } from "./fixtures.mjs";

const cli = `${process.cwd()}/dist/agent-workflow.mjs`;

function run(args, payload) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: "utf8", input: JSON.stringify(payload) });
}
function runGuard(guard, platform, payload, event) {
  return run([guard, "--platform", platform, ...(event ? ["--event", event] : [])], payload).stdout;
}
// Each platform is read through its own response contract rather than a shared "does the text say
// deny" match: an empty stdout is a valid allow on Claude/Codex and an invalid response on
// Antigravity, so treating both alike is exactly what let an Antigravity contract break pass green.
function decisionOf(platform, stdout) {
  if (platform === "Antigravity") {
    const response = JSON.parse(stdout);
    assert.ok(response.decision === "allow" || response.decision === "deny", `Antigravity PreToolUse must answer with an explicit decision, got: ${stdout}`);
    return response.decision;
  }
  if (!stdout.trim()) return "allow";
  return JSON.parse(stdout).hookSpecificOutput?.permissionDecision === "deny" ? "deny" : "allow";
}

for (const [opName, op] of Object.entries(OPERATIONS)) {
  test(`adapter parity: ${opName} decides the same way across Claude, Codex and Antigravity payload shapes`, () => {
    const outcomes = Object.fromEntries(Object.entries(op.payloads).map(([platform, payload]) => [platform, runGuard(op.guard, platform, payload)]));
    const expected = op.expectDeny ? "deny" : "allow";
    for (const [platform, stdout] of Object.entries(outcomes)) {
      assert.equal(decisionOf(platform, stdout), expected, `${platform} (${opName}): expected ${expected}, got: ${stdout}`);
      if (op.expectDeny && op.denyContains) assert.match(stdout, new RegExp(op.denyContains), `${platform} (${opName}) reason mismatch: ${stdout}`);
    }
    // Every platform must land on the same allow/deny outcome — that's the parity guarantee, not
    // merely "each platform individually behaves as expected in isolation".
    const decisions = new Set(Object.entries(outcomes).map(([platform, stdout]) => decisionOf(platform, stdout)));
    assert.equal(decisions.size, 1, `${opName}: platforms disagreed on allow/deny — ${JSON.stringify(outcomes)}`);
  });
}

test("Antigravity PostToolUse answers with an empty object, not a PreToolUse decision", () => {
  const stdout = runGuard("skill-guard", "Antigravity", OPERATIONS.safe_read.payloads.Antigravity, "PostToolUse");
  assert.deepEqual(JSON.parse(stdout), {}, `Antigravity PostToolUse must answer {}, got: ${stdout}`);
});

test("the Antigravity adapter declares only lifecycle events the platform still supports", () => {
  const allowed = new Set(["PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation", "Stop"]);
  const hooks = JSON.parse(readFileSync("adapters/antigravity/hooks.json", "utf8"));
  for (const [name, definition] of Object.entries(hooks)) {
    for (const event of Object.keys(definition)) assert.ok(allowed.has(event), `${name} declares '${event}', which Antigravity does not support`);
  }
  // PreInvocation takes a handler directly; the matcher/hooks wrapper is a PreToolUse/PostToolUse shape.
  for (const handler of hooks["agent-workflow-memory-context"].PreInvocation) {
    assert.equal(handler.type, "command", "PreInvocation handlers are declared directly, not wrapped in matcher/hooks");
    assert.match(handler.command, /memory-context --platform Antigravity/);
  }
});

test("Antigravity memory context injects on the first invocation only", () => {
  const state = join(tmpdir(), `agent-workflow-preinvocation-${process.pid}-${Date.now()}`);
  const entries = join(state, "knowledge", "global", "entries");
  mkdirSync(entries, { recursive: true });
  writeFileSync(join(entries, "demo.md"), "---\nid: demo\ntopic: demo-memory\nscope: global\nstatus: verified\nupdated_at: 2026-01-01T00:00:00Z\n---\n\nremembered detail\n");
  const memory = (payload) => JSON.parse(run(["memory-context", "--platform", "Antigravity", "--state-root", state], payload).stdout);
  const first = memory({ invocationNum: 0 });
  assert.equal(first.injectSteps.length, 1, `first invocation must inject: ${JSON.stringify(first)}`);
  assert.match(first.injectSteps[0].ephemeralMessage, /demo-memory/);
  // Every later invocation in the same conversation still has to answer, but must not re-scan and
  // re-inject: PreInvocation fires per model invocation, not once per session.
  assert.deepEqual(memory({ invocationNum: 3 }), { injectSteps: [] });
  assert.deepEqual(memory({}), { injectSteps: [] });
});

test("Antigravity .agents proof is established by view_file and scoped to one conversation", () => {
  const root = join(tmpdir(), `agent-workflow-antigravity-proof-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const repo = join(root, "repo");
  const otherRepo = join(root, "other-repo");
  const skillPath = join(repo, ".agents", "skills", "writing-for-agents", "SKILL.md");
  mkdirSync(join(repo, ".agents", "skills", "writing-for-agents"), { recursive: true });
  mkdirSync(join(otherRepo, ".agents"), { recursive: true });
  writeFileSync(skillPath, "writing-for-agents guidance");
  const guard = (event, payload) => run(["skill-guard", "--platform", "Antigravity", "--event", event, "--state-root", state], payload).stdout;
  const readSkill = (conversationId) => guard("PostToolUse", { conversationId, workspacePaths: [repo], toolCall: { name: "view_file", args: { AbsolutePath: skillPath } } });
  const mutate = (conversationId, cwd) => guard("PreToolUse", { conversationId, workspacePaths: [repo], toolCall: { name: "write_to_file", args: { TargetFile: join(".agents", "skills", "x", "SKILL.md"), Cwd: cwd } } });

  assert.equal(JSON.parse(mutate("conversation-a", repo)).decision, "deny", "a .agents write without proof must be denied");
  readSkill("conversation-a");
  assert.equal(JSON.parse(mutate("conversation-a", repo)).decision, "allow", "view_file's AbsolutePath must establish the proof");
  assert.equal(JSON.parse(mutate("conversation-b", repo)).decision, "deny", "proof is bound to one conversationId");
  // Cwd, not the workspace root, is what a run_command/tool call resolves its relative paths
  // against; reading the workspace root instead would resolve this into the proven .agents root.
  assert.equal(JSON.parse(mutate("conversation-a", otherRepo)).decision, "deny", "Cwd must decide which .agents root the write targets");
});
