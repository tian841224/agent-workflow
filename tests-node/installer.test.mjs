import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

// Install always writes canonical skills under the user's home regardless of the --*-target flags,
// so every spawned install/repair gets its own home instead of racing on the developer's ~/.agents.
const isolatedHome = (root) => ({ ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home") });

test("install writes a standalone Node runtime and required skills", () => {
  const root = join(tmpdir(), `agent-workflow-test-${process.pid}-${Date.now()}`);
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", env: isolatedHome(root) });
  const installed = run(["install", "--non-interactive", "--skills", "workflow", "--state-root", join(root, "state"), "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(JSON.parse(installed.stdout).ok, true);
  assert.ok(existsSync(join(root, "state", "runtime", "agent-workflow.mjs")));
  assert.ok(existsSync(join(root, "codex", "skills", "workflow", "SKILL.md")));
  assert.match(run(["verify", "--state-root", join(root, "state")]).stdout, /"valid":true/);
});

test("Ponytail native install is opt-in and dry-run only plans upstream commands", () => {
  const root = join(tmpdir(), `agent-workflow-ponytail-${process.pid}-${Date.now()}`);
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", env: isolatedHome(root) });
  const result = run(["install", "--non-interactive", "--skills", "workflow", "--ponytail", "--dry-run", "--state-root", join(root, "state"), "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")]);
  assert.equal(result.status, 0, result.stderr);
  const native = JSON.parse(result.stdout).native;
  assert.equal(native.length, 1);
  assert.equal(native[0].results.every((item) => item.status === "planned"), true);
  assert.match(native[0].results.map((item) => item.command).join("\n"), /codex plugin add ponytail@ponytail/);
});

test("Design Lab installs Claude through the marketplace and Codex/Antigravity from a temporary clone", () => {
  const root = join(tmpdir(), `agent-workflow-design-lab-${process.pid}-${Date.now()}`);
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", env: isolatedHome(root) });
  const result = run(["install", "--non-interactive", "--skills", "workflow", "--design-and-refine", "--dry-run", "--state-root", join(root, "state"), "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")]);
  assert.equal(result.status, 0, result.stderr);
  const native = JSON.parse(result.stdout).native;
  assert.equal(native.length, 1);
  const commands = native[0].results.map((item) => item.command);
  assert.ok(commands.some((command) => command === "claude plugin marketplace add https://github.com/0xdesign/design-plugin"), "a marketplace install hands the URL to the tool, which keeps its own copy");
  assert.match(commands.find((command) => command.startsWith("git clone")), /https:\/\/github\.com\/0xdesign\/design-plugin /);
  for (const agent of ["codex", "antigravity"]) assert.ok(commands.some((command) => /^npx -y skills add \S*design-and-refine --skill design-lab --global --yes --agent /.test(command) && command.endsWith(agent)), commands.join("\n"));
  assert.match(commands.at(-1), /^remove /);
});

test("--integration installs any manifest entry, and an unknown name fails before anything is written", () => {
  const root = join(tmpdir(), `agent-workflow-integration-${process.pid}-${Date.now()}`);
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", env: isolatedHome(root) });
  const targets = ["--state-root", join(root, "state"), "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")];
  const known = run(["install", "--non-interactive", "--skills", "workflow", "--integration", "hallmark,ponytail", "--dry-run", ...targets]);
  assert.equal(known.status, 0, known.stderr);
  assert.deepEqual(JSON.parse(known.stdout).native.map((item) => item.source), ["https://github.com/nutlope/hallmark", "https://github.com/DietrichGebert/ponytail"]);
  const unknown = run(["install", "--non-interactive", "--skills", "workflow", "--integration", "nope", ...targets]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown integration: nope \(known: ponytail, hallmark, design-and-refine\)/);
  assert.equal(existsSync(join(root, "state", "runtime")), false, "nothing is installed when a name is unknown");
});

test("Hallmark install is opt-in and plans a temporary clone, the upstream install command, and its removal", () => {
  const root = join(tmpdir(), `agent-workflow-hallmark-${process.pid}-${Date.now()}`);
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", env: isolatedHome(root) });
  const targets = ["--state-root", join(root, "state"), "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")];
  const plain = JSON.parse(run(["install", "--non-interactive", "--skills", "workflow", "--dry-run", ...targets]).stdout);
  assert.equal(plain.native, null, "no native install without the flag");
  const result = run(["install", "--non-interactive", "--skills", "workflow", "--hallmark", "--dry-run", ...targets]);
  assert.equal(result.status, 0, result.stderr);
  const native = JSON.parse(result.stdout).native;
  assert.equal(native.length, 1);
  const commands = native[0].results.map((item) => item.command);
  assert.match(commands[0], /^git clone --depth 1 --branch main https:\/\/github\.com\/nutlope\/hallmark /);
  for (const agent of ["claude-code", "codex", "antigravity"]) assert.ok(commands.some((command) => /^npx -y skills add \S*hallmark --global --yes --agent /.test(command) && command.endsWith(`--agent ${agent}`)), commands.join("\n"));
  assert.match(commands.at(-1), /^remove /);
  assert.equal(existsSync(join(root, "state", "upstream")), false, "nothing is kept in the state root");
});

