import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { JsonObject, git, output } from "./core.js";
type Options = Map<string, string | boolean | string[]>;
const text = (o: Options, n: string, f = "") => typeof o.get(n) === "string" ? o.get(n) as string : f;
const paths = (o: Options) => text(o, "paths").split(",").map((v) => v.trim()).filter(Boolean);
// The four repo-wide overviews whose `covers` never participates in matching, so Lookup attaches
// them to every query. Every other doc_type is need-driven and grows without bound, so returning
// the unmatched ones would make each Lookup cost scale with the size of docs/ rather than with the
// paths being changed.
const ALWAYS_ATTACHED = ["architecture", "structure", "dataflow", "glossary"];
// Both YAML sequence styles are accepted. Reading only the block form made a flow-style
// `covers: ["a", "b"]` parse as an empty list, which does not fail anywhere: the document simply
// stops matching any path and drops out of every Lookup without a single error to notice.
function coversOf(header: string): string[] {
  const flow = header.match(/^covers:[ \t]*\[([^\]]*)\]/m);
  const items = flow ? flow[1].split(",")
    : (header.match(/^covers:\s*\r?\n((?:\s*-.*\r?\n?)*)/m)?.[1] || "").split(/\r?\n/).map((line) => line.replace(/^\s*-\s*/, ""));
  return items.map((item) => item.trim().replace(/^(["'])(.*)\1$/, "$2").trim()).filter(Boolean);
}
function docs(root: string, directory: string): JsonObject[] { const base = join(root, directory); if (!existsSync(base)) return []; const found: JsonObject[] = []; const walk = (path: string) => { for (const entry of readdirSync(path, { withFileTypes: true })) { const next = join(path, entry.name); if (entry.isDirectory()) walk(next); else if (entry.isFile() && next.endsWith(".md")) { const body = readFileSync(next, "utf8"); const header = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)?.[1]; const type = header?.match(/^doc_type:\s*(.+)$/m)?.[1].trim(); if (!type) continue; found.push({ path: next, doc_type: type, covers: coversOf(header || "") }); } } }; walk(base); return found; }
export function projectDoc(options: Options): number { const action = text(options, "action"); const root = resolve(text(options, "repo-root", process.cwd())); const result = docs(root, text(options, "doc-root", "docs")); if (action === "List") { output(result); return 0; } if (action === "Check") { const path = resolve(text(options, "doc")); if (!existsSync(path)) { output([{ path, issues: ["document does not exist"] }]); return 0; } const data = docs(root, text(options, "doc-root", "docs")).find((item) => item.path === path); output([{ path, issues: data ? [] : ["missing or invalid frontmatter"] }]); return 0; } if (action === "Stale") { output(result.filter((item) => { const rel = relative(root, String(item.path)); const covered = Array.isArray(item.covers) ? item.covers.map(String) : []; const docTime = Number(git(root, ["log", "-1", "--format=%ct", "--", rel]).stdout || 0); const codeTime = covered.length ? Number(git(root, ["log", "-1", "--format=%ct", "--", ...covered]).stdout || 0) : 0; return codeTime > docTime; })); return 0; } if (action !== "Lookup") throw new Error(`unsupported project-doc action: ${action}`); const requested = paths(options).map((path) => path.replaceAll("\\", "/").toLowerCase()); const matched = new Set<string>(); const mapped = result.map((item) => { const covers = Array.isArray(item.covers) ? item.covers.map(String) : []; const matchedBy = requested.filter((path) => covers.some((cover) => path === cover.toLowerCase() || (cover.endsWith("/") && path.startsWith(cover.toLowerCase())))); matchedBy.forEach((path) => matched.add(path)); return { ...item, doc_type: String(item.doc_type), matched_by: matchedBy }; }).filter((item) => ALWAYS_ATTACHED.includes(item.doc_type) || item.matched_by.length > 0).sort((left, right) => Number(right.matched_by.length) - Number(left.matched_by.length)); output({ docs: mapped, uncovered: requested.filter((path) => !matched.has(path)) }); return 0; }
