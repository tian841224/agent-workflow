import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

function reminder(root) {
  return spawnSync(process.execPath, [cli, "locale-reminder", "--state-root", join(root, "state")], { cwd: process.cwd(), encoding: "utf8", input: "{}" });
}
function lint(root, payload) {
  return spawnSync(process.execPath, [cli, "locale-lint", "--state-root", join(root, "state")], { cwd: process.cwd(), encoding: "utf8", input: JSON.stringify(payload) });
}

test("locale-reminder outputs the policy's UserPromptSubmit additionalContext", () => {
  const result = reminder(installedRoot);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(parsed.hookSpecificOutput.additionalContext, /臺灣慣用繁體中文/);
});

test("locale-lint blocks on a mainland-usage sentence with all offending terms listed", () => {
  const result = lint(installedRoot, { last_assistant_message: "修改配置後運行服務器" });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.hookSpecificOutput.decision, "block");
  assert.match(parsed.hookSpecificOutput.decisionReason, /配置 → 設定/);
  assert.match(parsed.hookSpecificOutput.decisionReason, /運行 → 執行/);
  assert.match(parsed.hookSpecificOutput.decisionReason, /服務器 → 伺服器/);
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
  assert.equal((parsed.hookSpecificOutput.decisionReason.match(/→/g) || []).length, 1, "only one replacement should be reported");
  assert.match(parsed.hookSpecificOutput.decisionReason, /數據庫 → 資料庫/);
});

test("locale-lint is a no-op on a retry (stop_hook_active) even if still in violation", () => {
  const result = lint(installedRoot, { last_assistant_message: "運行服務器", stop_hook_active: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
});

test("both hooks no-op with exit 0 when localization-tw was not installed", () => {
  const root = join(tmpdir(), `agent-workflow-locale-none-${process.pid}-${Date.now()}`);
  const install = spawnSync(process.execPath, [cli, "install", "--non-interactive", "--skills", "workflow", "--state-root", join(root, "state"), "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);
  const reminderResult = reminder(root);
  assert.equal(reminderResult.status, 0);
  assert.equal(reminderResult.stdout.trim(), "");
  const lintResult = lint(root, { last_assistant_message: "運行服務器" });
  assert.equal(lintResult.status, 0);
  assert.equal(lintResult.stdout.trim(), "");
});
