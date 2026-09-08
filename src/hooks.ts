import { existsSync, readFileSync, rmSync } from "node:fs";
import { delimiter, join, resolve, sep } from "node:path";
import { isWithin, Json, JsonObject, normal, now, output, readJson, sha256, stateRoot, writeJson } from "./core.js";

const SKILL_PROOF_TTL_MS = 12 * 60 * 60 * 1000;

export type CanonicalHookEvent = { platform: string; event: string; tool: string; cwd?: string; command?: string; paths: string[]; mutation: boolean; targetKnown: boolean; sessionId?: string };
export type HookDecision = { allow: boolean; reason?: string; context?: string };

const pathKeys = ["file_path", "FilePath", "notebook_path", "NotebookPath", "path", "Path", "AbsolutePath", "target_file", "TargetFile", "source_path", "destination_path"];
const writeTools = new Set(["apply_patch", "delete_file", "edit", "edit_file", "multi_edit", "notebookedit", "rename_file", "replace_file_content", "write", "write_file", "write_to_file"]);

function object(value: Json | undefined): JsonObject { return value && !Array.isArray(value) && typeof value === "object" ? value as JsonObject : {}; }
function text(value: Json | undefined): string { return typeof value === "string" ? value : ""; }
function containers(payload: JsonObject): JsonObject[] { return [object(payload.toolCall)].map((item) => object(item.args)).concat([object(payload.tool_input), object(payload.input)]).filter((item) => Object.keys(item).length > 0); }
function paths(payload: JsonObject): string[] {
  const result: string[] = [];
  for (const item of containers(payload)) {
    for (const key of pathKeys) if (text(item[key]).trim()) result.push(text(item[key]).trim());
    const edits = item.edits; if (Array.isArray(edits)) for (const edit of edits) for (const key of pathKeys) if (text(object(edit)[key]).trim()) result.push(text(object(edit)[key]).trim());
    for (const patch of [text(item.patch), text(item.input)]) for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) result.push(match[1].trim());
  }
  return [...new Set(result)];
}
// Each platform has its own required response shape, and an empty stdout does not mean the same
// thing on all of them: Claude/Codex read "no output" as "no opinion", while Antigravity's
// PreToolUse contract requires an explicit decision on every call. Its PostToolUse carries no
// decision contract at all — the hook can only report that it ran — so it answers with `{}`.
function platformOutput(platform: string, event: string, decision: HookDecision): void {
  const reason = decision.reason || "agent-workflow guard denied the action";
  if (platform.toLowerCase() === "antigravity") {
    if (event === "PostToolUse") { output({}); return; }
    output(decision.allow ? { decision: "allow" } : { decision: "deny", reason });
    return;
  }
  if (decision.allow) { if (decision.context) output({ hookSpecificOutput: { hookEventName: event, additionalContext: decision.context } }); return; }
  output({ hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: reason } });
}
const MUTATING_COMMANDS = /\b(?:set-content|add-content|out-file|new-item|remove-item|copy-item|move-item|tee|sed\s+-i|perl\s+-pi|cp|mv|rm|del|erase)\b/i;
// Judged per segment on text that can actually run: a printer's quoted argument and a printer's
// heredoc body are output, so `echo "rm -rf x"` and a documented command inside `cat <<EOF` are not
// mutations. An interpreter's quoted script is left intact, so `bash -c "rm -rf x"` still is one.
// The paths a mutating command acts on, so `rm -rf build/` can be checked against the protected
// paths rather than refused for carrying no nameable target.
const BARE_FLAG = /^-[\w-]*$/;
// The path an option carries, so `--target-directory=x` and `-Path:x` are judged on `x` rather than
// waved through as flags.
function flagValue(argument: string): string {
  if (!argument.startsWith("-")) return argument;
  const separated = argument.match(/^-[^=:]*[=:](.*)$/);
  return separated ? separated[1] : argument.replace(/^-+/, "");
}
// The paths a mutating command names, and whether any argument defied classification.
function mutatingCommandTargets(segment: string): { targets: string[]; unresolved: boolean } {
  const mutating = MUTATING_COMMANDS.exec(segment);
  if (!mutating) return { targets: [], unresolved: false };
  const tokens = stripInvocationPrefix(segment).split(/\s+/).filter(Boolean);
  // Located by the command itself, since counting from the head read `sudo rm -rf` as a file `rm`.
  const at = tokens.findIndex((token) => token.toLowerCase() === mutating[0].split(/\s+/)[0].toLowerCase());
  if (at === -1) return { targets: [], unresolved: true };
  const targets: string[] = [];
  for (const argument of tokens.slice(at + 1)) {
    // Only a flag made purely of flag characters carries no path; `-Path:.agent[s]/x` carries one.
    if (BARE_FLAG.test(argument)) continue;
    // The only other argument that names no file: one that is itself a redirect, already read above.
    if (/^[<>|&]/.test(argument)) continue;
    const lead = flagValue(argument).split(/[<>|&]/)[0].replace(/^["']|["']$/g, "");
    // Refused rather than skipped, since an argument dropped without being rejected is one the gate then counts as accounted for.
    if (!RESOLVABLE_TARGET.test(lead)) return { targets: [], unresolved: true };
    targets.push(lead);
  }
  return { targets, unresolved: false };
}
function mutationSegments(command: string): string[] {
  return splitShellSegments(stripHeredocBodies(command)).flatMap((part) => unwrapCommands(part));
}
// Returns the redirect or command that made it one, so a denial can name what tripped it.
function shellMutationCause(command: string): string | undefined {
  if (!command) return undefined;
  for (const segment of mutationSegments(command)) {
    // Read off the raw segment: redirectTargets already skips a `>` inside quotes, while stripping
    // first would blank a quoted target and turn `echo x > "$dir/f"` into a non-write.
    const [target] = redirectTargets(segment);
    if (target) return `redirect to '${target}'`;
    const mutating = MUTATING_COMMANDS.exec(stripQuotedData(segment));
    if (mutating) return `command '${mutating[0]}'`;
  }
  return undefined;
}
function isShellMutation(command: string): boolean {
  return !!shellMutationCause(command);
}
// `unresolved` is reported separately because one nameable target does not make the rest safe:
// `cp evil.md .agent[s]/x` resolves its source and would otherwise look fully accounted for while
// its real destination is still a glob.
function mutationTargets(command: string): { resolved: string[]; unresolved: boolean } {
  const resolved: string[] = [];
  let unresolved = false;
  for (const segment of mutationSegments(command)) {
    for (const target of redirectTargets(segment)) {
      if (RESOLVABLE_TARGET.test(target)) resolved.push(target); else unresolved = true;
    }
    const named = mutatingCommandTargets(stripQuotedData(segment));
    resolved.push(...named.targets);
    unresolved = unresolved || named.unresolved;
  }
  return { resolved, unresolved };
}
export function normalizeHookEvent(platform: string, payload: JsonObject, event = "PreToolUse"): CanonicalHookEvent {
  const call = object(payload.toolCall); const input = object(payload.tool_input); const tool = (text(payload.tool_name) || text(payload.toolName) || text(payload.tool) || text(call.name)).toLowerCase().replaceAll("-", "_");
  const command = text(object(call.args).CommandLine) || text(object(call.args).command) || text(input.command) || text(object(payload.input).command);
  // A shell payload has no path field, but a redirect and a mutating command both name their target.
  const shellTargets = mutationTargets(command);
  const found = [...new Set([...paths(payload), ...shellTargets.resolved])];
  const shellMutation = isShellMutation(command);
  const fileMutation = writeTools.has(tool) || /(write|edit|delete|rename)/.test(tool) || shellMutation;
  // MCP 連接器的 target 是遠端資源而非檔案路徑，永遠正規化不出 path；名稱含 write 的連接器
  // 若套用本 guard 會被永久 fail-closed，故僅在它確實帶了路徑參數時才納入檔案 mutation 判斷
  const mutation = fileMutation && (!tool.startsWith("mcp__") || found.length > 0);
  // Antigravity carries the working directory on the tool call itself (run_command's Cwd) and only
  // falls back to the workspace root; reading payload.cwd alone resolved its relative paths against
  // the wrong directory.
  const cwd = text(object(call.args).Cwd) || text(payload.cwd) || (Array.isArray(payload.workspacePaths) ? text(payload.workspacePaths[0]) : "");
  return { platform, event, tool, cwd: cwd || undefined, command: command || undefined, paths: found, mutation, targetKnown: !mutation || (found.length > 0 && !shellTargets.unresolved), sessionId: text(payload.session_id) || text(payload.sessionId) || text(payload.conversationId) || undefined };
}
export function hookDecision(event: CanonicalHookEvent, root = stateRoot()): HookDecision {
  if (event.mutation && !event.targetKnown) {
    const cause = shellMutationCause(event.command || "");
    return { allow: false, reason: `hook-policy: ${cause ? `${cause} resolves to no nameable file` : "mutation target cannot be normalized"}; denied fail-closed.` };
  }
  if (event.mutation && event.paths.some((path) => !path.trim())) return { allow: false, reason: "hook-policy: mutation target is invalid; denied fail-closed." };
  if (touchesProtected(event, TASK_STATE_PATTERN) && !isReadOnly(event, TASK_STATE_WRITER_COMMANDS, root)) return { allow: false, reason: "task-guard: task.json is runtime-owned; use `agent-workflow task-init` / `task-write` / pause / block / supersede / waive / close-task instead of editing it directly." };
  return { allow: true };
}
const AGENTS_PATTERN = /\.agents\b/i;
const TASK_STATE_PATTERN = /\btask\.json\b/i;
// A resource is protected the moment it is mentioned, whether or not the mutation heuristics fire.
// Deciding protection from "did this look like a write?" is what let an inline interpreter script
// through: it carries neither a path argument nor a shell redirect, so it normalized to
// mutation=false and skipped the guard entirely.
// `.agent"s"` and `.agent\s` open the same file the shell does, so the name is also matched against
// the command with its quoting and escapes removed.
function spliced(command: string): string {
  return command.replace(/["']/g, "").replace(/\\([^\\])/g, "$1");
}
function touchesProtected(event: CanonicalHookEvent, pattern: RegExp): boolean {
  const cwd = event.cwd ? resolve(event.cwd) : "";
  const command = event.command || "";
  return event.paths.some((path) => pattern.test(resolve(cwd || ".", path))) || pattern.test(command) || pattern.test(spliced(command));
}
const READ_ONLY_COMMANDS = new Set([
  "cat", "type", "head", "tail", "more", "less", "nl", "ls", "dir", "tree", "wc", "grep", "rg", "findstr", "select-string",
  "get-content", "get-childitem", "test-path", "resolve-path", "diff", "cmp", "stat", "file", "jq", "yq",
  "sort", "uniq", "cut", "tr", "echo", "printf", "basename", "dirname", "realpath", "pwd", "md5sum", "sha256sum"
]);
// A few read tools have a write mode behind a flag; naming the flag is cheaper than dropping the tool.
// awk and sed are not here and not on the allowlist at all: both are general interpreters whose write
// paths (`print > file`, `w`, `s///w`) no flag check can enumerate.
const WRITE_FLAGS: Record<string, RegExp> = { perl: /(^|\s)-\S*i/, find: /\s-(delete|exec|execdir|ok|fprint)\b/, fd: /\s(-x|--exec)\b/ };
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
    if (character === ";" || character === "|" || character === "&" || character === "\n" || character === "\r") { segments.push(current); current = ""; continue; }
    current += character;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

const NULL_DEVICES = new Set(["/dev/null", "nul", "$null"]);
// An allowlist, not a blocklist of metacharacters: a target only counts as resolved when it is a
// plain literal path. Enumerating what to reject is what let `rm -rf .agent[s]` through — the glob
// expands to `.agents`, but `[` was not on the reject list, so the guard read it as a literal file
// nobody protects. Anything a shell could expand or splice now fails closed instead.
const RESOLVABLE_TARGET = /^[\w./\\:@+-]+$/;
// Files an unquoted redirection would create or truncate. Callers use it both to tell a write apart
// from a discard and to name the target, so a redirect no longer has to be refused for lack of one.
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
    if (command[cursor] === "&") continue;
    let target = "";
    if (command[cursor] === '"' || command[cursor] === "'") {
      const closing = command[cursor];
      for (cursor += 1; cursor < command.length && command[cursor] !== closing; cursor += 1) target += command[cursor];
    } else {
      for (; cursor < command.length && !/[\s;|&<>]/.test(command[cursor]); cursor += 1) target += command[cursor];
    }
    // Discarding to the null device writes nothing the guard needs to protect.
    if (target && !NULL_DEVICES.has(target.toLowerCase())) targets.push(target);
  }
  return targets;
}

// Drops the body of a heredoc whose receiving command treats it as data, so a command quoted inside
// `cat <<EOF ... EOF` is documentation rather than an invocation. A body fed to `bash`, `python` or
// any other interpreter is left in place, because there it really does execute.
function stripHeredocBodies(command: string): string {
  const kept: string[] = [];
  let terminator = "";
  for (const line of command.split(/\r?\n/)) {
    if (terminator) { if (line.trim() === terminator) terminator = ""; continue; }
    kept.push(line);
    const opener = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
    if (opener && DATA_ARGUMENT_COMMANDS.has(commandHead(line))) terminator = opener[2];
  }
  return kept.join("\n");
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
// `$( … )` and backticks run their contents whatever the surrounding command is, so their bodies
// are commands in their own right — `echo "$(git push)"` pushes and then prints the output.
function substitutionBodies(segment: string): string[] {
  const bodies: string[] = [];
  for (let index = 0; index < segment.length; index += 1) {
    if (segment.startsWith("$(", index) || segment.startsWith("<(", index)) {
      let depth = 1, cursor = index + 2;
      for (; cursor < segment.length && depth > 0; cursor += 1) {
        if (segment[cursor] === "(") depth += 1;
        else if (segment[cursor] === ")") depth -= 1;
      }
      bodies.push(segment.slice(index + 2, cursor - 1));
      index = cursor - 1;
      continue;
    }
    if (segment[index] === "`") {
      const end = segment.indexOf("`", index + 1);
      if (end === -1) break;
      bodies.push(segment.slice(index + 1, end));
      index = end;
    }
  }
  return bodies.filter((body) => body.trim());
}
function unwrapCommands(segment: string, depth = 0): string[] {
  if (depth > 3) return [segment];
  const head = commandHead(segment);
  const results = [segment];
  for (const body of substitutionBodies(segment)) for (const inner of splitShellSegments(body)) results.push(...unwrapCommands(inner, depth + 1));
  if (SCRIPT_INTERPRETERS.has(head)) {
    for (const match of segment.matchAll(/'([^']*)'|"([^"]*)"/g)) {
      const script = match[1] ?? match[2] ?? "";
      if (script.trim()) for (const inner of splitShellSegments(script)) results.push(...unwrapCommands(inner, depth + 1));
    }
  }
  if (PREFIX_WRAPPERS.has(head)) {
    // Drop the wrapper and any options it consumed, then look at whatever it was about to run.
    const rest = segment.trim().split(/\s+/).slice(1);
    while (rest.length && rest[0].startsWith("-")) rest.shift();
    if (rest.length) results.push(...unwrapCommands(rest.join(" "), depth + 1));
  }
  return results;
}
// Allowlist, never blocklist: an interpreter invoked with an inline script can write through an API
// the guard cannot see, so any command head not named here counts as a write.
function isReadOnlyShellCommand(command: string): boolean {
  if (redirectTargets(command).length > 0) return false;
  const segments = splitShellSegments(stripHeredocBodies(command));
  if (!segments.length) return false;
  return segments.every((raw) => {
    const segment = stripQuotedData(raw);
    // Tested after quote stripping, not on the raw command: a backtick inside a data command's own
    // pattern (`grep '^- \`'`) is text it matches, while an interpreter keeps its quotes and so
    // still shows its substitution here.
    if (SUBSTITUTION.test(segment)) return false;
    const head = commandHead(segment);
    if (head === "git") { const parsed = parseGitInvocation(segment); return !!parsed && gitSubcommandAllowed(parsed.subcommand, parsed.args); }
    if (head === "certutil") return isCertutilRead(segment);
    if (head in WRITE_FLAGS) return !WRITE_FLAGS[head].test(segment);
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
// The runtime CLI is the sanctioned writer for both protected resources — `task-write` for task.json
// and `install`/`repair` for .agents — so guarding against it would deny the very path the guard's
// own deny message tells the caller to use.
//
// This hook only ever sees the command as text, never a live process it could introspect. The name
// alone proves nothing, so every invocation — bare or path-qualified — must resolve to a file whose
// content matches the runtime hash recorded in managed-runtime.json; a bare name is resolved through
// PATH first. Anything that cannot be resolved and verified is denied fail-closed.
const AGENT_WORKFLOW_TOKEN = /(?:^|[\s"'\\/])agent-workflow(?:\.mjs)?(?:["']?\s|$)/i;
const PATH_EXTENSIONS = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat", ".ps1", ".mjs"] : [""];
function resolveOnPath(name: string): string | undefined {
  for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean))
    for (const extension of PATH_EXTENSIONS) {
      const candidate = resolve(directory, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  return undefined;
}
function resolvableAgentWorkflowPath(segment: string): string | undefined {
  const match = segment.match(/(\S*agent-workflow(?:\.mjs)?)(?=["']?(?:\s|$))/i);
  if (!match) return undefined;
  const candidate = match[1].replace(/^["']|["']$/g, "");
  if (!candidate.includes("/") && !candidate.includes("\\")) return resolveOnPath(candidate);
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return resolve(/^~[\\/]/.test(candidate) ? home + candidate.slice(1) : candidate);
}
// Verifies the segment resolves to the identity-checked runtime binary and, if so, returns the
// subcommand it invokes (e.g. "task-write", "evidence-run"); undefined if identity cannot be
// verified. Runtime identity alone does not authorize an operation — only the caller matching the
// returned subcommand against a resource-specific allowlist does (see isRuntimeInvocationFor).
function verifiedRuntimeSubcommand(segment: string, root = stateRoot()): string | undefined {
  // A substitution can smuggle an arbitrary, fully-privileged command past this check: the shell
  // runs `$(...)`/backticks before the outer `agent-workflow ...` invocation even starts, so the
  // segment can read as a clean, allowlisted subcommand while unrelated code already executed. Same
  // rule isReadOnlyShellCommand and gitDecision already apply to their own indirection cases.
  if (SUBSTITUTION.test(segment)) return undefined;
  if (!AGENT_WORKFLOW_TOKEN.test(segment)) return undefined;
  const resolvedPath = resolvableAgentWorkflowPath(segment);
  if (!resolvedPath) return undefined; // an unresolvable name has no identity to verify; deny fail-closed
  const managedPath = join(root, "managed-runtime.json");
  if (!existsSync(managedPath)) return undefined; // resolvable path with nothing to verify it against — deny fail-closed
  try {
    const runtimeHash = String((readJson(managedPath) as JsonObject).runtime_hash || "");
    if (!runtimeHash || !existsSync(resolvedPath) || sha256(readFileSync(resolvedPath)) !== runtimeHash) return undefined;
  } catch { return undefined; } // resolvedPath could not be verified against the recorded identity; deny fail-closed
  const subcommandMatch = segment.match(/agent-workflow(?:\.mjs)?["']?\s+(\S+)/i);
  return subcommandMatch ? subcommandMatch[1].toLowerCase() : undefined;
}
// A command legitimately writes task.json only through these commands' own validated write path
// (schema check + file lock), never by the shell segment touching the file directly.
const TASK_STATE_WRITER_COMMANDS = new Set([
  "task-init", "task-write", "reclassify", "close-task", "pause", "block", "resume", "supersede",
  "waive", "approve-intent", "evidence-record", "review-record"
]);
// install/repair/skill are the sanctioned writers for .agents content; every other runtime command
// gets no .agents mutation exemption.
const AGENTS_WRITER_COMMANDS = new Set(["install", "repair", "skill"]);
// Runtime subcommands that only read. `workflow/SKILL.md` §5 makes `project-doc --action Lookup` a
// mandatory step before every source change, but naming a `.agents` path in its arguments tripped this
// guard, leaving the framework's own required step unrunnable for changes to this repo.
const AGENTS_READER_COMMANDS = new Set(["project-doc", "workflow-plan", "task-gate", "execution-packet", "next"]);
// `evidence-run` executes a caller-supplied command (`spawnSync` on the trailing args) as its whole
// purpose, so its own identity verification proves nothing about what that trailing command touches
// — it must never be granted a blanket read-only exemption for either protected resource.
function isRuntimeInvocationFor(command: string, allowed: Set<string>, root = stateRoot()): boolean {
  return splitShellSegments(command).every((segment) => {
    const subcommand = verifiedRuntimeSubcommand(segment, root);
    return !!subcommand && allowed.has(subcommand);
  });
}
function isGenericReadOnly(event: CanonicalHookEvent): boolean {
  return event.command ? isReadOnlyShellCommand(event.command) : isReadOnlyTool(event.tool);
}
function isReadOnly(event: CanonicalHookEvent, runtimeAllowed: Set<string>, root: string): boolean {
  return isGenericReadOnly(event) || (!!event.command && isRuntimeInvocationFor(event.command, runtimeAllowed, root));
}
// Global options come before the subcommand, so they have to be consumed before it can be read;
// leaving them in place made `git --no-pager log` parse as the subcommand "--no-pager".
const GIT_GLOBAL_OPTIONS = /^(?:-C\s+\S+|--no-pager|-P|--no-replace-objects|--literal-pathspecs|--bare)\s*/;
// These do not merely decorate the invocation, they redirect what git executes: -c can set an alias
// or a hook path, --exec-path relocates the helper binaries, --namespace re-points ref resolution.
const GIT_EXECUTION_ALTERING = /^(?:-c(?:\s|=|$)|--exec-path\b|--namespace\b)/;
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
  return { subcommand: (tokens[0] || "").toLowerCase(), args: tokens.slice(1) };
}
// Wrappers that hand a command to something else to run: their payload can sit anywhere in the
// segment, not at its head. Head-anchoring alone read `ssh host git push` as an invocation of ssh.
const COMMAND_CARRYING = new Set([...SCRIPT_INTERPRETERS, ...PREFIX_WRAPPERS, "ssh", "docker", "podman", "kubectl", "lxc", "vagrant"]);
// git diff/show/log accept diff-machinery options that mutate the filesystem or shell out to a
// helper (`--output=<file>` writes there directly; `--ext-diff`/`--textconv` run a configured
// external command) even though the subcommand itself is on the read-only allowlist.
const GIT_DENIED_READ_OPTIONS = /^--(?:output(?:=.*)?|ext-diff|textconv)$/;
// `\bgit\b` also matches a longer hyphenated word, so this framework's own `git-guard` command name
// tripped its own git guard. Only a bare `git`, or a path ending in it, invokes git; the dashed
// `git-<subcommand>` form was retired from git's own PATH long ago and is not treated as one.
const GIT_TOKEN = /(?:^|[\s"'`|;&(={])(?:[^\s"'`;|&]*[\\/])?git(?:\.exe)?(?=$|[\s"'`;|&)}])/i;
function gitSubcommandAllowed(subcommand: string, args: string[]): boolean {
  if (["diff", "log", "show"].includes(subcommand) && args.some((arg) => GIT_DENIED_READ_OPTIONS.test(arg))) return false;
  if (["status", "diff", "log", "show", "rev-parse", "ls-files", "rev-list"].includes(subcommand)) return true;
  if (subcommand === "branch") return args.length === 0 || (args.length === 1 && args[0] === "--show-current");
  if (subcommand === "remote") return args.length > 0 && ["-v", "get-url", "show"].includes(args[0]);
  if (subcommand === "config") return args.length > 0 && ["--get", "--get-all", "--list"].includes(args[0]);
  return false;
}
// git gets a stricter, simpler rule than the general read-only allowlist: any indirection at all —
// a wrapper/interpreter/remote/container carrier, or a command substitution — touching a segment
// that mentions git is denied outright, without trying to resolve what git call is actually inside
// it. Only a bare, unwrapped, top-level `git <subcommand>` is evaluated. This trades "correctly
// classify every clever wrapping" for "never try": a case this cannot parse with certainty is
// refused, not reasoned about, so the parser does not have to keep chasing new disguises through
// recursive unwrapping.
//
// A directly parsed invocation whose subcommand is a mutation (add/commit/push/merge/rebase/...) is
// allowed through — deferred to the platform's own ask-for-approval flow, which shows the user the
// exact command before it runs — but only when it is the command's sole segment. A mutation found
// alongside any other segment (a compound, a decoy, a heredoc body handed to an interpreter that
// splitShellSegments turns into its own line) stays hard-denied: the guard cannot tell such a
// segment apart from one that only *looks* like a standalone invocation, so it is refused rather
// than reasoned about, same as an unparseable one. A diff-machinery escape (--output/--ext-diff/
// --textconv on an otherwise read-only diff/log/show) stays hard-denied unconditionally — it is not
// a git operation a user would recognize and approve, it is a read subcommand smuggling a write or
// a shell-out through an option.
export function gitDecision(event: CanonicalHookEvent): HookDecision {
  const command = stripHeredocBodies(event.command || "");
  if (!GIT_TOKEN.test(command)) return { allow: true };
  const soleSegment = splitShellSegments(command).length === 1;
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
    if (!gitSubcommandAllowed(parsed.subcommand, parsed.args)) {
      const diffMachineryEscape = ["diff", "log", "show"].includes(parsed.subcommand) && parsed.args.some((arg) => GIT_DENIED_READ_OPTIONS.test(arg));
      if (diffMachineryEscape) return { allow: false, reason: `git-guard: 'git ${parsed.subcommand}' with a diff-machinery escape (--output/--ext-diff/--textconv) is denied outright; ask the user to run it explicitly.` };
      if (!soleSegment) return { allow: false, reason: `git-guard: 'git ${parsed.subcommand}' alongside other shell segments is denied outright; ask the user to run it explicitly.` };
    }
  }
  return { allow: true };
}
function skillProofPath(root: string, platform: string, sessionId: string): string { return `${root}${sep}skill-guard${sep}${sha256(`${platform}:${sessionId}`)}.json`; }
function agentsRootOf(resolvedPath: string): string | undefined {
  // Same platform rule as normal(): only Windows treats ".Agents" and ".agents" as one directory
  const idx = (process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath).lastIndexOf(`${sep}.agents${sep}`);
  return idx === -1 ? undefined : resolvedPath.slice(0, idx + `${sep}.agents`.length);
}
export function skillDecision(event: CanonicalHookEvent, root = stateRoot()): HookDecision {
  if (!touchesProtected(event, AGENTS_PATTERN) || isReadOnly(event, AGENTS_WRITER_COMMANDS, root)) return { allow: true };
  // Gated on the event not being a mutation, so a reader that later grows a write mode, or one whose
  // segment also redirects, cannot inherit this exemption on the strength of its name.
  if (!event.mutation && !!event.command && isRuntimeInvocationFor(event.command, AGENTS_READER_COMMANDS, root)) return { allow: true };
  const cwd = event.cwd ? resolve(event.cwd) : ""; const targets = event.paths.map((path) => resolve(cwd || ".", path));
  if (!event.sessionId) return { allow: false, reason: "skill-guard: session proof is unavailable for a .agents mutation." };
  const proof = skillProofPath(root, event.platform, event.sessionId);
  if (!existsSync(proof)) return { allow: false, reason: "skill-guard: this touches .agents through a command that is not on the read-only allowlist, so it counts as a write. To read, use cat/head/grep/rg; to write, load .agents/skills/writing-for-agents/SKILL.md first." };
  const record = readJson(proof);
  if (typeof record.expires_at !== "number" || Date.now() >= record.expires_at) return { allow: false, reason: "skill-guard: proof has expired; re-read .agents/skills/writing-for-agents/SKILL.md." };
  if (typeof record.skill_path !== "string" || !existsSync(record.skill_path) || sha256(readFileSync(record.skill_path)) !== record.skill_sha256) return { allow: false, reason: "skill-guard: writing-for-agents/SKILL.md has changed since it was read; re-read it before modifying .agents content." };
  const targetRoots = targets.map(agentsRootOf).filter((path): path is string => !!path);
  if (typeof record.agents_root === "string" && targetRoots.some((path) => normal(path) !== normal(record.agents_root as string))) return { allow: false, reason: "skill-guard: proof was read for a different .agents root; re-read writing-for-agents/SKILL.md for this repo." };
  return { allow: true };
}
export function runGuard(kind: "git" | "skill", platform: string, eventName: string, payload: JsonObject, root = stateRoot()): void {
  const event = normalizeHookEvent(platform, payload, eventName); const baseline = hookDecision(event, root); const decision = !baseline.allow ? baseline : kind === "git" ? gitDecision(event) : skillDecision(event, root);
  platformOutput(platform, eventName, decision);
}
export function recordSkillRead(platform: string, payload: JsonObject, root = stateRoot()): void {
  const event = normalizeHookEvent(platform, payload, "PostToolUse");
  const skillPath = event.paths.find((path) => /\.agents[\\/]skills[\\/]writing-for-agents[\\/]SKILL\.md$/i.test(path));
  if (!event.sessionId || !skillPath) return;
  const resolvedSkillPath = resolve(skillPath); const agentsRoot = agentsRootOf(resolvedSkillPath) || "";
  writeJson(skillProofPath(root, platform, event.sessionId), { schema_version: 2, platform, session_id: event.sessionId, agents_root: agentsRoot, skill_path: resolvedSkillPath, skill_sha256: sha256(readFileSync(resolvedSkillPath)), read_at: now(), expires_at: Date.now() + SKILL_PROOF_TTL_MS });
}
export function clearSkillProof(platform: string, payload: JsonObject, root = stateRoot()): void {
  const event = normalizeHookEvent(platform, payload, "SessionEnd");
  if (!event.sessionId) return;
  rmSync(skillProofPath(root, platform, event.sessionId), { force: true });
}
