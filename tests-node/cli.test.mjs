import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
