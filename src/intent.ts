import { readFileSync } from "node:fs";
import { canonicalJson, sha256 } from "./core.js";

const TRACKED_SECTIONS = ["goal", "scope", "completion criteria"];

// Splits task.md into its "## Heading" sections, keyed lowercase so callers don't have to care
// about heading capitalization.
export function sections(markdown: string): Map<string, string> {
  const result = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];
  const flush = (): void => { if (current !== null) result.set(current, buffer.join("\n")); buffer = []; };
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) { flush(); current = heading[1].trim().toLowerCase(); continue; }
    if (current !== null) buffer.push(line);
  }
  flush();
  return result;
}

// Reasons task.md's tracked sections cannot form an intent hash; an empty list means it can.
export function intentValidationErrors(markdown: string): string[] {
  const headings = [...markdown.matchAll(/^##\s+(.+?)\s*$/gm)].map((match) => match[1].trim().toLowerCase());
  const map = sections(markdown);
  const errors: string[] = [];
  for (const name of TRACKED_SECTIONS) {
    const occurrences = headings.filter((heading) => heading === name).length;
    if (occurrences === 0) { errors.push(`task.md is missing the '## ${name}' section`); continue; }
    if (occurrences > 1) errors.push(`task.md declares '## ${name}' ${occurrences} times; exactly one is required`);
    if (!(map.get(name) || "").trim()) errors.push(`task.md section '## ${name}' is empty`);
  }
  return errors;
}

// Covers only Goal/Scope/Completion criteria, not the whole task.md — a typo fix, an added Evidence
// section, or a heading-format change elsewhere in the file must never invalidate an existing
// intent_approval. Whitespace is fully normalized so reflowing a paragraph doesn't either, and a
// checkbox tick ("- [ ]" to "- [x]") is progress rather than an intent change; only the visible
// content of these three sections can change this hash.
export function intentHash(taskMd: string): string {
  const errors = intentValidationErrors(taskMd);
  // Hashing a missing section digests an empty string, which downstream reads as an approved intent.
  if (errors.length) throw new Error(`task.md intent is invalid: ${errors.join("; ")}`);
  const map = sections(taskMd);
  const picked = Object.fromEntries(TRACKED_SECTIONS.map((name) => [name, (map.get(name) || "").replace(/^(\s*[-*] )\[[xX]\]/gm, "$1[ ]").replace(/\s+/g, " ").trim()]));
  return sha256(canonicalJson(picked));
}

export type AcceptanceCase = { id: string; title: string; given: string; when: string; then: string; verify: string; command: string };
export type AcceptanceParse = { declared: boolean; cases: AcceptanceCase[]; errors: string[] };

const ACCEPTANCE_HEADING = /^###\s+acceptance\s+(cases|criteria)\s*$/i;
const CASE_LINE = /^[-*]\s+(?:\[[ xX]\]\s+)?\*\*(AC\d+)\*\*\s*(.*)$/;
const CLAUSE_LINE = /^\s+[-*]\s+(given|when|then|verify)\b\s*:?\s*(.*)$/i;

// Parses the Given/When/Then cases under `### Acceptance cases` inside Completion criteria. The
// section already sits inside the intent hash, so a case edited after its verification run makes
// that run stale without any extra bookkeeping.
export function acceptanceCases(markdown: string): AcceptanceParse {
  const criteria = (sections(markdown).get("completion criteria") || "").split(/\r?\n/);
  const start = criteria.findIndex((line) => ACCEPTANCE_HEADING.test(line.trim()));
  if (start === -1) return { declared: false, cases: [], errors: [] };
  const cases: AcceptanceCase[] = [];
  const errors: string[] = [];
  let current: AcceptanceCase | undefined;
  for (const line of criteria.slice(start + 1)) {
    if (/^###\s+/.test(line)) break;
    const head = line.match(CASE_LINE);
    if (head) {
      current = { id: head[1], title: head[2].trim(), given: "", when: "", then: "", verify: "", command: "" };
      cases.push(current);
      continue;
    }
    const clause = line.match(CLAUSE_LINE);
    if (clause && current) {
      const key = clause[1].toLowerCase() as "given" | "when" | "then" | "verify";
      current[key] = clause[2].trim();
      if (key === "verify") current.command = clause[2].match(/`([^`]+)`/)?.[1].trim() || "";
    }
  }
  const seen = new Set<string>();
  for (const item of cases) {
    if (seen.has(item.id)) errors.push(`acceptance case ${item.id} is declared more than once`);
    seen.add(item.id);
    for (const key of ["given", "when", "then"] as const) if (!item[key]) errors.push(`acceptance case ${item.id} has no ${key[0].toUpperCase()}${key.slice(1)} clause`);
    if (!item.command) errors.push(`acceptance case ${item.id} needs a runnable command in its Verify clause, written as a code span`);
  }
  if (!cases.length) errors.push("'### Acceptance cases' declares no case; write each as `- **AC1** <title>` with Given/When/Then/Verify sub-items");
  return { declared: true, cases, errors };
}

// A code-change managed task must define its acceptance cases before development; other tasks may.
export function acceptanceRequired(state: { managed_change?: unknown; code_change?: unknown }): boolean {
  return state.managed_change === true && state.code_change === true;
}

export function acceptanceErrors(markdown: string, required: boolean): string[] {
  const parsed = acceptanceCases(markdown);
  if (!parsed.declared) return required ? ["task.md has no '### Acceptance cases' under '## Completion criteria'; a code-change task defines Given/When/Then cases before development"] : [];
  return parsed.errors;
}

export function intentHashForPath(taskMdPath: string): string {
  return intentHash(readFileSync(taskMdPath, "utf8"));
}
