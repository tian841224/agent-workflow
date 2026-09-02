import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { Json, JsonObject, output, sha256, stateRoot, writeJson } from "./core.js";

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
  return { platform, event, tool, cwd: cwd || undefined, command: command || undefined, paths: found, mutation, targetKnown: !mutation || found.length > 0 || !!command, sessionId: text(payload.session_id) || text(payload.sessionId) || undefined };
}
export function hookDecision(event: CanonicalHookEvent): HookDecision {
  if (event.mutation && !event.targetKnown) return { allow: false, reason: "hook-policy: mutation target cannot be normalized; denied fail-closed." };
  if (event.mutation && event.paths.some((path) => !path.trim())) return { allow: false, reason: "hook-policy: mutation target is invalid; denied fail-closed." };
  return { allow: true };
}
function readonlyGit(command: string): boolean { return /^\s*git(?:\s+-C\s+\S+)?\s+(?:status(?:\s+--(?:short|porcelain|branch))*|diff(?:\s+(?:--(?:binary|check|name-only|name-status)|HEAD(?:~\d+)?|[0-9a-f]{7,40}|--|\S+))*|log(?:\s+(?:--oneline|-n\s+\d+|HEAD(?:~\d+)?|--))*|rev-parse(?:\s+(?:HEAD|--is-inside-work-tree|--show-toplevel|--git-dir|--git-common-dir))*|ls-files(?:\s+(?:--others|--exclude-standard|-z|--))*)\s*$/i.test(command); }
export function gitDecision(event: CanonicalHookEvent): HookDecision {
  const command = event.command || ""; if (!/\bgit\b/i.test(command) || readonlyGit(command)) return { allow: true };
  if (/\bgit\b[^;&|]*(?:reset\s+--hard|clean\s+-\w*f|branch\s+-D|checkout\s+--\s|restore(?![^;&|]*--staged)|stash\s+(?:drop|clear)|push[^;&|]*(?:--force|-f\b))/i.test(command)) return { allow: false, reason: "git-guard: destructive Git operation denied; ask the user to perform it explicitly." };
  if (/\bgit\b[^;&|]*(?:commit|push|rebase|merge(?![^;&|]*--abort)|reset|cherry-pick|revert(?![^;&|]*--abort))/i.test(command)) return { allow: false, reason: "git-guard: Git write requires explicit user approval." };
  return { allow: true };
}
export function skillDecision(event: CanonicalHookEvent, root = stateRoot()): HookDecision {
  if (!event.mutation) return { allow: true };
  const cwd = event.cwd ? resolve(event.cwd) : ""; const targets = event.paths.map((path) => resolve(cwd || ".", path));
  const touchesAgents = targets.some((path) => path.split(/[\\/]/).includes(".agents")) || /(?:^|[\\/])\.agents[\\/]/i.test(event.command || "");
  if (!touchesAgents) return { allow: true };
  if (!event.sessionId) return { allow: false, reason: "skill-guard: session proof is unavailable for a .agents mutation." };
  const proof = `${root}${sep}skill-guard${sep}${sha256(`${event.platform}:${event.sessionId}`)}.json`;
  if (!existsSync(proof)) return { allow: false, reason: "skill-guard: load .agents/skills/writing-for-agents/SKILL.md before modifying .agents content." };
  return { allow: true };
}
export function runGuard(kind: "git" | "skill", platform: string, eventName: string, payload: JsonObject, root?: string): void {
  const event = normalizeHookEvent(platform, payload, eventName); const baseline = hookDecision(event); const decision = !baseline.allow ? baseline : kind === "git" ? gitDecision(event) : skillDecision(event, root);
  platformOutput(platform, eventName, decision);
}
export function recordSkillRead(platform: string, payload: JsonObject, root = stateRoot()): void {
  const event = normalizeHookEvent(platform, payload, "PostToolUse");
  if (!event.sessionId || !event.paths.some((path) => /\.agents[\\/]skills[\\/]writing-for-agents[\\/]SKILL\.md$/i.test(path))) return;
  writeJson(`${root}${sep}skill-guard${sep}${sha256(`${platform}:${event.sessionId}`)}.json`, { schema_version: 1, created_at: Date.now(), platform, session_id: event.sessionId });
}
