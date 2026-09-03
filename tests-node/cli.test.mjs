import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

test("CLI lists the Node command surface", () => {
  const result = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "--help"], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /workflow-plan/);
  assert.match(result.stdout, /migrate-state/);
});

test("install writes a standalone Node runtime and required skills", () => {
  const root = join(tmpdir(), `agent-workflow-test-${process.pid}-${Date.now()}`);
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
  const installed = run(["install", "--non-interactive", "--skills", "workflow", "--state-root", join(root, "state"), "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(JSON.parse(installed.stdout).ok, true);
  assert.ok(existsSync(join(root, "state", "runtime", "agent-workflow.mjs")));
  assert.ok(existsSync(join(root, "codex", "skills", "workflow", "SKILL.md")));
  assert.match(run(["verify", "--state-root", join(root, "state")]).stdout, /"valid":true/);
});

test("repair removes legacy runtime files after replacing the bundle", () => {
  const root = join(tmpdir(), `agent-workflow-repair-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(run(["install", "--non-interactive", "--state-root", state, "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")]).status, 0);
  const stale = join(state, "runtime", "agent_workflow", "installer.py");
  mkdirSync(join(state, "runtime", "agent_workflow"), { recursive: true });
  writeFileSync(stale, "legacy python runtime");
  assert.equal(run(["repair", "--non-interactive", "--state-root", state, "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")]).status, 0);
  assert.ok(!existsSync(stale));
});

test("migration preserves a task backup and marks legacy evidence unverified", () => {
  const root = join(tmpdir(), `agent-workflow-migration-${process.pid}-${Date.now()}`);
  const task = join(root, "projects", "project", "tasks", "legacy"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "---\nid: legacy\nstatus: in_progress\n---\n\nlegacy intent\n");
  const result = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "migrate-state", "--state-root", root], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).migrated, true);
  const migratedJson = JSON.parse(readFileSync(join(task, "task.json"), "utf8"));
  assert.equal(migratedJson.schema_version, 2);
  assert.equal(migratedJson.evidence[0].kind, "legacy-unverified");
  assert.ok(existsSync(join(task, "task.md")));
  const migratedMd = readFileSync(join(task, "task.md"), "utf8");
  assert.doesNotMatch(migratedMd, /^---/);
  assert.match(migratedMd, /legacy intent/);
});

test("skill drafts write the documented draft file and promote its contents", () => {
  const root = join(tmpdir(), `agent-workflow-skill-draft-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
  const drafted = run(["skill-draft", "--action", "Draft", "--name", "example-rule", "--description", "Use when the example rule applies.", "--content", "# Example rule\n\nFollow the rule.", "--state-root", state]);
  assert.equal(drafted.status, 0, drafted.stderr);
  const draftPath = join(state, "skill-drafts", "example-rule", "SKILL.md");
  assert.equal(JSON.parse(drafted.stdout).path, draftPath);
  assert.match(readFileSync(draftPath, "utf8"), /Follow the rule\./);
  const promoted = run(["skill-draft", "--action", "Promote", "--name", "example-rule", "--approved-by-user", "--state-root", state]);
  assert.equal(promoted.status, 0, promoted.stderr);
  assert.equal(readFileSync(join(state, "skills", "example-rule", "SKILL.md"), "utf8"), readFileSync(draftPath, "utf8"));
});

test("memory review prompts once per week and records the user's decision", () => {
  const root = join(tmpdir(), `agent-workflow-memory-review-${process.pid}-${Date.now()}`);
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
  const prompt = run(["memory-review", "--action", "Prompt", "--state-root", root]);
  assert.equal(prompt.status, 0, prompt.stderr);
  assert.equal(JSON.parse(prompt.stdout).prompted, true);
  const repeated = run(["memory-review", "--action", "Prompt", "--state-root", root]);
  assert.equal(JSON.parse(repeated.stdout).prompted, false);
  const decision = run(["memory-review", "--action", "Decision", "--decision", "yes", "--state-root", root]);
  assert.equal(decision.status, 0, decision.stderr);
  assert.match(decision.stdout, /run npm run memory-review/);
  const reviewed = run(["memory-review", "--action", "Reviewed", "--state-root", root]);
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.equal(JSON.parse(reviewed.stdout).due, false);
});

test("close-task reports the weekly memory review question when due", () => {
  const root = join(tmpdir(), `agent-workflow-close-memory-review-${process.pid}-${Date.now()}`);
  const task = join(root, "task");
  const stateRoot = join(root, "state");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Verify task completion prompt\n\n## Goal\n\nConfirm close-task reports the memory review question.\n");
  writeFileSync(join(task, "task.json"), JSON.stringify({
    schema_version: 2,
    id: "close-memory-review",
    lifecycle: { status: "in_progress", transitions: [{ at: new Date().toISOString(), action: "create", from: "new", to: "in_progress", actor: "test" }] },
    evidence: []
  }));
  const result = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "close-task", "--task-path", join(task, "task.json"), "--state-root", stateRoot], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(output.memory_review.due, true);
  assert.equal(output.memory_review.prompted, true);
  assert.match(output.memory_review.question, /記憶檢視/);
});

test("project-resolver reproduces the legacy project_id formula for a git repo with a remote", () => {
  const root = join(tmpdir(), `agent-workflow-project-id-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const git = (args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  git(["remote", "add", "origin", "http://example.com/Repo.git"]);
  writeFileSync(join(root, "file.txt"), "x");
  git(["add", "file.txt"]);
  git(["commit", "-q", "-m", "init"]);
  const rootCommit = spawnSync("git", ["-C", root, "rev-list", "--max-parents=0", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const expected = crypto.createHash("sha256").update(`${root.replaceAll("\\", "/").toLowerCase()}/.git|http://example.com/repo.git|${rootCommit}`).digest("hex").slice(0, 16);
  const resolved = JSON.parse(spawnSync(process.execPath, ["dist/agent-workflow.mjs", "project-resolver", "--path", root, "--state-root", join(root, "state")], { cwd: process.cwd(), encoding: "utf8" }).stdout);
  assert.equal(resolved.project_id, expected);
});

test("repeated repairs do not duplicate a platform's own managed hooks (Windows backslash paths)", () => {
  const root = join(tmpdir(), `agent-workflow-repair-dedupe-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const claudeTarget = join(root, "claude");
  const targets = ["--claude-target", claudeTarget, "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")];
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(run(["install", "--non-interactive", "--state-root", state, ...targets]).status, 0);
  assert.equal(run(["repair", "--non-interactive", "--state-root", state, ...targets]).status, 0);
  assert.equal(run(["repair", "--non-interactive", "--state-root", state, ...targets]).status, 0);
  const preToolUse = JSON.stringify(JSON.parse(readFileSync(join(claudeTarget, "settings.json"), "utf8")).hooks.PreToolUse);
  assert.equal((preToolUse.match(/git-guard --platform Claude/g) || []).length, 1);
});

test("repair keeps a platform's own Stop hook alongside managed hooks", () => {
  const root = join(tmpdir(), `agent-workflow-stop-merge-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const claudeTarget = join(root, "claude");
  const targets = ["--claude-target", claudeTarget, "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")];
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(run(["install", "--non-interactive", "--state-root", state, ...targets]).status, 0);
  const settingsPath = join(claudeTarget, "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.hooks.Stop = [...(settings.hooks.Stop || []), { hooks: [{ type: "agent", prompt: "user's own stop hook" }] }];
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  assert.equal(run(["repair", "--non-interactive", "--state-root", state, ...targets]).status, 0);
  const stopHooks = JSON.stringify(JSON.parse(readFileSync(settingsPath, "utf8")).hooks.Stop);
  assert.match(stopHooks, /user's own stop hook/);
  assert.match(stopHooks, /git-guard|skill-guard|memory-context/);
});

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

test("workflow-plan filters steps by impact_scope/impact_effect/change_kind and rejects an unknown capability", () => {
  const root = join(tmpdir(), `agent-workflow-plan-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const run = (task) => { const path = join(root, `${crypto.randomUUID()}.json`); writeFileSync(path, JSON.stringify(task)); return spawnSync(process.execPath, ["dist/agent-workflow.mjs", "workflow-plan", "--task-path", path], { cwd: process.cwd(), encoding: "utf8" }); };
  const small = JSON.parse(run({ workflow_request: ["execution_path_review"], impact_scope: "file", impact_effect: "local_behavior", change_kind: "fix", risk_flags: [] }).stdout);
  assert.deepEqual(small.steps[0].steps.map((step) => step.id), ["EP1"]);
  const wide = JSON.parse(run({ workflow_request: ["execution_path_review"], impact_scope: "cross_project", impact_effect: "destructive", change_kind: "refactor", risk_flags: [] }).stdout);
  assert.deepEqual(wide.steps[0].steps.map((step) => step.id), ["EP1", "EP2", "EP3", "EP4", "EP5"]);
  const bad = run({ workflow_request: ["not_a_real_capability"] });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout, /unknown capability/);
});

test("task-gate recomputes required evidence at gate time and a matching waiver satisfies one requirement", () => {
  const root = join(tmpdir(), `agent-workflow-gate-${process.pid}-${Date.now()}`);
  const task = join(root, "task"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Gate test\n\n## Goal\n\nVerify runtime-compiled required evidence.\n");
  const write = (state) => writeFileSync(join(task, "task.json"), JSON.stringify(state));
  write({ schema_version: 2, id: "gate-test", workflow_request: ["reviewer"], compiled: { required_evidence: [] }, lifecycle: { status: "in_progress", transitions: [{ at: new Date().toISOString(), action: "create", from: "new", to: "in_progress", actor: "test" }] }, evidence: [], waivers: [] });
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
  const gated = JSON.parse(run(["task-gate", "--task-path", join(task, "task.json")]).stdout);
  assert.equal(gated.valid, false);
  assert.ok(gated.errors.some((error) => error.includes("reviewer:role")));
  const waived = run(["waive", "--task", join(task, "task.json"), "--confirmed-by-user", "user said skip reviewer", "--requirement-id", "reviewer:role"]);
  assert.equal(waived.status, 0, waived.stderr);
  const regated = JSON.parse(run(["task-gate", "--task-path", join(task, "task.json")]).stdout);
  assert.ok(!regated.errors.some((error) => error.includes("reviewer:role")));
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
  const mutate = () => run("PreToolUse", { tool_name: "write_file", tool_input: { file_path: join(".agents", "skills", "x", "SKILL.md") }, session_id: sessionId });
  assert.equal(run("PostToolUse", { tool_name: "read", tool_input: { file_path: skillPath }, session_id: sessionId }).status, 0);
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
