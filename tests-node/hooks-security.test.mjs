import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

// Adversarial counterpart to hooks.test.mjs / shell-parsing.test.mjs: every case here is an attempt
// to reach unsafe Git execution through a command the guard must refuse.
const cli = join(process.cwd(), "dist", "agent-workflow.mjs");
const guard = (kind, command, extraArgs = []) => spawnSync(process.execPath, [cli, kind, "--platform", "Claude", ...extraArgs], {
  cwd: process.cwd(), encoding: "utf8", input: JSON.stringify({ tool_name: "bash", session_id: "s1", tool_input: { command } })
});
const denied = (kind, command, extraArgs = []) => {
  const result = guard(kind, command, extraArgs);
  assert.equal(result.status, 0, result.stderr);
  return /"permissionDecision":"deny"/.test(result.stdout);
};

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
