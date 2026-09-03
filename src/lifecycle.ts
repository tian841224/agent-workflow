import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { JsonObject, now, output, readJson, schemaPath, writeJson } from "./core.js";
import { memoryReviewPrompt } from "./memory-review.js";
import { compileWorkflowPlan, loadPolicy } from "./workflow-policy.js";

type Transition = "create" | "freeze" | "pause" | "block" | "supersede" | "waive" | "close";
const allowed: Record<string, string[]> = {
  create: ["in_progress"], in_progress: ["frozen", "paused", "blocked", "superseded", "closed"], frozen: ["in_progress", "paused", "blocked", "superseded"], paused: ["in_progress", "blocked", "superseded"], blocked: ["in_progress", "paused", "superseded"], superseded: [], closed: []
};
export function taskPath(value: string): string { return value.endsWith(".json") ? resolve(value) : join(resolve(value), "task.json"); }
function task(value: string): JsonObject { const path = taskPath(value); if (!existsSync(path)) throw new Error(`task state is missing: ${path}`); return readJson(path); }
function lifecycle(value: JsonObject): JsonObject { const current = value.lifecycle; if (!current || Array.isArray(current) || typeof current !== "object") throw new Error("task.json lifecycle is missing"); return current as JsonObject; }
export function transitionTask(value: string, action: Transition, actor = "cli", confirmation = "", requirementId = ""): JsonObject {
  const path = taskPath(value); const state = task(path); const life = lifecycle(state); const from = String(life.status || "");
  const target: Record<Transition, string> = { create: "in_progress", freeze: "frozen", pause: "paused", block: "blocked", supersede: "superseded", waive: from, close: "closed" };
  if (action === "waive" && !confirmation) throw new Error("waiver requires explicit --confirmed-by-user");
  if (action !== "waive" && !(allowed[from] || []).includes(target[action])) throw new Error(`invalid TaskLifecycle transition: ${from} -> ${target[action]}`);
  const transitions = Array.isArray(life.transitions) ? life.transitions : [];
  transitions.push({ at: now(), action, from, to: target[action], actor, ...(action === "waive" ? { confirmed_by_user: confirmation } : {}) });
  life.status = target[action]; life.transitions = transitions; state.lifecycle = life;
  if (action === "waive") { const waivers = Array.isArray(state.waivers) ? state.waivers : []; waivers.push({ at: now(), actor, confirmed_by_user: confirmation, ...(requirementId ? { requirement_id: requirementId } : {}) }); state.waivers = waivers; }
  writeJson(path, state); return state;
}
export function taskGate(value: string): number {
  try { const path = taskPath(value); const state = task(path); const life = lifecycle(state); const evidence = Array.isArray(state.evidence) ? state.evidence : []; const errors: string[] = [];
    if (state.schema_version !== 2) errors.push("task.json schema_version must be 2");
    if (typeof state.id !== "string" || !state.id.trim()) errors.push("task.json requires id");
    const taskMd = join(dirname(path), "task.md");
    if (!existsSync(taskMd) || !readFileSync(taskMd, "utf8").trim()) errors.push("sibling task.md requires human intent (Goal/Scope/Completion criteria)");
    if (!["in_progress", "frozen", "paused", "blocked", "superseded", "closed"].includes(String(life.status))) errors.push("task lifecycle has an invalid status");
    if (!Array.isArray(life.transitions) || !life.transitions.length) errors.push("task lifecycle requires transition history");
    if (life.status === "closed") errors.push("task is already closed");
    if (evidence.some((item) => item && typeof item === "object" && (item as JsonObject).kind === "legacy-unverified")) errors.push("legacy-unverified evidence requires a new verification");
    const waivers = Array.isArray(state.waivers) ? state.waivers.filter((item): item is JsonObject => !!item && !Array.isArray(item) && typeof item === "object") : [];
    const waived = new Set(waivers.filter((item) => item.confirmed_by_user).map((item) => String(item.requirement_id || "")));
    const passed = new Set(evidence.filter((item): item is JsonObject => !!item && !Array.isArray(item) && typeof item === "object").filter((item) => item.verified === true).map((item) => String(item.id || item.kind || "")));
    let required: string[] = []; let compiled: JsonObject = {};
    try {
      const plan = compileWorkflowPlan(state, loadPolicy(schemaPath("workflow-policy.json")));
      required = plan.required_evidence; compiled = { policy_version: plan.policy_version, requirements_hash: plan.requirements_hash, order: plan.order, required_evidence: plan.required_evidence };
      state.compiled = compiled; writeJson(path, state);
    } catch (error) { errors.push(`workflow-plan compile failed: ${String((error as Error).message || error)}`); }
    for (const key of required) if (!passed.has(key) && !waived.has(key)) errors.push(`required evidence is not verified or waived: ${key}`);
    output({ valid: errors.length === 0, task: path, status: life.status, compiled, errors }); return errors.length ? 1 : 0;
  } catch (error) { output({ valid: false, errors: [String(error)] }); return 1; }
}
export function closeTask(value: string, actor: string, confirmation: string, stateRootValue?: string): number { if (taskGate(value)) return 1; transitionTask(value, "close", actor, confirmation); output({ valid: true, closed: taskPath(value), memory_review: memoryReviewPrompt(stateRootValue) }); return 0; }
