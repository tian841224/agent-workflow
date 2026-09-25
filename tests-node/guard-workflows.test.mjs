import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function denied(command) {
  const result = spawnSync(process.execPath, ["dist/agent-workflow-hook.mjs", "git-guard", "--platform", "Codex"], {
    encoding: "utf8", input: JSON.stringify({ tool_name: "bash", tool_input: { command } })
  });
  assert.equal(result.status, 0, result.stderr);
  return /"permissionDecision":"deny"/.test(result.stdout);
}

for (const command of [
  "cat task.json", "cat task.json 2>&1 | head -80", "cat task.json 1>&2", "cat task.json >&2",
  "cd C:/repo && cat task.json", "cat task.json; npm run build", "npm run build; cat task.json",
  "cat task.json 2>&1 | head -80; echo ----; ls task-directory",
  "git diff -- task.json", "git status -- task.json", "git show HEAD:task.json",
  "cat <<'EOF'\n$(git reset --hard)\nEOF", "cat <<'EOF'\n$(printf '{}' > task.json)\nEOF",
  "cd C:/repo && ls .agents", 'cd C:/repo && find .agents -iname "*.json" 2>/dev/null',
  "echo x > .agents/test.md", "git checkout -b fix/foo", "cd C:/repo && git checkout -b fix/foo",
  "cd C:/repo && git branch --show-current && which agent-workflow 2>/dev/null; node scripts/run-tests.mjs --help 2>&1 | head -5; ls .agents/skills/workflow",
  // The runtime CLI is how every task step is recorded; the Git guard must never stand in its way.
  "node ~/.agent-workflow/runtime/agent-workflow.mjs close-task --task-path t/task.json",
  "echo '{\"task_type\":\"fix\"}' | agent-workflow task-write --task-path t",
  "agent-workflow evidence-run --task-path t --requirement-id acceptance.AC1 --summary ok -- npm test",
  "agent-workflow pre-review --path . --task-path t"
]) test(`representative workflow allows: ${command}`, () => assert.equal(denied(command), false));

for (const command of [
  "git reset --hard", "git clean -fdx", "git branch -D feature", "git checkout -- src/a.ts",
  "git restore src/a.ts", "git push --force", "git push -f", "git push origin +main",
  'git -calias.x="!git push" x', 'git --config-env=alias.x=EVIL x',
  "git --unknown-option reset --hard",
  "git push -d origin branch", "git branch -fD branch", 'git diff --output=task.json',
  "cat <<EOF\n$(git reset --hard)\nEOF",
  'bash -c "git push origin main"', 'echo "$(git push origin main)"'
]) test(`protected operation denies: ${command}`, () => assert.equal(denied(command), true));

test("Codex exec_command cmd goes through the same Git guard", () => {
  const result = spawnSync(process.execPath, ["dist/agent-workflow-hook.mjs", "git-guard", "--platform", "Codex"], {
    encoding: "utf8", input: JSON.stringify({ tool_name: "exec_command", tool_input: { cmd: "git reset --hard" } })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"permissionDecision":"deny"/);
});
