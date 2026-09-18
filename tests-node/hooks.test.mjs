import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

test("hook policy defers an unrelated mutation", () => {
  const guarded = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "git-guard", "--platform", "Codex"], { cwd: process.cwd(), encoding: "utf8", input: JSON.stringify({ tool_name: "write_file", tool_input: {} }) });
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.doesNotMatch(guarded.stdout, /denied fail-closed/);
});

test("MCP connector write tools are not denied as unlocatable file mutations", () => {
  // 連接器工具名含 write 會命中檔案 mutation 偵測，但它的 target 是遠端資源、沒有檔案路徑，
  // 遠端連接器沒有本機檔案路徑，不能套用檔案 mutation 的定位規則
  const guarded = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "git-guard", "--platform", "Claude"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "mcp__connector__writeCard", tool_input: { cardId: "remote-card", desc: "x" } }),
  });
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.doesNotMatch(guarded.stdout, /denied fail-closed/);
});

test("task-guard denies a direct Edit/Write tool call targeting task.json", () => {
  const guarded = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "git-guard", "--platform", "Claude"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "edit", tool_input: { file_path: join("tasks", "20260101-000000-demo", "task.json") } }),
  });
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.match(guarded.stdout, /task-guard/);
  assert.match(guarded.stdout, /task-report/);
});

test("git-guard defers a directly parsed git mutation to the platform's own approval flow", () => {
  const guarded = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "git-guard", "--platform", "Claude"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "bash", tool_input: { command: "git switch main" } }),
  });
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.doesNotMatch(guarded.stdout, /deny/);
});

test("git-guard still denies git reached through a wrapper/interpreter/substitution", () => {
  const guarded = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "git-guard", "--platform", "Claude"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "bash", tool_input: { command: "ssh host git switch main" } }),
  });
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.match(guarded.stdout, /deny/);
  assert.match(guarded.stdout, /git-guard/);
});

test("git-guard still denies a git invocation whose --git-dir points outside the project", () => {
  const guarded = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "git-guard", "--platform", "Claude"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "bash", tool_input: { command: "git --git-dir=/tmp/other/.git status" } }),
  });
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.match(guarded.stdout, /deny/);
  assert.match(guarded.stdout, /git-guard/);
});
