import { Ajv } from "ajv";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { changedPaths, diffFingerprint, JsonObject, mutateTask, now, output, projectIdentity, readJson, schemaPath, sha256, withFileLock, writeJson } from "./core.js";
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
    // A typo would otherwise record a waiver the gate can never match, leaving the user believing a
    // requirement was waived while it silently still blocks.
    if (!plan.required_evidence.includes(requirementId)) throw new Error(`waive: '${requirementId}' is not a required evidence id for this task; expected one of: ${plan.required_evidence.join(", ") || "(none)"}`);
    waivers.push({ at: now(), actor, confirmed_by_user: confirmation, requirement_id: requirementId, requirements_hash: plan.requirements_hash });
    state.waivers = waivers;
  }
  // Every write path funnels through here, so validating once here keeps task.schema.json the only
  // place that decides what a valid task.json is. Abandoning a task is the one exception: a state
  // written by an older runtime must still be closable out, or it can never be retired.
  const errors = action === "supersede" ? [] : schemaErrors(state);
  if (errors.length) throw new Error(`${action}: resulting task.json fails schema: ${errors.join("; ")}`);
}
export function transitionTask(value: string, action: Transition, actor = "cli", confirmation = "", requirementId = ""): JsonObject {
  const path = taskPath(value);
  if (!existsSync(path)) throw new Error(`task state is missing: ${path}`);
  if (action === "waive" && !confirmation) throw new Error("waiver requires explicit --confirmed-by-user");
  if (action === "waive" && !requirementId) throw new Error("waiver requires --requirement-id naming the requirement being waived");
  return mutateTask<JsonObject>(path, (state) => applyTransition(state, path, action, actor, confirmation, requirementId));
}
// The newest entry wins outright: an older PASS must never mask a later FAIL for the same
// requirement, which a "first verified entry" lookup would happily do.
function latestEvidence(evidence: JsonObject[], key: string): JsonObject | undefined {
  const matches = evidence.filter((entry) => String(entry.id || entry.kind || "") === key);
  // Parsed, not compared as strings: an RFC 3339 offset timestamp sorts wrong lexicographically, so
  // "2026-01-01T09:00:00+08:00" would beat the later "2026-01-01T05:00:00Z".
  const instant = (entry: JsonObject): number => { const parsed = Date.parse(String(entry.at || "")); return Number.isNaN(parsed) ? -Infinity : parsed; };
  return matches.length ? matches.reduce((best, entry) => instant(entry) >= instant(best) ? entry : best) : undefined;
}
const covers = (scopes: string[], path: string): boolean => scopes.some((scope) => path === scope || path.startsWith(scope.replace(/\/?$/, "/")));
// Declaring file_ownership declares a boundary, so a delivery that reaches outside it is a
// violation in its own right — never something diff-scoped review is allowed to filter away. The
// baseline is base_commit when the task records one, else the base a role review was taken against.
function ownershipErrors(state: JsonObject, repoRoot: string, evidence: JsonObject[]): string[] {
  const ownership = Array.isArray(state.file_ownership) ? state.file_ownership.map(String) : [];
  if (!ownership.length) return [];
  const base = String(state.base_commit || evidence.find((item) => typeof item.reviewed_base === "string")?.reviewed_base || "");
  if (!base) return ["file_ownership is declared but the task records no base_commit to measure the delivery against"];
  try {
    const outside = changedPaths(repoRoot, base).filter((changed) => !covers(ownership, changed));
    if (outside.length) return [`ownership violation: ${outside.slice(0, 5).join(", ")}${outside.length > 5 ? `, +${outside.length - 5} more` : ""} changed outside file_ownership (${ownership.join(", ")})`];
  } catch (error) { return [`ownership cannot be checked: ${String((error as Error).message || error)}`]; }
  return [];
}
// Role evidence goes stale only when the diff it actually reviewed changes, or when the task's
// classification moved under it — not when some unrelated file elsewhere in the repo is touched.
function roleFreshnessErrors(item: JsonObject, key: string, repoRoot: string, state: JsonObject): string[] {
  if (Number(item.plan_revision || 0) !== Number(state.plan_revision || 0)) return [`role evidence predates the current plan revision, re-review required: ${key}`];
  const paths = Array.isArray(item.reviewed_paths) ? item.reviewed_paths.map(String) : [];
  const base = String(item.reviewed_base || "");
  try {
    // A digest over a scope the reviewer chose freely proves nothing on its own: pointing
    // reviewed_paths at an untouched file yields a constant digest that never goes stale, so the
    // review has to cover every path this task delivers. Nothing is filtered out by ownership here —
    // a change outside file_ownership is an ownership violation reported by the gate itself, never a
    // path the reviewer is allowed to ignore.
    const uncovered = changedPaths(repoRoot, base).filter((changed) => !covers(paths, changed));
    if (uncovered.length) return [`role evidence does not cover every changed path (${uncovered.slice(0, 3).join(", ")}${uncovered.length > 3 ? `, +${uncovered.length - 3} more` : ""}), re-review required: ${key}`];
    if (diffFingerprint(repoRoot, base, paths) !== String(item.reviewed_diff_sha256 || "")) return [`role evidence is stale (reviewed diff changed since review), re-review required: ${key}`];
  } catch (error) { return [`role evidence freshness cannot be recomputed for ${key}: ${String((error as Error).message || error)}`]; }
  return [];
}
type GateResult = { valid: boolean; status: string; compiled: JsonObject; errors: string[] };
function evaluateTaskGate(state: JsonObject, path: string, repoRootValue: string): GateResult {
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
    compiled = { policy_version: plan.policy_version, requirements_hash: plan.requirements_hash, required: plan.required, classification_incomplete: plan.classification_incomplete as unknown as JsonObject[], order: plan.order, required_evidence: plan.required_evidence };
    // Only a code task owes an impact classification: a read-only or docs task never reaches the
    // capabilities these fields gate, so demanding them would leave it with no way to close.
    if (state.code_change === true) for (const entry of plan.classification_incomplete) errors.push(`workflow classification is incomplete: ${String(entry.name)} cannot be decided until ${(entry.missing as string[]).join(", ")} is declared`);
    const waived = new Set(waivers.filter((item) => item.confirmed_by_user && String(item.requirements_hash || "") === plan.requirements_hash).map((item) => String(item.requirement_id || "")));
    // The task directory normally lives in the state root, not in the repo, so the worktree to
    // fingerprint has to come from the caller's location rather than from the task's own path.
    const repoRoot = projectIdentity(repoRootValue || dirname(path)).root;
    errors.push(...ownershipErrors(state, repoRoot, evidence));
    for (const key of plan.required_evidence) {
      if (waived.has(key)) continue;
      const item = latestEvidence(evidence, key);
      if (!item || item.verified !== true) { errors.push(`required evidence is not verified or waived: ${key}`); continue; }
      if (String(item.requirements_hash || "") !== plan.requirements_hash) { errors.push(`evidence was recorded against a different plan, re-verification required: ${key}`); continue; }
      if (key.startsWith("role.")) errors.push(...roleFreshnessErrors(item, key, repoRoot, state));
    }
  } catch (error) { errors.push(`workflow-plan compile failed: ${String((error as Error).message || error)}`); }
  return { valid: errors.length === 0, status: String(life.status), compiled, errors };
}
export function taskGate(value: string, repoRoot = process.cwd()): number {
  try {
    const path = taskPath(value); const state = task(path);
    const gate = evaluateTaskGate(state, path, repoRoot);
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
const CLASSIFICATION_KEYS = new Set(["code_change", "workflow_mode", "task_type", "impact_scope", "impact_effect", "impact_confidence", "risk_flags", "workflow_facts", "workflow_request"]);
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
export function closeTask(value: string, actor: string, confirmation: string, stateRootValue?: string, repoRoot = process.cwd()): number {
  const path = taskPath(value);
  if (!existsSync(path)) { output({ valid: false, errors: [`task state is missing: ${path}`] }); return 1; }
  const outcome = withFileLock<{ code: number; body: JsonObject }>(`${path}.lock`, () => {
    const state = readJson(path) as JsonObject;
    const gate = evaluateTaskGate(state, path, repoRoot);
    if (!gate.valid) return { code: 1, body: { valid: false, task: path, status: gate.status, compiled: gate.compiled, errors: gate.errors } as JsonObject };
    applyTransition(state, path, "close", actor, confirmation, "");
    state.state_revision = Number(state.state_revision || 0) + 1;
    writeJson(path, state);
    return { code: 0, body: { valid: true, closed: path, memory_review: memoryReviewPrompt(stateRootValue) } as JsonObject };
  });
  output(outcome.body);
  return outcome.code;
}
