import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

test("help, invalid options and later Antigravity invocations do not initialize schema-owning subsystems", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-workflow-lazy-cli-"));
  const preload = join(directory, "observe.mjs");
  const trace = join(directory, "trace.json");
  writeFileSync(preload, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const original = fs.readFileSync;
    const reads = [];
    fs.readFileSync = function(path, ...args) {
      if (String(path).endsWith(".schema.json")) reads.push(String(path));
      return original.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    process.on("exit", () => fs.writeFileSync(process.env.LAZY_TRACE, JSON.stringify(reads)));
  `);
  for (const [args, payload, expectedStatus] of [
    [["--help"], {}, 0],
    [["task-init", "--unknown-option"], {}, 2],
    [["memory-context", "--platform", "Antigravity"], { invocationNum: 3 }, 0],
    [["git-guard", "--platform", "Codex"], { tool_name: "read_file", tool_input: { file_path: "README.md" } }, 0]
  ]) {
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, "dist/agent-workflow.mjs", ...args], {
      encoding: "utf8", input: JSON.stringify(payload), env: { ...process.env, LAZY_TRACE: trace }
    });
    assert.equal(result.status, expectedStatus, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(trace, "utf8")), [], args.join(" "));
    if (args[0] === "memory-context") assert.deepEqual(JSON.parse(result.stdout), { injectSteps: [] });
  }
});
