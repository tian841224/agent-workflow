import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const run = (args, root) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", "orchestrate", ...args, "--id", "demo", "--state-root", root], { cwd: process.cwd(), encoding: "utf8" });
const freshRoot = (suffix) => join(tmpdir(), `agent-workflow-orchestration-${suffix}-${process.pid}-${Date.now()}`);

test("protocol 3 is the default engine when --protocol is omitted", () => {
  // A missing batch is reported by the protocol 3 state reader, not by a v2 phase tracker default.
  const result = run(["--action", "Status"], freshRoot("default"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /orchestration batch is missing: demo/);
});

test("the retired protocol 2 phase tracker cannot create or advance state", () => {
  const root = freshRoot("retired");
  for (const action of ["Init", "StartExecution", "Integrate", "Apply", "Fail", "Cleanup"]) {
    const result = run(["--protocol", "2", "--action", action], root);
    assert.notEqual(result.status, 0, action);
    assert.match(result.stderr, /protocol 2 is retired/);
  }
  // The old v2 action names are not protocol 3 actions either.
  for (const action of ["Init", "StartExecution"]) assert.notEqual(run(["--action", action], root).status, 0, action);
});

test("a leftover protocol 2 state file stays readable", () => {
  const root = freshRoot("legacy-read");
  mkdirSync(join(root, "orchestration"), { recursive: true });
  writeFileSync(join(root, "orchestration", "demo.json"), JSON.stringify({ schema_version: 2, id: "demo", phase: "split" }));
  const result = run(["--protocol", "2", "--action", "Read"], root);
  assert.equal(result.status, 0, result.stderr);
  const body = JSON.parse(result.stdout);
  assert.equal(body.retired, true);
  assert.equal(body.state.phase, "split");
});
