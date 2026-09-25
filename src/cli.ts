import { PRODUCT_VERSION, JsonObject, flag, option, optionList, parseArgs, stateRoot, stdinJson } from "./core.js";
import { homedir } from "node:os";
import { join } from "node:path";

// The option each command accepts, declared here rather than discovered by reading every module's
// inline reads. This is the registry contract-lint validates documented invocations against, so a
// documented flag that no command reads is a finding instead of a silently ignored argument.
// Shorthand for --integration <name>; any other entry of adapters/upstream-manifest.json is reached through --integration.
const INTEGRATION_FLAGS = ["ponytail", "design-and-refine", "hallmark"];
const INSTALL_OPTIONS = ["target-agent", "agent", "state-root", "skills", "integration", "ponytail", "design-and-refine", "hallmark", "non-interactive", "dry-run", "claude-target", "codex-target", "antigravity-target"];
const TASK_TARGET_OPTIONS = ["task-path", "task"];
export const commandOptions: Record<string, string[]> = {
  install: INSTALL_OPTIONS, repair: INSTALL_OPTIONS, verify: INSTALL_OPTIONS, uninstall: INSTALL_OPTIONS,
  "migrate-state": ["state-root", "dry-run"],
  "git-guard": ["platform", "event", "state-root"],
  "locale-context": ["platform", "state-root"],
  "memory-context": ["platform", "state-root", "query", "cwd", "auto", "event"],
  "execution-packet": [...TASK_TARGET_OPTIONS, "repo-root"],
  skill: ["action", "name", "from", "source", "source-type", "skill-path", "root"],
  "task-init": [...TASK_TARGET_OPTIONS, "actor", "state-root", "repo-root", "adopt-current-diff", "paths"],
  "task-write": [...TASK_TARGET_OPTIONS, "state-root", "repo-root", "adopt-current-diff"],
  reclassify: [...TASK_TARGET_OPTIONS, "confirmed-by-user", "reason", "actor", "state-root", "repo-root"],
  "task-gate": [...TASK_TARGET_OPTIONS, "repo-root"],
  "task-report": [...TASK_TARGET_OPTIONS, "repo-root"],
  "close-task": [...TASK_TARGET_OPTIONS, "actor", "confirmed-by-user", "state-root", "repo-root"],
  pause: ["task", "actor"], block: ["task", "actor"], resume: ["task", "actor"], supersede: ["task", "actor"],
  waive: ["task", "actor", "confirmed-by-user", "requirement-id"],
  "approve-intent": [...TASK_TARGET_OPTIONS, "confirmed-by", "as-user"],
  "evidence-run": [...TASK_TARGET_OPTIONS, "requirement-id", "summary", "actor", "cwd"],
  "review-record": [...TASK_TARGET_OPTIONS, "role", "result", "summary", "repo-root", "state-root", "expected-workspace-sha256", "cause", "cause-evidence", "cause-round", "cause-paths", "cause-miss-category", "cause-introduced-by", "cause-proposed-change"],
  learn: ["action", "state-root", "scope", "project-id", "cwd", "kind", "topic", "content", "source-event", "supersedes", "forget", "id", "reason", "approved-by-user", "tags", "paths"],
  knowledge: ["action", "state-root", "scope", "project-id", "cwd", "query", "limit", "topic", "content", "approved-by-user"],
  "knowledge-verify": ["state-root", "scope", "project-id", "cwd", "id", "source-path", "approved-by-user"],
  "skill-draft": ["action", "state-root", "name", "status", "project-id", "cwd", "min-occurrences", "description", "content", "cluster-id", "source-entry", "note", "approved-by-user"],
  "memory-review": ["action", "state-root", "decision"],
  "review-cause": ["action", "state-root", "cause", "status", "id", "task-path", "evidence", "round", "paths", "min-occurrences", "miss-category", "introduced-by", "proposed-change"],
  "project-resolver": ["path", "state-root"],
  "project-doc": ["action", "paths", "doc", "doc-root", "repo-root", "task-path"],
  "pre-review": ["path", ...TASK_TARGET_OPTIONS],
  orchestrate: ["action", "id", "protocol", "state-root", "plan-path", "repo-root", "parent-task-path", "worker-id", "run-id", "platform", "workspace", "result-path", "reason"],
  "worker-check": ["assignment-path", "cwd"],
  "worker-exec": ["assignment-path", "cwd", "acceptance"],
  "worktree-fingerprint": ["path", "base", "paths"],
  "contract-lint": ["root"],
  "policy-matrix": ["policy-path", "mode", "task-type"]
};
const commands = Object.keys(commandOptions);

