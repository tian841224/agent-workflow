import { PRODUCT_VERSION, flag, option, parseArgs, stateRoot, stdinJson } from "./core.js";
import { install, migrateState } from "./installer.js";
import { clearSkillProof, recordSkillRead, runGuard } from "./hooks.js";
import { closeTask, taskGate, transitionTask } from "./lifecycle.js";
import { knowledge, memoryContext } from "./knowledge.js";
import { orchestrate } from "./orchestration.js";
import { fingerprint, preReview, projectResolver, workflowPlan } from "./misc.js";
import { retro, reviewCause, splitPlan } from "./records.js";
import { learn, skillDraft } from "./learning.js";
import { memoryReview } from "./memory-review.js";
import { projectDoc } from "./project-doc.js";

const commands = [
  "install", "repair", "verify", "uninstall", "migrate-state",
  "git-guard", "skill-guard", "memory-context",
  "workflow-plan", "task-gate", "close-task",
  "learn", "knowledge", "skill-draft", "memory-review", "retro", "review-cause",
  "project-resolver", "project-doc", "pre-review",
  "orchestrate", "split-plan", "worktree-fingerprint",
  "pause", "block", "supersede", "waive"
];

function usage(): void {
  process.stdout.write(`agent-workflow ${PRODUCT_VERSION}\n\nUsage: agent-workflow [command] [options]\n\nCommands:\n${commands.map((command) => `  ${command}`).join("\n")}\n`);
}

async function main(): Promise<void> {
  const [providedCommand, ...rest] = process.argv.slice(2);
  if (providedCommand === "--help" || providedCommand === "-h") {
    usage();
    return;
  }
  // The package is intentionally an installer when npx invokes its sole bin
  // without a subcommand: `npx --yes @tian/agent-workflow`.
  const command = providedCommand || "install";
  if (!commands.includes(command)) {
    process.stderr.write(`Unknown command: ${command}\n`);
    process.exitCode = 2;
    return;
  }
  const parsed = parseArgs(rest);
  const installOptions = (action: "Install" | "Repair" | "Verify" | "Uninstall") => ({
    action,
    target: option(parsed.values, "target-agent", option(parsed.values, "agent", "All")),
    root: option(parsed.values, "state-root", stateRoot()),
    skills: option(parsed.values, "skills") || undefined,
    nonInteractive: flag(parsed.values, "non-interactive"),
    dryRun: flag(parsed.values, "dry-run"),
    claude: option(parsed.values, "claude-target", `${process.env.USERPROFILE || process.env.HOME || "."}/.claude`),
    codex: option(parsed.values, "codex-target", `${process.env.USERPROFILE || process.env.HOME || "."}/.codex`),
    antigravity: option(parsed.values, "antigravity-target", `${process.env.USERPROFILE || process.env.HOME || "."}/.gemini`)
  });
  if (command === "install") process.exitCode = await install(installOptions("Install"));
  else if (command === "repair") process.exitCode = await install(installOptions("Repair"));
  else if (command === "verify") process.exitCode = await install(installOptions("Verify"));
  else if (command === "uninstall") process.exitCode = await install(installOptions("Uninstall"));
  else if (command === "migrate-state") { process.stdout.write(`${JSON.stringify(migrateState(option(parsed.values, "state-root", stateRoot()), flag(parsed.values, "dry-run")))}\n`); }
  else if (command === "git-guard" || command === "skill-guard") {
    let payload = {}; try { payload = stdinJson(); } catch { payload = {}; }
    const platform = option(parsed.values, "platform", "Codex");
    const event = option(parsed.values, "event", command === "git-guard" ? "PreToolUse" : "PreToolUse");
    if (command === "skill-guard" && event === "PostToolUse") recordSkillRead(platform, payload, option(parsed.values, "state-root", stateRoot()));
    if (command === "skill-guard" && event === "SessionEnd") clearSkillProof(platform, payload, option(parsed.values, "state-root", stateRoot()));
    runGuard(command === "git-guard" ? "git" : "skill", platform, event, payload, option(parsed.values, "state-root", stateRoot()));
  }
  else if (command === "memory-context") memoryContext(option(parsed.values, "platform", "Codex"), option(parsed.values, "state-root", stateRoot()));
  else if (command === "knowledge") process.exitCode = knowledge(option(parsed.values, "action", "Search"), parsed.values);
  else if (command === "orchestrate") process.exitCode = orchestrate(parsed.values);
  else if (command === "workflow-plan") process.exitCode = workflowPlan(option(parsed.values, "task-path"), option(parsed.values, "policy-path") || undefined);
  else if (command === "project-resolver") process.exitCode = projectResolver(option(parsed.values, "path", parsed.positionals[0] || process.cwd()), option(parsed.values, "state-root", stateRoot()));
  else if (command === "worktree-fingerprint") process.exitCode = fingerprint(option(parsed.values, "path", parsed.positionals[0] || process.cwd()));
  else if (command === "pre-review") process.exitCode = preReview(option(parsed.values, "path", parsed.positionals[0] || process.cwd()));
  else if (command === "retro") process.exitCode = retro(parsed.values);
  else if (command === "review-cause") process.exitCode = reviewCause(parsed.values);
  else if (command === "split-plan") process.exitCode = splitPlan(parsed.values);
  else if (command === "learn") process.exitCode = learn(parsed.values);
  else if (command === "skill-draft") process.exitCode = skillDraft(parsed.values);
  else if (command === "project-doc") process.exitCode = projectDoc(parsed.values);
  else if (command === "task-gate") process.exitCode = taskGate(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")));
  else if (command === "close-task") process.exitCode = closeTask(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), option(parsed.values, "actor", "cli"), option(parsed.values, "confirmed-by-user"), option(parsed.values, "state-root"));
  else if (command === "memory-review") process.exitCode = memoryReview(parsed.values);
  else if (["pause", "block", "supersede", "waive"].includes(command)) {
    const state = transitionTask(option(parsed.values, "task", parsed.positionals[0] || "."), command as "pause" | "block" | "supersede" | "waive", option(parsed.values, "actor", "cli"), option(parsed.values, "confirmed-by-user"), option(parsed.values, "requirement-id"));
    process.stdout.write(`${JSON.stringify(state)}\n`);
  }
  else {
    process.stderr.write(`Node runtime command is not implemented yet: ${command}\n`);
    process.exitCode = 1;
  }
}

void main();
