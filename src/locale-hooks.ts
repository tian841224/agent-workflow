// Puts the localization-tw vocabulary in front of the model before it writes. The hook reads the
// generated vocabulary policy so the terms stay single-sourced in the skill reference.
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Json, JsonObject, output, readJson, sha256 } from "./core.js";

export type LocaleTerm = { avoid: string; use: string; exceptions: string[] };
export type LocalePolicy = { rules?: string[]; terms: LocaleTerm[] };

export function readLocalePolicy(root: string): LocalePolicy | undefined {
  const path = join(root, "runtime", "localization-tw-policy.json");
  if (!existsSync(path)) return undefined;
  const parsed = readJson(path);
  if (!Array.isArray(parsed.terms)) return undefined;
  return parsed as unknown as LocalePolicy;
}

// The vocabulary is injected with every submitted prompt so it sits right before the reply; the core
// rules ride along only when includeRules is set. There is no after-reply check: a reply is already
// on screen by then, and correcting it only repeats it.
export function localeContext(policy: LocalePolicy, includeRules = true): string {
  const rules = includeRules ? (policy.rules || []).map((rule) => `- ${rule}`).join("\n") : "";
  const pairs = policy.terms.map((term) => `${term.avoid}→${term.use}${term.exceptions.length ? `（${term.exceptions.join("、")}除外）` : ""}`).join("、");
  return `localization-tw skill（輸出任何中文前先讀完，並照此撰寫）：\n${rules ? `${rules}\n` : ""}- 下列中國用語一律改用右側的臺灣用語：${pairs}`;
}

// The core rules stay in the transcript once injected, so a session receives them a single time.
// Returns true when this call should carry them: the first call of a session, a payload without a
// session id, or a marker that could not be written (repeating the rules beats losing them).
function firstInjectionOfSession(sessionId: Json | undefined): boolean {
  if (typeof sessionId !== "string" || !sessionId) return true;
  const marker = join(tmpdir(), `agent-workflow-locale-${sha256(sessionId).slice(0, 16)}`);
  if (existsSync(marker)) return false;
  try { writeFileSync(marker, ""); } catch { return true; }
  return true;
}

export function runLocaleContext(payload: JsonObject, root: string, platform = "Claude"): void {
  const policy = readLocalePolicy(root);
  const antigravity = platform.toLowerCase() === "antigravity";
  // Antigravity fires PreInvocation on every model invocation, not once per session.
  if (antigravity && payload.invocationNum !== 0) { output({ injectSteps: [] }); return; }
  if (!policy || !policy.terms.length) { if (antigravity) output({ injectSteps: [] }); return; }
  const context = localeContext(policy, antigravity || firstInjectionOfSession(payload.session_id));
  if (antigravity) output({ injectSteps: [{ ephemeralMessage: context }] });
  else output({ hookSpecificOutput: { hookEventName: typeof payload.hook_event_name === "string" ? payload.hook_event_name : "UserPromptSubmit", additionalContext: context } });
}
