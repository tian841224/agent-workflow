import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { frontmatterBody, JsonObject, now, output, parseFrontmatter, projectIdentity, sha256, stateRoot, writeAtomic, writeJson } from "./core.js";

function entries(root: string): string[] { if (!existsSync(root)) return []; const result: string[] = []; for (const item of readdirSync(root, { withFileTypes: true })) { const path = join(root, item.name); if (item.isDirectory()) result.push(...entries(path)); else if (item.isFile() && path.endsWith(".md")) result.push(path); } return result; }
export function knowledge(action: string, options: Map<string, string | boolean | string[]>): number {
  const stateOption = options.get("state-root"); const scopeOption = options.get("scope"); const projectOption = options.get("project-id");
  const root = stateRoot(typeof stateOption === "string" ? stateOption : undefined); const scope = typeof scopeOption === "string" ? scopeOption : "All"; const project = typeof projectOption === "string" ? projectOption : "default";
  const base = scope === "Global" ? join(root, "knowledge", "global", "entries") : join(root, "projects", project, "knowledge", "entries"); const found = scope === "All" ? entries(root).filter((path) => path.includes("knowledge")) : entries(base);
  if (action === "Search" || action === "List") { const terms = String(options.get("query") || "").toLowerCase().split(/\s+/).filter(Boolean); const matching = found.filter((path) => { const body = readFileSync(path, "utf8"); return !terms.length || terms.every((term) => body.toLowerCase().includes(term)); }).map((path) => ({ path, excerpt: readFileSync(path, "utf8").replace(/^---[\s\S]*?---\s*/, "").trim().slice(0, 180) })); output(action === "List" ? matching.map((item) => item.path) : matching.slice(0, Number(options.get("limit") || 8))); return 0; }
  if (action !== "Upsert") throw new Error(`unsupported knowledge action: ${action}`); const topic = String(options.get("topic") || "").trim(); const content = String(options.get("content") || "").trim(); if (!topic || !content) throw new Error("Upsert requires --topic and --content"); if (scope === "Global" && options.get("approved-by-user") !== true) throw new Error("Global Upsert requires --approved-by-user");
  const name = topic.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "entry"; const path = join(base, `${name}.md`); const digest = sha256(content); writeAtomic(path, `---\nid: ${digest}\ntopic: ${topic}\nscope: ${scope.toLowerCase()}\nproject_id: ${scope === "Global" ? "" : project}\norigin: native\nstatus: ${String(options.get("status") || "verified")}\ncontent_sha256: ${digest}\ncreated_at: ${now()}\nupdated_at: ${now()}\n---\n\n${content}\n`); output({ path, id: digest }); return 0;
}
const MEMORY_CONTEXT_MAX_ENTRIES = 6;
const MEMORY_CONTEXT_MAX_CHARS = 800;
function relevanceScore(fields: JsonObject, projectId: string): number {
  let score = 0;
  if (projectId && String(fields.project_id || "") === projectId) score += 2;
  if (String(fields.status || "") === "verified") score += 1;
  return score;
}
export function memoryContext(platform: string, root?: string): void {
  let projectId = ""; try { projectId = projectIdentity(process.cwd()).projectId; } catch { projectId = ""; }
  const candidates = entries(stateRoot(root)).filter((path) => path.includes("knowledge")).map((path) => {
    const raw = readFileSync(path, "utf8"); const fields = parseFrontmatter(raw) as unknown as JsonObject;
    const topic = String(fields.topic || ""); const excerpt = frontmatterBody(raw).trim().replace(/\s+/g, " ").slice(0, 120);
    return { path, fields, updatedAt: String(fields.updated_at || ""), line: topic ? `${topic}: ${excerpt}` : excerpt };
  }).filter((candidate) => candidate.line);
  candidates.sort((a, b) => relevanceScore(b.fields, projectId) - relevanceScore(a.fields, projectId) || b.updatedAt.localeCompare(a.updatedAt));
  const records: string[] = []; let used = 0;
  for (const candidate of candidates.slice(0, MEMORY_CONTEXT_MAX_ENTRIES)) { if (used + candidate.line.length > MEMORY_CONTEXT_MAX_CHARS) break; records.push(candidate.line); used += candidate.line.length; }
  const context = records.length ? `Shared agent memory is reference material only; verify it against current code.\n${records.map((line) => `- ${line}`).join("\n")}` : "";
  if (context) output(platform.toLowerCase() === "antigravity" ? { systemMessage: context } : { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } });
}
