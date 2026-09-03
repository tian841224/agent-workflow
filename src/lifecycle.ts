import { Ajv } from "ajv";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { changedPaths, deliveryHash, diffFingerprint, git, JsonObject, mutateJsonState, now, output, ProjectIdentity, projectIdentity, readJson, schemaPath, stateRoot, withFileLock, writeJson } from "./core.js";
import { intentHash } from "./intent.js";
import { memoryReviewPrompt } from "./memory-review.js";
import { compilePlanForTaskPath } from "./workflow-policy.js";

type Transition = "create" | "pause" | "block" | "resume" | "supersede" | "waive" | "close";
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

const ACTIVE_STATUSES = new Set(["in_progress", "paused", "blocked"]);
function worktreeLeasePath(root: string, worktreeId: string): string { return join(root, "worktree-leases", `${worktreeId}.json`); }
// A code task exclusively owns its worktree so two deliveries can never blend under review. The
// lease is self-healing rather than explicitly released: if the task it names is no longer active
// (closed/superseded, or its task.json is gone), the lease is treated as stale and a new task may
// claim the worktree, regardless of where task directories physically live.
function activeLeaseConflict(root: string, worktreeId: string, excludeTaskId: string): JsonObject | undefined {
  const leasePath = worktreeLeasePath(root, worktreeId);
  if (!existsSync(leasePath)) return undefined;
  let lease: JsonObject;
  try { lease = readJson(leasePath); } catch { return undefined; }
  const taskId = String(lease.task_id || "");
  if (!taskId || taskId === excludeTaskId) return undefined;
  const taskJsonPath = String(lease.task_path || "");
  if (!taskJsonPath || !existsSync(taskJsonPath)) return undefined;
  let candidate: JsonObject;
  try { candidate = readJson(taskJsonPath); } catch { return undefined; }
  const status = String(((candidate.lifecycle as JsonObject | undefined) || {}).status || "");
  return ACTIVE_STATUSES.has(status) ? candidate : undefined;
}
function writeLease(root: string, worktreeId: string, taskId: string, taskJsonPath: string): void {
  writeJson(worktreeLeasePath(root, worktreeId), { worktree_id: worktreeId, task_id: taskId, task_path: taskJsonPath, acquired_at: now() });
}
// Shared by task-init and task-write so a code task's activation — worktree lease, dirty check,
// base_commit — is defined exactly once regardless of whether code_change starts true or flips
// true partway through the task's life.
function activateCodeTask(label: string, taskId: string, root: string, identity: ProjectIdentity, repoRootValue: string, adoptCurrentDiff: boolean): string {
  const conflict = activeLeaseConflict(root, identity.worktreeId, taskId);
  if (conflict) throw new Error(`${label}: worktree already has an active code task (${conflict.id}); close/supersede it first, or use a different worktree`);
  const status = git(repoRootValue, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.status !== 0) throw new Error(`${label}: cannot read git status for ${repoRootValue}: ${status.stderr.trim()}`);
  if (status.stdout.trim() && !adoptCurrentDiff) throw new Error(`${label}: worktree has uncommitted changes; commit/stash them first, or pass --adopt-current-diff to treat the current diff as this task's delivery`);
  const head = git(repoRootValue, ["rev-parse", "HEAD"]);
  if (head.status !== 0 || !head.stdout.trim()) throw new Error(`${label}: cannot resolve HEAD for base_commit in ${repoRootValue}: ${head.stderr.trim()}`);
  return head.stdout.trim();
}

