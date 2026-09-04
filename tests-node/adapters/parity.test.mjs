import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { OPERATIONS } from "./fixtures.mjs";

const cli = `${process.cwd()}/dist/agent-workflow.mjs`;

function runGuard(guard, platform, payload) {
  return spawnSync(process.execPath, [cli, guard, "--platform", platform], { cwd: process.cwd(), encoding: "utf8", input: JSON.stringify(payload) }).stdout;
}
function isDenied(stdout) { return /"deny"|"decision":"deny"/.test(stdout); }

for (const [opName, op] of Object.entries(OPERATIONS)) {
  test(`adapter parity: ${opName} decides the same way across Claude, Codex and Antigravity payload shapes`, () => {
    const outcomes = Object.fromEntries(Object.entries(op.payloads).map(([platform, payload]) => [platform, runGuard(op.guard, platform, payload)]));
    for (const [platform, stdout] of Object.entries(outcomes)) {
      assert.equal(isDenied(stdout), op.expectDeny, `${platform} (${opName}): expected deny=${op.expectDeny}, got: ${stdout}`);
      if (op.expectDeny && op.denyContains) assert.match(stdout, new RegExp(op.denyContains), `${platform} (${opName}) reason mismatch: ${stdout}`);
    }
    // Every platform must land on the same allow/deny outcome — that's the parity guarantee, not
    // merely "each platform individually behaves as expected in isolation".
    const denials = new Set(Object.values(outcomes).map(isDenied));
    assert.equal(denials.size, 1, `${opName}: platforms disagreed on allow/deny — ${JSON.stringify(outcomes)}`);
  });
}
