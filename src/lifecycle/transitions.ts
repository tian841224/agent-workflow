import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { JsonObject, mutateJsonState, now, output, projectIdentity, readJson, stateRoot, withFileLock, writeJson } from "../core.js";
import { deriveModelProfile } from "../classification/model-profile.js";
import { intentHash } from "../intent.js";
import { memoryReviewPrompt } from "../memory-review.js";
import { compilePlanForTaskPath, planOutput } from "../workflow-policy.js";
import { resolveProcedures } from "../execution/execution-packet.js";
import { evaluateTaskGate } from "./task-gate.js";
import { schemaErrors } from "./task-schema.js";
import { assertMutable, lifecycleOf, OPEN_STATUSES, RUNNING_STATUSES, task, taskPath } from "./task-store.js";
import { activateCodeTask, worktreeLeasePath, writeLease } from "./worktree-lease.js";

type Transition = "create" | "pause" | "block" | "resume" | "supersede" | "waive" | "close";
const allowed: Record<string, string[]> = {
  create: ["in_progress"], in_progress: ["paused", "blocked", "superseded", "closed"], paused: ["in_progress", "blocked", "superseded"], blocked: ["in_progress", "paused", "superseded"], superseded: [], closed: []
};

// Shared by transitionTask and closeTask so both write through the exact same transition logic.
function applyTransition(state: JsonObject, path: string, action: Transition, actor: string, confirmation: string, requirementId: string): void {
  const life = lifecycleOf(state); const from = String(life.status || "");
  const target: Record<Transition, string> = { create: "in_progress", pause: "paused", block: "blocked", resume: "in_progress", supersede: "superseded", waive: from, close: "closed" };
  // waive deliberately keeps the current status, so the transition table cannot reject it: without
  // this check a closed or superseded task could still accumulate waivers.
  if (action === "waive") assertMutable(state, "waive", RUNNING_STATUSES);
  else if (!(allowed[from] || []).includes(target[action])) throw new Error(`invalid TaskLifecycle transition: ${from} -> ${target[action]}`);
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
    const taskMd = join(dirname(path), "task.md");
    if (!existsSync(taskMd)) throw new Error("waive: sibling task.md is missing; cannot determine intent_hash");
    const intent_hash = intentHash(readFileSync(taskMd, "utf8"));
    // plan_revision alongside plan_hash for the same reason step evidence records both: plan_hash is
    // a pure function of the classification, so moving it away and back restores the old value and
    // would revive a waiver the user granted against a plan that no longer exists.
    waivers.push({ at: now(), actor, confirmed_by_user: confirmation, requirement_id: requirementId, plan_hash: plan.plan_hash, plan_revision: Number(state.plan_revision || 1), intent_hash });
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
  return mutateJsonState<JsonObject>(path, (state) => applyTransition(state, path, action, actor, confirmation, requirementId));
}

