import { PRODUCT_VERSION, flag, option, optionList, parseArgs, stateRoot, stdinJson } from "./core.js";

// The option each command accepts, declared here rather than discovered by reading every module's
// inline reads. This is the registry contract-lint validates documented invocations against, so a
// documented flag that no command reads is a finding instead of a silently ignored argument.
const INSTALL_OPTIONS = ["target-agent", "agent", "state-root", "skills", "non-interactive", "dry-run", "claude-target", "codex-target", "antigravity-target"];
const TASK_TARGET_OPTIONS = ["task-path", "task"];
export const commandOptions: Record<string, string[]> = {
  install: INSTALL_OPTIONS, repair: INSTALL_OPTIONS, verify: INSTALL_OPTIONS, uninstall: INSTALL_OPTIONS,
  "migrate-state": ["state-root", "dry-run"],
  "git-guard": ["platform", "event", "state-root"],
  "memory-context": ["platform", "state-root", "query", "cwd", "auto"],
  "workflow-plan": ["task-path", "policy-path"],
  "execution-packet": [...TASK_TARGET_OPTIONS, "repo-root"],
  skill: ["action", "name", "from", "source", "source-type", "skill-path", "root"],
  "task-init": [...TASK_TARGET_OPTIONS, "actor", "state-root", "repo-root", "adopt-current-diff"],
  "task-write": [...TASK_TARGET_OPTIONS, "state-root", "repo-root", "adopt-current-diff"],
  reclassify: [...TASK_TARGET_OPTIONS, "confirmed-by-user", "reason", "actor", "state-root", "repo-root"],
  "task-gate": [...TASK_TARGET_OPTIONS, "repo-root"],
  "task-report": [...TASK_TARGET_OPTIONS, "repo-root"],
  next: [...TASK_TARGET_OPTIONS, "repo-root"],
  "close-task": [...TASK_TARGET_OPTIONS, "actor", "confirmed-by-user", "state-root", "repo-root"],
  pause: ["task", "actor"], block: ["task", "actor"], resume: ["task", "actor"], supersede: ["task", "actor"],
  waive: ["task", "actor", "confirmed-by-user", "requirement-id"],
  "approve-intent": [...TASK_TARGET_OPTIONS, "confirmed-by", "as-user"],
  "evidence-record": [...TASK_TARGET_OPTIONS, "requirement-id", "summary", "actor", "command", "cwd", "exit-code", "output-digest"],
  "evidence-run": [...TASK_TARGET_OPTIONS, "requirement-id", "summary", "actor", "cwd"],
  "review-record": [...TASK_TARGET_OPTIONS, "role", "result", "summary", "repo-root", "state-root", "expected-workspace-sha256", "cause", "cause-evidence", "cause-round", "cause-paths"],
  learn: ["action", "state-root", "scope", "project-id", "cwd", "kind", "topic", "content", "source-event", "supersedes", "forget", "id", "reason", "approved-by-user"],
  knowledge: ["action", "state-root", "scope", "project-id", "cwd", "query", "limit", "topic", "content", "approved-by-user"],
  "knowledge-verify": ["state-root", "scope", "project-id", "cwd", "id", "source-path", "approved-by-user"],
  "skill-draft": ["action", "state-root", "name", "status", "project-id", "cwd", "min-occurrences", "description", "content", "cluster-id", "source-entry", "note", "approved-by-user"],
  "memory-review": ["action", "state-root", "decision"],
  retro: ["action", "state-root", "status", "id", "task-path", "proposed-change"],
  "review-cause": ["action", "state-root", "cause", "status", "id", "task-path", "evidence", "round", "paths", "min-occurrences"],
  "project-resolver": ["path", "state-root"],
  preflight: [...TASK_TARGET_OPTIONS, "repo-root", "state-root"],
  "project-doc": ["action", "paths", "doc", "doc-root", "repo-root", "task-path"],
  "pre-review": ["path"],
  orchestrate: ["action", "id", "state-root"],
  "split-plan": ["plan-path"],
  "worktree-fingerprint": ["path", "base", "paths"],
  "contract-lint": ["root"],
  "policy-matrix": ["policy-path", "mode", "task-type"]
};
const commands = Object.keys(commandOptions);

