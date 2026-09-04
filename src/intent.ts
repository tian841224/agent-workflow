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

// Covers only Goal/Scope/Completion criteria, not the whole task.md — a typo fix, an added Evidence
// section, or a heading-format change elsewhere in the file must never invalidate an existing
// intent_approval. Whitespace is fully normalized so reflowing a paragraph doesn't either; only the
// visible content of these three sections can change this hash.
export function intentHash(taskMd: string): string {
  const map = sections(taskMd);
  const picked = Object.fromEntries(TRACKED_SECTIONS.map((name) => [name, (map.get(name) || "").replace(/\s+/g, " ").trim()]));
  return sha256(canonicalJson(picked));
}

export function intentHashForPath(taskMdPath: string): string {
  return intentHash(readFileSync(taskMdPath, "utf8"));
}
