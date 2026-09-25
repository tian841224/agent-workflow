import { resolve } from "node:path";
import { isWithin, Json, JsonObject, output } from "./core.js";

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

// Commands whose quoted arguments and heredoc bodies are text they print or match, never text they
// execute. Only these get their quoted runs and heredoc bodies dropped before parsing — an
// interpreter's quoted argument or heredoc body IS the program, so those must stay visible.
const DATA_ARGUMENT_COMMANDS = new Set([
  "echo", "printf", "cat", "type", "grep", "rg", "egrep", "fgrep", "findstr", "select-string",
  "ack", "ag", "jq", "yq", "awk", "sed", "comm", "diff", "write-host", "write-output", "tee"
]);
// PowerShell does not put the command first: an assignment binds it (`$t = git ls-files`) and a block
// opener precedes it (`foreach ($d in $dirs) { Get-ChildItem $d }`). The raw first token read those as
// the commands `$t` and `foreach`, which hid the git invocation behind them.
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
  // `s` flag: a multi-line -m message or here-string must still match past its embedded newlines.
  const match = segment.match(/^(?:\S*[\\/])?git(?:\.exe)?\b\s*(.*)$/is); if (!match) return null;
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
    const invocation = stripInvocationPrefix(segment);
    const parsed = parseGitInvocation(invocation, event.cwd ? resolve(event.cwd) : process.cwd());
    if (!parsed) {
      // Distinguish "git" merely appearing in another command's arguments from an actual git invocation that alters execution.
      if (!/^(?:\S*[\\/])?git(?:\.exe)?\b/is.test(invocation)) return { allow: false, reason: `git-guard: 'git' appears in the arguments of '${head}', which may execute it; ask the user to run it explicitly.` };
      return { allow: false, reason: `git-guard: 'git ${segment}' alters git's execution (-c/--exec-path/--namespace) or its --git-dir/--work-tree points outside the project; ask the user to run it explicitly.` };
    }
    if (destructiveGit(parsed.subcommand, parsed.args)) return { allow: false, reason: `git-guard: destructive git ${parsed.subcommand} is denied; ask the user to run it explicitly.` };
    if (["diff", "log", "show"].includes(parsed.subcommand) && parsed.args.some((arg) => GIT_DENIED_READ_OPTIONS.test(arg))) return { allow: false, reason: "git-guard: diff machinery output or external execution is denied." };
  }
  return { allow: true };
}
// Task state is not guarded here: the runtime owns every write to it, and a shell-string guard could
// only block commands by pattern while never proving what they actually write.
export function runGuard(platform: string, eventName: string, payload: JsonObject): void {
  platformOutput(platform, eventName, gitDecision(normalizeHookEvent(platform, payload, eventName)));
}