// Allowlist rather than a blocklist of runtime-managed keys: an unrecognized field (including any
// future task.schema.json addition) is rejected by default instead of silently passing through.
const TASK_INIT_WRITABLE_FIELDS = new Set([
  "code_change", "managed_change", "workflow_mode", "task_type",
  "impact_scope", "impact_effect", "impact_confidence", "validation_profile", "risk_flags",
  "workflow_facts", "workflow_request", "workflow_decision",
  "project_docs",
  "independence", "subtask_role", "parent_task_id", "file_ownership",
  "delivery_status", "integration_status"
]);
function assertProjectDocsUpdateOnly(patch: JsonObject, command: string): void {
  const projectDocsPatch = patch.project_docs;
  if (!projectDocsPatch || typeof projectDocsPatch !== "object" || Array.isArray(projectDocsPatch)) return;
  const disallowed = Object.keys(projectDocsPatch).filter((key) => key !== "updated");
  if (disallowed.length) throw new Error(`${command}: project_docs.${disallowed.join("/project_docs.")} is managed by project-doc Remember; ${command} may update only project_docs.updated`);
}
export function taskInit(value: string, patch: JsonObject, actor = "cli", stateRootValue?: string, repoRootValue = process.cwd(), adoptCurrentDiff = false): number {
  const path = taskPath(value);
  return withFileLock(`${path}.lock`, () => {
    if (existsSync(path)) { output({ valid: false, errors: [`task state already exists: ${path}`] }); return 1; }
    try {
      const disallowed = Object.keys(patch).filter((key) => !TASK_INIT_WRITABLE_FIELDS.has(key));
      if (disallowed.length) throw new Error(`task-init: field(s) are not writable via task-init: ${disallowed.join(", ")} (identity/evidence/intent_approval/model_profile/lifecycle are runtime-managed)`);
      assertProjectDocsUpdateOnly(patch, "task-init");
      // Task identity always comes from the real repository being worked in (repoRootValue), never
      // from the task directory itself — that directory normally lives in the state root, not the
      // repo, so hashing it would produce a project_id/worktree_id no gate or lease could match.
      const identity = projectIdentity(repoRootValue);
      const taskId = basename(dirname(path));
      const codeChange = patch.code_change === true;
      const root = stateRoot(stateRootValue);
      // The conflict check and the lease write must be indivisible from every other task's
      // create/activate, or two tasks racing on the same worktree can both pass
      // activeLeaseConflict before either writes its lease. This lock is keyed by worktree, not
      // by task.json path, so it actually serializes against a concurrent task in a different
      // task.json (the outer `${path}.lock` above only serializes against itself).
      const createTask = (): JsonObject => {
        const baseCommit = codeChange ? activateCodeTask("task-init", taskId, root, identity, repoRootValue, adoptCurrentDiff, path) : undefined;
        const stamp = now();
        const state: JsonObject = {
          schema_version: 4, id: taskId, project_id: identity.projectId, worktree_id: identity.worktreeId,
          code_change: false, managed_change: false, risk_flags: [], created_at: stamp, updated_at: stamp, state_revision: 1, plan_revision: 1,
          lifecycle: { status: "in_progress", transitions: [{ at: stamp, action: "create", from: "new", to: "in_progress", actor }] },
          evidence: [], waivers: [],
          ...(baseCommit ? { base_commit: baseCommit } : {}),
          ...patch
        };
        if (state.task_type === "read_only") state.model_profile = deriveModelProfile(state);
        const errors = schemaErrors(state);
        if (errors.length) throw new Error(`task-init: task.json fails schema: ${errors.join("; ")}`);
        writeJson(path, state);
        if (codeChange) writeLease(root, identity.worktreeId, taskId, path);
        return state;
      };
      const created = codeChange ? withFileLock(`${worktreeLeasePath(root, identity.worktreeId)}.lock`, createTask) : createTask();
      const plan = compilePlanForTaskPath(created, path);
      output({ valid: true, task: path, plan: planOutput(plan), procedures: resolveProcedures(plan, created) });
      return 0;
    } catch (error) { output({ valid: false, errors: [String((error as Error).message || error)] }); return 1; }
  });
}
// The two classification moves that quietly shrink what the gate can demand. Each is legitimate
// after a real re-assessment, which is why `reclassify` exists — but never as a silent task-write.
// impact_confidence is deliberately not one of them: lowering it raises what the gate demands
// (medium/low requires impact_discovery), so it is the agent's own analysis state to revise freely
// rather than an authorization the user has to re-grant.
function downgradeErrors(before: JsonObject, patch: JsonObject): string[] {
  const errors: string[] = [];
  if (before.managed_change === true && patch.managed_change === false) errors.push("managed_change cannot transition from true back to false");
  if (Array.isArray(patch.risk_flags)) {
    const next = patch.risk_flags.map(String);
    const dropped = (Array.isArray(before.risk_flags) ? before.risk_flags.map(String) : []).filter((flag) => !next.includes(flag));
    if (dropped.length) errors.push(`risk_flags cannot be removed: ${dropped.join(", ")}`);
  }
  return errors;
}

