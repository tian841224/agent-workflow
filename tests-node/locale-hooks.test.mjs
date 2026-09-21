import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const cli = join(process.cwd(), "dist", "agent-workflow.mjs");
let installedRoot;
test.before(() => {
  installedRoot = join(tmpdir(), `agent-workflow-locale-hooks-${process.pid}-${Date.now()}`);
  const install = spawnSync(process.execPath, [cli, "install", "--non-interactive", "--state-root", join(installedRoot, "state"), "--claude-target", join(installedRoot, "claude"), "--codex-target", join(installedRoot, "codex"), "--antigravity-target", join(installedRoot, "gemini")], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);
});

function lint(root, payload) {
  return spawnSync(process.execPath, [cli, "locale-lint", "--state-root", join(root, "state")], { cwd: process.cwd(), encoding: "utf8", input: JSON.stringify(payload) });
}
function hookLint(root, platform, payload) {
  return spawnSync(process.execPath, [join(process.cwd(), "dist", "agent-workflow-hook.mjs"), "locale-lint", "--platform", platform, "--state-root", join(root, "state")], { cwd: process.cwd(), encoding: "utf8", input: JSON.stringify(payload) });
}

test("locale-lint blocks on a mainland-usage sentence with all offending terms listed", () => {
  const result = lint(installedRoot, { last_assistant_message: "修改配置後運行服務器" });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /配置 → 設定/);
  assert.match(parsed.reason, /運行 → 執行/);
  assert.match(parsed.reason, /服務器 → 伺服器/);
});

test("locale-lint reads the last assistant text from transcript_path when the payload has none", () => {
  const transcript = join(installedRoot, "transcript.jsonl");
  const assistant = (text) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  writeFileSync(transcript, ["not json", assistant("舊的回覆使用了配置"), JSON.stringify({ type: "user", message: { content: "next" } }), assistant("運行服務器")].join("\n"));
  const result = hookLint(installedRoot, "Claude", { transcript_path: transcript });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "block");
  assert.match(parsed.reason, /運行 → 執行/);
  assert.doesNotMatch(parsed.reason, /配置/);
  assert.equal(hookLint(installedRoot, "Claude", { transcript_path: join(installedRoot, "missing.jsonl") }).stdout.trim(), "");
});

test("locale-lint does not flag words that only contain the term as a documented exception", () => {
  for (const message of ["接了一台數據機", "調整記憶體配置", "改一下配置檔"]) {
    const result = lint(installedRoot, { last_assistant_message: message });
    assert.equal(result.stdout.trim(), "", `expected no output for: ${message}`);
  }
});

test("locale-lint ignores mainland terms inside code fences, inline code, and 「」 quotes", () => {
  for (const message of [
    "```go\nconfig := 配置\n```",
    "行內 `配置` 這個變數",
    "中國常說「配置」，臺灣說「設定」"
  ]) {
    const result = lint(installedRoot, { last_assistant_message: message });
    assert.equal(result.stdout.trim(), "", `expected no output for: ${message}`);
  }
});

test("locale-lint reports a compound term once, not also its shorter substring", () => {
  const result = lint(installedRoot, { last_assistant_message: "連上數據庫查詢" });
  const parsed = JSON.parse(result.stdout);
  assert.equal((parsed.reason.match(/→/g) || []).length, 1, "only one replacement should be reported");
  assert.match(parsed.reason, /數據庫 → 資料庫/);
});

test("locale-lint is a no-op on a retry (stop_hook_active) even if still in violation", () => {
  const result = lint(installedRoot, { last_assistant_message: "運行服務器", stop_hook_active: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
});

test("Antigravity locale hook accepts its prompt_response field and emits deny", () => {
  const result = hookLint(installedRoot, "Antigravity", { prompt_response: "運行服務器" });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.decision, "deny");
  assert.match(parsed.reason, /運行 → 執行/);
});

function hookContext(root, platform, payload) {
  return spawnSync(process.execPath, [join(process.cwd(), "dist", "agent-workflow-hook.mjs"), "locale-context", "--platform", platform, "--state-root", join(root, "state")], { cwd: process.cwd(), encoding: "utf8", input: JSON.stringify(payload) });
}

test("locale-context injects the lint vocabulary at session start, including 落地", () => {
  const claude = hookContext(installedRoot, "Claude", { hook_event_name: "SessionStart" });
  assert.equal(claude.status, 0, claude.stderr);
  const output = JSON.parse(claude.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, "SessionStart");
  assert.match(output.additionalContext, /落地→實作／上線／導入/);
  assert.match(output.additionalContext, /數據→資料（數據機除外）/);
  assert.equal(JSON.parse(hookContext(installedRoot, "Codex", {}).stdout).hookSpecificOutput.hookEventName, "SessionStart");
});

test("locale-context on Antigravity injects only on the first invocation", () => {
  const first = JSON.parse(hookContext(installedRoot, "Antigravity", { invocationNum: 0 }).stdout);
  assert.match(first.injectSteps[0].ephemeralMessage, /落地→/);
  assert.deepEqual(JSON.parse(hookContext(installedRoot, "Antigravity", { invocationNum: 2 }).stdout), { injectSteps: [] });
  assert.deepEqual(JSON.parse(hookContext(installedRoot, "Antigravity", {}).stdout), { injectSteps: [] });
});

test("locale-lint blocks the terms added for session-start injection", () => {
  for (const [message, expected] of [
    ["這個方案要落地", /落地 → 實作／上線／導入/], ["補一份文檔", /文檔 → 文件/], ["使用緩存加速", /緩存 → 快取/],
    ["支持這個格式", /支持 → 支援/], ["優化效能", /優化 → 最佳化/], ["實現這個功能", /實現 → 實作／達成/], ["通過設定啟用", /通過 → 透過/],
    ["新增一個項目", /項目 → 專案/], ["提升質量", /質量 → 品質/], ["登入的用戶", /用戶 → 使用者/], ["讓經驗沉澱下來", /沉澱 → 累積／整理/]
  ]) {
    const parsed = JSON.parse(lint(installedRoot, { last_assistant_message: message }).stdout);
    assert.match(parsed.reason, expected, message);
  }
});

test("locale-lint keeps the Taiwan-valid senses of terms that also have a mainland usage", () => {
  for (const message of ["全部測試通過", "逐一檢查項目", "用戶端送出請求", "質量守恆", "沉澱物很少", "審核通過率很高", "全套測試 337 個通過", "兩項檢查都通過", "驗證已通過"]) {
    assert.equal(lint(installedRoot, { last_assistant_message: message }).stdout.trim(), "", `expected no output for: ${message}`);
  }
});

test("locale-lint is a no-op with exit 0 when no localization policy is installed", () => {
  const root = join(tmpdir(), `agent-workflow-locale-none-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const install = spawnSync(process.execPath, [cli, "install", "--non-interactive", "--skills", "workflow", "--state-root", state, "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);
  // localization-tw is a required skill, so every install writes the policy and no --skills value
  // can exclude it; deleting it is the only way to reach the state this degradation path covers.
  const policy = join(state, "runtime", "localization-tw-policy.json");
  assert.ok(existsSync(policy), "the installer is expected to write the policy for a required skill");
  rmSync(policy);
  const lintResult = lint(root, { last_assistant_message: "運行服務器" });
  assert.equal(lintResult.status, 0);
  assert.equal(lintResult.stdout.trim(), "");
});
