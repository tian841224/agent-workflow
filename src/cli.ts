import { PRODUCT_VERSION, flag, option, optionList, parseArgs, stateRoot, stdinJson } from "./core.js";
import { install, migrateState } from "./installer.js";
import { clearSkillProof, recordSkillRead, runGuard } from "./hooks.js";
import { approveIntent, closeTask, evidenceRecord, reviewRecord, taskGate, taskInit, taskWrite, transitionTask } from "./lifecycle.js";
import { knowledge, knowledgeVerify, memoryContext } from "./knowledge.js";
import { orchestrate } from "./orchestration.js";
import { fingerprint, preReview, projectResolver, workflowPlan } from "./misc.js";
import { retro, reviewCause, splitPlan } from "./records.js";
import { learn, skillDraft } from "./learning.js";
import { memoryReview } from "./memory-review.js";
import { projectDoc } from "./project-doc.js";
import { contractLint } from "./contract-lint.js";
import { policyMatrixCommand } from "./policy-matrix.js";

// The option each command accepts, declared here rather than discovered by reading every module's
// inline reads. This is the registry contract-lint validates documented invocations against, so a
// documented flag that no command reads is a finding instead of a silently ignored argument.
const INSTALL_OPTIONS = ["target-agent", "agent", "state-root", "skills", "non-interactive", "dry-run", "claude-target", "codex-target", "antigravity-target"];
const TASK_TARGET_OPTIONS = ["task-path", "task"];
export const commandOptions: Record<string, string[]> = {
  install: INSTALL_OPTIONS, repair: INSTALL_OPTIONS, verify: INSTALL_OPTIONS, uninstall: INSTALL_OPTIONS,
  "migrate-state": ["state-root", "dry-run"],
  "git-guard": ["platform", "event", "state-root"],
  "skill-guard": ["platform", "event", "state-root"],
  "memory-context": ["platform", "state-root", "query", "cwd"],
  "workflow-plan": ["task-path", "policy-path"],
  "task-init": [...TASK_TARGET_OPTIONS, "actor", "state-root", "repo-root", "adopt-current-diff"],
  "task-write": [...TASK_TARGET_OPTIONS, "state-root", "repo-root", "adopt-current-diff"],
  "task-gate": [...TASK_TARGET_OPTIONS, "repo-root"],
  "close-task": [...TASK_TARGET_OPTIONS, "actor", "confirmed-by-user", "state-root", "repo-root"],
  pause: ["task", "actor"], block: ["task", "actor"], resume: ["task", "actor"], supersede: ["task", "actor"],
  waive: ["task", "actor", "confirmed-by-user", "requirement-id"],
  "approve-intent": [...TASK_TARGET_OPTIONS, "confirmed-by", "as-user"],
  "evidence-record": [...TASK_TARGET_OPTIONS, "requirement-id", "summary", "actor"],
  "review-record": [...TASK_TARGET_OPTIONS, "role", "result", "summary", "repo-root"],
  learn: ["action", "state-root", "scope", "project-id", "cwd", "kind", "topic", "content", "source-event", "supersedes", "forget", "id", "reason", "approved-by-user"],
  knowledge: ["action", "state-root", "scope", "project-id", "cwd", "query", "limit", "topic", "content", "approved-by-user"],
  "knowledge-verify": ["state-root", "scope", "project-id", "cwd", "id", "source-path", "approved-by-user"],
  "skill-draft": ["action", "state-root", "name", "status", "project-id", "cwd", "min-occurrences", "description", "content", "cluster-id", "source-entry", "note", "approved-by-user"],
  "memory-review": ["action", "state-root", "decision"],
  retro: ["action", "state-root", "status", "id", "task-path", "proposed-change"],
  "review-cause": ["action", "state-root", "cause", "status", "id", "task-path", "evidence", "round", "paths", "min-occurrences"],
  "project-resolver": ["path", "state-root"],
  "project-doc": ["action", "paths", "doc", "doc-root", "repo-root"],
  "pre-review": ["path"],
  orchestrate: ["action", "id", "state-root"],
  "split-plan": ["plan-path"],
  "worktree-fingerprint": ["path", "base", "paths"],
  "contract-lint": ["root"],
  "policy-matrix": ["policy-path", "mode", "task-type"]
};
const commands = Object.keys(commandOptions);

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
  else if (command === "memory-context") memoryContext(option(parsed.values, "platform", "Codex"), option(parsed.values, "state-root", stateRoot()), option(parsed.values, "query"), option(parsed.values, "cwd", process.cwd()));
  else if (command === "knowledge") process.exitCode = knowledge(option(parsed.values, "action", "Search"), parsed.values);
  else if (command === "knowledge-verify") process.exitCode = knowledgeVerify(parsed.values);
  else if (command === "orchestrate") process.exitCode = orchestrate(parsed.values);
  else if (command === "workflow-plan") process.exitCode = workflowPlan(option(parsed.values, "task-path"), option(parsed.values, "policy-path") || undefined);
  else if (command === "project-resolver") process.exitCode = projectResolver(option(parsed.values, "path", parsed.positionals[0] || process.cwd()), option(parsed.values, "state-root", stateRoot()));
  else if (command === "worktree-fingerprint") process.exitCode = fingerprint(option(parsed.values, "path", parsed.positionals[0] || process.cwd()), option(parsed.values, "base"), optionList(parsed.values, "paths"));
  else if (command === "policy-matrix") process.exitCode = policyMatrixCommand(option(parsed.values, "policy-path") || undefined, option(parsed.values, "mode", "digests"), option(parsed.values, "task-type"));
  else if (command === "contract-lint") process.exitCode = contractLint(option(parsed.values, "root", parsed.positionals[0] || process.cwd()), commandOptions);
  else if (command === "pre-review") process.exitCode = preReview(option(parsed.values, "path", parsed.positionals[0] || process.cwd()));
  else if (command === "retro") process.exitCode = retro(parsed.values);
  else if (command === "review-cause") process.exitCode = reviewCause(parsed.values);
  else if (command === "split-plan") process.exitCode = splitPlan(parsed.values);
  else if (command === "learn") process.exitCode = learn(parsed.values);
  else if (command === "skill-draft") process.exitCode = skillDraft(parsed.values);
  else if (command === "project-doc") process.exitCode = projectDoc(parsed.values);
  else if (command === "task-init") { let patch = {}; try { patch = stdinJson(); } catch { patch = {}; } process.exitCode = taskInit(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), patch, option(parsed.values, "actor", "cli"), option(parsed.values, "state-root") || undefined, option(parsed.values, "repo-root", process.cwd()), flag(parsed.values, "adopt-current-diff")); }
  else if (command === "task-write") process.exitCode = taskWrite(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), stdinJson(), option(parsed.values, "state-root") || undefined, option(parsed.values, "repo-root", process.cwd()), flag(parsed.values, "adopt-current-diff"));
  else if (command === "task-gate") process.exitCode = taskGate(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), option(parsed.values, "repo-root", process.cwd()));
  else if (command === "close-task") process.exitCode = closeTask(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), option(parsed.values, "actor", "cli"), option(parsed.values, "confirmed-by-user"), option(parsed.values, "state-root"), option(parsed.values, "repo-root", process.cwd()));
  else if (command === "approve-intent") process.exitCode = approveIntent(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), option(parsed.values, "confirmed-by"), flag(parsed.values, "as-user"));
  else if (command === "evidence-record") process.exitCode = evidenceRecord(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), option(parsed.values, "requirement-id"), option(parsed.values, "summary"), option(parsed.values, "actor", "agent"));
  else if (command === "review-record") process.exitCode = reviewRecord(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), option(parsed.values, "role"), option(parsed.values, "result"), option(parsed.values, "summary"), option(parsed.values, "repo-root", process.cwd()));
  else if (command === "memory-review") process.exitCode = memoryReview(parsed.values);
  else if (["pause", "block", "resume", "supersede", "waive"].includes(command)) {
    const state = transitionTask(option(parsed.values, "task", parsed.positionals[0] || "."), command as "pause" | "block" | "resume" | "supersede" | "waive", option(parsed.values, "actor", "cli"), option(parsed.values, "confirmed-by-user"), option(parsed.values, "requirement-id"));
    process.stdout.write(`${JSON.stringify(state)}\n`);
  }
  else {
    process.stderr.write(`Node runtime command is not implemented yet: ${command}\n`);
    process.exitCode = 1;
  }
}

void main();
