import { existsSync } from "node:fs";
import { join } from "node:path";
import { JsonObject, now, output, readJson, stateRoot, writeJson } from "./core.js";

type Decision = "run" | "skip";
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function path(root: string): string { return join(root, "memory-review.json"); }
function readState(root: string): JsonObject { const file = path(root); return existsSync(file) ? readJson(file) : { schema_version: 1 }; }
function timestamp(value: Json | undefined): number { const parsed = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : 0; }
function status(root: string, at = Date.now()): JsonObject {
  const state = readState(root); const lastPrompt = timestamp(state.last_prompt_at); const lastReview = timestamp(state.last_review_at); const reference = Math.max(lastPrompt, lastReview);
  return { due: reference === 0 || at - reference >= 7 * 24 * 60 * 60 * 1000, last_prompt_at: state.last_prompt_at || null, last_review_at: state.last_review_at || null, last_decision: state.last_decision || null };
}
function saveDecision(root: string, decision: Decision, reviewed: boolean): JsonObject {
  const state = readState(root); const at = now(); state.last_decision = decision; state.last_decision_at = at; if (reviewed) state.last_review_at = at; writeJson(path(root), state); return status(root);
}

export function memoryReviewPrompt(rootValue?: string): JsonObject {
  const root = stateRoot(rootValue); const current = status(root);
  if (!current.due) return { due: false, prompted: false, last_prompt_at: current.last_prompt_at || null, last_review_at: current.last_review_at || null };
  const state = readState(root); state.last_prompt_at = now(); state.last_decision = "pending"; writeJson(path(root), state);
  return { due: true, prompted: true, question: "本週要執行記憶檢視嗎？請回答 yes 或 no。", command: "npm run memory-review" };
}

export function memoryReview(options: Map<string, string | boolean | string[]>): number {
  const root = stateRoot(typeof options.get("state-root") === "string" ? options.get("state-root") as string : undefined);
  const action = typeof options.get("action") === "string" ? options.get("action") as string : "Check";
  if (action === "Check") { output({ action, ...status(root) }); return 0; }
  if (action === "Prompt") { output({ action, ...memoryReviewPrompt(root) }); return 0; }
  if (action === "Decision") {
    const value = options.get("decision");
    if (value !== "yes" && value !== "no") throw new Error("Decision requires --decision yes or --decision no");
    output({ action, ...saveDecision(root, value === "yes" ? "run" : "skip", false), next: value === "yes" ? "run npm run memory-review, then mark Reviewed" : "wait until the next weekly task completion" }); return 0;
  }
  if (action === "Reviewed") { output({ action, ...saveDecision(root, "run", true) }); return 0; }
  throw new Error(`unsupported memory review action: ${action}`);
}
