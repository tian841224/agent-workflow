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
  ["a real write after a quoted decoy", `echo "just a note" && git push`],
  ["a real write before a quoted decoy", `git push && echo "done"`],
  ["a real write separated inside a compound", `cd /tmp; git commit -m wip`],
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

// `tee out.md <<EOF` writes, so it is denied — but for writing out.md, not for the command quoted
// in its heredoc body. Keeping the two reasons apart is the point of the stripping.
test("a writing printer is judged on its own target, not on text in its heredoc body", () => {
  const unprotected = guard("git-guard", "tee out.md <<EOF\ngit rebase -i\nEOF");
  assert.doesNotMatch(unprotected.stdout, /"permissionDecision":"deny"/);
  const protectedTarget = guard("skill-guard", "tee .agents/skills/workflow/SKILL.md <<EOF\ngit rebase -i\nEOF");
  assert.match(protectedTarget.stdout, /"permissionDecision":"deny"/);
  assert.doesNotMatch(protectedTarget.stdout, /git-guard/);
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

// git gets a stricter rule than the general read-only allowlist: any indirection at all around a
// segment that mentions git is denied outright, even when the wrapped git call would itself have
// been read-only-safe. The guard no longer tries to resolve what is inside a wrapper/interpreter/
// remote carrier — it refuses on sight of the wrapping instead.
test("git-guard denies git reached through any wrapper, even one that would itself be read-only-safe", () => {
  for (const command of [`ssh build-host git status`, `bash -c "git rev-parse HEAD"`]) {
    assert.equal(denied("git-guard", command), true, command);
  }
});

// The same quote-awareness applies to the read-only allowlist that decides whether a .agents
// command needs the writing-for-agents proof.
test("a quoted redirect does not make an inspection command look like a write", () => {
  assert.equal(denied("skill-guard", `grep -n "a > b" .agents/skills/workflow/SKILL.md`), false);
  assert.equal(denied("skill-guard", `echo x > .agents/skills/workflow/SKILL.md`), true);
});

test("a heredoc fed to an interpreter still counts as a .agents write", () => {
  assert.equal(denied("skill-guard", "python - <<'PY'\nopen('.agents/skills/x/SKILL.md','w').write('x')\nPY"), true);
  assert.equal(denied("skill-guard", "cat <<'EOF'\nsee .agents/skills/workflow/SKILL.md\nEOF"), false);
});

// A redirection that opens no file is a read. Counting every `>` as a write denied `npm run build
// 2>&1`, and a shell payload carries no path field, so it surfaced as an unnameable target.
const DISCARDING_REDIRECTS = [
  ["stderr onto stdout", `npm run build 2>&1`],
  ["stderr to the null device", `npm test 2>/dev/null`],
  ["stdout to the null device", `npm run lint >/dev/null`],
  ["stdout onto stderr", `npm run build >&2`],
  ["a read-only command discarding stderr", `wc -l README.md AGENTS.md 2>&1`]
];
for (const [label, command] of DISCARDING_REDIRECTS) {
  test(`hook-policy allows a redirect that writes no file: ${label}`, () => {
    assert.equal(denied("skill-guard", command), false, command);
    assert.equal(denied("git-guard", command), false, command);
  });
}

// A redirect names its own target, so a real write is judged on that path rather than refused for
// having none. The protected paths stay denied through the same route.
test("a file redirect is judged on its target instead of failing closed", () => {
  assert.equal(denied("skill-guard", `npm run build > out.log`), false);
  assert.equal(denied("skill-guard", `npm run build >> build/out.log`), false);
  assert.equal(denied("skill-guard", `echo x > .agents/pwned.md`), true);
  assert.equal(denied("skill-guard", `echo x > task.json`), true);
});

// A target the shell would expand or splice is one this guard cannot pin to a file, so it stays
// fail-closed. Each of these reaches a protected path once the shell is done with it.
const UNRESOLVED_TARGETS = [
  ["a variable", `echo x > "$TARGET/task.md"`],
  ["a star glob", `echo x > out-*.log`],
  ["a question glob", `rm -rf .agent?`],
  ["a bracket glob", `rm -rf .agent[s]`],
  ["a brace expansion", `rm -rf .agent{s}`],
  ["a bracket glob in a redirect", `echo x > .agent[s]/skills/workflow/SKILL.md`],
  ["a bracket glob naming task state", `echo x > tas[k].json`],
  ["a bracket glob copied over", `cp evil.md .agent[s]/skills/workflow/SKILL.md`],
  ["a bracket glob moved over", `mv evil.json tas[k].json`],
  ["a home-relative target", `rm -rf ~/x`]
];
for (const [label, command] of UNRESOLVED_TARGETS) {
  test(`a target the shell would expand is still refused: ${label}`, () => {
    assert.equal(denied("skill-guard", command), true, command);
  });
}

// Quote and backslash splicing reaches the protected name without ever spelling it literally, so the
// protected-name check also runs over the command with its quoting and escapes removed.
test("a spliced protected name is still denied", () => {
  assert.equal(denied("skill-guard", `rm -rf .agent"s"/skills`), true);
  assert.equal(denied("skill-guard", `rm -rf .agent's'/skills`), true);
  assert.equal(denied("skill-guard", `echo x > "task".json`), true);
});

// A mutating command names its target as plainly as a redirect does. Reading it only from the tool
// payload — which a shell call has none of — refused every `rm`/`cp`/`mv` instead of checking it.
test("a mutating command is judged on the paths it names", () => {
  assert.equal(denied("skill-guard", `rm -rf tmp_wstest/`), false);
  assert.equal(denied("skill-guard", `rm -f slotsrv_test.exe`), false);
  assert.equal(denied("skill-guard", `mv build/out.js dist/out.js`), false);
  assert.equal(denied("skill-guard", `Remove-Item -Path tmp_jptest -Recurse -Force`), false);
});

// A wrapper's payload command is not one of its targets. Counting it as one made `sudo rm -rf` look
// fully accounted for — `rm` reads as a resolved path — and reopened the gate on a targetless delete.
const WRAPPED_TARGETLESS_DELETES = [
  ["a prefix wrapper", `sudo rm -rf`],
  ["env", `env rm -rf`],
  ["nohup", `nohup rm -rf`],
  ["xargs", `xargs rm -rf`],
  ["xargs with a flag", `xargs -0 rm -rf`],
  ["a pipeline into xargs", `cat list.txt | xargs rm -rf`]
];
for (const [label, command] of WRAPPED_TARGETLESS_DELETES) {
  test(`a delete with no nameable target is refused behind ${label}`, () => {
    assert.equal(denied("skill-guard", command), true, command);
  });
}

test("a wrapper does not hide a protected target", () => {
  assert.equal(denied("skill-guard", `sudo rm -rf .agents/skills`), true);
  assert.equal(denied("skill-guard", `xargs rm -rf task.json`), true);
});

// Discarding or capturing stderr does not make a delete targetless; these are the shapes the change
// set out to stop refusing.
test("a mutating command keeps its target alongside a redirect", () => {
  assert.equal(denied("skill-guard", `rm -rf build 2>/dev/null`), false);
  assert.equal(denied("skill-guard", `rm -rf build 2>err.log`), false);
  assert.equal(denied("skill-guard", `rm -rf build >/dev/null 2>&1`), false);
});

// A redirect written flush against the target must not swallow it: dropping the whole token left no
// target to reject at all, which reads as fully accounted for and reopens the gate.
const REDIRECT_GLUED_TARGETS = [
  ["a glob target", `rm -rf .agent[s]>out.txt`],
  ["a glob target under home", `mv /tmp/evil $HOME/.agent[s]>/dev/null`],
  ["a glob target copied over", `cp /tmp/evil $HOME/.agent[s]/skills/workflow/SKILL.md>out.txt`],
  ["a variable beside a real one", `rm -rf /tmp/ok $X>/dev/null`],
  ["a quoted variable beside a real one", `rm -rf /tmp/ok "$D">/dev/null`]
];
for (const [label, command] of REDIRECT_GLUED_TARGETS) {
  test(`a redirect glued to the target does not hide it: ${label}`, () => {
    assert.equal(denied("skill-guard", command), true, command);
  });
}

// `sed` and `tee` are the two commands that both mutate and treat quoted arguments as data, so their
// quoted arguments arrive blanked and a script cannot be told apart from a path. Skipping the blank
// let `tee ok.log ".agent[s]/x.md"` through on the strength of its sibling, so it fails closed and
// the bare form is the one that stays usable.
test("a data command's blanked quoted argument fails closed", () => {
  assert.equal(denied("skill-guard", `sed -i 's/a/b/' file.txt`), true);
  assert.equal(denied("skill-guard", `tee ok.log "notes.md"`), true);
  assert.equal(denied("skill-guard", `sed -i s/a/b/ file.txt`), false);
});

// An option can carry the path in the same word, so a flag is only waved through when it is made of
// nothing but flag characters. `Set-Content -Path:.agent[s]/…` really did write the file.
const FLAG_CARRIED_TARGETS = [
  ["PowerShell -Path:", `Set-Content -Path:.agent[s]/skills/SKILL.md -Value 'pwned'`],
  ["PowerShell -FilePath:", `Out-File -FilePath:.agent[s]/skills/SKILL.md -InputObject 'pwned'`],
  ["PowerShell -Destination:", `Copy-Item evil.md -Destination:.agent[s]/skills/SKILL.md`],
  ["a long option with =", `cp --target-directory=$AG evil.md`],
  ["a short option with an attached value", `tee ok.log -a.agent[s]/x.md`]
];
for (const [label, command] of FLAG_CARRIED_TARGETS) {
  test(`a target carried inside a flag is not waved through: ${label}`, () => {
    assert.equal(denied("skill-guard", command), true, command);
  });
}

test("a flag that carries no path is still skipped", () => {
  assert.equal(denied("skill-guard", `rm -rf --no-preserve-root tmp_wstest/`), false);
  assert.equal(denied("skill-guard", `Remove-Item -Path tmp_jptest -Recurse -Force`), false);
  assert.equal(denied("skill-guard", `cp --target-directory=/tmp/ok evil.md`), false);
});

// The bypass that rule closes: a sibling that does resolve must not vouch for an argument that does not.
test("a resolvable sibling does not account for a blanked argument", () => {
  assert.equal(denied("skill-guard", `tee ok.log ".agent[s]/x.md"`), true);
  assert.equal(denied("skill-guard", `echo hi | tee ok.log ".agent[s]/x.md"`), true);
  assert.equal(denied("skill-guard", `sed -i 's/a/b/' ok.txt ".agent[s]/SKILL.md"`), true);
  assert.equal(denied("skill-guard", `tee ok.log "$D/SKILL.md"`), true);
});

test("a mutating command aimed at a protected path is still denied", () => {
  assert.equal(denied("skill-guard", `rm -rf .agents/skills/workflow`), true);
  assert.equal(denied("skill-guard", `cp evil.md .agents/skills/workflow/SKILL.md`), true);
  assert.equal(denied("skill-guard", `rm -rf $TARGET`), true);
  assert.equal(denied("skill-guard", `rm -rf build-*/`), true);
});

// PowerShell is the primary shell on Windows and does not put the command first. Reading the raw
// first token classified `$t = ...` and `foreach (...) {` as the command and denied read-only work.
const POWERSHELL_READS = [
  ["an assignment binding a read-only git call", `$t = git ls-files`],
  ["a foreach block wrapping a read", `foreach ($d in $dirs) { Get-ChildItem $d -Recurse }`],
  ["an if block wrapping a read", `if ($x) { Get-Content README.md }`],
  ["ForEach-Object wrapping a read", `Get-ChildItem | ForEach-Object { Get-Content $_ }`]
];
for (const [label, command] of POWERSHELL_READS) {
  test(`the allowlist reads through a PowerShell prefix: ${label}`, () => {
    assert.equal(denied("skill-guard", command), false, command);
    assert.equal(denied("git-guard", command), false, command);
  });
}

// Stripping the prefix must reveal the real command to the same checks, never bypass them. A bare
// mutating git call stays deferred to the platform's approval flow, so the compound form is what
// this asserts on: it is the shape git-guard refuses outright.
test("a PowerShell prefix does not hide a write from either guard", () => {
  assert.equal(denied("git-guard", `$r = git push origin main; echo done`), true);
  assert.equal(denied("git-guard", `foreach ($x in $y) { bash -c "git push" }`), true);
});

// Every prefix form the head-stripper understands has to still expose the write underneath it.
const PREFIXED_WRITES = [
  ["an assignment", `$t = rm -rf .agents/skills`],
  ["a foreach block", `foreach ($x in $y) { rm -rf .agents/skills }`],
  ["an if block", `if ($x) { rm -rf .agents/skills }`],
  ["a while block", `while ($x) { rm -rf .agents/skills }`],
  ["a try block", `try { rm -rf .agents/skills }`],
  ["a ForEach-Object block", `Get-ChildItem | ForEach-Object { rm -rf .agents/skills }`],
  ["a bare block", `{ rm -rf .agents/skills }`],
  ["a redirect inside a block", `foreach ($x in $y) { echo v > .agents/pwned.md }`]
];
for (const [label, command] of PREFIXED_WRITES) {
  test(`a write stays denied behind ${label}`, () => {
    assert.equal(denied("skill-guard", command), true, command);
  });
}

// Single quotes suppress expansion in both sh and PowerShell, so a backtick inside one is literal.
// Treating it as a substitution denied plain searches for markdown code spans.
test("a backtick inside single quotes is data, inside double quotes is a substitution", () => {
  assert.equal(denied("skill-guard", "grep -n '^- `' .agents/skills/workflow/risk-flags.md"), false);
  assert.equal(denied("git-guard", "echo '`git push`'"), false);
  assert.equal(denied("git-guard", 'echo "`git push`"'), true);
});

// `\bgit\b` also matched a longer hyphenated word, so this framework's own `git-guard` command name
// tripped its own git guard.
test("a hyphenated word containing git is not a git invocation", () => {
  assert.equal(denied("git-guard", `node dist/agent-workflow.mjs git-guard --platform Claude`), false);
  assert.equal(denied("git-guard", `cat .gitignore`), false);
  assert.equal(denied("git-guard", `git push origin main && echo done`), true);
  assert.equal(denied("git-guard", `/usr/bin/git push && echo done`), true);
});
