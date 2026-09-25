import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

const cli = join(process.cwd(), "dist", "agent-workflow.mjs");
const guard = (kind, command) => spawnSync(process.execPath, [cli, kind, "--platform", "Claude"], {
  cwd: process.cwd(), encoding: "utf8", input: JSON.stringify({ tool_name: "bash", session_id: "s1", tool_input: { command } })
});
const denied = (kind, command) => {
  const result = guard(kind, command);
  assert.equal(result.status, 0, result.stderr);
  return /"permissionDecision":"deny"/.test(result.stdout);
};

// A command that only appears inside data — a heredoc body a printer consumes, or a quoted argument
// a matcher searches for — never runs, so parsing it as an invocation is a false positive.
const QUOTED_OR_HEREDOC = [
  ["quoted argument to a matcher", `rg 'git commit' docs/`],
  ["quoted argument to a printer", `echo "git reset --hard"`],
  ["single-quoted printf", `printf 'git push'`],
  ["grep with a separator inside the quotes", `grep -n "a; git push" README.md`],
  ["echo with a pipe inside the quotes", `echo "run git push | tee log"`],
  ["heredoc body fed to cat", "cat <<EOF\ngit push\ngit reset --hard\nEOF"],
  ["quoted-delimiter heredoc body fed to cat", "cat <<'EOF'\ngit commit -m x\nEOF"],
  ["indented heredoc body fed to cat", "cat <<-EOF\n\tgit merge main\n\tEOF"]
];
for (const [label, command] of QUOTED_OR_HEREDOC) {
  test(`git-guard allows a git command that is only ${label}`, () => {
    assert.equal(denied("git-guard", command), false, command);
  });
}

// The stripping is scoped to commands that treat their arguments as text. An interpreter's quoted
// argument or heredoc body is the program itself, so removing it would hide a real invocation.
const STILL_DENIED = [
  ["bash -c with a quoted git write", `bash -c "git push origin main"`],
  ["sh -c with a quoted git write", `sh -c 'git reset --hard'`],
  ["heredoc body fed to bash", "bash <<EOF\ngit push origin main\nEOF"],
  ["heredoc body fed to sh", "sh <<'EOF'\ngit reset --hard HEAD~1\nEOF"],
  ["powershell -Command with a quoted git write", `powershell -Command "git push"`],
  // Stripping a data command's quoted argument must not strip a substitution: this one runs.
  ["a substitution inside a printer's quotes", `echo "$(git push)"`],
  ["a backtick substitution inside a printer's quotes", "echo \"`git reset --hard`\""],
  ["a wrapper that carries the command past its own head", `ssh build-host git push origin main`],
  ["a container executor carrying the command", `docker exec app git commit -m wip`],
  ["a prefix wrapper with options", `sudo -u deploy git push`],
  ["xargs carrying the command", `printf x | xargs git push`]
];
for (const [label, command] of STILL_DENIED) {
  test(`git-guard still denies ${label}`, () => {
    assert.equal(denied("git-guard", command), true, command);
  });
}

// `tee out.md <<EOF` only writes out.md; the Git command quoted in its heredoc body is data, so the
// guard must not treat it as a Git invocation.
test("a writing printer is judged on its own target, not on text in its heredoc body", () => {
  const unprotected = guard("git-guard", "tee out.md <<EOF\ngit rebase -i\nEOF");
  assert.doesNotMatch(unprotected.stdout, /"permissionDecision":"deny"/);
});

test("read-only git commands survive every stripping layer", () => {
  for (const command of [
    "git status",
    "git --no-pager log --oneline -5",
    `echo "git push" ; git status`,
    "cat <<EOF\ngit push\nEOF\ngit diff HEAD"
  ]) {
    assert.equal(denied("git-guard", command), false, command);
  }
});

// A multi-line -m message or a PowerShell here-string embeds a literal newline in the segment;
// the anchoring regex must still match past it instead of misreporting an execution-altering flag.
test("a multi-line commit message is not misreported as altering git's execution", () => {
  for (const command of [
    'git commit -m "title\n\nbody line"',
    "git commit -m @'\ntitle\n\nbody\n'@"
  ]) {
    const result = guard("git-guard", command);
    assert.doesNotMatch(result.stdout, /"permissionDecision":"deny"/, command);
  }
});

test("a multi-line git command still denies -c and destructive flags", () => {
  const configEscape = guard("git-guard", 'git -c core.hooksPath=x commit -m "a\nb"');
  assert.match(configEscape.stdout, /"permissionDecision":"deny"/);
  assert.doesNotMatch(configEscape.stdout, /'git' appears in the arguments of/);
  const destructive = guard("git-guard", 'git push --force "origin"\nmain');
  assert.match(destructive.stdout, /"permissionDecision":"deny"/);
});

// 'git' appearing only in another command's arguments (not as the segment head) is a different
// failure mode than an execution-altering git invocation, and needs its own accurate message.
test("git-guard denies 'git' inside another command's arguments with an accurate reason, not the execution-altering message", () => {
  const result = guard("git-guard", `node -e "require('child_process').execSync('git push')"`);
  assert.match(result.stdout, /"permissionDecision":"deny"/);
  assert.doesNotMatch(result.stdout, /alters git's execution/);
  assert.match(result.stdout, /'git' appears in the arguments of 'node'/);
});

// git gets a stricter rule than the general read-only allowlist: any indirection at all around a
// segment that mentions git is denied outright, even when the wrapped git call would itself have
// been read-only-safe. The guard no longer tries to resolve what is inside a wrapper/interpreter/
// remote carrier — it refuses on sight of the wrapping instead.
test("git-guard denies git reached through any wrapper, even one that would itself be read-only-safe", () => {
  for (const command of [`ssh build-host git status`, `bash -c "git rev-parse HEAD"`]) {
    assert.equal(denied("git-guard", command), true, command);
  }
});

