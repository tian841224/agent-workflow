import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const cli = join(process.cwd(), "dist", "agent-workflow.mjs");

test("memory-context for one project never includes a knowledge entry written under a different project id", () => {
  const root = join(tmpdir(), `agent-workflow-knowledge-isolation-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  writeFileSync(join(repo, "file.txt"), "x");
  git(["add", "file.txt"]);
  git(["commit", "-q", "-m", "init"]);
  const state = join(root, "state");
  const run = (args, cwd = process.cwd()) => spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
  const currentProjectId = JSON.parse(run(["project-resolver", "--path", repo, "--state-root", state]).stdout).project_id;
  const otherProjectId = "deadbeefcafef00d";
  assert.notEqual(currentProjectId, otherProjectId);
  const upsert = (projectId, topic, content) => run(["knowledge", "--action", "Upsert", "--state-root", state, "--project-id", projectId, "--topic", topic, "--content", content]);
  const verify = (projectId, id) => run(["knowledge-verify", "--state-root", state, "--project-id", projectId, "--id", id, "--source-path", join(repo, "file.txt")]);
  const own = upsert(currentProjectId, "current-project-fact", "This project's own memory entry.");
  assert.equal(own.status, 0);
  assert.equal(verify(currentProjectId, JSON.parse(own.stdout).id).status, 0);
  const other = upsert(otherProjectId, "other-project-secret", "OTHER_PROJECT_DISTINCTIVE_TEXT");
  assert.equal(other.status, 0);
  assert.equal(verify(otherProjectId, JSON.parse(other.stdout).id).status, 0);
  const context = run(["memory-context", "--platform", "Claude", "--state-root", state], repo);
  assert.equal(context.status, 0, context.stderr);
  assert.match(context.stdout, /current-project-fact/);
  assert.doesNotMatch(context.stdout, /OTHER_PROJECT_DISTINCTIVE_TEXT/);
});

test("a freshly-created knowledge entry defaults to status needs_verification and is excluded from memory-context until verified", () => {
  const root = join(tmpdir(), `agent-workflow-knowledge-status-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8" });
  const upsertGlobal = (extra) => run(["knowledge", "--action", "Upsert", "--state-root", state, "--scope", "Global", "--approved-by-user", ...extra]);
  const candidate = upsertGlobal(["--topic", "candidate-fact", "--content", "CANDIDATE_DISTINCTIVE_TEXT"]);
  assert.equal(candidate.status, 0, candidate.stderr);
  const verified = upsertGlobal(["--topic", "verified-fact", "--content", "VERIFIED_DISTINCTIVE_TEXT"]);
  assert.equal(verified.status, 0, verified.stderr);
  // Upsert can only ever create needs_verification; knowledge-verify is the sole path to verified.
  const confirmed = run(["knowledge-verify", "--state-root", state, "--scope", "Global", "--approved-by-user", "--id", JSON.parse(verified.stdout).id]);
  assert.equal(confirmed.status, 0, confirmed.stderr);
  const context = run(["memory-context", "--platform", "Claude", "--state-root", state]);
  assert.equal(context.status, 0, context.stderr);
  assert.match(context.stdout, /VERIFIED_DISTINCTIVE_TEXT/);
  assert.doesNotMatch(context.stdout, /CANDIDATE_DISTINCTIVE_TEXT/);
});

test("memory selection skips stale sources and fills the six-entry budget in relevance order", () => {
  const root = join(tmpdir(), `agent-workflow-ranked-memory-${process.pid}-${Date.now()}`);
  const entries = join(root, "knowledge", "global", "entries");
  mkdirSync(entries, { recursive: true });
  const source = join(root, "source.txt");
  writeFileSync(source, "current source");
  const digest = createHash("sha256").update("current source").digest("hex");
  for (let index = 0; index < 9; index++) {
    const stale = index === 0 || index === 2;
    writeFileSync(join(entries, `${index}.md`), [
      "---", `topic: fact-${index}`, "status: verified", `updated_at: 2026-09-${String(19 - index).padStart(2, "0")}T00:00:00Z`,
      `source_path: ${source}`, `source_sha256: ${stale ? "0".repeat(64) : digest}`, "---", `fact body ${index}`
    ].join("\n"));
  }
  const result = spawnSync(process.execPath, [cli, "memory-context", "--state-root", root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.deepEqual([...context.matchAll(/- fact-(\d):/g)].map((match) => Number(match[1])), [1, 3, 4, 5, 6, 7]);
  assert.doesNotMatch(context, /fact-0|fact-2|fact-8/);
});
