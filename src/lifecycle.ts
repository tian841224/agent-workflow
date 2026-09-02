import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { JsonObject, now, output, readJson, writeJson } from "./core.js";

type Transition = "create" | "freeze" | "pause" | "block" | "supersede" | "waive" | "close";
const allowed: Record<string, string[]> = {
  create: ["in_progress"], in_progress: ["frozen", "paused", "blocked", "superseded", "closed"], frozen: ["in_progress", "paused", "blocked", "superseded"], paused: ["in_progress", "blocked", "superseded"], blocked: ["in_progress", "paused", "superseded"], superseded: [], closed: []
};
function taskPath(value: string): string { return value.endsWith(".json") ? resolve(value) : join(resolve(value), "task.json"); }
function task(value: string): JsonObject { const path = taskPath(value); if (!existsSync(path)) throw new Error(`task state is missing: ${path}`); return readJson(path); }
function lifecycle(value: JsonObject): JsonObject { const current = value.lifecycle; if (!current || Array.isArray(current) || typeof current !== "object") throw new Error("task.json lifecycle is missing"); return current as JsonObject; }
export function transitionTask(value: string, action: Transition, actor = "cli", confirmation = ""): JsonObject {
  const path = taskPath(value); const state = task(path); const life = lifecycle(state); const from = String(life.status || "");
  const target: Record<Transition, string> = { create: "in_progress", freeze: "frozen", pause: "paused", block: "blocked", supersede: "superseded", waive: from, close: "closed" };
  if (action === "waive" && !confirmation) throw new Error("waiver requires explicit --confirmed-by-user");
  if (action !== "waive" && !(allowed[from] || []).includes(target[action])) throw new Error(`invalid TaskLifecycle transition: ${from} -> ${target[action]}`);
  const transitions = Array.isArray(life.transitions) ? life.transitions : [];
  transitions.push({ at: now(), action, from, to: target[action], actor, ...(action === "waive" ? { confirmed_by_user: confirmation } : {}) });
  life.status = target[action]; life.transitions = transitions; state.lifecycle = life;
  if (action === "waive") { const waivers = Array.isArray(state.waivers) ? state.waivers : []; waivers.push({ at: now(), actor, confirmed_by_user: confirmation }); state.waivers = waivers; }
  writeJson(path, state); return state;
}
export function taskGate(value: string): number {
  try { const state = task(value); const life = lifecycle(state); const evidence = Array.isArray(state.evidence) ? state.evidence : []; const errors: string[] = [];
    if (state.schema_version !== 1) errors.push("task.json schema_version must be 1");
    if (typeof state.id !== "string" || !state.id.trim()) errors.push("task.json requires id");
    if (typeof state.intent !== "string" || !state.intent.trim()) errors.push("task.json requires human intent");
    if (!["in_progress", "frozen", "paused", "blocked", "superseded", "closed"].includes(String(life.status))) errors.push("task lifecycle has an invalid status");
    if (!Array.isArray(life.transitions) || !life.transitions.length) errors.push("task lifecycle requires transition history");
    if (life.status === "closed") errors.push("task is already closed");
    if (evidence.some((item) => item && typeof item === "object" && (item as JsonObject).kind === "legacy-unverified")) errors.push("legacy-unverified evidence requires a new verification");
    const required = Array.isArray(state.required_evidence) ? state.required_evidence.map(String) : [];
    const passed = new Set(evidence.filter((item): item is JsonObject => !!item && !Array.isArray(item) && typeof item === "object").filter((item) => item.verified === true).map((item) => String(item.id || item.kind || "")));
    for (const key of required) if (!passed.has(key)) errors.push(`required evidence is not verified: ${key}`);
    output({ valid: errors.length === 0, task: taskPath(value), status: life.status, errors }); return errors.length ? 1 : 0;
  } catch (error) { output({ valid: false, errors: [String(error)] }); return 1; }
}
export function closeTask(value: string, actor: string, confirmation: string): number { if (taskGate(value)) return 1; transitionTask(value, "close", actor, confirmation); output({ valid: true, closed: taskPath(value) }); return 0; }
