import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

test("task-guard allows the verified runtime's read-only task inspection but still denies a shell write", () => {
  const root = join(tmpdir(), `agent-workflow-guard-reads-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const install = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "install", "--non-interactive", "--skills", "workflow", "--state-root", state, "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);
  const runtime = join(state, "runtime", "agent-workflow.mjs");
  // A forward-slash relative path keeps the guard's task.json detection engaged, so the allow cases
  // below prove the reader allowlist rather than passing because the path went unrecognised.
  const target = "tasks/20260101-000000-demo/task.json";
  const guard = (command) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", "git-guard", "--platform", "Claude", "--state-root", state], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
  });

  for (const subcommand of ["task-report", "task-gate"]) {
    const allowed = guard(`node ${runtime} ${subcommand} --task-path ${target}`);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.doesNotMatch(allowed.stdout, /task-guard/, `${subcommand} must not be denied`);
  }

  // A backslash path is the case splicing cannot see: it glues the directories onto the filename
  // and destroys the word boundary the pattern anchors on, so only the raw spelling still matches.
  for (const [label, write] of [
    ["relative", `echo corrupted > ${target}`],
    ["posix", "echo corrupted > /tmp/agent-workflow-probe/task.json"],
    ["windows", "echo corrupted > C:\\Users\\probe\\agent-workflow\\task.json"],
  ]) {
    const denied = guard(write);
    assert.equal(denied.status, 0, denied.stderr);
    assert.match(denied.stdout, /task-guard/, `${label} redirect must be denied`);
  }
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
