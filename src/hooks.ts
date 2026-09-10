import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { isWithin, Json, JsonObject, output, readJson, sha256, stateRoot } from "./core.js";

export type CanonicalHookEvent = { platform: string; event: string; tool: string; cwd?: string; command?: string; paths: string[] };
export type HookDecision = { allow: boolean; reason?: string; context?: string };

const pathKeys = ["file_path", "FilePath", "notebook_path", "NotebookPath", "path", "Path", "AbsolutePath", "target_file", "TargetFile", "source_path", "destination_path"];

function object(value: Json | undefined): JsonObject { return value && !Array.isArray(value) && typeof value === "object" ? value as JsonObject : {}; }
function text(value: Json | undefined): string { return typeof value === "string" ? value : ""; }
function containers(payload: JsonObject): JsonObject[] { return [object(payload.toolCall)].map((item) => object(item.args)).concat([object(payload.tool_input), object(payload.input)]).filter((item) => Object.keys(item).length > 0); }
function paths(payload: JsonObject): string[] {
  const result: string[] = [];
  for (const item of containers(payload)) {
    for (const key of pathKeys) if (text(item[key]).trim()) result.push(text(item[key]).trim());
    const edits = item.edits; if (Array.isArray(edits)) for (const edit of edits) for (const key of pathKeys) if (text(object(edit)[key]).trim()) result.push(text(object(edit)[key]).trim());
    for (const patch of [text(item.patch), text(item.input)]) for (const match of patch.matchAll(/^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/gm)) result.push(match[1].trim());
  }
  for (const patch of [text(payload.tool_input), text(payload.input)]) for (const match of patch.matchAll(/^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/gm)) result.push(match[1].trim());
  return [...new Set(result)];
}
// Each platform has its own required response shape, and an empty stdout does not mean the same
// thing on all of them: Claude/Codex read "no output" as "no opinion", while Antigravity's
// PreToolUse contract requires an explicit decision on every call.
function platformOutput(platform: string, event: string, decision: HookDecision): void {
  const reason = decision.reason || "agent-workflow guard denied the action";
  if (platform.toLowerCase() === "antigravity") {
    output(decision.allow ? { decision: "allow" } : { decision: "deny", reason });
    return;
  }
  if (decision.allow) { if (decision.context) output({ hookSpecificOutput: { hookEventName: event, additionalContext: decision.context } }); return; }
  output({ hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: reason } });
}
export function normalizeHookEvent(platform: string, payload: JsonObject, event = "PreToolUse"): CanonicalHookEvent {
  const call = object(payload.toolCall); const input = object(payload.tool_input); const tool = (text(payload.tool_name) || text(payload.toolName) || text(payload.tool) || text(call.name)).toLowerCase().replaceAll("-", "_");
  const command = text(object(call.args).CommandLine) || text(object(call.args).command) || text(input.command) || text(input.cmd) || text(object(payload.input).command) || text(object(payload.input).cmd);
  const found = paths(payload);
  // Antigravity carries the working directory on the tool call itself (run_command's Cwd) and only
  // falls back to the workspace root; reading payload.cwd alone resolved its relative paths against
  // the wrong directory.
  const cwd = text(object(call.args).Cwd) || text(payload.cwd) || (Array.isArray(payload.workspacePaths) ? text(payload.workspacePaths[0]) : "");
  return { platform, event, tool, cwd: cwd || undefined, command: command || undefined, paths: found };
}
export function hookDecision(event: CanonicalHookEvent, root = stateRoot()): HookDecision {
  if (!touchesProtected(event, TASK_STATE_PATTERN)) return { allow: true };
  const allowed = event.command ? taskCommandAllowed(event.command, root) : isReadOnlyTool(event.tool);
  return allowed ? { allow: true } : { allow: false, reason: "task-guard: task.json is runtime-owned; use the verified agent-workflow task CLI instead of editing it directly." };
}
const TASK_STATE_PATTERN = /\btask\.json\b/i;
// Quoted path fragments such as task".json" still name the protected file.
function spliced(command: string): string {
  return command.replace(/["']/g, "").replace(/\\([^\\])/g, "$1");
}
function touchesProtected(event: CanonicalHookEvent, pattern: RegExp): boolean {
  const command = event.command || "";
  return event.paths.some((path) => pattern.test(path)) || pattern.test(command) || pattern.test(spliced(command));
}
const READ_ONLY_COMMANDS = new Set([
  "cat", "type", "head", "tail", "more", "less", "nl", "ls", "dir", "tree", "wc", "grep", "rg", "findstr", "select-string",
  "get-content", "get-childitem", "test-path", "resolve-path", "cmp", "stat", "file", "jq",
  "cut", "tr", "echo", "printf", "basename", "dirname", "realpath", "pwd", "md5sum", "sha256sum"
]);
// Interpreters and commands with output-file modes require the sanctioned runtime path.
// certutil is a general certificate/encoding tool; only its file-hashing mode is a read.
const HASH_ALGORITHMS = new Set(["sha256", "sha1", "md5"]);
function isCertutilRead(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/);
  return tokens.length === 4 && tokens[1].toLowerCase() === "-hashfile" && HASH_ALGORITHMS.has(tokens[3].toLowerCase());
}

// Commands whose quoted arguments and heredoc bodies are text they print or match, never text they
// execute. Only these get their quoted runs and heredoc bodies dropped before parsing — an
// interpreter's quoted argument or heredoc body IS the program, so those must stay visible.
const DATA_ARGUMENT_COMMANDS = new Set([
  "echo", "printf", "cat", "type", "grep", "rg", "egrep", "fgrep", "findstr", "select-string",
  "ack", "ag", "jq", "yq", "awk", "sed", "comm", "diff", "write-host", "write-output", "tee"
]);
// PowerShell does not put the command first: an assignment binds it (`$t = git ls-files`) and a block
// opener precedes it (`foreach ($d in $dirs) { Get-ChildItem $d }`). The raw first token read those as
// the commands `$t` and `foreach`, which are on no allowlist, so read-only PowerShell was denied.
const POWERSHELL_PREFIX = /^(?:\$[A-Za-z_]\w*\s*=\s*|(?:foreach|foreach-object|if|elseif|else|while|for|switch|try|catch|finally|do|%)\b\s*(?:\([^()]*\))?\s*\{?\s*|\{\s*)/i;
function stripInvocationPrefix(segment: string): string {
  let text = segment.trim();
  for (let stripped = text.replace(POWERSHELL_PREFIX, ""); stripped !== text; stripped = text.replace(POWERSHELL_PREFIX, "")) text = stripped;
  return text;
}
function commandHead(segment: string): string {
  return (stripInvocationPrefix(segment).split(/\s+/)[0] || "").toLowerCase().replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|ps1)$/, "");
}

// Splits on shell separators that are actually separators. Splitting with a plain regex broke
// `echo "a; git push"` into two segments, the second of which begins with `git` — a command that
// never runs, reported as one that does.
function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "", quote = "", escaped = false;
  for (const character of command) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'") { current += character; escaped = true; continue; }
    if (quote) { current += character; if (character === quote) quote = ""; continue; }
    if (character === "'" || character === '"') { quote = character; current += character; continue; }
    if (character === "&" && /[<>]$/.test(current)) { current += character; continue; }
    if (character === ";" || character === "|" || character === "&" || character === "\n" || character === "\r") { segments.push(current); current = ""; continue; }
    current += character;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

const NULL_DEVICES = new Set(["/dev/null", "nul", "$null"]);
function redirectTargets(command: string): string[] {
  const targets: string[] = [];
  let quote = "", escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character !== ">") continue;
    let cursor = index + 1;
    while (command[cursor] === ">") cursor += 1;
    while (command[cursor] === " " || command[cursor] === "\t") cursor += 1;
    // `2>&1` and `>&2` rebind a descriptor onto another, so no file is opened.
    if (command[cursor] === "&" && /^(?:\d+|-)(?:\s|[;|&]|$)/.test(command.slice(cursor + 1))) continue;
    let target = "";
    let targetQuote = "";
    if (command[cursor] === "&") cursor += 1;
    for (; cursor < command.length; cursor += 1) {
      const part = command[cursor];
      if (targetQuote) { if (part === targetQuote) targetQuote = ""; else target += part; }
      else if (part === '"' || part === "'") targetQuote = part;
      else if (/[\s;|&<>]/.test(part)) break;
      else target += part;
    }
    // Discarding to the null device writes nothing the guard needs to protect.
    if (target && !NULL_DEVICES.has(target.toLowerCase())) targets.push(target);
  }
  return targets;
}

