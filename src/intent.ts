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
// intent_approval. Whitespace is fully normalized so reflowing a paragraph doesn't either; only the
// visible content of these three sections can change this hash.
export function intentHash(taskMd: string): string {
  const errors = intentValidationErrors(taskMd);
  // Hashing a missing section digests an empty string, which downstream reads as an approved intent.
  if (errors.length) throw new Error(`task.md intent is invalid: ${errors.join("; ")}`);
  const map = sections(taskMd);
  const picked = Object.fromEntries(TRACKED_SECTIONS.map((name) => [name, (map.get(name) || "").replace(/\s+/g, " ").trim()]));
  return sha256(canonicalJson(picked));
}

export function intentHashForPath(taskMdPath: string): string {
  return intentHash(readFileSync(taskMdPath, "utf8"));
}