async function commandHelp(command: string, options: Set<string>): Promise<string> {
  const lines = [`Usage: agent-workflow ${command} [options]`, "", "Options:", ...[...options].map((name) => `  --${name}`)];
  if (command === "task-init" || command === "task-write") {
    const { classificationHelp } = await import("./lifecycle/task-schema.js");
    lines.push(
      "",
      "Input: pipe one JSON object on stdin.",
      command === "task-init"
        ? 'Example: {"code_change":true,"managed_change":true,"task_type":"fix","impact_scope":"file","impact_effect":"local_behavior","impact_confidence":"high"}'
        : 'Example: {"impact_confidence":"high"}',
      "",
      "Classification values (from schemas/task.schema.json):",
      classificationHelp()
    );
  }
  return `${lines.join("\n")}\n`;
}

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
  // Everything after a bare `--` is the command evidence-run executes, not this CLI's own options.
  const separator = rest.indexOf("--");
  const trailing = separator === -1 ? [] : rest.slice(separator + 1);
  const parsed = parseArgs(separator === -1 ? rest : rest.slice(0, separator));
  const allowedOptions = new Set(commandOptions[command]);
  if (parsed.values.has("help") || rest.includes("-h")) {
    process.stdout.write(await commandHelp(command, allowedOptions));
    return;
  }
  const unknown = [...parsed.values.keys()].filter((key) => !allowedOptions.has(key));
  if (unknown.length) {
    process.stderr.write(`Unknown option(s) for ${command}: ${unknown.map((key) => `--${key}`).join(", ")}; allowed: ${[...allowedOptions].map((key) => `--${key}`).join(", ") || "(none)"}\n`);
    process.exitCode = 2;
    return;
  }
  const installOptions = (action: "Install" | "Repair" | "Verify" | "Uninstall") => ({
    action,
    target: option(parsed.values, "target-agent", option(parsed.values, "agent", "All")),
    root: option(parsed.values, "state-root", stateRoot()),
    skills: option(parsed.values, "skills") || undefined,
    integrations: [...new Set([...INTEGRATION_FLAGS.filter((name) => flag(parsed.values, name)), ...option(parsed.values, "integration", "").split(",").map((name) => name.trim()).filter(Boolean)])],
    nonInteractive: flag(parsed.values, "non-interactive"),
    dryRun: flag(parsed.values, "dry-run"),
    claude: option(parsed.values, "claude-target", join(homedir(), ".claude")),
    codex: option(parsed.values, "codex-target", join(homedir(), ".codex")),
    antigravity: option(parsed.values, "antigravity-target", join(homedir(), ".gemini"))
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
    (await import("./hooks.js")).runGuard(platform, event, payload);
  }
  else if (command === "locale-context") {
    let payload = {}; try { payload = stdinJson(); } catch { payload = {}; }
    (await import("./locale-hooks.js")).runLocaleContext(payload, option(parsed.values, "state-root", stateRoot()), option(parsed.values, "platform", "Claude"));
  }
  else if (command === "memory-context") {
    const platform = option(parsed.values, "platform", "Codex");
    const requestedEvent = option(parsed.values, "event");
    const event: "SessionStart" | "UserPromptSubmit" | undefined = requestedEvent === "SessionStart" || requestedEvent === "UserPromptSubmit" ? requestedEvent : undefined;
    if (requestedEvent && !event) throw new Error("memory-context: --event must be SessionStart or UserPromptSubmit");
    let payload: JsonObject = {};
    if (event || platform.toLowerCase() === "antigravity") { try { payload = stdinJson(); } catch { payload = {}; } }
    let invocationNum: number | undefined;
    if (platform.toLowerCase() === "antigravity") invocationNum = typeof payload.invocationNum === "number" ? payload.invocationNum : undefined;
    if (platform.toLowerCase() === "antigravity" && invocationNum !== 0) { process.stdout.write(`${JSON.stringify({ injectSteps: [] })}\n`); return; }
    (await import("./knowledge.js")).memoryContext(platform, option(parsed.values, "state-root", stateRoot()), option(parsed.values, "query"), option(parsed.values, "cwd", typeof payload.cwd === "string" ? payload.cwd : process.cwd()), invocationNum, flag(parsed.values, "auto"), event ? { event, prompt: typeof payload.prompt === "string" ? payload.prompt : undefined, sessionId: typeof payload.session_id === "string" ? payload.session_id : undefined } : undefined);
  }
  else if (command === "knowledge") process.exitCode = (await import("./knowledge.js")).knowledge(option(parsed.values, "action", "Search"), parsed.values);
  else if (command === "knowledge-verify") process.exitCode = (await import("./knowledge.js")).knowledgeVerify(parsed.values);
  else if (command === "orchestrate") process.exitCode = (await import("./orchestration/protocol.js")).orchestrate(parsed.values);
  else if (command === "worker-check") process.exitCode = (await import("./orchestration/protocol.js")).workerCheck(parsed.values);
  else if (command === "worker-exec") process.exitCode = (await import("./orchestration/protocol.js")).workerExec(parsed.values, trailing);
  else if (command === "execution-packet") process.exitCode = (await import("./execution/index.js")).executionPacketCommand(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), option(parsed.values, "repo-root", process.cwd()));
  else if (command === "skill") process.exitCode = (await import("./skills.js")).skillCommand(option(parsed.values, "action", "List"), option(parsed.values, "name"), option(parsed.values, "from"), option(parsed.values, "source"), option(parsed.values, "source-type"), option(parsed.values, "skill-path"), option(parsed.values, "root"));
  else if (command === "project-resolver") process.exitCode = (await import("./misc.js")).projectResolver(option(parsed.values, "path", parsed.positionals[0] || process.cwd()), option(parsed.values, "state-root", stateRoot()));
  else if (command === "worktree-fingerprint") process.exitCode = (await import("./misc.js")).fingerprint(option(parsed.values, "path", parsed.positionals[0] || process.cwd()), option(parsed.values, "base"), optionList(parsed.values, "paths"));
  else if (command === "policy-matrix") process.exitCode = (await import("./policy-matrix.js")).policyMatrixCommand(option(parsed.values, "policy-path") || undefined, option(parsed.values, "mode", "digests"), option(parsed.values, "task-type"));
  else if (command === "contract-lint") process.exitCode = (await import("./contract-lint.js")).contractLint(option(parsed.values, "root", parsed.positionals[0] || process.cwd()), commandOptions);
  else if (command === "pre-review") process.exitCode = (await import("./misc.js")).preReview(option(parsed.values, "path", parsed.positionals[0] || process.cwd()), option(parsed.values, "task-path", option(parsed.values, "task")));
  else if (command === "review-cause") process.exitCode = (await import("./records.js")).reviewCause(parsed.values);
  else if (command === "learn") process.exitCode = (await import("./learning.js")).learn(parsed.values);
  else if (command === "skill-draft") process.exitCode = (await import("./learning.js")).skillDraft(parsed.values);
  else if (command === "project-doc") process.exitCode = (await import("./project-doc.js")).projectDoc(parsed.values);
  else if (command === "task-init") process.exitCode = (await import("./lifecycle/index.js")).taskInit(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), stdinJson(), option(parsed.values, "actor", "cli"), option(parsed.values, "state-root") || undefined, option(parsed.values, "repo-root", process.cwd()), flag(parsed.values, "adopt-current-diff"), true, {}, optionList(parsed.values, "paths"));
  else if (command === "task-write") process.exitCode = (await import("./lifecycle/index.js")).taskWrite(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), stdinJson(), option(parsed.values, "state-root") || undefined, option(parsed.values, "repo-root", process.cwd()), flag(parsed.values, "adopt-current-diff"));
  else if (command === "task-gate") process.exitCode = (await import("./lifecycle/index.js")).taskGate(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), option(parsed.values, "repo-root", process.cwd()));
  else if (command === "task-report") process.exitCode = (await import("./task-report.js")).taskReport(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), option(parsed.values, "repo-root", process.cwd()));
  else if (command === "close-task") process.exitCode = (await import("./lifecycle/index.js")).closeTask(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), option(parsed.values, "actor", "cli"), option(parsed.values, "confirmed-by-user"), option(parsed.values, "state-root"), option(parsed.values, "repo-root", process.cwd()));
  else if (command === "approve-intent") process.exitCode = (await import("./lifecycle/index.js")).approveIntent(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), option(parsed.values, "confirmed-by"), flag(parsed.values, "as-user"));
  else if (command === "evidence-run") process.exitCode = (await import("./lifecycle/index.js")).evidenceRun(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), optionList(parsed.values, "requirement-id"), option(parsed.values, "summary"), option(parsed.values, "actor", "agent"), trailing, option(parsed.values, "cwd", process.cwd()));
  else if (command === "reclassify") process.exitCode = (await import("./lifecycle/index.js")).reclassify(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), stdinJson(), option(parsed.values, "confirmed-by-user"), option(parsed.values, "reason"), option(parsed.values, "actor", "cli"), option(parsed.values, "state-root") || undefined, option(parsed.values, "repo-root", process.cwd()));
  else if (command === "review-record") {
    const cause = option(parsed.values, "cause"); const causeEvidence = option(parsed.values, "cause-evidence"); const causeRound = option(parsed.values, "cause-round"); const causePaths = optionList(parsed.values, "cause-paths");
    const causeMissCategory = option(parsed.values, "cause-miss-category"); const causeIntroducedBy = option(parsed.values, "cause-introduced-by"); const causeProposedChange = option(parsed.values, "cause-proposed-change");
    const causeInput = cause || causeEvidence || causeRound || causePaths.length
      ? { round: Number(causeRound), cause, evidence: causeEvidence, paths: causePaths, missCategory: causeMissCategory || undefined, introducedBy: causeIntroducedBy || undefined, proposedChange: causeProposedChange || undefined }
      : undefined;
    process.exitCode = (await import("./lifecycle/index.js")).reviewRecord(option(parsed.values, "task-path", option(parsed.values, "task", parsed.positionals[0] || ".")), option(parsed.values, "role"), option(parsed.values, "result"), option(parsed.values, "summary"), option(parsed.values, "repo-root", process.cwd()), causeInput, option(parsed.values, "state-root") || undefined, option(parsed.values, "expected-workspace-sha256"));
  }
  else if (command === "memory-review") process.exitCode = (await import("./memory-review.js")).memoryReview(parsed.values);
  else if (["pause", "block", "resume", "supersede", "waive"].includes(command)) {
    const lifecycleModule = await import("./lifecycle/index.js");
    const target = option(parsed.values, "task", parsed.positionals[0] || ".");
    const state = lifecycleModule.transitionTask(target, command as "pause" | "block" | "resume" | "supersede" | "waive", option(parsed.values, "actor", "cli"), option(parsed.values, "confirmed-by-user"), option(parsed.values, "requirement-id"));
    const lifecycle = state.lifecycle as JsonObject | undefined;
    process.stdout.write(`${JSON.stringify({ valid: true, task: state.id, status: lifecycle?.status, state_revision: state.state_revision, ...(["in_progress", "paused", "blocked"].includes(String(lifecycle?.status || "")) ? { next: lifecycleModule.nextForState(state, lifecycleModule.taskPath(target), process.cwd()) } : {}) })}\n`);
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