// Drops the body of a heredoc whose receiving command treats it as data, so a command quoted inside
// `cat <<EOF ... EOF` is documentation rather than an invocation. A body fed to `bash`, `python` or
// any other interpreter is left in place, because there it really does execute.
function stripHeredocBodies(command: string): { command: string; hiddenExpansion: boolean } {
  const kept: string[] = [];
  let terminator = "", quotedDelimiter = false, hiddenExpansion = false;
  for (const line of command.split(/\r?\n/)) {
    if (terminator) {
      if (line.trim() === terminator) terminator = "";
      else if (!quotedDelimiter && SUBSTITUTION.test(line)) hiddenExpansion = true;
      continue;
    }
    kept.push(line);
    const opener = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (opener && DATA_ARGUMENT_COMMANDS.has(commandHead(line))) { terminator = opener[2]; quotedDelimiter = !!opener[1]; }
  }
  return { command: kept.join("\n"), hiddenExpansion };
}

const SUBSTITUTION = /\$\(|`|<\(/;
function stripQuotedData(segment: string): string {
  if (!DATA_ARGUMENT_COMMANDS.has(commandHead(segment))) return segment;
  // A quoted run holding a substitution is not inert text — `echo "$(git push)"` runs the push and
  // prints its output — so those runs stay visible instead of being treated as an argument.
  const keepIfExecutable = (run: string) => SUBSTITUTION.test(run) ? run : run[0] + run[run.length - 1];
  // Single quotes suppress expansion in both sh and PowerShell, so a backtick or `$(` inside one is
  // literal — keeping those runs read `grep '^- \`'` as a substitution and denied a plain search.
  return segment.replace(/'[^']*'/g, (run) => run[0] + run[run.length - 1]).replace(/"[^"]*"/g, keepIfExecutable);
}

// Wrappers that run a command given to them: `-c`/`-Command` interpreters carry it inside quotes,
// prefix wrappers carry it as the rest of the line. Parsing only the segment head would read
// `bash -c "git push"` as an invocation of bash and never look at what bash was told to run.
const SCRIPT_INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "powershell", "pwsh", "cmd", "busybox"]);
const PREFIX_WRAPPERS = new Set(["sudo", "doas", "su", "env", "nohup", "timeout", "command", "exec", "time", "xargs", "stdbuf", "nice", "ionice"]);
// Only segments naming task.json pay for task read/write classification.
function taskCommandAllowed(command: string, root: string): boolean {
  const { command: stripped, hiddenExpansion } = stripHeredocBodies(command);
  if (hiddenExpansion) return false;
  if (/<<<?/.test(stripped) && !DATA_ARGUMENT_COMMANDS.has(commandHead(stripped))) return false;
  return splitShellSegments(stripped).every((raw) => {
    if (!TASK_STATE_PATTERN.test(raw) && !TASK_STATE_PATTERN.test(spliced(raw))) return true;
    if (redirectTargets(raw).some((target) => TASK_STATE_PATTERN.test(spliced(target)))) return false;
    const segment = stripQuotedData(raw);
    if (SUBSTITUTION.test(segment)) return false;
    const subcommand = verifiedRuntimeSubcommand(raw, root);
    if (subcommand && TASK_STATE_WRITER_COMMANDS.has(subcommand)) return true;
    const head = commandHead(segment);
    if (head === "git") {
      const git = parseGitInvocation(stripInvocationPrefix(raw));
      return !!git && TASK_GIT_READS.has(git.subcommand) && !git.args.some((arg) => GIT_DENIED_READ_OPTIONS.test(arg));
    }
    if (head === "certutil") return isCertutilRead(raw);
    if (head === "rg" && /--pre(?:=|\s)/.test(spliced(raw))) return false;
    return READ_ONLY_COMMANDS.has(head);
  });
}
// The mirror image of the shell allowlist: a tool event carries no command to inspect, so the tool
// name itself has to prove it only reads. Inverting a write-name blocklist let ordinary editor and
// filesystem tools (str_replace, create_file, move_file) pass as reads.
const READ_ONLY_TOOLS = new Set(["read", "read_file", "readfile", "view", "view_file", "cat", "open", "glob", "grep", "search", "search_files", "list", "list_dir", "list_directory", "ls", "notebookread", "notebook_read", "get_file_info", "directory_tree"]);
function isReadOnlyTool(tool: string): boolean {
  return READ_ONLY_TOOLS.has(tool) || READ_ONLY_TOOLS.has(tool.replace(/^mcp__.*?__/, ""));
}
// Sanctioned task writers must resolve to the recorded runtime hash, not merely share its name.
const PATH_EXTENSIONS = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat", ".ps1", ".mjs"] : [""];
function resolveOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean))
    for (const extension of PATH_EXTENSIONS) {
      const candidate = resolve(directory, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  return undefined;
}
function resolvableAgentWorkflowPath(candidate: string): string | undefined {
  if (!candidate.includes("/") && !candidate.includes("\\")) return resolveOnPath(candidate);
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return resolve(/^~[\\/]/.test(candidate) ? home + candidate.slice(1) : candidate);
}
// Returns the subcommand only after verifying the runtime binary against managed state.
function verifiedRuntimeSubcommand(segment: string, root = stateRoot()): string | undefined {
  // Substitutions execute before the runtime can validate its own arguments.
  if (SUBSTITUTION.test(segment)) return undefined;
  const tokens = (segment.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((token) => token.replace(/^["']|["']$/g, ""));
  const executableName = (token: string) => token.replace(/^.*[\\/]/, "").toLowerCase();
  if (/^node(?:\.exe)?$/.test(executableName(tokens[0] || ""))) tokens.shift();
  const candidate = tokens[0] || "";
  if (!/^agent-workflow(?:\.mjs)?$/.test(executableName(candidate))) return undefined;
  if (redirectTargets(segment).length) return undefined;
  const resolvedPath = resolvableAgentWorkflowPath(candidate);
  if (!resolvedPath) return undefined; // an unresolvable name has no identity to verify; deny fail-closed
  const managedPath = join(root, "managed-runtime.json");
  if (!existsSync(managedPath)) return undefined; // resolvable path with nothing to verify it against — deny fail-closed
  try {
    const runtimeHash = String((readJson(managedPath) as JsonObject).runtime_hash || "");
    if (!runtimeHash || !existsSync(resolvedPath) || sha256(readFileSync(resolvedPath)) !== runtimeHash) return undefined;
  } catch { return undefined; } // resolvedPath could not be verified against the recorded identity; deny fail-closed
  return tokens[1]?.toLowerCase();
}
// A command legitimately writes task.json only through these commands' own validated write path
// (schema check + file lock), never by the shell segment touching the file directly.
const TASK_STATE_WRITER_COMMANDS = new Set([
  "task-init", "task-write", "reclassify", "close-task", "pause", "block", "resume", "supersede",
  "waive", "approve-intent", "evidence-record", "review-record", "project-doc"
]);
// This allowlist applies only when inspecting the runtime-owned task file.
const TASK_GIT_READS = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "rev-list"]);
// Global options come before the subcommand, so they have to be consumed before it can be read;
// leaving them in place made `git --no-pager log` parse as the subcommand "--no-pager".
const GIT_GLOBAL_OPTIONS = /^(?:-C\s*(?:"[^"]+"|'[^']+'|\S+)|--no-pager|--no-optional-locks|--no-lazy-fetch|-P|--no-replace-objects|--literal-pathspecs|--bare)\s*/;
// These do not merely decorate the invocation, they redirect what git executes: -c can set an alias
// or a hook path, --exec-path relocates the helper binaries, --namespace re-points ref resolution.
const GIT_EXECUTION_ALTERING = /^(?:-c|--config-env\b|--exec-path\b|--namespace\b)/;
// A repository location git is allowed to reach, as long as it stays inside the caller's project.
const GIT_LOCATION_OPTIONS = /^(?:--git-dir|--work-tree)(?:=(\S+)|\s+(\S+))\s*/;
function parseGitInvocation(segment: string, boundary = process.cwd()): { subcommand: string; args: string[] } | null {
  // Anchored at the segment head so prose that merely quotes a git command is not parsed as one.
  const match = segment.match(/^(?:\S*[\\/])?git(?:\.exe)?\b\s*(.*)$/i); if (!match) return null;
  let rest = match[1].trim();
  for (;;) {
    if (GIT_EXECUTION_ALTERING.test(rest)) return null;
    const location = rest.match(GIT_LOCATION_OPTIONS);
    if (location) {
      const target = (location[1] ?? location[2]).replace(/^["']|["']$/g, "");
      if (!isWithin(resolve(boundary, target), boundary)) return null;
      rest = rest.slice(location[0].length).trim();
      continue;
    }
    if (!GIT_GLOBAL_OPTIONS.test(rest)) break;
    rest = rest.replace(GIT_GLOBAL_OPTIONS, "").trim();
  }
  // A slice taken from inside a wrapper's quoted argument keeps its closing quote, so strip the
  // quote characters rather than reading `status"` as an unknown subcommand.
  const tokens = rest.split(/\s+/).map((token) => token.replace(/^["']|["']$/g, "")).filter(Boolean);
  if (tokens[0]?.startsWith("-") && !["--version", "--help", "-v", "-h"].includes(tokens[0])) return null;
  return { subcommand: (tokens[0] || "").toLowerCase(), args: tokens.slice(1) };
}
// Wrappers that hand a command to something else to run: their payload can sit anywhere in the
// segment, not at its head. Head-anchoring alone read `ssh host git push` as an invocation of ssh.
const COMMAND_CARRYING = new Set([...SCRIPT_INTERPRETERS, ...PREFIX_WRAPPERS, "ssh", "docker", "podman", "kubectl", "lxc", "vagrant"]);
// git diff/show/log accept diff-machinery options that mutate the filesystem or shell out to a
// helper (`--output=<file>` writes there directly; `--ext-diff`/`--textconv` run a configured
// external command); these remain explicit safety boundaries.
const GIT_DENIED_READ_OPTIONS = /^--(?:output(?:=.*)?|ext-diff|textconv)$/;
// `\bgit\b` also matches a longer hyphenated word, so this framework's own `git-guard` command name
// tripped its own git guard. Only a bare `git`, or a path ending in it, invokes git; the dashed
// `git-<subcommand>` form was retired from git's own PATH long ago and is not treated as one.
const GIT_TOKEN = /(?:^|[\s"'`|;&(={])(?:[^\s"'`;|&]*[\\/])?git(?:\.exe)?(?=$|[\s"'`;|&)}])/i;
function destructiveGit(subcommand: string, args: string[]): boolean {
  if (subcommand === "reset") return args.some((arg) => /^--hard(?:=|$)/.test(arg));
  if (subcommand === "clean") return !args.some((arg) => arg === "--dry-run" || /^-[^-]*n/.test(arg));
  if (subcommand === "restore") return true;
  if (subcommand === "branch") return args.some((arg) => arg === "--delete" || /^-[^-]*[dD]/.test(arg));
  if (subcommand === "checkout") return args.includes("--") || args.some((arg) => /^(?:-f|--force|--overwrite-ignore)$/.test(arg));
  if (subcommand === "switch") return args.some((arg) => /^(?:-f|--force|--discard-changes)$/.test(arg));
  if (subcommand === "push") return args.some((arg) => /^--(?:force|force-with-lease|force-if-includes|mirror|delete)(?:=|$)/.test(arg) || /^-[^-]*[fd]/.test(arg) || arg.startsWith("+") || arg.startsWith(":"));
  return false;
}
// Ordinary top-level Git commands defer to native permission; hidden execution stays denied.
export function gitDecision(event: CanonicalHookEvent): HookDecision {
  const rawCommand = event.command || "";
  if (!GIT_TOKEN.test(rawCommand)) return { allow: true };
  const { command, hiddenExpansion } = stripHeredocBodies(rawCommand);
  if (hiddenExpansion) return { allow: false, reason: "git-guard: expansion in an unquoted heredoc is denied." };
  if (command.split(/\r?\n/).some((line) => /<<<?/.test(line) && !DATA_ARGUMENT_COMMANDS.has(commandHead(line))) && GIT_TOKEN.test(command)) return { allow: false, reason: "git-guard: git in an executable heredoc is denied." };
  for (const raw of splitShellSegments(command)) {
    if (!GIT_TOKEN.test(raw)) continue;
    const head = commandHead(raw);
    const segment = stripQuotedData(raw);
    // Substitution is judged after stripping, so a backtick a printer only quotes single-quoted is
    // data; a double-quoted or interpreter-held one survives stripping and is still caught here.
    if (COMMAND_CARRYING.has(head) || SUBSTITUTION.test(segment)) return { allow: false, reason: "git-guard: git reached through a wrapper, interpreter, remote/container carrier, or command substitution is denied outright; ask the user to run it explicitly." };
    if (!GIT_TOKEN.test(segment)) continue; // "git" only appeared inside a data command's quoted argument, e.g. grep "git status"
    const parsed = parseGitInvocation(stripInvocationPrefix(segment), event.cwd ? resolve(event.cwd) : process.cwd());
    if (!parsed) return { allow: false, reason: `git-guard: 'git ${segment}' alters git's execution (-c/--exec-path/--namespace) or its --git-dir/--work-tree points outside the project; ask the user to run it explicitly.` };
    if (destructiveGit(parsed.subcommand, parsed.args)) return { allow: false, reason: `git-guard: destructive git ${parsed.subcommand} is denied; ask the user to run it explicitly.` };
    if (["diff", "log", "show"].includes(parsed.subcommand) && parsed.args.some((arg) => GIT_DENIED_READ_OPTIONS.test(arg))) return { allow: false, reason: "git-guard: diff machinery output or external execution is denied." };
  }
  return { allow: true };
}
export function runGuard(platform: string, eventName: string, payload: JsonObject, root = stateRoot()): void {
  const event = normalizeHookEvent(platform, payload, eventName);
  const baseline = hookDecision(event, root);
  platformOutput(platform, eventName, baseline.allow ? gitDecision(event) : baseline);
}
