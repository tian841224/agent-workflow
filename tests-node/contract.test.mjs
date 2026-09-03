import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const cli = join(process.cwd(), "dist", "agent-workflow.mjs");
const run = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: "utf8", ...options });

test("contract-lint passes on this repository", () => {
  const result = run(["contract-lint", "--root", process.cwd()]);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.findings, []);
  assert.equal(result.status, 0);
});

test("contract-lint reports a retired name, an unknown CLI command and a missing schema reference", () => {
  const root = join(tmpdir(), `agent-workflow-lint-${process.pid}-${Date.now()}`);
  for (const folder of ["schemas", "templates", ".agents/skills/workflow"]) mkdirSync(join(root, folder), { recursive: true });
  for (const schema of ["workflow-policy.json", "task.schema.json"]) cpSync(join(process.cwd(), "schemas", schema), join(root, "schemas", schema));
  cpSync(join(process.cwd(), ".agents", "skills", "workflow", "SKILL.md"), join(root, ".agents", "skills", "workflow", "SKILL.md"));
  writeFileSync(join(root, "templates", "task.md"), [
    "change_kind: fix",
    "See schemas/task-state.schema.json for the contract.",
    "Run `agent-workflow frobnicate --now`."
  ].join("\n"));
  const result = run(["contract-lint", "--root", root]);
  const rules = JSON.parse(result.stdout).findings.map((finding) => finding.rule);
  assert.ok(rules.includes("retired-name"));
  assert.ok(rules.includes("missing-schema"));
  assert.ok(rules.includes("unknown-command"));
  assert.equal(result.status, 1);
});

// The guard used to decide "is this protected?" only after its mutation heuristics fired, so a write
// performed inside an interpreter argument — no path parameter, no shell redirect — slipped past it.
const AGENTS_WRITES = [
  ["python inline script", `python -c "open('.agents/skills/x/SKILL.md','w').write('x')"`],
  ["node inline script", `node -e "require('fs').writeFileSync('.agents/skills/x/SKILL.md','x')"`],
  ["bash -c wrapper", `bash -c "cp /tmp/x .agents/skills/x/SKILL.md"`],
  ["powershell -Command wrapper", `powershell -Command "Set-Content .agents/skills/x/SKILL.md 'x'"`],
  ["shell redirect", `echo x > .agents/skills/x/SKILL.md`],
  ["piped write", `cat /tmp/x | tee .agents/skills/x/SKILL.md`]
];
for (const [label, command] of AGENTS_WRITES) {
  test(`skill-guard denies a .agents write hidden in a ${label}`, () => {
    const result = run(["skill-guard", "--platform", "Claude"], { input: JSON.stringify({ tool_name: "bash", session_id: "s1", tool_input: { command } }) });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"permissionDecision":"deny"/);
  });
}

test("skill-guard allows a read-only inspection of .agents content", () => {
  for (const command of ["cat .agents/skills/workflow/SKILL.md", "rg todo .agents/skills", "git status .agents"]) {
    const result = run(["skill-guard", "--platform", "Claude"], { input: JSON.stringify({ tool_name: "bash", session_id: "s1", tool_input: { command } }) });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /permissionDecision":"deny/, command);
  }
});

test("task-guard denies a task.json write hidden in an interpreter argument", () => {
  const command = `python -c "open('task.json','w').write('{}')"`;
  const result = run(["git-guard", "--platform", "Claude"], { input: JSON.stringify({ tool_name: "bash", session_id: "s1", tool_input: { command } }) });
  assert.match(result.stdout, /task-guard/);
});