function usage(): void {
  // orchestrate stays dispatchable (it refuses unflagged mutating use itself) but is listed only
  // under the flag, so nothing advertises a prototype phase tracker as a stable command.
  const listed = commands.filter((command) => command !== "orchestrate" || process.env.AGENT_WORKFLOW_ORCHESTRATION_EXPERIMENTAL === "1");
  process.stdout.write(`agent-workflow ${PRODUCT_VERSION}\n\nUsage: agent-workflow [command] [options]\n\nCommands:\n${listed.map((command) => `  ${command}`).join("\n")}\n`);
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
  // Everything after a bare `--` is the command evidence-run executes, not this CLI's own options.
  const separator = rest.indexOf("--");
  const trailing = separator === -1 ? [] : rest.slice(separator + 1);
  const parsed = parseArgs(separator === -1 ? rest : rest.slice(0, separator));
  const allowedOptions = new Set(commandOptions[command]);
  if (parsed.values.has("help") || rest.includes("-h")) {
    process.stdout.write(`Usage: agent-workflow ${command} [options]\n\nOptions:\n${[...allowedOptions].map((name) => `  --${name}`).join("\n")}\n`);
    return;
  }
  const unknown = [...parsed.values.keys()].filter((key) => !allowedOptions.has(key));
  if (unknown.length) {
    process.stderr.write(`Unknown option(s) for ${command}: ${unknown.map((key) => `--${key}`).join(", ")}\n`);
    process.exitCode = 2;
    return;
  }
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
  if (command === "install") process.exitCode = await (await import("./installer.js")).install(installOptions("Install"));
  else if (command === "repair") process.exitCode = await (await import("./installer.js")).install(installOptions("Repair"));
  else if (command === "verify") process.exitCode = await (await import("./installer.js")).install(installOptions("Verify"));
  else if (command === "uninstall") process.exitCode = await (await import("./installer.js")).install(installOptions("Uninstall"));
  else if (command === "migrate-state") { process.stdout.write(`${JSON.stringify((await import("./installer.js")).migrateState(option(parsed.values, "state-root", stateRoot()), flag(parsed.values, "dry-run")))}\n`); }
  else if (command === "git-guard") {
    let payload = {}; try { payload = stdinJson(); } catch { payload = {}; }
    const platform = option(parsed.values, "platform", "Codex");
    const event = option(parsed.values, "event", "PreToolUse");
    (await import("./hooks.js")).runGuard(platform, event, payload, option(parsed.values, "state-root", stateRoot()));
  }
  else if (command === "memory-context") {
    // Only Antigravity's PreInvocation hook carries a payload worth reading here; the other
    // platforms invoke this on SessionStart with nothing on stdin to wait for.
    const platform = option(parsed.values, "platform", "Codex");
    let invocationNum: number | undefined;
    if (platform.toLowerCase() === "antigravity") { try { const value = stdinJson().invocationNum; invocationNum = typeof value === "number" ? value : undefined; } catch { invocationNum = undefined; } }
    if (platform.toLowerCase() === "antigravity" && invocationNum !== 0) { process.stdout.write(`${JSON.stringify({ injectSteps: [] })}\n`); return; }
    (await import("./knowledge.js")).memoryContext(platform, option(parsed.values, "state-root", stateRoot()), option(parsed.values, "query"), option(parsed.values, "cwd", process.cwd()), invocationNum, flag(parsed.values, "auto"));
  }
  else if (command === "knowledge") process.exitCode = (await import("./knowledge.js")).knowledge(option(parsed.values, "action", "Search"), parsed.values);
  else if (command === "knowledge-verify") process.exitCode = (await import("./knowledge.js")).knowledgeVerify(parsed.values);
  else if (command === "orchestrate") process.exitCode = (await import("./experimental/orchestration.js")).orchestrate(parsed.values);
  else if (command === "workflow-plan") process.exitCode = (await import("./misc.js")).workflowPlan(option(parsed.values, "task-path"), option(parsed.values, "policy-path") || undefined);
  else if (command === "execution-packet") process.exitCode = (await import("./execution/index.js")).executionPacketCommand(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), option(parsed.values, "repo-root", process.cwd()));
  else if (command === "skill") process.exitCode = (await import("./skills.js")).skillCommand(option(parsed.values, "action", "List"), option(parsed.values, "name"), option(parsed.values, "from"), option(parsed.values, "source"), option(parsed.values, "source-type"), option(parsed.values, "skill-path"), option(parsed.values, "root"));
  else if (command === "project-resolver") process.exitCode = (await import("./misc.js")).projectResolver(option(parsed.values, "path", parsed.positionals[0] || process.cwd()), option(parsed.values, "state-root", stateRoot()));
  else if (command === "worktree-fingerprint") process.exitCode = (await import("./misc.js")).fingerprint(option(parsed.values, "path", parsed.positionals[0] || process.cwd()), option(parsed.values, "base"), optionList(parsed.values, "paths"));
  else if (command === "policy-matrix") process.exitCode = (await import("./policy-matrix.js")).policyMatrixCommand(option(parsed.values, "policy-path") || undefined, option(parsed.values, "mode", "digests"), option(parsed.values, "task-type"));
  else if (command === "contract-lint") process.exitCode = (await import("./contract-lint.js")).contractLint(option(parsed.values, "root", parsed.positionals[0] || process.cwd()), commandOptions);
  else if (command === "pre-review") process.exitCode = (await import("./misc.js")).preReview(option(parsed.values, "path", parsed.positionals[0] || process.cwd()));
  else if (command === "preflight") process.exitCode = (await import("./misc.js")).preflight(option(parsed.values, "task-path", option(parsed.values, "task", "")), option(parsed.values, "repo-root", process.cwd()), option(parsed.values, "state-root") || undefined);
  else if (command === "retro") process.exitCode = (await import("./records.js")).retro(parsed.values);
  else if (command === "review-cause") process.exitCode = (await import("./records.js")).reviewCause(parsed.values);
  else if (command === "split-plan") process.exitCode = (await import("./records.js")).splitPlan(parsed.values);
  else if (command === "learn") process.exitCode = (await import("./learning.js")).learn(parsed.values);
  else if (command === "skill-draft") process.exitCode = (await import("./learning.js")).skillDraft(parsed.values);
  else if (command === "project-doc") process.exitCode = (await import("./project-doc.js")).projectDoc(parsed.values);
  else if (command === "task-init") process.exitCode = (await import("./lifecycle/index.js")).taskInit(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), stdinJson(), option(parsed.values, "actor", "cli"), option(parsed.values, "state-root") || undefined, option(parsed.values, "repo-root", process.cwd()), flag(parsed.values, "adopt-current-diff"));
  else if (command === "task-write") process.exitCode = (await import("./lifecycle/index.js")).taskWrite(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), stdinJson(), option(parsed.values, "state-root") || undefined, option(parsed.values, "repo-root", process.cwd()), flag(parsed.values, "adopt-current-diff"));
  else if (command === "next") process.exitCode = (await import("./lifecycle/index.js")).taskNext(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), option(parsed.values, "repo-root", process.cwd()));
  else if (command === "task-gate") process.exitCode = (await import("./lifecycle/index.js")).taskGate(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), option(parsed.values, "repo-root", process.cwd()));
  else if (command === "task-report") process.exitCode = (await import("./task-report.js")).taskReport(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), option(parsed.values, "repo-root", process.cwd()));
  else if (command === "close-task") process.exitCode = (await import("./lifecycle/index.js")).closeTask(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), option(parsed.values, "actor", "cli"), option(parsed.values, "confirmed-by-user"), option(parsed.values, "state-root"), option(parsed.values, "repo-root", process.cwd()));
  else if (command === "approve-intent") process.exitCode = (await import("./lifecycle/index.js")).approveIntent(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), option(parsed.values, "confirmed-by"), flag(parsed.values, "as-user"));
  else if (command === "evidence-record") {
    const execCommand = option(parsed.values, "command");
    const execution = execCommand ? { command: execCommand, cwd: option(parsed.values, "cwd", process.cwd()), exitCode: Number(option(parsed.values, "exit-code")), outputDigest: option(parsed.values, "output-digest") } : undefined;
    process.exitCode = (await import("./lifecycle/index.js")).evidenceRecord(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), optionList(parsed.values, "requirement-id"), option(parsed.values, "summary"), option(parsed.values, "actor", "agent"), execution);
  }
  else if (command === "evidence-run") process.exitCode = (await import("./lifecycle/index.js")).evidenceRun(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), optionList(parsed.values, "requirement-id"), option(parsed.values, "summary"), option(parsed.values, "actor", "agent"), trailing, option(parsed.values, "cwd", process.cwd()));
  else if (command === "reclassify") process.exitCode = (await import("./lifecycle/index.js")).reclassify(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), stdinJson(), option(parsed.values, "confirmed-by-user"), option(parsed.values, "reason"), option(parsed.values, "actor", "cli"), option(parsed.values, "state-root") || undefined, option(parsed.values, "repo-root", process.cwd()));
  else if (command === "review-record") {
    const cause = option(parsed.values, "cause"); const causeEvidence = option(parsed.values, "cause-evidence"); const causeRound = option(parsed.values, "cause-round"); const causePaths = optionList(parsed.values, "cause-paths");
    const causeInput = cause || causeEvidence || causeRound || causePaths.length ? { round: Number(causeRound), cause, evidence: causeEvidence, paths: causePaths } : undefined;
    process.exitCode = (await import("./lifecycle/index.js")).reviewRecord(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), option(parsed.values, "role"), option(parsed.values, "result"), option(parsed.values, "summary"), option(parsed.values, "repo-root", process.cwd()), causeInput, option(parsed.values, "state-root") || undefined, option(parsed.values, "expected-workspace-sha256"));
  }
  else if (command === "memory-review") process.exitCode = (await import("./memory-review.js")).memoryReview(parsed.values);
  else if (["pause", "block", "resume", "supersede", "waive"].includes(command)) {
    const state = (await import("./lifecycle/index.js")).transitionTask(option(parsed.values, "task", parsed.positionals[0] || "."), command as "pause" | "block" | "resume" | "supersede" | "waive", option(parsed.values, "actor", "cli"), option(parsed.values, "confirmed-by-user"), option(parsed.values, "requirement-id"));
    process.stdout.write(`${JSON.stringify(state)}\n`);
  }
  else {
    process.stderr.write(`Node runtime command is not implemented yet: ${command}\n`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message || error}\n`);
  process.exitCode = 1;
});
