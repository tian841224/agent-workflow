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
  "cd C:/repo && git branch --show-current && which agent-workflow 2>/dev/null; node scripts/run-tests.mjs --help 2>&1 | head -5; ls .agents/skills/workflow"
]) test(`representative workflow allows: ${command}`, () => assert.equal(denied(command), false));

for (const command of [
  'echo "{}" > task.json', `python -c "open('task.json','w').write('{}')"`,
  `node -e "require('fs').writeFileSync('task.json','{}')"`, "cat task.json; echo x > task.json",
  "git reset --hard", "git clean -fdx", "git branch -D feature", "git checkout -- src/a.ts",
  "git restore src/a.ts", "git push --force", "git push -f", "git push origin +main",
  'echo x > "task".json', 'echo x >&task.json', "perl -e 'unlink q(task.json)'",
  'git -calias.x="!git push" x', 'git --config-env=alias.x=EVIL x',
  "git --unknown-option reset --hard",
  "sort -o task.json input.txt", "uniq input.txt task.json", "find task.json '-delete'", "yq '-i' task.json",
  "git push -d origin branch", "git branch -fD branch", 'git diff --output=task.json',
  "cat <<EOF\n$(git reset --hard)\nEOF", "cat <<EOF\n$(printf '{}' > task.json)\nEOF",
  'bash -c "git push origin main"', 'echo "$(git push origin main)"'
]) test(`protected operation denies: ${command}`, () => assert.equal(denied(command), true));

for (const tool_input of [
  { file_path: "task.json" },
  { patch: "*** Begin Patch\n*** Update File: task.json\n@@\n-a\n+b\n*** End Patch" },
  { input: "*** Begin Patch\n*** Update File: other.json\n*** Move to: task.json\n*** End Patch" }
]) test(`editor task protection: ${JSON.stringify(tool_input)}`, () => {
  const result = spawnSync(process.execPath, ["dist/agent-workflow-hook.mjs", "git-guard", "--platform", "Codex"], {
    encoding: "utf8", input: JSON.stringify({ tool_name: "apply_patch", tool_input })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /task-guard/);
});

test("Codex exec_command cmd uses the same task guard", () => {
  const result = spawnSync(process.execPath, ["dist/agent-workflow-hook.mjs", "git-guard", "--platform", "Codex"], {
    encoding: "utf8", input: JSON.stringify({ tool_name: "exec_command", tool_input: { cmd: "echo x > task.json" } })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /task-guard/);
});
