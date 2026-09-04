import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const guard = (kind, command) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", kind, "--platform", "Claude"], {
  cwd: process.cwd(), encoding: "utf8", input: JSON.stringify({ tool_name: "bash", session_id: "s1", tool_input: { command } })
});

// The deny message points the caller at `agent-workflow task-write`; denying the installed runtime
// itself would leave no permitted way to write task.json at all. Trust is granted to the recorded
// runtime hash, never to the name, so the invocation has to resolve to that exact file.
test("the installed runtime CLI is not blocked by the guards that protect task.json and .agents", () => {
  for (const command of [
    "node ~/.agent-workflow/runtime/agent-workflow.mjs close-task --task-path /tmp/t/task.json",
    "node ~/.agent-workflow/runtime/agent-workflow.mjs repair --non-interactive"
  ]) {
    for (const kind of ["git-guard", "skill-guard"]) {
      const result = guard(kind, command);
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /permissionDecision":"deny/, `${kind}: ${command}`);
    }
  }
});

// A bare name proves nothing on its own: any script called "agent-workflow" earlier on PATH would
// inherit the runtime's write privileges. It has to resolve to the hash-verified bundle or be denied.
test("a bare agent-workflow invocation that resolves to nothing hash-verified is denied", () => {
  const result = guard("git-guard", "agent-workflow task-write --task-path /tmp/t/task.json");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /permissionDecision":"deny/);
});

test("a non-runtime command that writes task.json is still denied", () => {
  for (const command of [
    "cp /tmp/other.json ./task.json",
    `node -e "require('fs').writeFileSync('task.json','{}')"`,
    "agent-workflow task-write --task-path t/task.json && rm -rf t/task.json"
  ]) {
    assert.match(guard("git-guard", command).stdout, /permissionDecision":"deny/, command);
  }
});
