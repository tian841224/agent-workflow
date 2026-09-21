// Deterministic (no LLM) enforcement for the localization-tw policy. The hook reads the generated
// vocabulary policy so the terms stay single-sourced in the skill reference.
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { JsonObject, output, readJson } from "./core.js";

export type LocaleTerm = { avoid: string; use: string; exceptions: string[] };
export type LocalePolicy = { terms: LocaleTerm[] };

export function readLocalePolicy(root: string): LocalePolicy | undefined {
  const path = join(root, "runtime", "localization-tw-policy.json");
  if (!existsSync(path)) return undefined;
  const parsed = readJson(path);
  if (!Array.isArray(parsed.terms)) return undefined;
  return parsed as unknown as LocalePolicy;
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

// The vocabulary is injected at the start of every session so the terms are in context before the
// first reply instead of depending on the agent choosing to read the skill.
export function localeContext(terms: LocaleTerm[]): string {
  const pairs = terms.map((term) => `${term.avoid}→${term.use}${term.exceptions.length ? `（${term.exceptions.join("、")}除外）` : ""}`).join("、");
  return `localization-tw：所有中文回覆使用臺灣用語，下列中國用語不得出現，改用右側；Stop hook 會檢查。程式碼、指令、路徑與引用原文不受限，沒有自然臺灣譯名的技術詞彙保留英文。\n${pairs}`;
}

export function runLocaleContext(payload: JsonObject, root: string, platform = "Claude"): void {
  const policy = readLocalePolicy(root);
  const antigravity = platform.toLowerCase() === "antigravity";
  // Antigravity fires PreInvocation on every model invocation, not once per session.
  if (antigravity && payload.invocationNum !== 0) { output({ injectSteps: [] }); return; }
  if (!policy || !policy.terms.length) { if (antigravity) output({ injectSteps: [] }); return; }
  const context = localeContext(policy.terms);
  if (antigravity) output({ injectSteps: [{ ephemeralMessage: context }] });
  else output({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } });
}

const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

// Claude Code's Stop payload carries no assistant text, only transcript_path. Reading just the
// tail keeps a long session's transcript from being loaded on every reply.
export function lastAssistantText(transcriptPath: string): string {
  let text = "";
  try {
    const fd = openSync(transcriptPath, "r");
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      for (const line of buffer.toString("utf8").split(/\r?\n/)) {
        let entry: JsonObject;
        try { entry = JSON.parse(line) as JsonObject; } catch { continue; } // first line may be cut mid-record
        const content = (entry.message as JsonObject | undefined)?.content;
        if (entry.type !== "assistant" || !Array.isArray(content)) continue;
        const blocks = content.filter((block): block is JsonObject => !!block && typeof block === "object" && (block as JsonObject).type === "text" && typeof (block as JsonObject).text === "string");
        if (blocks.length) text = blocks.map((block) => String(block.text)).join("\n");
      }
    } finally { closeSync(fd); }
  } catch { return ""; }
  return text;
}

export function runLocaleLint(payload: JsonObject, root: string, platform = "Claude"): void {
  const policy = readLocalePolicy(root);
  if (!policy) return;
  if (payload.stop_hook_active === true) return; // this is already a retry after our own block; do not loop
  const message = [payload.last_assistant_message, payload.prompt_response, payload.assistant_response]
    .find((value): value is string => typeof value === "string")
    || (typeof payload.transcript_path === "string" ? lastAssistantText(payload.transcript_path) : "");
  if (!message) return;
  const hits = lintViolations(message, policy.terms);
  if (!hits.length) return;
  const replacements = hits.map((hit) => `${hit.avoid} → ${hit.use}`).join("；");
  const reason = `localization-tw 違規：${replacements}；請修正整份回答後重新輸出。`;
  if (platform.toLowerCase() === "antigravity") output({ decision: "deny", reason });
  else output({ decision: "block", reason });
}
