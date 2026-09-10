import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

// Adversarial counterpart to hooks.test.mjs / shell-parsing.test.mjs: every case here is an attempt
// to reach task.json or unsafe Git execution through a command the guard must refuse.
const cli = join(process.cwd(), "dist", "agent-workflow.mjs");
const guard = (kind, command, extraArgs = []) => spawnSync(process.execPath, [cli, kind, "--platform", "Claude", ...extraArgs], {
  cwd: process.cwd(), encoding: "utf8", input: JSON.stringify({ tool_name: "bash", session_id: "s1", tool_input: { command } })
});
const denied = (kind, command, extraArgs = []) => {
  const result = guard(kind, command, extraArgs);
  assert.equal(result.status, 0, result.stderr);
  return /"permissionDecision":"deny"/.test(result.stdout);
};

// The runtime CLI is the only sanctioned writer of task.json, and that trust is granted to the
// recorded runtime hash — never to the name. A bare invocation with no hash record to check it
// against has no identity at all, so it is denied rather than believed.
test("a spoofed bare agent-workflow invocation is denied when no runtime hash record backs it", () => {
  const root = join(tmpdir(), `agent-workflow-spoof-${process.pid}-${Date.now()}`);
  assert.equal(denied("git-guard", "agent-workflow task-write --task-path t/task.json", ["--state-root", root]), true);
});

// -c can point git at an alias or a hook, --exec-path relocates its helper binaries and --namespace
// re-points ref resolution: each turns a "read-only" subcommand into arbitrary execution.
const GIT_EXECUTION_ALTERING = [
  `git -c diff.external=/tmp/evil status`,
  `git -c core.fsmonitor=/tmp/evil status`,
  `git -c alias.st='!/tmp/evil' st`,
  `git --exec-path=/tmp/evil status`,
  `git --namespace=evil status`
];
for (const command of GIT_EXECUTION_ALTERING) {
  test(`git-guard denies an execution-altering global option: ${command}`, () => {
    assert.equal(denied("git-guard", command), true, command);
  });
}

// A carrier hands the command to something else to run, so the git call is not at the segment head
// where a head-anchored parser would look for it. Any such indirection is refused on sight.
const CARRIED_GIT = [
  `docker exec app git commit -m wip`,
  `podman exec app git push origin main`,
  `ssh build-host git push origin main`,
  `kubectl exec pod -- git reset --hard`
];
for (const command of CARRIED_GIT) {
  test(`git-guard denies git carried by a remote/container executor: ${command}`, () => {
    assert.equal(denied("git-guard", command), true, command);
  });
}

// git diff/show/log are on the read-only subcommand allowlist, but --output writes their content to
// a file and --ext-diff/--textconv shell out to a configured external helper — each turns a
// "read-only" subcommand into a filesystem mutation or arbitrary execution the allowlist never saw.
const GIT_READ_ONLY_SUBCOMMAND_ESCAPES = [
  `git diff --output=.agents/skills/x/SKILL.md`,
  `git diff --output .agents/skills/x/SKILL.md`,
  `git show --output=.agents/skills/x/SKILL.md HEAD`,
  `git diff --ext-diff`,
  `git diff --textconv HEAD~1 HEAD`,
  `git log --output=.agents/skills/x/SKILL.md`
];
for (const command of GIT_READ_ONLY_SUBCOMMAND_ESCAPES) {
  test(`git-guard denies a diff-machinery escape on an otherwise read-only subcommand: ${command}`, () => {
    assert.equal(denied("git-guard", command), true, command);
  });
}

// Same subcommands without the denied options must keep working — the fix is a narrow second layer
// on top of the existing allowlist, not a rewrite of it.
const GIT_READ_ONLY_SURVIVORS = [`git diff`, `git diff --stat`, `git show HEAD`, `git log --oneline`];
for (const command of GIT_READ_ONLY_SURVIVORS) {
  test(`git-guard still allows an ordinary read-only invocation: ${command}`, () => {
    assert.equal(denied("git-guard", command), false, command);
  });
}

// Runtime identity verification (isRuntimeInvocation) must not be conflated with resource
// authorization: a verified runtime binary is only exempt from a guard for the specific subcommands
// that legitimately write that resource, never as a blanket "any agent-workflow invocation is safe".
test("runtime operation authorization: task-state writers are exempt from task-guard, evidence-run is not", () => {
  const root = join(tmpdir(), `agent-workflow-runtime-auth-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const cliBinary = readFileSync(cli);
  writeFileSync(join(root, "managed-runtime.json"), JSON.stringify({ runtime_hash: createHash("sha256").update(cliBinary).digest("hex") }));
  // task-write is a legitimate task.json writer: verified identity + this subcommand exempts it.
  assert.equal(denied("git-guard", `node ${cli} task-write --task-path t/task.json`, ["--state-root", root]), false);
  // evidence-run is a command carrier — it executes a caller-supplied trailing command, so a
  // verified runtime identity must not grant it a blanket read-only/task-state exemption.
  assert.equal(denied("git-guard", `node ${cli} evidence-run --task-path t/task.json --requirement-id x --summary y -- rm -rf t`, ["--state-root", root]), true);
  // A command substitution runs before the outer `agent-workflow` invocation even starts, so a
  // segment can read as a clean, allowlisted "task-write" call while a `$(...)`/backtick payload
  // has already executed something unrelated and fully privileged. isRuntimeInvocationFor must deny
  // this outright rather than extract "task-write" and grant it the task-state exemption.
  assert.equal(denied("git-guard", `node ${cli} task-write --task-path t/task.json --extra "$(rm -rf t)"`, ["--state-root", root]), true);
  assert.equal(denied("git-guard", "node " + cli + " task-write --task-path t/task.json --extra `rm -rf t`", ["--state-root", root]), true);
});
