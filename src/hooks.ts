import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { Json, JsonObject, normal, now, output, readJson, sha256, stateRoot, writeJson } from "./core.js";

const SKILL_PROOF_TTL_MS = 12 * 60 * 60 * 1000;

export type CanonicalHookEvent = { platform: string; event: string; tool: string; cwd?: string; command?: string; paths: string[]; mutation: boolean; targetKnown: boolean; sessionId?: string };
export type HookDecision = { allow: boolean; reason?: string; context?: string };

const pathKeys = ["file_path", "FilePath", "notebook_path", "NotebookPath", "path", "Path", "target_file", "TargetFile", "source_path", "destination_path"];
const writeTools = new Set(["apply_patch", "delete_file", "edit", "edit_file", "multi_edit", "notebookedit", "rename_file", "write", "write_file"]);

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
function platformOutput(platform: string, event: string, decision: HookDecision): void {
  if (decision.allow) { if (decision.context) output(platform.toLowerCase() === "antigravity" ? { systemMessage: decision.context } : { hookSpecificOutput: { hookEventName: event, additionalContext: decision.context } }); return; }
  if (platform.toLowerCase() === "antigravity") output({ decision: "deny", reason: decision.reason || "agent-workflow guard denied the action" });
  else output({ hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: decision.reason || "agent-workflow guard denied the action" } });
}
const MUTATING_COMMANDS = /\b(?:set-content|add-content|out-file|new-item|remove-item|copy-item|move-item|tee|sed\s+-i|perl\s+-pi|cp|mv|rm|del|erase)\b/i;
// Judged per segment on text that can actually run: a printer's quoted argument and a printer's
// heredoc body are output, so `echo "rm -rf x"` and a documented command inside `cat <<EOF` are not
// mutations. An interpreter's quoted script is left intact, so `bash -c "rm -rf x"` still is one.
function isShellMutation(command: string): boolean {
  if (!command) return false;
  return splitShellSegments(stripHeredocBodies(command))
    .flatMap((segment) => unwrapCommands(segment))
    .map((segment) => stripQuotedData(segment))
    .some((segment) => hasUnquotedRedirect(segment) || MUTATING_COMMANDS.test(segment));
}
export function normalizeHookEvent(platform: string, payload: JsonObject, event = "PreToolUse"): CanonicalHookEvent {
  const call = object(payload.toolCall); const input = object(payload.tool_input); const tool = (text(payload.tool_name) || text(payload.toolName) || text(payload.tool) || text(call.name)).toLowerCase().replaceAll("-", "_");
  const command = text(object(call.args).CommandLine) || text(object(call.args).command) || text(input.command) || text(object(payload.input).command);
  const found = paths(payload); const shellMutation = isShellMutation(command);
  const fileMutation = writeTools.has(tool) || /(write|edit|delete|rename)/.test(tool) || shellMutation;
  // MCP 連接器的 target 是遠端資源而非檔案路徑，永遠正規化不出 path；名稱含 write 的連接器
  // 若套用本 guard 會被永久 fail-closed，故僅在它確實帶了路徑參數時才納入檔案 mutation 判斷
  const mutation = fileMutation && (!tool.startsWith("mcp__") || found.length > 0);
  const cwd = text(payload.cwd) || (Array.isArray(payload.workspacePaths) ? text(payload.workspacePaths[0]) : "");
  return { platform, event, tool, cwd: cwd || undefined, command: command || undefined, paths: found, mutation, targetKnown: !mutation || found.length > 0, sessionId: text(payload.session_id) || text(payload.sessionId) || undefined };
}
export function hookDecision(event: CanonicalHookEvent): HookDecision {
  if (event.mutation && !event.targetKnown) return { allow: false, reason: "hook-policy: mutation target cannot be normalized; denied fail-closed." };
  if (event.mutation && event.paths.some((path) => !path.trim())) return { allow: false, reason: "hook-policy: mutation target is invalid; denied fail-closed." };
  if (touchesProtected(event, TASK_STATE_PATTERN) && !isReadOnly(event)) return { allow: false, reason: "task-guard: task.json is runtime-owned; use `agent-workflow task-init` / `task-write` / pause / block / supersede / waive / close-task instead of editing it directly." };
  return { allow: true };
}
const AGENTS_PATTERN = /\.agents\b/i;
const TASK_STATE_PATTERN = /\btask\.json\b/i;
// A resource is protected the moment it is mentioned, whether or not the mutation heuristics fire.
// Deciding protection from "did this look like a write?" is what let an inline interpreter script
// through: it carries neither a path argument nor a shell redirect, so it normalized to
// mutation=false and skipped the guard entirely.
function touchesProtected(event: CanonicalHookEvent, pattern: RegExp): boolean {
  const cwd = event.cwd ? resolve(event.cwd) : "";
  return event.paths.some((path) => pattern.test(resolve(cwd || ".", path))) || pattern.test(event.command || "");
}
const READ_ONLY_COMMANDS = new Set([
  "cat", "type", "head", "tail", "more", "less", "nl", "ls", "dir", "tree", "wc", "grep", "rg", "findstr", "select-string",
  "get-content", "get-childitem", "test-path", "resolve-path", "diff", "cmp", "stat", "file", "awk", "jq", "yq",
  "sort", "uniq", "cut", "tr", "echo", "printf", "basename", "dirname", "realpath", "pwd", "md5sum", "sha256sum", "certutil"
]);
// A few read tools have a write mode behind a flag; naming the flag is cheaper than dropping the tool.
const WRITE_FLAGS: Record<string, RegExp> = { sed: /(^|\s)-\S*i/, perl: /(^|\s)-\S*i/, find: /\s-(delete|exec|execdir|ok|fprint)\b/, fd: /\s(-x|--exec)\b/ };

