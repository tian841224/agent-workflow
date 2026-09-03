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
test("a writing printer is denied for its own write, not for text in its heredoc body", () => {
  const result = guard("git-guard", "tee out.md <<EOF\ngit rebase -i\nEOF");
  assert.match(result.stdout, /"permissionDecision":"deny"/);
  assert.match(result.stdout, /mutation target cannot be normalized/);
  assert.doesNotMatch(result.stdout, /git-guard/);
});

test("read-only git commands survive every stripping layer", () => {
  for (const command of [
    "git status",
    "git --no-pager log --oneline -5",
    `echo "git push" ; git status`,
    "cat <<EOF\ngit push\nEOF\ngit diff HEAD",
    `ssh build-host git status`,
    `bash -c "git rev-parse HEAD"`
  ]) {
    assert.equal(denied("git-guard", command), false, command);
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
