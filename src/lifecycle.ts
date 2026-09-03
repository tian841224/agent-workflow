import { Ajv } from "ajv";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { JsonObject, mutateTask, now, output, projectIdentity, readJson, schemaPath, sha256, withFileLock, writeJson, workspaceFingerprint } from "./core.js";
import { memoryReviewPrompt } from "./memory-review.js";
import { compilePlanForTaskPath } from "./workflow-policy.js";

type Transition = "create" | "pause" | "block" | "supersede" | "waive" | "close";
const allowed: Record<string, string[]> = {
  create: ["in_progress"], in_progress: ["paused", "blocked", "superseded", "closed"], paused: ["in_progress", "blocked", "superseded"], blocked: ["in_progress", "paused", "superseded"], superseded: [], closed: []
};
const taskSchema = JSON.parse(readFileSync(schemaPath("task.schema.json"), "utf8")) as JsonObject;
const freezeRequired = new Set(((taskSchema.x_agent_workflow as JsonObject | undefined)?.freeze_required as string[] | undefined) || []);
// task.schema.json declares 2020-12; ajv's default export only ships the draft-07 meta-schema, and
// ajv/dist/2020 has no "exports" map entry for NodeNext to resolve statically, so pull it via require
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as unknown as typeof Ajv;
const ajv = new Ajv2020({ allErrors: true, strict: false }); // task.schema.json carries the non-standard x_agent_workflow annotation keyword
// ajv-formats ships only a CJS default export with no "exports" map, which NodeNext can't type as callable via a static import
(createRequire(import.meta.url)("ajv-formats") as (instance: Ajv) => void)(ajv);
const validateTask = ajv.compile(taskSchema);
function schemaErrors(state: JsonObject): string[] {
  return validateTask(state) ? [] : (validateTask.errors || []).map((error: { instancePath?: string; message?: string }) => `task.json${error.instancePath || ""} ${error.message}`.trim());
}
export function taskPath(value: string): string { return value.endsWith(".json") ? resolve(value) : join(resolve(value), "task.json"); }
function task(value: string): JsonObject { const path = taskPath(value); if (!existsSync(path)) throw new Error(`task state is missing: ${path}`); return readJson(path); }
function lifecycle(value: JsonObject): JsonObject { const current = value.lifecycle; if (!current || Array.isArray(current) || typeof current !== "object") throw new Error("task.json lifecycle is missing"); return current as JsonObject; }
// Shared by transitionTask and closeTask so both write through the exact same transition logic.
function applyTransition(state: JsonObject, path: string, action: Transition, actor: string, confirmation: string, requirementId: string): void {
  const life = lifecycle(state); const from = String(life.status || "");
  const target: Record<Transition, string> = { create: "in_progress", pause: "paused", block: "blocked", supersede: "superseded", waive: from, close: "closed" };
  if (action !== "waive" && !(allowed[from] || []).includes(target[action])) throw new Error(`invalid TaskLifecycle transition: ${from} -> ${target[action]}`);
  const transitions = Array.isArray(life.transitions) ? life.transitions : [];
  transitions.push({ at: now(), action, from, to: target[action], actor, ...(action === "waive" ? { confirmed_by_user: confirmation } : {}) });
  life.status = target[action]; life.transitions = transitions; state.lifecycle = life;
  if (state.plan_revision === undefined) state.plan_revision = 1; // transitionTask never edits classification fields itself; a future command that does must bump this
  if (action === "waive") {
    const waivers = Array.isArray(state.waivers) ? state.waivers : [];
    const plan = compilePlanForTaskPath(state, path);
    waivers.push({ at: now(), actor, confirmed_by_user: confirmation, ...(requirementId ? { requirement_id: requirementId } : {}), requirements_hash: plan.requirements_hash });
    state.waivers = waivers;
  }
}
export function transitionTask(value: string, action: Transition, actor = "cli", confirmation = "", requirementId = ""): JsonObject {
  const path = taskPath(value);
  if (!existsSync(path)) throw new Error(`task state is missing: ${path}`);
  if (action === "waive" && !confirmation) throw new Error("waiver requires explicit --confirmed-by-user");
  return mutateTask<JsonObject>(path, (state) => applyTransition(state, path, action, actor, confirmation, requirementId));
}
type GateResult = { valid: boolean; status: string; compiled: JsonObject; errors: string[] };
function evaluateTaskGate(state: JsonObject, path: string): GateResult {
  const life = lifecycle(state);
  const evidence = (Array.isArray(state.evidence) ? state.evidence : []).filter((item): item is JsonObject => !!item && !Array.isArray(item) && typeof item === "object");
  const errors: string[] = [...schemaErrors(state)];
  if (life.status === "closed") errors.push("task is already closed");
  const taskMd = join(dirname(path), "task.md");
  const taskMdBuffer = existsSync(taskMd) ? readFileSync(taskMd) : null;
  if (!taskMdBuffer || !taskMdBuffer.toString("utf8").trim()) errors.push("sibling task.md requires human intent (Goal/Scope/Completion criteria)");
  if (evidence.some((item) => item.kind === "legacy-unverified")) errors.push("legacy-unverified evidence requires a new verification");
  const riskFlags = Array.isArray(state.risk_flags) ? state.risk_flags.map(String) : [];
  if (riskFlags.some((flag) => freezeRequired.has(flag))) {
    const approval = state.intent_approval;
    if (!approval || Array.isArray(approval) || typeof approval !== "object") errors.push("intent_approval is required for a freeze-required risk flag but is missing");
    else if (!taskMdBuffer) errors.push("intent_approval cannot be verified: sibling task.md is missing");
    else if (String((approval as JsonObject).intent_sha256 || "") !== sha256(taskMdBuffer)) errors.push("intent_approval.intent_sha256 is stale: task.md has changed since approval");
  }
  const waivers = (Array.isArray(state.waivers) ? state.waivers : []).filter((item): item is JsonObject => !!item && !Array.isArray(item) && typeof item === "object");
  let compiled: JsonObject = {};
  try {
    const plan = compilePlanForTaskPath(state, path);
    compiled = { policy_version: plan.policy_version, requirements_hash: plan.requirements_hash, order: plan.order, required_evidence: plan.required_evidence };
    const waived = new Set(waivers.filter((item) => item.confirmed_by_user && String(item.requirements_hash || "") === plan.requirements_hash).map((item) => String(item.requirement_id || "")));
    const workspaceSha = workspaceFingerprint(projectIdentity(dirname(path)).root);
    for (const key of plan.required_evidence) {
      const item = evidence.find((entry) => String(entry.id || entry.kind || "") === key && entry.verified === true);
      if (!item) { if (!waived.has(key)) errors.push(`required evidence is not verified or waived: ${key}`); continue; }
      if (key.startsWith("role.") && String(item.workspace_sha256 || "") !== workspaceSha && !waived.has(key)) errors.push(`role evidence is stale (workspace changed since review), re-review required: ${key}`);
    }
  } catch (error) { errors.push(`workflow-plan compile failed: ${String((error as Error).message || error)}`); }
  return { valid: errors.length === 0, status: String(life.status), compiled, errors };
}
export function taskGate(value: string): number {
  try {
    const path = taskPath(value); const state = task(path);
    const gate = evaluateTaskGate(state, path);
    output({ valid: gate.valid, task: path, status: gate.status, compiled: gate.compiled, errors: gate.errors });
    return gate.valid ? 0 : 1;
  } catch (error) { output({ valid: false, errors: [String(error)] }); return 1; }
}
const CREATE_MANAGED_KEYS = new Set(["schema_version", "state_revision", "plan_revision", "created_at", "updated_at", "lifecycle", "waivers", "project_id", "worktree_id"]);
export function taskInit(value: string, patch: JsonObject, actor = "cli"): number {
  const path = taskPath(value);
  return withFileLock(`${path}.lock`, () => {
    if (existsSync(path)) { output({ valid: false, errors: [`task state already exists: ${path}`] }); return 1; }
    try {
      const blocked = Object.keys(patch).filter((key) => CREATE_MANAGED_KEYS.has(key));
      if (blocked.length) throw new Error(`task-init: field(s) are runtime-managed and cannot be set directly: ${blocked.join(", ")}`);
      const identity = projectIdentity(dirname(path));
      const stamp = now();
      const state: JsonObject = {
        schema_version: 3, id: basename(dirname(path)), project_id: identity.projectId, worktree_id: identity.worktreeId,
        code_change: false, risk_flags: [], created_at: stamp, updated_at: stamp, state_revision: 1, plan_revision: 1,
        lifecycle: { status: "in_progress", transitions: [{ at: stamp, action: "create", from: "new", to: "in_progress", actor }] },
        evidence: [], waivers: [],
        ...patch
      };
      const errors = schemaErrors(state);
      if (errors.length) throw new Error(`task-init: task.json fails schema: ${errors.join("; ")}`);
      writeJson(path, state);
      output({ valid: true, task: path });
      return 0;
    } catch (error) { output({ valid: false, errors: [String((error as Error).message || error)] }); return 1; }
  });
}
const WRITE_MANAGED_KEYS = new Set(["schema_version", "id", "project_id", "worktree_id", "state_revision", "plan_revision", "created_at", "updated_at", "lifecycle", "waivers"]);
const CLASSIFICATION_KEYS = new Set(["code_change", "workflow_mode", "task_type", "change_kind", "impact_scope", "impact_effect", "impact_confidence", "risk_flags", "workflow_facts", "workflow_request", "complexity_hint"]);
export function taskWrite(value: string, patch: JsonObject): number {
  const path = taskPath(value);
  if (!existsSync(path)) { output({ valid: false, errors: [`task state is missing: ${path}`] }); return 1; }
  try {
    const blocked = Object.keys(patch).filter((key) => WRITE_MANAGED_KEYS.has(key));
    if (blocked.length) throw new Error(`task-write: field(s) are runtime-managed and cannot be set directly: ${blocked.join(", ")} (use task-init / pause / block / supersede / waive / close-task instead)`);
    const state = mutateTask<JsonObject>(path, (current) => {
      for (const [key, fieldValue] of Object.entries(patch)) current[key] = fieldValue;
      current.updated_at = now();
      if (Object.keys(patch).some((key) => CLASSIFICATION_KEYS.has(key))) current.plan_revision = Number(current.plan_revision || 0) + 1;
      const errors = schemaErrors(current);
      if (errors.length) throw new Error(`task-write: resulting task.json fails schema: ${errors.join("; ")}`);
    });
    output({ valid: true, task: path, state_revision: state.state_revision, plan_revision: state.plan_revision });
    return 0;
  } catch (error) { output({ valid: false, errors: [String((error as Error).message || error)] }); return 1; }
}
export function closeTask(value: string, actor: string, confirmation: string, stateRootValue?: string): number {
  const path = taskPath(value);
  if (!existsSync(path)) { output({ valid: false, errors: [`task state is missing: ${path}`] }); return 1; }
  const outcome = withFileLock<{ code: number; body: JsonObject }>(`${path}.lock`, () => {
    const state = readJson(path) as JsonObject;
    const gate = evaluateTaskGate(state, path);
    if (!gate.valid) return { code: 1, body: { valid: false, task: path, status: gate.status, compiled: gate.compiled, errors: gate.errors } as JsonObject };
    applyTransition(state, path, "close", actor, confirmation, "");
    state.state_revision = Number(state.state_revision || 0) + 1;
    writeJson(path, state);
    return { code: 0, body: { valid: true, closed: path, memory_review: memoryReviewPrompt(stateRootValue) } as JsonObject };
  });
  output(outcome.body);
  return outcome.code;
}
