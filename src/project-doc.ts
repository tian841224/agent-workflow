import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { JsonObject, git, isWithin, output, readJson, sha256 } from "./core.js";
import { taskWrite } from "./lifecycle/transitions.js";
type Options = Map<string, string | boolean | string[]>;
const text = (o: Options, n: string, f = "") => typeof o.get(n) === "string" ? o.get(n) as string : f;
const paths = (o: Options) => text(o, "paths").split(",").map((v) => v.trim()).filter(Boolean);
// Repo-wide overviews are candidates, not implicit reads. Returning their digest lets an agent
// reuse a document already read in the same session without reopening every overview on each lookup.
const OVERVIEW_TYPES = ["architecture", "structure", "dataflow", "glossary"];
const DOC_TYPES = new Set(["architecture", "structure", "dataflow", "flow", "module", "api", "decision", "glossary"]);
const REQUIRED_SECTIONS: Record<string, string[]> = {
  structure: ["layout", "placement rules", "unverified"],
  flow: ["trigger", "steps", "failure modes", "unverified"],
  module: ["responsibility", "entrypoints", "flow", "shared state", "invariants and gotchas", "unverified"],
  api: ["endpoint", "auth", "request", "response", "errors", "invariants and gotchas", "unverified"],
  decision: ["context", "decision", "alternatives", "consequences"],
  glossary: ["terms"]
};
// Both YAML sequence styles are accepted. Reading only the block form made a flow-style
// `covers: ["a", "b"]` parse as an empty list, which does not fail anywhere: the document simply
// stops matching any path and drops out of every Lookup without a single error to notice.
function coversOf(header: string): string[] {
  const flow = header.match(/^covers:[ \t]*\[([^\]]*)\]/m);
  const items = flow ? flow[1].split(",")
    : (header.match(/^covers:\s*\r?\n((?:\s*-.*\r?\n?)*)/m)?.[1] || "").split(/\r?\n/).map((line) => line.replace(/^\s*-\s*/, ""));
  return items.map((item) => item.trim().replace(/^(["'])(.*)\1$/, "$2").trim()).filter(Boolean);
}
function docs(root: string, directory: string): JsonObject[] {
  const base = join(root, directory); if (!existsSync(base)) return [];
  const found: JsonObject[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const next = join(path, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile() && next.endsWith(".md")) {
        const body = readFileSync(next, "utf8");
        const header = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)?.[1];
        const type = header?.match(/^doc_type:\s*(.+)$/m)?.[1].trim().replace(/^['"]|['"]$/g, "");
        if (!type) continue;
        found.push({ path: next, doc_type: type, covers: coversOf(header || ""), content_sha256: sha256(body) });
      }
    }
  };
  walk(base); return found;
}
function checkDocument(root: string, docRoot: string, path: string): string[] {
  if (!existsSync(path)) return ["document does not exist"];
  if (!isWithin(path, join(root, docRoot))) return ["document is outside the configured doc-root"];
  const body = readFileSync(path, "utf8");
  const headerMatch = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!headerMatch) return ["missing or invalid frontmatter"];
  const header = headerMatch[1];
  const rawType = header.match(/^doc_type:\s*(.+)$/m)?.[1].trim().replace(/^['"]|['"]$/g, "") || "";
  const issues: string[] = [];
  if (!DOC_TYPES.has(rawType)) issues.push(`doc_type must be one of: ${[...DOC_TYPES].join(", ")}`);
  const coverValues = coversOf(header);
  if (["flow", "module", "api", "decision"].includes(rawType) && !coverValues.length) issues.push(`${rawType} documents require a non-empty covers list`);
  for (const cover of coverValues) {
    if (!cover || cover.includes("..") || cover.includes("[") || cover.includes("]") || cover.includes("\\") || cover.startsWith("/")) issues.push(`invalid covers path: ${cover}`);
  }
  const headings = new Set([...body.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1].trim().toLowerCase()));
  for (const required of REQUIRED_SECTIONS[rawType] || []) if (!headings.has(required)) issues.push(`missing required section: ## ${required}`);
  if (OVERVIEW_TYPES.includes(rawType)) {
    const siblings = docs(root, docRoot).filter((item) => String(item.doc_type) === rawType && String(item.path) !== path);
    if (siblings.length) issues.push(`duplicate singleton doc_type '${rawType}': ${siblings.map((item) => String(item.path)).join(", ")}`);
  }
  return issues;
}

function taskStatePath(value: string): string {
  const candidate = resolve(value);
  return candidate.toLowerCase().endsWith(".json") ? candidate : join(candidate, "task.json");
}

function projectDocPath(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

type ProjectDocState = { read: Set<string>; digests: Map<string, string> };
function projectDocState(root: string, taskValue: string): ProjectDocState {
  if (!taskValue) return { read: new Set(), digests: new Map() };
  const state = readJson(taskStatePath(taskValue)) as JsonObject;
  const project = state.project_docs && typeof state.project_docs === "object" ? state.project_docs as JsonObject : {};
  const read = new Set((Array.isArray(project.read) ? project.read : []).map((value) => String(value).replaceAll("\\", "/")));
  const digests = new Map<string, string>();
  for (const item of Array.isArray(project.digests) ? project.digests : []) {
    if (!item || typeof item !== "object") continue;
    const entry = item as JsonObject;
    if (typeof entry.path === "string" && typeof entry.content_sha256 === "string") digests.set(entry.path.replaceAll("\\", "/"), entry.content_sha256);
  }
  return { read, digests };
}

function digestStatus(root: string, item: JsonObject, state: ProjectDocState, taskValue: string): string {
  if (!taskValue) return "untracked";
  const path = projectDocPath(root, String(item.path));
  if (!state.read.has(path)) return "unread";
  const recorded = state.digests.get(path);
  if (!recorded) return "digest_missing";
  return recorded === String(item.content_sha256) ? "reusable" : "stale";
}

function remember(options: Options): number {
  const taskValue = text(options, "task-path");
  if (!taskValue) throw new Error("project-doc Remember requires --task-path");
  const root = resolve(text(options, "repo-root", process.cwd()));
  const docRoot = text(options, "doc-root", "docs");
  const requested = paths(options);
  if (!requested.length) throw new Error("project-doc Remember requires --paths");
  const entries = docs(root, docRoot);
  const byPath = new Map(entries.map((item) => [projectDocPath(root, String(item.path)), item]));
  const remembered: JsonObject[] = [];
  const issues: string[] = [];
  for (const requestedPath of requested) {
    const absolute = resolve(root, requestedPath);
    const canonical = projectDocPath(root, absolute);
    const item = byPath.get(canonical);
    if (!item) { issues.push(`${requestedPath}: document is missing or has invalid frontmatter`); continue; }
    const documentIssues = checkDocument(root, docRoot, absolute);
    if (documentIssues.length) { issues.push(`${requestedPath}: ${documentIssues.join("; ")}`); continue; }
    remembered.push({ path: canonical, content_sha256: String(item.content_sha256) });
  }
  if (issues.length) { output({ valid: false, errors: issues }); return 1; }
  const state = readJson(taskStatePath(taskValue)) as JsonObject;
  const current = state.project_docs && typeof state.project_docs === "object" ? state.project_docs as JsonObject : {};
  const read = new Set((Array.isArray(current.read) ? current.read : []).map((value) => String(value).replaceAll("\\", "/")));
  const digestMap = new Map<string, string>();
  for (const item of Array.isArray(current.digests) ? current.digests : []) {
    if (!item || typeof item !== "object") continue;
    const entry = item as JsonObject;
    if (typeof entry.path === "string" && typeof entry.content_sha256 === "string") digestMap.set(entry.path.replaceAll("\\", "/"), entry.content_sha256);
  }
  for (const item of remembered) { read.add(String(item.path)); digestMap.set(String(item.path), String(item.content_sha256)); }
  const nextProject = {
    read: [...read].sort(),
    updated: (Array.isArray(current.updated) ? current.updated : []).map(String).sort(),
    digests: [...digestMap.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, content_sha256]) => ({ path, content_sha256 }))
  };
  const previous = JSON.stringify(current); const next = JSON.stringify(nextProject);
  let stateRevision = Number(state.state_revision || 0);
  if (previous !== next) {
    const code = taskWrite(taskValue, { project_docs: nextProject }, undefined, root, false, undefined, false);
    if (code !== 0) { output({ valid: false, errors: ["project-doc Remember could not update task state"] }); return code; }
    stateRevision = Number((readJson(taskStatePath(taskValue)) as JsonObject).state_revision || stateRevision);
  }
  output({ valid: true, task: taskStatePath(taskValue), state_revision: stateRevision, remembered });
  return 0;
}

export function projectDoc(options: Options): number {
  const action = text(options, "action"); const root = resolve(text(options, "repo-root", process.cwd())); const docRoot = text(options, "doc-root", "docs"); const result = docs(root, docRoot);
  if (action === "List") { output(result); return 0; }
  if (action === "Check") { const requested = text(options, "doc"); const path = resolve(root, requested); const issues = checkDocument(root, docRoot, path); output([{ path, issues }]); return issues.length ? 1 : 0; }
  if (action === "Stale") { output(result.filter((item) => { const rel = relative(root, String(item.path)); const covered = Array.isArray(item.covers) ? item.covers.map(String) : []; const docTime = Number(git(root, ["log", "-1", "--format=%ct", "--", rel]).stdout || 0); const codeTime = covered.length ? Number(git(root, ["log", "-1", "--format=%ct", "--", ...covered]).stdout || 0) : 0; return codeTime > docTime; })); return 0; }
  if (action === "Remember") return remember(options);
  if (action !== "Lookup") throw new Error(`unsupported project-doc action: ${action}`);
  const taskValue = text(options, "task-path"); const prior = projectDocState(root, taskValue);
  const requested = paths(options).map((path) => path.replaceAll("\\", "/").toLowerCase()); const matched = new Set<string>();
  const mapped = result.map((item) => {
    const covers = Array.isArray(item.covers) ? item.covers.map(String) : [];
    const matchedBy = requested.filter((path) => covers.some((cover) => path === cover.toLowerCase() || (cover.endsWith("/") && path.startsWith(cover.toLowerCase()))));
    matchedBy.forEach((path) => matched.add(path));
    return { ...item, doc_type: String(item.doc_type), matched_by: matchedBy, digest_status: digestStatus(root, item, prior, taskValue) };
  }).filter((item) => !OVERVIEW_TYPES.includes(String(item.doc_type)) && item.matched_by.length > 0).sort((left, right) => Number(right.matched_by.length) - Number(left.matched_by.length));
  const overview_candidates = result.filter((item) => OVERVIEW_TYPES.includes(String(item.doc_type))).map((item) => ({ path: item.path, doc_type: item.doc_type, content_sha256: item.content_sha256, reason: "repo-wide overview; read when the compiled exploration profile or task impact requires it", digest_status: digestStatus(root, item, prior, taskValue) }));
  output({ docs: mapped, overview_candidates, uncovered: requested.filter((path) => !matched.has(path)) }); return 0;
}