// Commands whose quoted arguments and heredoc bodies are text they print or match, never text they
// execute. Only these get their quoted runs and heredoc bodies dropped before parsing — an
// interpreter's quoted argument or heredoc body IS the program, so those must stay visible.
const DATA_ARGUMENT_COMMANDS = new Set([
  "echo", "printf", "cat", "type", "grep", "rg", "egrep", "fgrep", "findstr", "select-string",
  "ack", "ag", "jq", "yq", "awk", "sed", "comm", "diff", "write-host", "write-output", "tee"
]);
function commandHead(segment: string): string {
  return (segment.trim().split(/\s+/)[0] || "").toLowerCase().replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|ps1)$/, "");
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

function hasUnquotedRedirect(command: string): boolean {
  let quote = "", escaped = false;
  for (const character of command) {
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = ""; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === ">") return true;
  }
  return false;
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
  return segment.replace(/'[^']*'/g, keepIfExecutable).replace(/"[^"]*"/g, keepIfExecutable);
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
  if (hasUnquotedRedirect(command)) return false;
  if (/\$\(|`|<\(/.test(command)) return false; // substitution hides the real invocation
  const segments = splitShellSegments(stripHeredocBodies(command));
  if (!segments.length) return false;
  return segments.every((raw) => {
    const segment = stripQuotedData(raw);
    const head = commandHead(segment);
    if (head === "git") { const parsed = parseGitInvocation(segment); return !!parsed && gitSubcommandAllowed(parsed.subcommand, parsed.args); }
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
function isRuntimeInvocation(command: string): boolean {
  return splitShellSegments(command).every((segment) => /(?:^|[\s"'\\/])agent-workflow(?:\.mjs)?(?:["']?\s|$)/i.test(segment));
}
function isReadOnly(event: CanonicalHookEvent): boolean {
  return event.command ? isReadOnlyShellCommand(event.command) || isRuntimeInvocation(event.command) : isReadOnlyTool(event.tool);
}
// Global options come before the subcommand, so they have to be consumed before it can be read;
// leaving them in place made `git --no-pager log` parse as the subcommand "--no-pager".
const GIT_GLOBAL_OPTIONS = /^(?:-C\s+\S+|-c\s+\S+|--git-dir(?:=\S+|\s+\S+)|--work-tree(?:=\S+|\s+\S+)|--exec-path(?:=\S+)?|--namespace(?:=\S+|\s+\S+)|--no-pager|-P|--no-replace-objects|--literal-pathspecs|--bare)\s*/;
function parseGitInvocation(segment: string): { subcommand: string; args: string[] } | null {
  // Anchored at the segment head so prose that merely quotes a git command is not parsed as one.
  const match = segment.match(/^(?:\S*[\\/])?git(?:\.exe)?\b\s*(.*)$/i); if (!match) return null;
  let rest = match[1].trim();
  while (GIT_GLOBAL_OPTIONS.test(rest)) rest = rest.replace(GIT_GLOBAL_OPTIONS, "").trim();
  // A slice taken from inside a wrapper's quoted argument keeps its closing quote, so strip the
  // quote characters rather than reading `status"` as an unknown subcommand.
  const tokens = rest.split(/\s+/).map((token) => token.replace(/^["']|["']$/g, "")).filter(Boolean);
  return { subcommand: (tokens[0] || "").toLowerCase(), args: tokens.slice(1) };
}
// Wrappers that hand a command to something else to run: their payload can sit anywhere in the
// segment, not at its head. Head-anchoring alone read `ssh host git push` as an invocation of ssh.
const COMMAND_CARRYING = new Set([...SCRIPT_INTERPRETERS, ...PREFIX_WRAPPERS, "ssh", "docker", "podman", "kubectl", "lxc", "vagrant"]);
function gitInvocations(segment: string): { subcommand: string; args: string[] }[] {
  const found: { subcommand: string; args: string[] }[] = [];
  const atHead = parseGitInvocation(segment);
  if (atHead) found.push(atHead);
  if (COMMAND_CARRYING.has(commandHead(segment))) {
    for (const match of segment.matchAll(/\bgit\b/gi)) {
      const parsed = parseGitInvocation(segment.slice(match.index));
      if (parsed) found.push(parsed);
    }
  }
  return found;
}
function gitSubcommandAllowed(subcommand: string, args: string[]): boolean {
  if (["status", "diff", "log", "show", "rev-parse", "ls-files", "rev-list"].includes(subcommand)) return true;
  if (subcommand === "branch") return args.length === 0 || (args.length === 1 && args[0] === "--show-current");
  if (subcommand === "remote") return args.length > 0 && ["-v", "get-url", "show"].includes(args[0]);
  if (subcommand === "config") return args.length > 0 && ["--get", "--get-all", "--list"].includes(args[0]);
  return false;
}
// Three layers, each removing a different kind of text that only looks like an invocation: a data
// command's heredoc body, a real separator versus one inside quotes, and a data command's quoted
// arguments. What survives all three is parsed as a command, and only at the segment head.
export function gitDecision(event: CanonicalHookEvent): HookDecision {
  const command = stripHeredocBodies(event.command || "");
  if (!/\bgit\b/i.test(command)) return { allow: true };
  for (const raw of splitShellSegments(command).flatMap((segment) => unwrapCommands(segment))) {
    const segment = stripQuotedData(raw);
    if (!/\bgit\b/i.test(segment)) continue;
    for (const parsed of gitInvocations(segment)) {
      if (!gitSubcommandAllowed(parsed.subcommand, parsed.args)) return { allow: false, reason: `git-guard: 'git ${parsed.subcommand || segment}' is not on the read-only allowlist; ask the user to run it explicitly.` };
    }
  }
  return { allow: true };
}
function skillProofPath(root: string, platform: string, sessionId: string): string { return `${root}${sep}skill-guard${sep}${sha256(`${platform}:${sessionId}`)}.json`; }
function agentsRootOf(resolvedPath: string): string | undefined {
  const idx = resolvedPath.toLowerCase().lastIndexOf(`${sep}.agents${sep}`);
  return idx === -1 ? undefined : resolvedPath.slice(0, idx + `${sep}.agents`.length);
}
export function skillDecision(event: CanonicalHookEvent, root = stateRoot()): HookDecision {
  if (!touchesProtected(event, AGENTS_PATTERN) || isReadOnly(event)) return { allow: true };
  const cwd = event.cwd ? resolve(event.cwd) : ""; const targets = event.paths.map((path) => resolve(cwd || ".", path));
  if (!event.sessionId) return { allow: false, reason: "skill-guard: session proof is unavailable for a .agents mutation." };
  const proof = skillProofPath(root, event.platform, event.sessionId);
  if (!existsSync(proof)) return { allow: false, reason: "skill-guard: this touches .agents through a command that is not on the read-only allowlist, so it counts as a write. To read, use cat/grep/rg/sed -n; to write, load .agents/skills/writing-for-agents/SKILL.md first." };
  const record = readJson(proof);
  if (typeof record.expires_at !== "number" || Date.now() >= record.expires_at) return { allow: false, reason: "skill-guard: proof has expired; re-read .agents/skills/writing-for-agents/SKILL.md." };
  if (typeof record.skill_path !== "string" || !existsSync(record.skill_path) || sha256(readFileSync(record.skill_path)) !== record.skill_sha256) return { allow: false, reason: "skill-guard: writing-for-agents/SKILL.md has changed since it was read; re-read it before modifying .agents content." };
  const targetRoots = targets.map(agentsRootOf).filter((path): path is string => !!path);
  if (typeof record.agents_root === "string" && targetRoots.some((path) => normal(path) !== normal(record.agents_root as string))) return { allow: false, reason: "skill-guard: proof was read for a different .agents root; re-read writing-for-agents/SKILL.md for this repo." };
  return { allow: true };
}
export function runGuard(kind: "git" | "skill", platform: string, eventName: string, payload: JsonObject, root?: string): void {
  const event = normalizeHookEvent(platform, payload, eventName); const baseline = hookDecision(event); const decision = !baseline.allow ? baseline : kind === "git" ? gitDecision(event) : skillDecision(event, root);
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
