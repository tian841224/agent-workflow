import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { JsonObject, readJson } from "../core.js";

export function taskPath(value: string): string { return value.endsWith(".json") ? resolve(value) : join(resolve(value), "task.json"); }
export function task(value: string): JsonObject { const path = taskPath(value); if (!existsSync(path)) throw new Error(`task state is missing: ${path}`); return readJson(path); }
export function lifecycleOf(value: JsonObject): JsonObject { const current = value.lifecycle; if (!current || Array.isArray(current) || typeof current !== "object") throw new Error("task.json lifecycle is missing"); return current as JsonObject; }

// closed and superseded are dead ends in the transition table: nothing moves a task out of them, so
// anything written afterwards can never be gated, reviewed or closed again — it would sit in the
// record looking authoritative while belonging to a task that is over.
export const TERMINAL_STATUSES = ["closed", "superseded"];
// task-write and reclassify only revise what the task claims about itself, which a paused or blocked
// task must still be able to do — that is often exactly why it is blocked.
export const OPEN_STATUSES = ["in_progress", "paused", "blocked"];
// Validation writes are narrower: evidence, reviews, waivers and intent approval all assert
// something about work that is happening now, so a paused or blocked task has to resume first
// rather than accumulate proof about a state nobody is maintaining.
export const RUNNING_STATUSES = ["in_progress"];
// Every mutating command funnels through this instead of re-deriving the rule, so a new write path
// cannot quietly become the one that still accepts a closed task.
export function assertMutable(state: JsonObject, command: string, statuses: readonly string[]): void {
  const status = String(lifecycleOf(state).status || "");
  if (statuses.includes(status)) return;
  if (TERMINAL_STATUSES.includes(status)) throw new Error(`${command}: task is ${status}; a terminal task can no longer be modified — create a new task instead`);
  throw new Error(`${command}: task is ${status}; run 'agent-workflow resume --task <path>' before ${command}`);
}
