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
export function normalizeHookEvent(platform: string, payload: JsonObject, event = "PreToolUse"): CanonicalHookEvent {
  const call = object(payload.toolCall); const input = object(payload.tool_input); const tool = (text(payload.tool_name) || text(payload.toolName) || text(payload.tool) || text(call.name)).toLowerCase().replaceAll("-", "_");
  const command = text(object(call.args).CommandLine) || text(object(call.args).command) || text(input.command) || text(object(payload.input).command);
  const found = paths(payload); const shellMutation = /(?:>|>>|\b(?:set-content|add-content|out-file|new-item|remove-item|copy-item|move-item|tee|sed\s+-i|perl\s+-pi|cp|mv|rm|del|erase)\b)/i.test(command);
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
  if (event.mutation && event.paths.some((path) => /(?:^|[\\/])task\.json$/i.test(path))) return { allow: false, reason: "task-guard: task.json is runtime-owned; use `agent-workflow task-init` / `task-write` / pause / block / supersede / waive / close-task instead of editing it directly." };
  return { allow: true };
}
function parseGitInvocation(segment: string): { subcommand: string; args: string[] } | null {
  const match = segment.match(/\bgit\b\s*(.*)$/i); if (!match) return null;
  const cStripped = match[1].trim().match(/^-C\s+\S+\s*(.*)$/i);
  const tokens = (cStripped ? cStripped[1] : match[1]).trim().split(/\s+/).filter(Boolean);
  return { subcommand: (tokens[0] || "").toLowerCase(), args: tokens.slice(1) };
}
function gitSubcommandAllowed(subcommand: string, args: string[]): boolean {
  if (["status", "diff", "log", "show", "rev-parse", "ls-files", "rev-list"].includes(subcommand)) return true;
  if (subcommand === "branch") return args.length === 0 || (args.length === 1 && args[0] === "--show-current");
  if (subcommand === "remote") return args.length > 0 && ["-v", "get-url", "show"].includes(args[0]);
  if (subcommand === "config") return args.length > 0 && ["--get", "--get-all", "--list"].includes(args[0]);
  return false;
}
export function gitDecision(event: CanonicalHookEvent): HookDecision {
  const command = event.command || ""; if (!/\bgit\b/i.test(command)) return { allow: true };
  for (const segment of command.split(/[;&|\n]+/).map((part) => part.trim()).filter((part) => /\bgit\b/i.test(part))) {
    const parsed = parseGitInvocation(segment);
    if (parsed && !gitSubcommandAllowed(parsed.subcommand, parsed.args)) return { allow: false, reason: `git-guard: 'git ${parsed.subcommand || segment.trim()}' is not on the read-only allowlist; ask the user to run it explicitly.` };
  }
  return { allow: true };
}
function skillProofPath(root: string, platform: string, sessionId: string): string { return `${root}${sep}skill-guard${sep}${sha256(`${platform}:${sessionId}`)}.json`; }
function agentsRootOf(resolvedPath: string): string | undefined {
  const idx = resolvedPath.toLowerCase().lastIndexOf(`${sep}.agents${sep}`);
  return idx === -1 ? undefined : resolvedPath.slice(0, idx + `${sep}.agents`.length);
}
export function skillDecision(event: CanonicalHookEvent, root = stateRoot()): HookDecision {
  if (!event.mutation) return { allow: true };
  const cwd = event.cwd ? resolve(event.cwd) : ""; const targets = event.paths.map((path) => resolve(cwd || ".", path));
  const touchesAgents = targets.some((path) => path.split(/[\\/]/).includes(".agents")) || /(?:^|[\\/])\.agents[\\/]/i.test(event.command || "");
  if (!touchesAgents) return { allow: true };
  if (!event.sessionId) return { allow: false, reason: "skill-guard: session proof is unavailable for a .agents mutation." };
  const proof = skillProofPath(root, event.platform, event.sessionId);
  if (!existsSync(proof)) return { allow: false, reason: "skill-guard: load .agents/skills/writing-for-agents/SKILL.md before modifying .agents content." };
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