test("knowledge entries are written through knowledge.schema.json and land under the resolved project id", () => {
  const root = join(tmpdir(), `agent-workflow-knowledge-contract-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo"); mkdirSync(repo, { recursive: true });
  const git = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git(["init", "-q"]); git(["config", "user.email", "t@e.com"]); git(["config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), "x"); git(["add", "file.txt"]); git(["commit", "-q", "-m", "init"]);
  const state = join(root, "state");
  const captured = run(["learn", "--action", "Capture", "--kind", "decision", "--topic", "Scoped Memory", "--content", "DISTINCTIVE_LEARNING_TEXT", "--state-root", state], { cwd: repo });
  assert.equal(captured.status, 0, captured.stderr);
  const entry = readFileSync(JSON.parse(captured.stdout).path, "utf8");
  assert.match(entry, /^relationships: \[\]$/m);
  assert.match(entry, /^status: needs_verification$/m);
  const projectId = JSON.parse(run(["project-resolver", "--path", repo, "--state-root", state]).stdout).project_id;
  assert.match(JSON.parse(captured.stdout).path, new RegExp(projectId));
  // Capture can only ever create needs_verification; knowledge-verify is the sole path to verified.
  const verified = run(["knowledge-verify", "--id", JSON.parse(captured.stdout).id, "--source-path", join(repo, "file.txt"), "--state-root", state], { cwd: repo });
  assert.equal(verified.status, 0, verified.stderr);
  const context = run(["memory-context", "--platform", "Claude", "--state-root", state, "--cwd", repo], { cwd: repo });
  assert.match(context.stdout, /DISTINCTIVE_LEARNING_TEXT/);
});

test("a knowledge entry defaults to needs_verification rather than a status outside the schema", () => {
  const root = join(tmpdir(), `agent-workflow-knowledge-default-${process.pid}-${Date.now()}`);
  const captured = run(["knowledge", "--action", "Upsert", "--scope", "Global", "--approved-by-user", "--topic", "default-status", "--content", "body", "--state-root", join(root, "state")]);
  assert.equal(captured.status, 0, captured.stderr);
  assert.match(readFileSync(JSON.parse(captured.stdout).path, "utf8"), /^status: needs_verification$/m);
});

test("memory-context drops entries that match none of the query terms", () => {
  const root = join(tmpdir(), `agent-workflow-memory-query-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const upsert = (topic, content) => run(["knowledge", "--action", "Upsert", "--scope", "Global", "--approved-by-user", "--topic", topic, "--content", content, "--state-root", state]);
  const verify = (id) => run(["knowledge-verify", "--scope", "Global", "--approved-by-user", "--id", id, "--state-root", state]);
  const redis = upsert("redis-cache-keys", "REDIS_DISTINCTIVE_TEXT");
  assert.equal(redis.status, 0);
  assert.equal(verify(JSON.parse(redis.stdout).id).status, 0);
  const jwt = upsert("jwt-rotation", "JWT_DISTINCTIVE_TEXT");
  assert.equal(jwt.status, 0);
  assert.equal(verify(JSON.parse(jwt.stdout).id).status, 0);
  const withoutQuery = run(["memory-context", "--platform", "Claude", "--state-root", state]);
  assert.match(withoutQuery.stdout, /REDIS_DISTINCTIVE_TEXT/);
  assert.match(withoutQuery.stdout, /JWT_DISTINCTIVE_TEXT/);
  const scoped = run(["memory-context", "--platform", "Claude", "--state-root", state, "--query", "jwt rotation"]);
  assert.match(scoped.stdout, /JWT_DISTINCTIVE_TEXT/);
  assert.doesNotMatch(scoped.stdout, /REDIS_DISTINCTIVE_TEXT/);
});

test("orchestration state records its experimental status and revisions each locked transition", () => {
  const root = join(tmpdir(), `agent-workflow-orch-state-${process.pid}-${Date.now()}`);
  const env = { ...process.env, AGENT_WORKFLOW_ORCHESTRATION_EXPERIMENTAL: "1" };
  const step = (action) => JSON.parse(run(["orchestrate", "--action", action, "--id", "demo", "--state-root", root], { env }).stdout);
  const split = step("Init");
  assert.equal(split.experimental, true);
  assert.equal(split.state_revision, 1);
  assert.equal(step("WorkerReady").state_revision, 2);
});
