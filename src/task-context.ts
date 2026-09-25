import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { frontmatterBody, JsonObject, normalizeRepoPath, parseFrontmatter } from "./core.js";
import { sections } from "./intent.js";
import { entries } from "./knowledge.js";
import { lookupDocs } from "./project-doc.js";

const MAX_MEMORY = 8;
const MAX_HISTORY = 5;

// A requested path and a recorded path relate when either is a prefix of the other, so a task on
// `src/auth/login.ts` finds an entry recorded for `src/auth/`, and a task on `src/auth/` finds one
// recorded for a file under it.
function related(requested: string[], recorded: string[]): boolean {
  const left = requested.map(normalizeRepoPath);
  return recorded.map(normalizeRepoPath).some((path) => left.some((item) => item === path || item.startsWith(path.endsWith("/") ? path : `${path}/`) || path.startsWith(item.endsWith("/") ? item : `${item}/`)));
}

const list = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];

function memoryFor(stateRoot: string, projectId: string, paths: string[]): JsonObject[] {
  const sources = [join(stateRoot, "projects", projectId, "knowledge", "entries"), join(stateRoot, "knowledge", "global", "entries")];
  const tokens = paths.flatMap((path) => normalizeRepoPath(path).split("/")).filter((token) => token.length > 2).map((token) => token.toLowerCase());
  return sources.flatMap((source) => entries(source)).flatMap((path) => {
    const raw = readFileSync(path, "utf8");
    const fields = parseFrontmatter(raw);
    if (String(fields.status || "") === "superseded") return [];
    const byPath = related(paths, list(fields.paths));
    const byTag = list(fields.tags).some((tag) => tokens.includes(tag.toLowerCase()));
    if (!byPath && !byTag) return [];
    return [{ path, topic: String(fields.topic || ""), kind: String(fields.kind || ""), tags: list(fields.tags), status: String(fields.status || ""), matched_by: byPath ? "paths" : "tags", excerpt: frontmatterBody(raw).trim().replace(/\s+/g, " ").slice(0, 200), updated_at: String(fields.updated_at || "") }];
  }).sort((a, b) => (a.matched_by === b.matched_by ? 0 : a.matched_by === "paths" ? -1 : 1) || b.updated_at.localeCompare(a.updated_at)).slice(0, MAX_MEMORY) as unknown as JsonObject[];
}

// Closed tasks that delivered or reviewed the same paths are the project's change history for them:
// their Goal and review summaries tell the next task why the code looks the way it does.
function historyFor(stateRoot: string, projectId: string, paths: string[], currentTaskId: string): JsonObject[] {
  const tasks = join(stateRoot, "projects", projectId, "tasks");
  if (!existsSync(tasks)) return [];
  const found: JsonObject[] = [];
  for (const entry of readdirSync(tasks, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === currentTaskId) continue;
    const statePath = join(tasks, entry.name, "task.json");
    if (!existsSync(statePath)) continue;
    let state: JsonObject;
    try { state = JSON.parse(readFileSync(statePath, "utf8")) as JsonObject; } catch { continue; }
    if (String((state.lifecycle as JsonObject | undefined)?.status || "") !== "closed") continue;
    const evidence = Array.isArray(state.evidence) ? state.evidence as JsonObject[] : [];
    const touched = [...new Set(evidence.flatMap((item) => [...list(item.delivery_paths), ...list(item.reviewed_paths)]))];
    if (!related(paths, touched)) continue;
    const markdownPath = join(tasks, entry.name, "task.md");
    const markdown = existsSync(markdownPath) ? readFileSync(markdownPath, "utf8") : "";
    const title = markdown.match(/^#\s+(.+)$/m)?.[1].trim() || entry.name;
    const goal = (sections(markdown).get("goal") || "").trim().replace(/\s+/g, " ").slice(0, 200);
    const review = evidence.filter((item) => item.kind === "role").map((item) => String(item.summary || "")).filter(Boolean).at(-1) || "";
    found.push({ task: join(tasks, entry.name), title, goal, last_review: review.slice(0, 200), updated_at: String(state.updated_at || "") });
  }
  return found.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, MAX_HISTORY);
}

// Everything an agent should read before development, in one call: project docs covering the paths,
// memory entries recorded for them, and closed tasks that changed them.
export function taskContext(repoRoot: string, stateRoot: string, projectId: string, paths: string[], currentTaskId = "", taskValue = ""): JsonObject {
  const docs = lookupDocs(repoRoot, "docs", paths, taskValue);
  const uncovered = list(docs.uncovered);
  return {
    paths,
    docs,
    memory: memoryFor(stateRoot, projectId, paths),
    history: historyFor(stateRoot, projectId, paths, currentTaskId),
    ...(uncovered.length ? { doc_gap: `no project doc covers ${uncovered.join(", ")}; before development, write one module doc for the area this task touches (project-docs skill) and add it to the docs index` } : {})
  };
}
