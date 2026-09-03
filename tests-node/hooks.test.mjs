import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

test("hook policy rejects an unlocatable mutation and orchestration rejects duplicate apply", () => {
  const root = join(tmpdir(), `agent-workflow-guard-${process.pid}-${Date.now()}`);
  const guarded = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "skill-guard", "--platform", "Codex"], { cwd: process.cwd(), encoding: "utf8", input: JSON.stringify({ tool_name: "write_file", tool_input: {} }) });
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.match(guarded.stdout, /denied fail-closed/);
  const run = (action) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", "orchestrate", "--action", action, "--id", "demo", "--state-root", root], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, AGENT_WORKFLOW_ORCHESTRATION_EXPERIMENTAL: "1" } });
  for (const action of ["Init", "WorkerReady", "Integrate", "Apply"]) assert.equal(run(action).status, 0, action);
  assert.notEqual(run("Apply").status, 0);
});

test("MCP connector write tools are not denied as unlocatable file mutations", () => {
  // 連接器工具名含 write 會命中檔案 mutation 偵測，但它的 target 是遠端資源、沒有檔案路徑，
  // 遠端連接器沒有本機檔案路徑，不能套用檔案 mutation 的定位規則
  const guarded = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "skill-guard", "--platform", "Claude"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "mcp__connector__writeCard", tool_input: { cardId: "remote-card", desc: "x" } }),
  });
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.doesNotMatch(guarded.stdout, /denied fail-closed/);
});

test("orchestrate refuses Init without the experimental flag", () => {
  const root = join(tmpdir(), `agent-workflow-orchestration-flag-${process.pid}-${Date.now()}`);
  const result = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "orchestrate", "--action", "Init", "--id", "demo", "--state-root", root], { cwd: process.cwd(), encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Experimental/);
});

test("skill-guard proof rejects a changed SKILL.md and SessionEnd clears the proof", () => {
  const root = join(tmpdir(), `agent-workflow-skill-proof-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const skillPath = join(root, "repo", ".agents", "skills", "writing-for-agents", "SKILL.md");
  mkdirSync(join(root, "repo", ".agents", "skills", "writing-for-agents"), { recursive: true });
  writeFileSync(skillPath, "original guidance");
  const sessionId = "test-session";
  const run = (event, payload) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", "skill-guard", "--platform", "Claude", "--event", event, "--state-root", state], { cwd: process.cwd(), encoding: "utf8", input: JSON.stringify(payload) });
  // cwd 要與 SKILL.md 所在的 tmp repo 一致，否則相對路徑會被解析到執行測試的真實 repo，導致 agents_root 誤判
  const mutate = () => run("PreToolUse", { tool_name: "write_file", tool_input: { file_path: join(".agents", "skills", "x", "SKILL.md") }, session_id: sessionId, cwd: join(root, "repo") });
  assert.equal(run("PostToolUse", { tool_name: "read", tool_input: { file_path: skillPath }, session_id: sessionId, cwd: join(root, "repo") }).status, 0);
  assert.doesNotMatch(mutate().stdout, /denied|deny/);
  writeFileSync(skillPath, "changed guidance");
  assert.match(mutate().stdout, /deny/);
  writeFileSync(skillPath, "original guidance");
  assert.doesNotMatch(mutate().stdout, /denied|deny/);
  assert.equal(run("SessionEnd", { session_id: sessionId }).status, 0);
  assert.match(mutate().stdout, /deny/);
});

test("MCP tools carrying a .agents path still require the writing-for-agents proof", () => {
  // 放行沒有檔案路徑的連接器工具，不得削弱 .agents 寫入保護
  const guarded = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "skill-guard", "--platform", "Claude"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "mcp__fs__write_file", tool_input: { file_path: join(".agents", "skills", "x", "SKILL.md") } }),
  });
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.match(guarded.stdout, /skill-guard/);
});

test("skill-guard denies a shell delete/redirect command whose target path cannot be parsed out", () => {
  const guarded = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "skill-guard", "--platform", "Codex"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "bash", tool_input: { command: "rm .agents/skills/x/SKILL.md" } }),
  });
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.match(guarded.stdout, /denied fail-closed/);
});

test("skill-guard denies a direct Edit/Write tool call targeting task.json", () => {
  const guarded = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "skill-guard", "--platform", "Claude"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "edit", tool_input: { file_path: join("tasks", "20260101-000000-demo", "task.json") } }),
  });
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.match(guarded.stdout, /task-guard/);
});

test("git-guard denies a git subcommand that is not on the read-only allowlist", () => {
  const guarded = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "git-guard", "--platform", "Claude"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "bash", tool_input: { command: "git switch main" } }),
  });
  assert.equal(guarded.status, 0, guarded.stderr);
  assert.match(guarded.stdout, /deny/);
  assert.match(guarded.stdout, /git-guard/);
});
