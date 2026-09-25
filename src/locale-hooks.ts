// Puts the localization-tw vocabulary in front of the model before it writes. The hook reads the
// generated vocabulary policy so the terms stay single-sourced in the skill reference.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { JsonObject, output, readJson } from "./core.js";

export type LocaleTerm = { avoid: string; use: string; exceptions: string[] };
export type LocalePolicy = { rules?: string[]; terms: LocaleTerm[] };

export function readLocalePolicy(root: string): LocalePolicy | undefined {
  const path = join(root, "runtime", "localization-tw-policy.json");
  if (!existsSync(path)) return undefined;
  const parsed = readJson(path);
  if (!Array.isArray(parsed.terms)) return undefined;
  return parsed as unknown as LocalePolicy;
}

// The skill's core rules and vocabulary, injected with every submitted prompt so the model has read
// them right before it writes. There is no after-reply check: a reply is already on screen by then,
// and correcting it only repeats it.
export function localeContext(policy: LocalePolicy): string {
  const rules = (policy.rules || []).map((rule) => `- ${rule}`).join("\n");
  const pairs = policy.terms.map((term) => `${term.avoid}→${term.use}${term.exceptions.length ? `（${term.exceptions.join("、")}除外）` : ""}`).join("、");
  return `localization-tw skill（輸出任何中文前先讀完，並照此撰寫）：\n${rules ? `${rules}\n` : ""}- 下列中國用語一律改用右側的臺灣用語：${pairs}`;
}

export function runLocaleContext(payload: JsonObject, root: string, platform = "Claude"): void {
  const policy = readLocalePolicy(root);
  const antigravity = platform.toLowerCase() === "antigravity";
  // Antigravity fires PreInvocation on every model invocation, not once per session.
  if (antigravity && payload.invocationNum !== 0) { output({ injectSteps: [] }); return; }
  if (!policy || !policy.terms.length) { if (antigravity) output({ injectSteps: [] }); return; }
  const context = localeContext(policy);
  if (antigravity) output({ injectSteps: [{ ephemeralMessage: context }] });
  else output({ hookSpecificOutput: { hookEventName: typeof payload.hook_event_name === "string" ? payload.hook_event_name : "UserPromptSubmit", additionalContext: context } });
}