test("a cloned upstream is installed with its own command and the clone is removed afterwards, also on failure", () => {
  const root = join(tmpdir(), `agent-workflow-hallmark-clone-${process.pid}-${Date.now()}`);
  const home = join(root, "home"); const state = join(root, "state"); const upstream = join(root, "upstream-repo"); const sandbox = join(root, "sandbox");
  const git = (cwd, args) => { const result = spawnSync("git", ["-c", "user.email=t@e.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); };
  mkdirSync(join(upstream, "skills", "hallmark"), { recursive: true });
  mkdirSync(join(upstream, "docs"), { recursive: true });
  writeFileSync(join(upstream, "skills", "hallmark", "SKILL.md"), "---\nname: hallmark\ndescription: fake\n---\n");
  writeFileSync(join(upstream, "docs", "recipes.md"), "recipes");
  git(root, ["init", "-q", "-b", "main", upstream]); git(upstream, ["add", "."]); git(upstream, ["commit", "-q", "-m", "init"]);

  // Run the bundle from a scratch package root so the manifest can point at the local upstream repo
  // and stand in for the upstream's install command with a script that only needs the clone.
  mkdirSync(join(sandbox, "dist"), { recursive: true });
  for (const bundle of ["agent-workflow.mjs", "agent-workflow-hook.mjs"]) copyFileSync(join("dist", bundle), join(sandbox, "dist", bundle));
  for (const folder of ["adapters", "schemas", ".agents"]) cpSync(folder, join(sandbox, folder), { recursive: true });
  const manifestPath = join(sandbox, "adapters", "upstream-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const installScript = "const fs=require('fs'),path=require('path');const [checkout,dest]=process.argv.slice(1);fs.cpSync(path.join(checkout,'skills','hallmark'),dest,{recursive:true});fs.writeFileSync(path.join(dest,'saw-docs'),String(fs.existsSync(path.join(checkout,'docs','recipes.md'))));";
  const agentSkill = (agent) => join(root, "installed", agent);
  manifest.integrations.hallmark = {
    source: upstream, ref: "main",
    executables: { Claude: "node", Codex: "node", Antigravity: "node" },
    platforms: Object.fromEntries(["Claude", "Codex", "Antigravity"].map((platform) => [platform, [["-e", installScript, "$checkout", agentSkill(platform)]]]))
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const install = () => spawnSync(process.execPath, [join(sandbox, "dist", "agent-workflow.mjs"), "install", "--non-interactive", "--skills", "workflow", "--hallmark", "--state-root", state, "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")], { cwd: sandbox, encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } });
  const workdirOf = (stdout) => JSON.parse(stdout).native[0].results.find((item) => item.command.startsWith("remove ")).command.slice("remove ".length);

  const first = install();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  for (const platform of ["Claude", "Codex", "Antigravity"]) {
    assert.ok(existsSync(join(agentSkill(platform), "SKILL.md")), `${platform} gets the skill through the install command`);
    assert.equal(readFileSync(join(agentSkill(platform), "saw-docs"), "utf8"), "true", "the install command ran against the full clone");
  }
  assert.equal(existsSync(workdirOf(first.stdout)), false, "the clone is removed after a successful install");
  assert.equal(existsSync(join(state, "upstream")), false);

  manifest.integrations.hallmark.platforms.Claude = [["-e", "process.exit(3)"]];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const failed = install();
  assert.notEqual(failed.status, 0, "a failing upstream install fails the install");
  assert.equal(existsSync(workdirOf(failed.stdout)), false, "the clone is removed even when the install command fails");
});

test("a global CLI shim resolves its recorded source from the managed state root", () => {
  const root = join(tmpdir(), `agent-workflow-global-cli-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const bin = join(root, "npm");
  mkdirSync(bin, { recursive: true });
  const env = { ...process.env, AGENT_WORKFLOW_STATE_ROOT: state, USERPROFILE: root, HOME: root };
  const setup = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "install", "--non-interactive", "--skills", "workflow", "--state-root", state, "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")], {
    cwd: process.cwd(),
    env,
    encoding: "utf8"
  });
  assert.equal(setup.status, 0, setup.stderr);
  copyFileSync(join(state, "runtime", "agent-workflow.mjs"), join(bin, "agent-workflow"));
  const run = spawnSync(process.execPath, [join(bin, "agent-workflow"), "verify", "--non-interactive"], {
    cwd: root,
    env,
    encoding: "utf8"
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /"valid":true/);
});

test("repair removes legacy runtime files after replacing the bundle", () => {
  const root = join(tmpdir(), `agent-workflow-repair-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", env: isolatedHome(root) });
  assert.equal(run(["install", "--non-interactive", "--state-root", state, "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")]).status, 0);
  const stale = join(state, "runtime", "agent_workflow", "installer.py");
  mkdirSync(join(state, "runtime", "agent_workflow"), { recursive: true });
  writeFileSync(stale, "legacy python runtime");
  assert.equal(run(["repair", "--non-interactive", "--state-root", state, "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")]).status, 0);
  assert.ok(!existsSync(stale));
});

test("repeated repairs do not duplicate a platform's own managed hooks (Windows backslash paths)", () => {
  const root = join(tmpdir(), `agent-workflow-repair-dedupe-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const claudeTarget = join(root, "claude");
  const targets = ["--claude-target", claudeTarget, "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")];
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", env: isolatedHome(root) });
  assert.equal(run(["install", "--non-interactive", "--state-root", state, ...targets]).status, 0);
  assert.equal(run(["repair", "--non-interactive", "--state-root", state, ...targets]).status, 0);
  assert.equal(run(["repair", "--non-interactive", "--state-root", state, ...targets]).status, 0);
  const preToolUse = JSON.stringify(JSON.parse(readFileSync(join(claudeTarget, "settings.json"), "utf8")).hooks.PreToolUse);
  assert.equal((preToolUse.match(/git-guard --platform Claude/g) || []).length, 1);
});

test("install keeps clean-comments out of runtime hooks while retaining locale lint", () => {
  const root = join(tmpdir(), `agent-workflow-clean-comments-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const claudeTarget = join(root, "claude");
  const targets = ["--claude-target", claudeTarget, "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")];
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", env: isolatedHome(root) });
  assert.equal(run(["install", "--non-interactive", "--state-root", state, ...targets]).status, 0);
  assert.equal(run(["repair", "--non-interactive", "--state-root", state, ...targets]).status, 0);
  const hooks = JSON.parse(readFileSync(join(claudeTarget, "settings.json"), "utf8")).hooks;
  const stop = JSON.stringify(hooks.Stop || []);
  const preToolUse = JSON.stringify(hooks.PreToolUse || []);
  assert.doesNotMatch(stop, /locale-lint/, "no after-reply lint is installed");
  assert.equal((JSON.stringify(hooks.UserPromptSubmit || []).match(/locale-context --platform Claude/g) || []).length, 1, "locale-context UserPromptSubmit hook must not duplicate across repairs");
  assert.doesNotMatch(stop, /\[agent-workflow managed: clean-comments\]|clean-comments\/SKILL\.md|\"type\":\"agent\"/);
  assert.doesNotMatch(preToolUse, /\[agent-workflow managed: clean-comments\]|clean-comments\/SKILL\.md|Edit\|Write/, "clean-comments must not run on every Edit/Write");
});

test("repair preserves a platform's own Stop hook and adds none of its own", () => {
  const root = join(tmpdir(), `agent-workflow-stop-merge-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const claudeTarget = join(root, "claude");
  const targets = ["--claude-target", claudeTarget, "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")];
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", env: isolatedHome(root) });
  assert.equal(run(["install", "--non-interactive", "--state-root", state, ...targets]).status, 0);
  const settingsPath = join(claudeTarget, "settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.hooks.Stop = [...(settings.hooks.Stop || []), { hooks: [{ type: "agent", prompt: "user's own stop hook" }] }];
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  assert.equal(run(["repair", "--non-interactive", "--state-root", state, ...targets]).status, 0);
  const stopHooks = JSON.stringify(JSON.parse(readFileSync(settingsPath, "utf8")).hooks.Stop);
  assert.match(stopHooks, /user's own stop hook/);
  assert.doesNotMatch(stopHooks, /locale-lint/, "no after-reply lint is installed");
});

test("repair sweeps retired Antigravity lifecycle hooks and keeps the user's own", () => {
  const root = join(tmpdir(), `agent-workflow-antigravity-sweep-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const antigravityTarget = join(root, "gemini");
  const targets = ["--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", antigravityTarget];
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", env: isolatedHome(root) });
  assert.equal(run(["install", "--non-interactive", "--state-root", state, ...targets]).status, 0);
  const hooksPath = join(antigravityTarget, "config", "hooks.json");
  // An install from a build that still targeted SessionStart/SessionEnd — events Antigravity no
  // longer supports. Repair has to sweep them without a dedicated migration, and without touching
  // whatever the user configured themselves.
  writeFileSync(hooksPath, JSON.stringify({
    "agent-workflow-memory-context": { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "legacy memory-context" }] }] },
    "agent-workflow-git-guard": { SessionEnd: [{ matcher: "*", hooks: [{ type: "command", command: "legacy skill-guard --event SessionEnd" }] }] },
    "user-own-hook": { Stop: [{ matcher: "*", hooks: [{ type: "command", command: "user's own stop hook" }] }] }
  }, null, 2));
  assert.equal(run(["repair", "--non-interactive", "--state-root", state, ...targets]).status, 0);
  const repaired = JSON.parse(readFileSync(hooksPath, "utf8"));
  const managed = Object.fromEntries(Object.entries(repaired).filter(([name]) => name.startsWith("agent-workflow-")));
  for (const definition of Object.values(managed)) {
    assert.equal(definition.SessionStart, undefined, "Antigravity must not declare SessionStart");
    assert.equal(definition.SessionEnd, undefined, "Antigravity must not declare SessionEnd");
  }
  assert.ok(repaired["agent-workflow-memory-context"].PreInvocation, "repair must install the PreInvocation memory hook");
  assert.match(JSON.stringify(repaired["user-own-hook"]), /user's own stop hook/);
});

test("a fresh non-interactive install with no --skills selects only required skills; --skills all selects every skill", () => {
  const root = join(tmpdir(), `agent-workflow-install-defaults-${process.pid}-${Date.now()}`);
  const targets = ["--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")];
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", env: isolatedHome(root) });
  const required = Object.entries(JSON.parse(readFileSync("adapters/managed-manifest.json", "utf8")).skills).filter(([, meta]) => meta.required === true).map(([name]) => name).sort();
  const catalog = Object.keys(JSON.parse(readFileSync("adapters/managed-manifest.json", "utf8")).skills).sort();
  assert.ok(catalog.length > required.length, "the manifest needs at least one optional skill for this test to mean anything");

  const defaultInstall = run(["install", "--non-interactive", "--state-root", join(root, "state-default"), ...targets]);
  assert.equal(defaultInstall.status, 0, defaultInstall.stderr);
  assert.deepEqual(JSON.parse(defaultInstall.stdout).selected_skills, required);

  const allInstall = run(["install", "--non-interactive", "--skills", "all", "--state-root", join(root, "state-all"), "--claude-target", join(root, "claude2"), "--codex-target", join(root, "codex2"), "--antigravity-target", join(root, "gemini2")]);
  assert.equal(allInstall.status, 0, allInstall.stderr);
  assert.deepEqual(JSON.parse(allInstall.stdout).selected_skills, catalog);
});

test("a re-install with no --skills keeps the previous selection instead of dropping to required", () => {
  const root = join(tmpdir(), `agent-workflow-install-retention-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const targets = ["--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")];
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", env: isolatedHome(root) });
  const catalog = Object.keys(JSON.parse(readFileSync("adapters/managed-manifest.json", "utf8")).skills).sort();

  const first = run(["install", "--non-interactive", "--skills", "all", "--state-root", state, ...targets]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout).selected_skills, catalog);

  const again = run(["install", "--non-interactive", "--state-root", state, ...targets]);
  assert.equal(again.status, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout).selected_skills, catalog);
});
