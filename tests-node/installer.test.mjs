import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

// Install always writes canonical skills under the user's home regardless of the --*-target flags,
// so every spawned install/repair gets its own home instead of racing on the developer's ~/.agents.
const isolatedHome = (root) => ({ ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home") });

function retirementFixture() {
  const root = join(tmpdir(), `agent-workflow-retirement-${process.pid}-${Date.now()}`);
  const source = join(root, "source");
  mkdirSync(join(source, "dist"), { recursive: true });
  for (const bundle of ["agent-workflow.mjs", "agent-workflow-hook.mjs"]) copyFileSync(join("dist", bundle), join(source, "dist", bundle));
  for (const folder of ["adapters", "schemas", ".agents"]) cpSync(folder, join(source, folder), { recursive: true });
  copyFileSync("AGENTS.md", join(source, "AGENTS.md"));
  const manifestPath = join(source, "adapters", "managed-manifest.json");
  const current = JSON.parse(readFileSync(manifestPath, "utf8"));
  const legacy = structuredClone(current);
  legacy.retired_skills = [];
  for (const name of current.retired_skills) {
    legacy.skills[name] = { required: false };
    mkdirSync(join(source, ".agents", "skills", name), { recursive: true });
    writeFileSync(join(source, ".agents", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\nLegacy content\n`);
  }
  writeFileSync(manifestPath, JSON.stringify(legacy));
  const run = (action, target = "All", extra = []) => spawnSync(process.execPath, [join(source, "dist", "agent-workflow.mjs"), action, "--non-interactive", "--target-agent", target, "--state-root", join(root, "state"), "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini"), ...extra], { cwd: source, encoding: "utf8", env: isolatedHome(root) });
  assert.equal(run("install", "All", ["--skills", "all"]).status, 0);
  writeFileSync(manifestPath, JSON.stringify(current));
  return { root, run };
}

test("retired skills leave the catalog and repair removes only selected unchanged managed links", () => {
  const { root, run } = retirementFixture();
  const codex = join(root, "codex", "skills", "adhd-comms");
  const claude = join(root, "claude", "skills", "adhd-comms");
  const dry = run("repair", "Codex", ["--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).retired_skills[0].status, "planned");
  assert.ok(existsSync(codex));
  for (let i = 0; i < 2; i++) {
    const repaired = run("repair", "Codex");
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.equal(existsSync(codex), false);
    assert.ok(existsSync(claude), "unselected platform remains installed");
    assert.ok(existsSync(join(root, "home", ".agents", "skills", "adhd-comms", "SKILL.md")), "recovery copy survives");
  }
  assert.equal(run("repair").status, 0);
  assert.equal(existsSync(claude), false);
  assert.equal(run("verify").status, 0);
  for (const name of ["adhd-comms", "humanizer"]) assert.match(run("install", "All", ["--skills", name]).stderr, /unknown skill/);
  const installed = run("install", "All", ["--skills", "all"]);
  assert.equal(installed.status, 0, installed.stderr);
  for (const name of ["adhd-comms", "humanizer"]) assert.equal(JSON.parse(installed.stdout).selected_skills.includes(name), false);
});

test("retirement preserves changed shared content, unexpected targets, extras and unknown user skills", () => {
  const { root, run } = retirementFixture();
  writeFileSync(join(root, "home", ".agents", "skills", "adhd-comms", "SKILL.md"), "user-edited content");
  const codex = join(root, "codex", "skills", "humanizer");
  unlinkSync(codex);
  const wrong = join(root, "user-target"); mkdirSync(wrong);
  writeFileSync(join(wrong, "SKILL.md"), "user-owned target");
  symlinkSync(wrong, codex, process.platform === "win32" ? "junction" : "dir");
  const claude = join(root, "claude", "skills", "humanizer");
  unlinkSync(claude);
  cpSync(join(root, "home", ".agents", "skills", "humanizer"), claude, { recursive: true });
  writeFileSync(join(claude, "extra.md"), "user extra");
  for (let i = 0; i < 2; i++) {
    const repaired = run("repair");
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.ok(JSON.parse(repaired.stdout).retired_skills.some((item) => item.status === "preserved"));
    assert.equal(readFileSync(join(root, "codex", "skills", "adhd-comms", "SKILL.md"), "utf8"), "user-edited content");
    assert.equal(realpathSync(codex), realpathSync(wrong));
    assert.equal(readFileSync(join(claude, "extra.md"), "utf8"), "user extra");
  }
  const statePath = join(root, "state", "managed-runtime.json");
  const state = JSON.parse(readFileSync(statePath));
  state.files = state.files.filter((item) => !item.path.startsWith(claude));
  writeFileSync(statePath, JSON.stringify(state));
  assert.equal(run("repair").status, 0, "unknown user skill is preserved without import");
  assert.equal(lstatSync(claude).isSymbolicLink(), false);
});

test("retirement archives unchanged legacy copies and keeps their canonical recovery copy", () => {
  const { root, run } = retirementFixture();
  const directory = join(root, "codex", "skills", "humanizer");
  const shared = join(root, "home", ".agents", "skills", "humanizer");
  unlinkSync(directory); cpSync(shared, directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  const statePath = join(root, "state", "managed-runtime.json");
  const state = JSON.parse(readFileSync(statePath));
  state.files = state.files.filter((item) => item.path !== directory);
  state.files.push({ path, kind: "platform-skill", sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
  writeFileSync(statePath, JSON.stringify(state));
  const result = run("repair", "Codex");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(directory), false);
  assert.ok(existsSync(join(JSON.parse(result.stdout).skill_backup, "Codex", "humanizer", "SKILL.md")));
  assert.ok(existsSync(join(shared, "SKILL.md")));
  assert.equal(run("repair", "Codex").status, 0);
});

test("install writes a standalone Node runtime and required skills", () => {
  const root = join(tmpdir(), `agent-workflow-test-${process.pid}-${Date.now()}`);
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", env: isolatedHome(root) });
  const installed = run(["install", "--non-interactive", "--skills", "workflow", "--state-root", join(root, "state"), "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(JSON.parse(installed.stdout).ok, true);
  assert.ok(existsSync(join(root, "state", "runtime", "agent-workflow.mjs")));
  assert.ok(existsSync(join(root, "codex", "skills", "workflow", "SKILL.md")));
  for (const name of ["adhd-comms", "humanizer"]) assert.equal(existsSync(join(root, "codex", "skills", name)), false);
  assert.match(run(["verify", "--state-root", join(root, "state")]).stdout, /"valid":true/);
});

test("install and repair emit native workers that accept direct assignments", () => {
  const root = join(tmpdir(), `agent-workflow-native-worker-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const claudeTarget = join(root, "claude");
  const codexTarget = join(root, "codex");
  for (const action of ["install", "repair"]) {
    const run = spawnSync(process.execPath, ["dist/agent-workflow.mjs", action, "--non-interactive", "--state-root", state,
      "--claude-target", claudeTarget, "--codex-target", codexTarget, "--antigravity-target", join(root, "gemini")],
    { cwd: process.cwd(), encoding: "utf8", env: isolatedHome(root) });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    for (const file of [join(claudeTarget, "agents", "agent-workflow-worker.md"), join(codexTarget, "agents", "agent-workflow-worker.toml")]) {
      const body = readFileSync(file, "utf8");
      assert.match(body, /directly in the coordinator's message/);
      assert.match(body, /Do not revert other contributors' changes/);
      assert.match(body, /Use a result file or particular format only when the coordinator asks/);
      assert.match(body, /Direct native assignments do not require a packet/);
      assert.doesNotMatch(body, /message names one|its `assignment` is your whole job/);
    }
  }
});

test("required implementation-spec installs on every platform on install and repair", () => {
  const root = join(tmpdir(), `agent-workflow-platform-skills-${process.pid}-${Date.now()}`);
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", env: isolatedHome(root) });
  const targets = ["--target-agent", "All", "--state-root", join(root, "state"), "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")];
  for (const action of ["install", "repair"]) {
    const result = run([action, "--non-interactive", "--skills", "workflow", ...targets]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(JSON.parse(result.stdout).selected_skills.includes("implementation-spec"));
    for (const platform of ["claude", "codex", "gemini"]) {
      const skills = platform === "gemini" ? join(root, platform, "config", "skills") : join(root, platform, "skills");
      assert.ok(existsSync(join(skills, "workflow", "SKILL.md")));
      assert.ok(lstatSync(join(skills, "workflow")).isSymbolicLink());
      assert.equal(realpathSync(join(skills, "workflow")), realpathSync(join(root, "home", ".agents", "skills", "workflow")));
      assert.equal(existsSync(join(skills, "implementation-spec", "SKILL.md")), true);
      assert.equal(lstatSync(join(skills, "implementation-spec")).isSymbolicLink(), true);
      assert.equal(realpathSync(join(skills, "implementation-spec")), realpathSync(join(root, "home", ".agents", "skills", "implementation-spec")));
    }
    const state = JSON.parse(readFileSync(join(root, "state", "managed-runtime.json"), "utf8"));
    for (const [platform, skillsPath] of [["claude", join(root, "claude", "skills")], ["codex", join(root, "codex", "skills")], ["gemini", join(root, "gemini", "config", "skills")]]) {
      assert.equal(state.files.some((record) => record.path === join(skillsPath, "implementation-spec") && record.kind === "platform-skill-link"), true, `${platform} link is recorded`);
    }
    const verified = run(["verify", "--state-root", join(root, "state")]);
    assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  }
});

test("platform restriction repairs prune only unchanged managed files and reject invalid platforms", () => {
  const root = join(tmpdir(), `agent-workflow-platform-repair-${process.pid}-${Date.now()}`);
  const sandbox = join(root, "source");
  mkdirSync(join(sandbox, "dist"), { recursive: true });
  for (const bundle of ["agent-workflow.mjs", "agent-workflow-hook.mjs"]) copyFileSync(join("dist", bundle), join(sandbox, "dist", bundle));
  for (const folder of ["adapters", "schemas", ".agents"]) cpSync(folder, join(sandbox, folder), { recursive: true });
  copyFileSync("AGENTS.md", join(sandbox, "AGENTS.md"));
  const manifestPath = join(sandbox, "adapters", "managed-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const allowed = ["Codex"];
  const claudeSkill = join(root, "claude", "skills", "implementation-spec", "SKILL.md");
  const run = (action) => spawnSync(process.execPath, [join(sandbox, "dist", "agent-workflow.mjs"), action, "--non-interactive", "--target-agent", "All", "--state-root", join(root, "state"), "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")], { cwd: sandbox, encoding: "utf8", env: isolatedHome(root) });
  for (const edited of [false, true]) {
    delete manifest.skills["implementation-spec"].platforms;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const installed = run("install");
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    assert.ok(existsSync(claudeSkill));
    const directory = join(root, "claude", "skills", "implementation-spec");
    unlinkSync(directory);
    cpSync(join(root, "home", ".agents", "skills", "implementation-spec"), directory, { recursive: true });
    const statePath = join(root, "state", "managed-runtime.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.files = state.files.filter((record) => record.path !== directory);
    state.files.push({ path: claudeSkill, sha256: createHash("sha256").update(readFileSync(claudeSkill)).digest("hex"), kind: "platform-skill" });
    writeFileSync(statePath, JSON.stringify(state));
    if (edited) writeFileSync(claudeSkill, "user-owned modification");
    manifest.skills["implementation-spec"].platforms = allowed;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const repaired = run("repair");
    assert.equal(repaired.status, 0, repaired.stdout + repaired.stderr);
    assert.ok(existsSync(join(root, "home", ".agents", "skills", "implementation-spec", "SKILL.md")), "platform cleanup preserves the shared target");
    assert.equal(existsSync(claudeSkill), edited);
    assert.equal(existsSync(join(root, "gemini", "config", "skills", "implementation-spec")), false, "restricted platforms are pruned");
    const codexSkill = join(root, "codex", "skills", "implementation-spec");
    assert.equal(existsSync(join(codexSkill, "SKILL.md")), true, "selected platform keeps the skill");
    assert.equal(realpathSync(codexSkill), realpathSync(join(root, "home", ".agents", "skills", "implementation-spec")));
    if (edited) assert.equal(readFileSync(claudeSkill, "utf8"), "user-owned modification");
  }
  for (const invalid of [[], ["codex"], "Codex", ["Claude", 1]]) {
    manifest.skills["implementation-spec"].platforms = invalid;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = run("repair");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid platforms for skill implementation-spec/);
  }
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

test("shared skill links migrate copies, preserve other platforms, and validate identity before uninstall", () => {
  const root = join(tmpdir(), `agent-workflow-links-${process.pid}-${Date.now()}`);
  const shared = join(root, "home", ".agents", "skills", "workflow");
  const claude = join(root, "claude", "skills", "workflow");
  const codex = join(root, "codex", "skills", "workflow");
  const targets = ["--state-root", join(root, "state"), "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")];
  const run = (action, extra = []) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", action, "--non-interactive", ...targets, ...extra], { encoding: "utf8", env: isolatedHome(root) });
  const first = run("install", ["--target-agent", "All"]);
  assert.equal(first.status, 0, first.stderr);
  unlinkSync(codex);
  cpSync(shared, codex, { recursive: true });
  writeFileSync(join(codex, "custom.md"), "local content to preserve");
  const dry = run("repair", ["--target-agent", "Codex", "--dry-run"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(lstatSync(codex).isSymbolicLink(), false);
  const repaired = run("repair", ["--target-agent", "Codex"]);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(readFileSync(join(JSON.parse(repaired.stdout).skill_backup, "Codex", "workflow", "custom.md"), "utf8"), "local content to preserve");
  assert.ok(lstatSync(codex).isSymbolicLink());
  const records = JSON.parse(readFileSync(join(root, "state", "managed-runtime.json"))).files;
  assert.ok(records.some((record) => record.path === claude && record.kind === "platform-skill-link"));
  assert.equal(run("verify").status, 0);
  writeFileSync(join(shared, "visible.md"), "shared change");
  assert.equal(readFileSync(join(claude, "visible.md"), "utf8"), "shared change");
  assert.equal(readFileSync(join(codex, "visible.md"), "utf8"), "shared change");
  unlinkSync(codex);
  cpSync(shared, codex, { recursive: true });
  assert.match(run("verify").stdout, /managed skill link mismatch/);
  rmSync(codex, { recursive: true });
  symlinkSync(join(root, "missing"), codex, process.platform === "win32" ? "junction" : "dir");
  assert.match(run("verify").stdout, /managed skill link mismatch/);
  assert.notEqual(run("repair", ["--target-agent", "Codex"]).status, 0);
  unlinkSync(codex);
  const wrong = join(root, "wrong"); mkdirSync(wrong);
  writeFileSync(join(wrong, "SKILL.md"), "do not delete");
  symlinkSync(wrong, codex, process.platform === "win32" ? "junction" : "dir");
  assert.notEqual(run("verify").status, 0);
  assert.notEqual(run("repair", ["--target-agent", "Codex"]).status, 0);
  const statePath = join(root, "state", "managed-runtime.json");
  const state = JSON.parse(readFileSync(statePath));
  const linkedFile = join(claude, "SKILL.md");
  state.files.unshift({ path: linkedFile, sha256: createHash("sha256").update(readFileSync(linkedFile)).digest("hex"), kind: "platform-skill" });
  writeFileSync(statePath, JSON.stringify(state));
  const removed = run("uninstall");
  assert.equal(removed.status, 0, removed.stderr);
  assert.ok(existsSync(join(shared, "SKILL.md")));
  assert.ok(existsSync(join(wrong, "SKILL.md")));
  assert.ok(lstatSync(codex).isSymbolicLink(), "unexpected links remain user-owned");
  assert.equal(existsSync(claude), false);
});

test("existing extra skills share one version and conflicts or linked roots fail before writes", () => {
  const root = join(tmpdir(), `agent-workflow-extra-${process.pid}-${Date.now()}`);
  const claudeRoot = join(root, "claude", "skills"); const codexRoot = join(root, "codex", "skills");
  for (const directory of [claudeRoot, codexRoot]) {
    mkdirSync(join(directory, "local-skill"), { recursive: true });
    writeFileSync(join(directory, "local-skill", "SKILL.md"), "same content");
  }
  const targets = ["--target-agent", "All", "--state-root", join(root, "state"), "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")];
  const run = (action, extra = []) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", action, "--non-interactive", ...targets, ...extra], { encoding: "utf8", env: isolatedHome(root) });
  writeFileSync(join(codexRoot, "local-skill", "SKILL.md"), "different content");
  const conflict = run("install");
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /conflicting shared skill local-skill/);
  assert.equal(existsSync(join(root, "state")), false);
  assert.equal(readFileSync(join(codexRoot, "local-skill", "SKILL.md"), "utf8"), "different content");
  writeFileSync(join(codexRoot, "local-skill", "SKILL.md"), "same content");
  writeFileSync(join(codexRoot, "local-skill", "extra.md"), "preserve non-conflicting extra files");
  assert.equal(run("install", ["--dry-run"]).status, 0);
  assert.equal(existsSync(join(root, "state")), false);
  const installed = run("install"); assert.equal(installed.status, 0, installed.stderr);
  assert.equal(realpathSync(join(claudeRoot, "local-skill")), realpathSync(join(codexRoot, "local-skill")));
  assert.equal(readFileSync(join(claudeRoot, "local-skill", "extra.md"), "utf8"), "preserve non-conflicting extra files");
  assert.ok(readdirSync(JSON.parse(installed.stdout).skill_backup).includes("Codex"));
  assert.equal(run("repair").status, 0);
  const shared = join(root, "home", ".agents", "skills");
  rmSync(codexRoot, { recursive: true });
  symlinkSync(shared, codexRoot, process.platform === "win32" ? "junction" : "dir");
  assert.match(run("repair").stderr, /outside the shared skills directory/);
  assert.ok(existsSync(join(shared, "local-skill", "SKILL.md")));
});

test("platform target relocation removes old managed links and keeps other platform records", () => {
  const root = join(tmpdir(), `agent-workflow-relocate-${process.pid}-${Date.now()}`);
  const state = join(root, "state"); const oldCodex = join(root, "codex-a"); const newCodex = join(root, "codex-b");
  const claude = join(root, "claude");
  const run = (action, platform, codex) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", action, "--non-interactive", "--state-root", state, "--target-agent", platform, "--claude-target", claude, "--codex-target", codex, "--antigravity-target", join(root, "gemini")], { encoding: "utf8", env: isolatedHome(root) });
  const installed = run("install", "All", oldCodex); assert.equal(installed.status, 0, installed.stderr);
  const repaired = run("repair", "Codex", newCodex); assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(existsSync(join(oldCodex, "skills", "workflow")), false);
  assert.ok(lstatSync(join(newCodex, "skills", "workflow")).isSymbolicLink());
  assert.ok(lstatSync(join(claude, "skills", "workflow")).isSymbolicLink());
  const records = JSON.parse(readFileSync(join(state, "managed-runtime.json"))).files;
  assert.equal(records.some((record) => record.path.startsWith(oldCodex)), false);
  const verified = run("verify", "All", newCodex); assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  assert.equal(run("uninstall", "All", newCodex).status, 0);
  assert.equal(existsSync(join(newCodex, "skills", "workflow")), false);
  assert.ok(existsSync(join(root, "home", ".agents", "skills", "workflow", "SKILL.md")));
});

test("equivalent shared roots are rejected before writes and Windows link target casing is equivalent", () => {
  const root = join(tmpdir(), `agent-workflow-identity-${process.pid}-${Date.now()}`);
  const sharedRoot = join(root, "home", ".agents"); const state = join(root, "state");
  const run = (action, codex) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", action, "--non-interactive", "--target-agent", "Codex", "--state-root", state, "--codex-target", codex], { encoding: "utf8", env: isolatedHome(root) });
  const rejected = run("install", process.platform === "win32" ? sharedRoot.toUpperCase() : sharedRoot);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /outside the shared skills directory/);
  assert.equal(existsSync(state), false);
  const codex = join(root, "codex");
  const installed = run("install", codex); assert.equal(installed.status, 0, installed.stderr);
  if (process.platform === "win32") {
    const link = join(codex, "skills", "workflow"); const shared = join(sharedRoot, "skills", "workflow");
    unlinkSync(link); symlinkSync(shared.toUpperCase(), link, "junction");
    const verified = run("verify", codex); assert.equal(verified.status, 0, verified.stdout + verified.stderr);
    const aliasRejected = run("repair", sharedRoot.toUpperCase());
    assert.notEqual(aliasRejected.status, 0);
    assert.ok(existsSync(join(shared, "SKILL.md")));
  }
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
  const env = { ...process.env, AGENT_WORKFLOW_STATE_ROOT: state, AGENT_WORKFLOW_CLI_DIR: bin, USERPROFILE: root, HOME: root };
  const setup = spawnSync(process.execPath, ["dist/agent-workflow.mjs", "install", "--non-interactive", "--skills", "workflow", "--state-root", state, "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")], {
    cwd: process.cwd(),
    env,
    encoding: "utf8"
  });
  assert.equal(setup.status, 0, setup.stderr);
  const cliRecords = JSON.parse(readFileSync(join(state, "managed-runtime.json"))).files.filter((record) => record.kind === "cli-shim");
  assert.ok(cliRecords.length);
  assert.ok(cliRecords.every((record) => record.path.startsWith(bin)));
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
  const hooks = JSON.parse(readFileSync(join(claudeTarget, "settings.json"), "utf8")).hooks;
  assert.doesNotMatch(JSON.stringify(hooks.PreToolUse || []), /git-guard/);
  const prompt = JSON.stringify(hooks.UserPromptSubmit);
  assert.equal((prompt.match(/locale-context --platform Claude/g) || []).length, 1);
  assert.equal((prompt.match(/memory-context --platform Claude/g) || []).length, 1);
});

test("repair removes retired Git guards on all platforms while preserving mixed user hooks", () => {
  const root = join(tmpdir(), `agent-workflow-retire-git-policy-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const claudeTarget = join(root, "claude");
  const codexTarget = join(root, "codex");
  const geminiTarget = join(root, "gemini");
  const targets = ["--claude-target", claudeTarget, "--codex-target", codexTarget, "--antigravity-target", geminiTarget];
  const run = (action) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", action, "--non-interactive", "--state-root", state, ...targets], { cwd: process.cwd(), encoding: "utf8", env: isolatedHome(root) });
  assert.equal(run("install").status, 0);
  const user = { type: "command", command: "echo user-git-policy" };
  for (const [platform, path] of [["Claude", join(claudeTarget, "settings.json")], ["Codex", join(codexTarget, "hooks.json")]]) {
    const current = JSON.parse(readFileSync(path, "utf8"));
    current.hooks.PreToolUse = [{ matcher: "*", hooks: [{ type: "command", command: `node "${join(state, "runtime", "agent-workflow-hook.mjs")}" git-guard --platform ${platform}` }, user] }];
    writeFileSync(path, JSON.stringify(current));
  }
  const antigravityPath = join(geminiTarget, "config", "hooks.json");
  const current = JSON.parse(readFileSync(antigravityPath, "utf8"));
  current["agent-workflow-git-guard"] = { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "legacy git-guard" }] }] };
  current["user-git-policy"] = { PreToolUse: [{ matcher: "*", hooks: [user] }] };
  writeFileSync(antigravityPath, JSON.stringify(current));
  for (let attempt = 0; attempt < 2; attempt++) {
    const repaired = run("repair");
    assert.equal(repaired.status, 0, repaired.stderr || repaired.stdout);
    for (const path of [join(claudeTarget, "settings.json"), join(codexTarget, "hooks.json"), antigravityPath]) {
      const body = readFileSync(path, "utf8");
      assert.doesNotMatch(body, /git-guard/, path);
      assert.match(body, /user-git-policy/, path);
      assert.match(body, /locale-context/, path);
      assert.match(body, /memory-context/, path);
      const parsed = JSON.parse(body);
      const groups = parsed.hooks?.PreToolUse || parsed["user-git-policy"].PreToolUse;
      assert.deepEqual(groups, [{ matcher: "*", hooks: [user] }]);
    }
  }
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

test("the installed entrypoint drops repo-only lines and points .agents links at the canonical home copy", () => {
  const root = join(tmpdir(), `agent-workflow-entrypoint-${process.pid}-${Date.now()}`);
  const sandbox = join(root, "source");
  mkdirSync(join(sandbox, "dist"), { recursive: true });
  for (const bundle of ["agent-workflow.mjs", "agent-workflow-hook.mjs"]) copyFileSync(join("dist", bundle), join(sandbox, "dist", bundle));
  for (const folder of ["adapters", "schemas", ".agents"]) cpSync(folder, join(sandbox, folder), { recursive: true });
  writeFileSync(join(sandbox, "AGENTS.md"), [
    "# entry",
    "- shared rule → [workflow](.agents/skills/workflow/SKILL.md)",
    "- repository rule → [architecture](docs/architecture.md)<!-- repo-only -->",
    "- installed skill rule<!-- skill:workflow -->",
    "- absent skill rule<!-- skill:not-installed -->"
  ].join("\n"));
  const installed = spawnSync(process.execPath, [join(sandbox, "dist", "agent-workflow.mjs"), "install", "--non-interactive", "--target-agent", "All", "--state-root", join(root, "state"), "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")], { cwd: sandbox, encoding: "utf8", env: isolatedHome(root) });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  // Claude imports the canonical copy, so the filtered body reaches it through that file.
  const claudeEntry = readFileSync(join(root, "claude", "CLAUDE.md"), "utf8");
  assert.match(claudeEntry, /^@~\/\.agents\/AGENTS\.md$/m);
  assert.doesNotMatch(claudeEntry, /shared rule|repository rule|installed skill rule/);
  for (const entry of [join(root, "home", ".agents", "AGENTS.md"), join(root, "codex", "AGENTS.md"), join(root, "gemini", "GEMINI.md")]) {
    const body = readFileSync(entry, "utf8");
    assert.match(body, /shared rule → \[workflow\]\(~\/\.agents\/skills\/workflow\/SKILL\.md\)/, entry);
    assert.doesNotMatch(body, /\]\(\.agents\//, `${entry} keeps a link that only resolves inside the repository`);
    assert.doesNotMatch(body, /repository rule|repo-only|docs\/architecture\.md/, entry);
    assert.match(body, /installed skill rule/, entry);
    assert.doesNotMatch(body, /absent skill rule/, entry);
  }
  assert.ok(existsSync(join(root, "home", ".agents", "skills", "workflow", "SKILL.md")), "the rewritten link names a file the install laid down");
});

test("doc-coauthoring is retired from the catalog", () => {
  const root = join(tmpdir(), `agent-workflow-retired-doc-coauthoring-${process.pid}-${Date.now()}`);
  const run = (skills) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", "install", "--non-interactive", "--skills", skills, "--state-root", join(root, "state"), "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini")], { cwd: process.cwd(), encoding: "utf8", env: isolatedHome(root) });
  assert.match(run("doc-coauthoring").stderr, /unknown skill/);
  const installed = run("all");
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.equal(JSON.parse(installed.stdout).selected_skills.includes("doc-coauthoring"), false);
  assert.equal(existsSync(join(root, "home", ".agents", "skills", "doc-coauthoring")), false);
  assert.equal(existsSync(join(process.cwd(), ".agents", "skills", "doc-coauthoring")), false, "a retired skill has no source left in the repository");
});

// A sandbox copy of the repository is the install source, so a test can delete a skill file from
// the source after the first install without touching the real tree.
function staleCanonicalFixture(label, { skillName = "workflow", relativePath = ["references", "stale.md"], target = "All", installArgs = [] } = {}) {
  const root = join(tmpdir(), `agent-workflow-stale-canonical-${label}-${process.pid}-${Date.now()}`);
  const source = join(root, "source");
  mkdirSync(join(source, "dist"), { recursive: true });
  for (const bundle of ["agent-workflow.mjs", "agent-workflow-hook.mjs"]) copyFileSync(join("dist", bundle), join(source, "dist", bundle));
  for (const folder of ["adapters", "schemas", ".agents"]) cpSync(folder, join(source, folder), { recursive: true });
  copyFileSync("AGENTS.md", join(source, "AGENTS.md"));
  const sourceStale = join(source, ".agents", "skills", skillName, ...relativePath);
  mkdirSync(join(sourceStale, ".."), { recursive: true });
  writeFileSync(sourceStale, "reference removed from the source later\n");
  const run = (action, extra = [], agent = target) => spawnSync(process.execPath, [join(source, "dist", "agent-workflow.mjs"), action, "--non-interactive", "--target-agent", agent, "--state-root", join(root, "state"), "--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", join(root, "gemini"), ...extra], { cwd: source, encoding: "utf8", env: isolatedHome(root) });
  const installed = run("install", installArgs);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const skill = join(root, "home", ".agents", "skills", skillName);
  const stale = join(skill, ...relativePath);
  const statePath = join(root, "state", "managed-runtime.json");
  const recorded = () => JSON.parse(readFileSync(statePath, "utf8")).files.some((record) => record.path === stale);
  assert.ok(existsSync(stale));
  assert.equal(recorded(), true);
  return { run, skill, stale, statePath, recorded, removeFromSource: () => rmSync(join(source, ".agents", "skills", skillName, relativePath[0]), { recursive: true }) };
}

test("a canonical skill file deleted from the source is removed with its record when unchanged", () => {
  const { run, skill, stale, recorded, removeFromSource } = staleCanonicalFixture("unchanged");
  removeFromSource();
  const installed = run("install");
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(join(skill, "references")), false, "the directory emptied by the removal goes with it");
  assert.ok(existsSync(join(skill, "SKILL.md")));
  assert.equal(recorded(), false);
  assert.ok(existsSync(join(JSON.parse(installed.stdout).skill_backup, "canonical", "workflow", "references", "stale.md")), "the removed content stays recoverable");
  assert.equal(run("verify").status, 0);
  const again = run("install");
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(JSON.parse(again.stdout).skill_backup, null, "the cleaned skill matches the source, so a repeat install has nothing to back up");
});

test("removing a source-deleted canonical file stops at the first directory that still has content", () => {
  const { run, skill, stale, recorded, removeFromSource } = staleCanonicalFixture("nested", { relativePath: ["references", "deep", "stale.md"] });
  const notes = join(skill, "references", "notes.md");
  writeFileSync(notes, "user-owned notes");
  removeFromSource();
  const installed = run("install");
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(join(skill, "references", "deep")), false);
  assert.equal(readFileSync(notes, "utf8"), "user-owned notes");
  assert.ok(existsSync(join(skill, "SKILL.md")));
  assert.equal(recorded(), false);
  assert.equal(run("verify").status, 0);
});

test("a canonical skill that is not rewritten in this run keeps its source-deleted file and record", () => {
  const { run, stale, recorded, removeFromSource } = staleCanonicalFixture("not-rewritten", { skillName: "distill", target: "Claude", installArgs: ["--skills", "all"] });
  removeFromSource();
  const installed = run("install", ["--skills", "workflow"], "Codex");
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.equal(JSON.parse(installed.stdout).selected_skills.includes("distill"), false);
  assert.ok(existsSync(stale));
  assert.equal(recorded(), true);
  assert.equal(run("verify").status, 0);
});

test("a user-edited canonical file deleted from the source is kept and no longer recorded", () => {
  const { run, stale, recorded, removeFromSource } = staleCanonicalFixture("edited");
  writeFileSync(stale, "user-owned modification");
  removeFromSource();
  const installed = run("install");
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.equal(readFileSync(stale, "utf8"), "user-owned modification");
  assert.equal(recorded(), false);
  assert.equal(run("verify").status, 0);
});

test("a record for a source-deleted canonical file that is already gone is dropped", () => {
  const { run, stale, recorded, removeFromSource } = staleCanonicalFixture("missing");
  rmSync(stale);
  assert.match(run("verify").stdout, /managed file is missing/);
  removeFromSource();
  const installed = run("install");
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert.equal(recorded(), false);
  assert.equal(run("verify").status, 0);
});

test("a dry run leaves a source-deleted canonical file and the managed state untouched", () => {
  const { run, stale, statePath, removeFromSource } = staleCanonicalFixture("dry-run");
  removeFromSource();
  const before = readFileSync(statePath, "utf8");
  const planned = run("install", ["--dry-run"]);
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  assert.ok(existsSync(stale));
  assert.equal(readFileSync(statePath, "utf8"), before);
});

test("Antigravity hook command assembly outputs clean node on Windows and avoids quote stripping", () => {
  const root = join(tmpdir(), `agent-workflow-antigravity-quotes-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const geminiTarget = join(root, "gemini");
  const targets = ["--claude-target", join(root, "claude"), "--codex-target", join(root, "codex"), "--antigravity-target", geminiTarget];
  const run = (args) => spawnSync(process.execPath, ["dist/agent-workflow.mjs", ...args], { cwd: process.cwd(), encoding: "utf8", env: isolatedHome(root) });
  assert.equal(run(["install", "--non-interactive", "--state-root", state, ...targets]).status, 0);

  const hooksPath = join(geminiTarget, "config", "hooks.json");
  const config = JSON.parse(readFileSync(hooksPath, "utf8"));
  const memoryCmd = config["agent-workflow-memory-context"].PreInvocation[0].command;
  const localeCmd = config["agent-workflow-locale-context"].PreInvocation[0].command;

  assert.match(memoryCmd, /^node\s+"/, "memory-context hook must start with clean node invocation");
  assert.match(localeCmd, /^node\s+"/, "locale-context hook must start with clean node invocation");
  assert.match(memoryCmd, /--platform Antigravity/);
  assert.match(localeCmd, /--platform Antigravity/);
  assert.match(memoryCmd, /--event SessionStart/);

  if (process.platform === "win32") {
    const result = spawnSync("cmd.exe", ["/c", memoryCmd], {
      windowsVerbatimArguments: true,
      encoding: "utf8",
      input: JSON.stringify({ invocationNum: 1 })
    });
    assert.equal(result.status, 0, `cmd /c execution failed: ${result.stderr || result.stdout}`);
  }
});

