// Deterministic (no LLM) enforcement for the localization-tw policy: a short per-turn reminder and
// a lexical check on the assistant's own final text. Both read the same generated policy file so
// the vocabulary stays single-sourced in .agents/skills/localization-tw/references/vocabulary.md.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { JsonObject, output, readJson } from "./core.js";

export type LocaleTerm = { avoid: string; use: string; exceptions: string[] };
export type LocalePolicy = { reminder: string; terms: LocaleTerm[] };

export function readLocalePolicy(root: string): LocalePolicy | undefined {
  const path = join(root, "runtime", "localization-tw-policy.json");
  if (!existsSync(path)) return undefined;
  const parsed = readJson(path);
  if (typeof parsed.reminder !== "string" || !Array.isArray(parsed.terms)) return undefined;
  return parsed as unknown as LocalePolicy;
}

export function runLocaleReminder(root: string): void {
  const policy = readLocalePolicy(root);
  if (!policy) return; // localization-tw not installed/selected: no opinion, not an error
  output({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: policy.reminder } });
}

// Code fences, inline code, URLs/paths and quoted spans hold text the assistant is presenting or
// citing rather than authoring, so a mainland term appearing there is not this turn's own wording.
function stripNonProseSpans(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[A-Za-z]:[\\/][^\s"'」]*|(?:\.\.?\/|\/)[^\s"'」]*/g, "")
    .replace(/「[^」]*」/g, "")
    .replace(/『[^』]*』/g, "")
    .replace(/^>.*$/gm, "");
}

export function lintViolations(message: string, terms: LocaleTerm[]): LocaleTerm[] {
  const prose = stripNonProseSpans(message);
  const hits: LocaleTerm[] = [];
  for (const term of terms) {
    if (!prose.includes(term.avoid)) continue;
    // A longer term already covering this span (e.g. 數據庫 before 數據) means this shorter one
    // is a substring hit inside an already-reported term, not a separate violation.
    if (hits.some((hit) => hit.avoid.includes(term.avoid))) continue;
    if (term.exceptions.some((exception) => prose.includes(exception) && exception.includes(term.avoid))) continue;
    hits.push(term);
  }
  return hits;
}

export function runLocaleLint(payload: JsonObject, root: string, platform = "Claude"): void {
  const policy = readLocalePolicy(root);
  if (!policy) return;
  if (payload.stop_hook_active === true) return; // this is already a retry after our own block; do not loop
  const message = [payload.last_assistant_message, payload.prompt_response, payload.assistant_response]
    .find((value): value is string => typeof value === "string") || "";
  if (!message) return;
  const hits = lintViolations(message, policy.terms);
  if (!hits.length) return;
  const replacements = hits.map((hit) => `${hit.avoid} → ${hit.use}`).join("；");
  const reason = `localization-tw 違規：${replacements}；請修正整份回答後重新輸出。`;
  if (platform.toLowerCase() === "antigravity") output({ decision: "deny", reason });
  else output({ hookSpecificOutput: { hookEventName: "Stop", decision: "block", decisionReason: reason } });
}