const TASK_WRITABLE_FIELDS = new Set(["code_change", "managed_change", "task_type", "impact_scope", "impact_effect", "impact_confidence", "validation_profile", "risk_flags", "workflow_facts", "workflow_request", "workflow_decision", "project_docs", "independence"]);
const CLASSIFICATION_KEYS = new Set(["code_change", "managed_change", "task_type", "impact_scope", "impact_effect", "impact_confidence", "risk_flags", "workflow_facts", "workflow_request"]);
export function taskWrite(value: string, patch: JsonObject, stateRootValue?: string, repoRootValue = process.cwd(), adoptCurrentDiff = false, reclassification?: { confirmedByUser: string; reason: string; actor: string }, emitOutput = true, allowProjectDocEvidence = false): number {
  const path = taskPath(value);
  if (!existsSync(path)) { output({ valid: false, errors: [`task state is missing: ${path}`] }); return 1; }
  try {
    const disallowed = Object.keys(patch).filter((key) => !TASK_WRITABLE_FIELDS.has(key));
    if (disallowed.length) throw new Error(`task-write: field(s) are not writable via task-write: ${disallowed.join(", ")} (evidence/intent_approval/lifecycle/base_commit/file_ownership/hashes are runtime-managed — use task-init / approve-intent / evidence-record / review-record / pause / block / resume / supersede / waive / close-task instead)`);
    // Only project-doc Remember may replace read/digest evidence; ordinary task-write merges updated paths.
    if (!allowProjectDocEvidence) assertProjectDocsUpdateOnly(patch, "task-write");
    const before = task(path);
    const classificationTouched = Object.keys(patch).some((key) => CLASSIFICATION_KEYS.has(key));
    // Only used to decide whether activation needs to run at all; the actual downgrade/code_change
    // authorization check below re-reads state inside the task lock, since this pre-lock read can be
    // stale under concurrent writers (see the in-lock checks in applyWrite).
    // Also re-runs activation for a task that is already code_change: true but predates base_commit
    // tracking (created by an older runtime) — the gate now requires base_commit on every code task,
    // and re-sending code_change: true is the only writable signal left to backfill one.
    const activating = patch.code_change === true && (before.code_change !== true || !String(before.base_commit || ""));
    const root = activating ? stateRoot(stateRootValue) : undefined;
    const identity = activating ? projectIdentity(repoRootValue) : undefined;
    // Same worktree-keyed lock as task-init: without it, two task-write calls activating
    // different tasks against the same worktree can both pass the conflict check before either
    // lease write lands, letting both end up "active" at once.
    let postPatchPlan: ReturnType<typeof compilePlanForTaskPath> | undefined;
    const applyWrite = (): JsonObject => {
      const baseCommit = root && identity ? activateCodeTask("task-write", String(before.id || ""), root, identity, repoRootValue, adoptCurrentDiff, path) : undefined;
      const state = mutateJsonState<JsonObject>(path, (current) => {
        // Checked against `current` (read inside this task's file lock), not the pre-lock `before`:
        // a stale writer racing another write must not be able to slip a downgrade past this check
        // just because its own read happened before the other writer's change landed.
        assertMutable(current, reclassification ? "reclassify" : "task-write", OPEN_STATUSES);
        if (current.code_change === true && patch.code_change === false) throw new Error("task-write: code_change cannot transition from true back to false; supersede this task and create a new non-code task instead");
        if (!reclassification) {
          const downgrades = downgradeErrors(current, patch);
          if (downgrades.length) throw new Error(`task-write: ${downgrades.join("; ")}; use \`agent-workflow reclassify --confirmed-by-user <text> --reason <text>\` if the user really re-assessed this task`);
        }
        const beforePlan = classificationTouched ? compilePlanForTaskPath(current, path) : undefined;
        for (const [key, fieldValue] of Object.entries(patch)) {
          if (key === "project_docs" && !allowProjectDocEvidence && fieldValue && typeof fieldValue === "object" && !Array.isArray(fieldValue)) {
            const existing = current.project_docs && typeof current.project_docs === "object" && !Array.isArray(current.project_docs) ? current.project_docs as JsonObject : {};
            const incoming = fieldValue as JsonObject;
            current.project_docs = { ...existing, ...(Object.prototype.hasOwnProperty.call(incoming, "updated") ? { updated: incoming.updated } : {}) };
          } else current[key] = fieldValue;
        }
        // model_profile is derived from task_type/risk_flags/impact_*, which task-write can change
        // after creation — recompute here so it never goes stale relative to the fields it derives from.
        if (current.task_type === "read_only") current.model_profile = deriveModelProfile(current);
        else delete current.model_profile;
        // Activation rebinds identity/base_commit here rather than trusting whatever task-init
        // recorded, so a task-write --repo-root pointed at the real repo still self-corrects a task
        // created against the wrong one.
        if (identity) { current.project_id = identity.projectId; current.worktree_id = identity.worktreeId; }
        if (baseCommit) current.base_commit = baseCommit;
        // Same actor/at/reason/confirmed_by_user shape a waiver records, kept in the existing
        // workflow_decision prose so a downgrade cannot be performed without leaving a trace.
        if (reclassification) current.workflow_decision = [String(current.workflow_decision || ""), `reclassify at=${now()} actor=${reclassification.actor} confirmed_by_user=${reclassification.confirmedByUser} reason=${reclassification.reason} fields=${Object.keys(patch).sort().join(",")}`].filter(Boolean).join("\n");
        current.updated_at = now();
        const errors = schemaErrors(current);
        if (errors.length) throw new Error(`task-write: resulting task.json fails schema: ${errors.join("; ")}`);
        if (beforePlan) {
          postPatchPlan = compilePlanForTaskPath(current, path);
          if (postPatchPlan.plan_hash !== beforePlan.plan_hash) current.plan_revision = Number(current.plan_revision || 0) + 1;
        }
      });
      if (root && identity) writeLease(root, identity.worktreeId, String(before.id || ""), path);
      return state;
    };
    const state = root && identity ? withFileLock(`${worktreeLeasePath(root, identity.worktreeId)}.lock`, applyWrite) : applyWrite();
    if (emitOutput) {
      if (classificationTouched) {
        const plan = postPatchPlan || compilePlanForTaskPath(state, path);
        output({ valid: true, task: path, state_revision: state.state_revision, plan: planOutput(plan), plan_revision: state.plan_revision, procedures: resolveProcedures(plan, state) });
      } else output({ valid: true, task: path, state_revision: state.state_revision });
    }
    return 0;
  } catch (error) { if (emitOutput) output({ valid: false, errors: [String((error as Error).message || error)] }); return 1; }
}

// The only path allowed to drop managed_change or remove an existing risk flag.
export function reclassify(value: string, patch: JsonObject, confirmedByUser: string, reason: string, actor = "cli", stateRootValue?: string, repoRootValue = process.cwd()): number {
  if (!confirmedByUser || !reason) { output({ valid: false, errors: ["reclassify requires both --confirmed-by-user and --reason"] }); return 1; }
  return taskWrite(value, patch, stateRootValue, repoRootValue, false, { confirmedByUser, reason, actor });
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