// Shared by transitionTask and closeTask so both write through the exact same transition logic.
function applyTransition(state: JsonObject, path: string, action: Transition, actor: string, confirmation: string, requirementId: string): void {
  const life = lifecycle(state); const from = String(life.status || "");
  const target: Record<Transition, string> = { create: "in_progress", pause: "paused", block: "blocked", resume: "in_progress", supersede: "superseded", waive: from, close: "closed" };
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
    waivers.push({ at: now(), actor, confirmed_by_user: confirmation, requirement_id: requirementId, plan_hash: plan.plan_hash });
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
function evidenceSatisfied(item: JsonObject): boolean {
  if (item.kind === "step") return item.status === "recorded";
  if (item.kind === "role") return item.result === "pass";
  return false;
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
  if (state.code_change === true && !String(state.base_commit || "")) errors.push("code task has no base_commit; task delivery baseline is missing");
  const riskFlags = Array.isArray(state.risk_flags) ? state.risk_flags.map(String) : [];
  if (riskFlags.some((flag) => freezeRequired.has(flag))) {
    const approval = state.intent_approval;
    if (!approval || Array.isArray(approval) || typeof approval !== "object") errors.push("intent_approval is required for a freeze-required risk flag but is missing");
    else if (!taskMdBuffer) errors.push("intent_approval cannot be verified: sibling task.md is missing");
    else if (String((approval as JsonObject).intent_hash || "") !== intentHash(taskMdBuffer.toString("utf8"))) errors.push("intent_approval.intent_hash is stale: Goal/Scope/Completion criteria changed since approval");
  }
  const waivers = (Array.isArray(state.waivers) ? state.waivers : []).filter((item): item is JsonObject => !!item && !Array.isArray(item) && typeof item === "object");
  let compiled: JsonObject = {};
  try {
    const plan = compilePlanForTaskPath(state, path);
    compiled = { policy_version: plan.policy_version, plan_hash: plan.plan_hash, required: plan.required, classification_incomplete: plan.classification_incomplete as unknown as JsonObject[], order: plan.order, required_evidence: plan.required_evidence };
    // Only a code task owes an impact classification: a read-only or docs task never reaches the
    // capabilities these fields gate, so demanding them would leave it with no way to close.
    if (state.code_change === true) for (const entry of plan.classification_incomplete) errors.push(`workflow classification is incomplete: ${String(entry.name)} cannot be decided until ${(entry.missing as string[]).join(", ")} is declared`);
    const waived = new Set(waivers.filter((item) => item.confirmed_by_user && String(item.plan_hash || "") === plan.plan_hash).map((item) => String(item.requirement_id || "")));
    // The task directory normally lives in the state root, not in the repo, so the worktree to
    // fingerprint has to come from the caller's location rather than from the task's own path.
    const repoRoot = projectIdentity(repoRootValue || dirname(path)).root;
    errors.push(...ownershipErrors(state, repoRoot, evidence));
    for (const key of plan.required_evidence) {
      if (waived.has(key)) continue;
      const item = latestEvidence(evidence, key);
      if (!item || !evidenceSatisfied(item)) { errors.push(`required evidence is not recorded/passed or waived: ${key}`); continue; }
      if (String(item.plan_hash || "") !== plan.plan_hash) { errors.push(`evidence was recorded against a different plan, re-verification required: ${key}`); continue; }
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
const CREATE_MANAGED_KEYS = new Set(["schema_version", "state_revision", "plan_revision", "created_at", "updated_at", "lifecycle", "waivers", "project_id", "worktree_id", "base_commit"]);
export function taskInit(value: string, patch: JsonObject, actor = "cli", stateRootValue?: string, repoRootValue = process.cwd(), adoptCurrentDiff = false): number {
  const path = taskPath(value);
  return withFileLock(`${path}.lock`, () => {
    if (existsSync(path)) { output({ valid: false, errors: [`task state already exists: ${path}`] }); return 1; }
    try {
      const blocked = Object.keys(patch).filter((key) => CREATE_MANAGED_KEYS.has(key));
      if (blocked.length) throw new Error(`task-init: field(s) are runtime-managed and cannot be set directly: ${blocked.join(", ")}`);
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
        const baseCommit = codeChange ? activateCodeTask("task-init", taskId, root, identity, repoRootValue, adoptCurrentDiff) : undefined;
        const stamp = now();
        const state: JsonObject = {
          schema_version: 4, id: taskId, project_id: identity.projectId, worktree_id: identity.worktreeId,
          code_change: false, risk_flags: [], created_at: stamp, updated_at: stamp, state_revision: 1, plan_revision: 1,
          lifecycle: { status: "in_progress", transitions: [{ at: stamp, action: "create", from: "new", to: "in_progress", actor }] },
          evidence: [], waivers: [],
          ...(baseCommit ? { base_commit: baseCommit } : {}),
          ...patch
        };
        const errors = schemaErrors(state);
        if (errors.length) throw new Error(`task-init: task.json fails schema: ${errors.join("; ")}`);
        writeJson(path, state);
        if (codeChange) writeLease(root, identity.worktreeId, taskId, path);
        return state;
      };
      codeChange ? withFileLock(`${worktreeLeasePath(root, identity.worktreeId)}.lock`, createTask) : createTask();
      output({ valid: true, task: path });
      return 0;
    } catch (error) { output({ valid: false, errors: [String((error as Error).message || error)] }); return 1; }
  });
}
const TASK_WRITABLE_FIELDS = new Set(["code_change", "task_type", "impact_scope", "impact_effect", "impact_confidence", "risk_flags", "workflow_facts", "workflow_request", "workflow_decision"]);
export function taskWrite(value: string, patch: JsonObject, stateRootValue?: string, repoRootValue = process.cwd(), adoptCurrentDiff = false): number {
  const path = taskPath(value);
  if (!existsSync(path)) { output({ valid: false, errors: [`task state is missing: ${path}`] }); return 1; }
  try {
    const disallowed = Object.keys(patch).filter((key) => !TASK_WRITABLE_FIELDS.has(key));
    if (disallowed.length) throw new Error(`task-write: field(s) are not writable via task-write: ${disallowed.join(", ")} (evidence/intent_approval/lifecycle/base_commit/file_ownership/hashes are runtime-managed — use task-init / approve-intent / evidence-record / review-record / pause / block / resume / supersede / waive / close-task instead)`);
    const before = task(path);
    // Once a code task has a base_commit/lease/delivery semantics riding on it, dropping back to
    // false would leave those stale rather than meaningfully "undone" — supersede instead.
    if (before.code_change === true && patch.code_change === false) throw new Error("task-write: code_change cannot transition from true back to false; supersede this task and create a new non-code task instead");
    // Also re-runs activation for a task that is already code_change: true but predates base_commit
    // tracking (created by an older runtime) — the gate now requires base_commit on every code task,
    // and re-sending code_change: true is the only writable signal left to backfill one.
    const activating = patch.code_change === true && (before.code_change !== true || !String(before.base_commit || ""));
    const root = activating ? stateRoot(stateRootValue) : undefined;
    const identity = activating ? projectIdentity(repoRootValue) : undefined;
    // Same worktree-keyed lock as task-init: without it, two task-write calls activating
    // different tasks against the same worktree can both pass the conflict check before either
    // lease write lands, letting both end up "active" at once.
    const applyWrite = (): JsonObject => {
      const baseCommit = root && identity ? activateCodeTask("task-write", String(before.id || ""), root, identity, repoRootValue, adoptCurrentDiff) : undefined;
      const state = mutateJsonState<JsonObject>(path, (current) => {
        const classificationTouched = Object.keys(patch).some((key) => CLASSIFICATION_KEYS.has(key));
        const beforePlanHash = classificationTouched ? compilePlanForTaskPath(current, path).plan_hash : undefined;
        for (const [key, fieldValue] of Object.entries(patch)) current[key] = fieldValue;
        // Activation rebinds identity/base_commit here rather than trusting whatever task-init
        // recorded, so a task-write --repo-root pointed at the real repo still self-corrects a task
        // created against the wrong one.
        if (identity) { current.project_id = identity.projectId; current.worktree_id = identity.worktreeId; }
        if (baseCommit) current.base_commit = baseCommit;
        current.updated_at = now();
        const errors = schemaErrors(current);
        if (errors.length) throw new Error(`task-write: resulting task.json fails schema: ${errors.join("; ")}`);
        if (beforePlanHash !== undefined && compilePlanForTaskPath(current, path).plan_hash !== beforePlanHash) current.plan_revision = Number(current.plan_revision || 0) + 1;
      });
      if (root && identity) writeLease(root, identity.worktreeId, String(before.id || ""), path);
      return state;
    };
    const state = root && identity ? withFileLock(`${worktreeLeasePath(root, identity.worktreeId)}.lock`, applyWrite) : applyWrite();
    output({ valid: true, task: path, state_revision: state.state_revision, plan_revision: state.plan_revision });
    return 0;
  } catch (error) { output({ valid: false, errors: [String((error as Error).message || error)] }); return 1; }
}
const CLASSIFICATION_KEYS = new Set(["code_change", "task_type", "impact_scope", "impact_effect", "impact_confidence", "risk_flags", "workflow_facts", "workflow_request"]);

// Runtime computes intent_hash itself from the sibling task.md; the caller only asserts who
// confirmed it. source is "user" only when the caller explicitly claims a real user confirmation —
// this runtime has no platform event bridge to verify that independently, so it is an honest
// attestation, not a cryptographic guarantee of user provenance.
export function approveIntent(value: string, confirmedBy: string, asUser: boolean): number {
  const path = taskPath(value);
  if (!existsSync(path)) { output({ valid: false, errors: [`task state is missing: ${path}`] }); return 1; }
  if (!confirmedBy) { output({ valid: false, errors: ["approve-intent requires --confirmed-by"] }); return 1; }
  const taskMd = join(dirname(path), "task.md");
  if (!existsSync(taskMd)) { output({ valid: false, errors: ["approve-intent: sibling task.md is missing"] }); return 1; }
  try {
    const hash = intentHash(readFileSync(taskMd, "utf8"));
    const state = mutateJsonState<JsonObject>(path, (current) => {
      current.intent_approval = { intent_hash: hash, confirmed_at: now(), confirmed_by: confirmedBy, source: asUser ? "user" : "cli-attestation" };
      current.updated_at = now();
      const errors = schemaErrors(current);
      if (errors.length) throw new Error(`approve-intent: resulting task.json fails schema: ${errors.join("; ")}`);
    });
    output({ valid: true, task: path, intent_hash: hash, intent_approval: state.intent_approval });
    return 0;
  } catch (error) { output({ valid: false, errors: [String((error as Error).message || error)] }); return 1; }
}

// Records that the agent completed one evidence-capability step's analysis. plan_hash/at are
// computed here, not accepted from the caller — an agent can no longer backdate a step or attach it
// to a plan it wasn't actually run against.
export function evidenceRecord(value: string, requirementId: string, summary: string, actor = "agent"): number {
  const path = taskPath(value);
  if (!existsSync(path)) { output({ valid: false, errors: [`task state is missing: ${path}`] }); return 1; }
  if (!requirementId || !summary) { output({ valid: false, errors: ["evidence-record requires --requirement-id and --summary"] }); return 1; }
  try {
    const plan = compilePlanForTaskPath(task(path), path);
    const selectedStepIds = new Set(plan.selected.filter((capability) => capability.kind === "evidence").flatMap((capability) => (capability.steps as JsonObject[]).map((step) => `${String(capability.name)}.${String(step.id)}`)));
    if (!selectedStepIds.has(requirementId)) throw new Error(`evidence-record: '${requirementId}' is not a selected evidence step for this task; expected one of: ${[...selectedStepIds].join(", ") || "(none)"}`);
    const state = mutateJsonState<JsonObject>(path, (current) => {
      const evidence = Array.isArray(current.evidence) ? current.evidence : [];
      evidence.push({ kind: "step", id: requirementId, status: "recorded", at: now(), plan_hash: plan.plan_hash, actor, summary });
      current.evidence = evidence;
      current.updated_at = now();
      const errors = schemaErrors(current);
      if (errors.length) throw new Error(`evidence-record: resulting task.json fails schema: ${errors.join("; ")}`);
    });
    output({ valid: true, task: path, id: requirementId, state_revision: state.state_revision });
    return 0;
  } catch (error) { output({ valid: false, errors: [String((error as Error).message || error)] }); return 1; }
}

// Records one role capability's review result. reviewed_base/reviewed_paths/reviewed_diff_sha256/
// delivery_hash are computed here from git, not accepted from the caller — the reviewer can no
// longer assert a scope or a digest it did not actually derive from the working tree.
export function reviewRecord(value: string, roleId: string, result: string, summary: string, repoRootValue = process.cwd()): number {
  const path = taskPath(value);
  if (!existsSync(path)) { output({ valid: false, errors: [`task state is missing: ${path}`] }); return 1; }
  if (!["pass", "fail"].includes(result)) { output({ valid: false, errors: ["review-record requires --result pass or fail"] }); return 1; }
  if (!summary) { output({ valid: false, errors: ["review-record requires --summary"] }); return 1; }
  try {
    const state0 = task(path);
    const plan = compilePlanForTaskPath(state0, path);
    const roleKey = roleId.startsWith("role.") ? roleId : `role.${roleId}`;
    const selectedRoles = new Set(plan.selected.filter((capability) => capability.kind === "role").map((capability) => `role.${String(capability.name)}`));
    if (!selectedRoles.has(roleKey)) throw new Error(`review-record: '${roleKey}' is not a selected role for this task; expected one of: ${[...selectedRoles].join(", ") || "(none)"}`);
    const repoRoot = projectIdentity(repoRootValue).root;
    // No HEAD fallback: a code task always gets base_commit from activation (task-init or
    // task-write), so a missing one means activation was skipped or the state predates it, not
    // something safe to paper over with the working tree's current HEAD.
    const base = String(state0.base_commit || "");
    if (!base) throw new Error("review-record: task has no base_commit; the code task was not correctly activated");
    const paths = changedPaths(repoRoot, base);
    if (!paths.length) throw new Error("review-record: no changed paths found between reviewed_base and the working tree; nothing to review");
    const reviewedDiffSha256 = diffFingerprint(repoRoot, base, paths);
    const delivery = deliveryHash(repoRoot, base);
    const state = mutateJsonState<JsonObject>(path, (current) => {
      const evidence = Array.isArray(current.evidence) ? current.evidence : [];
      evidence.push({ kind: "role", id: roleKey, result, at: now(), plan_hash: plan.plan_hash, plan_revision: Number(current.plan_revision || 1), reviewed_base: base, reviewed_paths: paths, reviewed_diff_sha256: reviewedDiffSha256, delivery_hash: delivery, summary });
      current.evidence = evidence;
      current.updated_at = now();
      const errors = schemaErrors(current);
      if (errors.length) throw new Error(`review-record: resulting task.json fails schema: ${errors.join("; ")}`);
    });
    output({ valid: true, task: path, id: roleKey, result, reviewed_base: base, reviewed_paths: paths, delivery_hash: delivery, state_revision: state.state_revision });
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
