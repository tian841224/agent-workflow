import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cli = join(process.cwd(), "dist", "agent-workflow.mjs");

// Runtime identity is proven by content hash, so `~/.agent-workflow/runtime/agent-workflow.mjs` only
// resolves to a verified binary when that file actually exists and matches the recorded hash. The
// tests build that whole state themselves under a temporary HOME instead of depending on whatever
// the developer or CI machine happens to have installed.
function installedRuntimeHome() {
  const home = join(tmpdir(), `agent-workflow-runtime-home-${process.pid}-${Date.now()}`);
  const runtime = join(home, ".agent-workflow", "runtime");
  mkdirSync(runtime, { recursive: true });
  const bundle = readFileSync(cli);
  writeFileSync(join(runtime, "agent-workflow.mjs"), bundle);
  writeFileSync(join(home, ".agent-workflow", "managed-runtime.json"), JSON.stringify({ runtime_hash: createHash("sha256").update(bundle).digest("hex") }));
  return home;
}

// PATH is controlled for the same reason HOME is: a bare `agent-workflow` resolves through it, so an
// installed copy on the developer's own PATH would otherwise decide the outcome of these tests.
const guard = (kind, command, home, path = "") => spawnSync(process.execPath, [cli, kind, "--platform", "Claude"], {
  cwd: process.cwd(),
  encoding: "utf8",
  input: JSON.stringify({ tool_name: "bash", session_id: "s1", tool_input: { command } }),
  env: { ...process.env, AGENT_WORKFLOW_STATE_ROOT: "", HOME: home, USERPROFILE: home, PATH: path }
});

// The deny message points the caller at `agent-workflow task-write`; denying the installed runtime
// itself would leave no permitted way to write task.json at all. Trust is granted to the recorded
// runtime hash, never to the name, so the invocation has to resolve to that exact file.
test("the installed runtime CLI is not blocked by the guards that protect task.json", () => {
  const home = installedRuntimeHome();
  for (const command of [
    "node ~/.agent-workflow/runtime/agent-workflow.mjs close-task --task-path /tmp/t/task.json",
    "node ~/.agent-workflow/runtime/agent-workflow.mjs repair --non-interactive"
  ]) {
    for (const kind of ["git-guard"]) {
      const result = guard(kind, command, home);
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /permissionDecision":"deny/, `${kind}: ${command}`);
    }
  }
});

// The `~` expansion is the only reason the command above resolves at all, so it has to be exercised
// against a HOME where no runtime is installed: nothing to verify against must deny, not fall back.
test("a ~-qualified runtime path is denied when that HOME has no verified runtime installed", () => {
  const home = join(tmpdir(), `agent-workflow-runtime-empty-${process.pid}-${Date.now()}`);
  mkdirSync(home, { recursive: true });
  const result = guard("git-guard", "node ~/.agent-workflow/runtime/agent-workflow.mjs close-task --task-path /tmp/t/task.json", home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /permissionDecision":"deny/);
});

// A bare name proves nothing on its own: any script called "agent-workflow" earlier on PATH would
// inherit the runtime's write privileges. It has to resolve to the hash-verified bundle or be denied.
test("a bare agent-workflow invocation that resolves to nothing hash-verified is denied", () => {
  const home = installedRuntimeHome();
  const result = guard("git-guard", "agent-workflow task-write --task-path /tmp/t/task.json", home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /permissionDecision":"deny/);
});

// The install puts a byte-identical copy of the bundle on PATH under the bare name, so this is the
// one way a bare invocation can carry runtime identity. It is the extensionless copy that has to
// match: an npm-style shim wrapping the bundle hashes to something else and stays denied.
test("a bare agent-workflow invocation resolving to the byte-identical bundle is allowed", () => {
  const home = installedRuntimeHome();
  const binDirectory = join(tmpdir(), `agent-workflow-bin-${process.pid}-${Date.now()}`);
  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(join(binDirectory, "agent-workflow"), readFileSync(cli));
  const allowed = guard("git-guard", "agent-workflow task-write --task-path tasks/t/task.json", home, binDirectory);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stdout, /permissionDecision":"deny/);

  writeFileSync(join(binDirectory, "agent-workflow"), `#!/bin/sh\nexec node "${cli}" "$@"\n`);
  const shimmed = guard("git-guard", "agent-workflow task-write --task-path tasks/t/task.json", home, binDirectory);
  assert.match(shimmed.stdout, /permissionDecision":"deny/);
});

test("a non-runtime command that writes task.json is still denied", () => {
  const home = installedRuntimeHome();
  for (const command of [
    "cp /tmp/other.json ./task.json",
    `node -e "require('fs').writeFileSync('task.json','{}')"`,
    "agent-workflow task-write --task-path t/task.json && rm -rf t/task.json"
  ]) {
    assert.match(guard("git-guard", command, home).stdout, /permissionDecision":"deny/, command);
  }
});
