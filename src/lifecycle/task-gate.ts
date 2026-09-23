import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { JsonObject, output, projectIdentity } from "../core.js";
import { intentHash } from "../intent.js";
import { compilePlanForTaskPath } from "../workflow-policy.js";
import { deliverySnapshot, evidenceSatisfied, executionFreshnessErrors, latestEvidence, roleFreshnessErrors } from "./evidence.js";
import { ownershipErrors } from "./ownership.js";
import { freezeRequired, schemaErrors } from "./task-schema.js";
import { lifecycleOf, RUNNING_STATUSES, task, taskPath } from "./task-store.js";

export type GateResult = { valid: boolean; status: string; compiled: JsonObject; errors: string[] };
export function evaluateTaskGate(state: JsonObject, path: string, repoRootValue: string): GateResult {
  const life = lifecycleOf(state);
  const evidence = (Array.isArray(state.evidence) ? state.evidence : []).filter((item): item is JsonObject => !!item && !Array.isArray(item) && typeof item === "object");
  const errors: string[] = [...schemaErrors(state)];
  if (!RUNNING_STATUSES.includes(String(life.status))) errors.push(`task is ${String(life.status)}, not in_progress; only a running task can be closed`);
  const taskMd = join(dirname(path), "task.md");
  const taskMdBuffer = existsSync(taskMd) ? readFileSync(taskMd) : null;
  if (!taskMdBuffer || !taskMdBuffer.toString("utf8").trim()) errors.push("sibling task.md requires human intent (Goal/Scope/Completion criteria)");
  let liveIntentHash: string | undefined;
  if (taskMdBuffer) {
    try { liveIntentHash = intentHash(taskMdBuffer.toString("utf8")); }
    catch (error) { errors.push(String((error as Error).message || error)); }
  }
  if (evidence.some((item) => item.kind === "legacy-unverified")) errors.push("legacy-unverified evidence requires a new verification");
  if (state.code_change === true && !String(state.base_commit || "")) errors.push("code task has no base_commit; task delivery baseline is missing");
  const riskFlags = Array.isArray(state.risk_flags) ? state.risk_flags.map(String) : [];
  if (riskFlags.some((flag) => freezeRequired.has(flag))) {
    const approval = state.intent_approval;
    if (!approval || Array.isArray(approval) || typeof approval !== "object") errors.push("intent_approval is required for a freeze-required risk flag but is missing");
    else if (!liveIntentHash) errors.push("intent_approval cannot be verified: sibling task.md is missing or has no valid intent");
    else if (String((approval as JsonObject).intent_hash || "") !== liveIntentHash) errors.push("intent_approval.intent_hash is stale: Goal/Scope/Completion criteria changed since approval");
  }
  const waivers = (Array.isArray(state.waivers) ? state.waivers : []).filter((item): item is JsonObject => !!item && !Array.isArray(item) && typeof item === "object");
  let compiled: JsonObject = {};
  try {
    const plan = compilePlanForTaskPath(state, path);
    // Only what identifies the plan: the id lists already came back from task-init, and every
    // missing id is named in errors, so echoing them again only repeats kilobytes per gate run.
    compiled = { policy_version: plan.policy_version, plan_hash: plan.plan_hash, exploration_profile: plan.exploration_profile };
    // Only a managed-change task owes an impact classification: an unmanaged (docs/read-only/etc.)
    // task never reaches the capabilities these fields gate, so demanding them would leave it with
    // no way to close. code_change no longer decides this — see managed_change in task.schema.json.
    if (state.managed_change === true) {
      for (const entry of plan.classification_incomplete) errors.push(`workflow classification is incomplete: ${String(entry.name)} cannot be decided until ${(entry.missing as string[]).join(", ")} is declared`);
      // A step left undecidable is neither selected nor dropped: keeping it would demand evidence the
      // task never established was needed, dropping it would silently retire a check.
      for (const entry of plan.step_classification_incomplete) errors.push(`workflow step classification is incomplete: ${String(entry.capability)}.${String(entry.id)} cannot be decided until ${(entry.missing as string[]).join(", ")} is declared`);
    }
    const repoRoot = projectIdentity(repoRootValue || dirname(path)).root;
    let liveDelivery: ReturnType<typeof deliverySnapshot> | undefined;
    let liveDeliveryError: string | undefined;
    const ensureLiveDelivery = (): ReturnType<typeof deliverySnapshot> | undefined => {
      if (!liveDelivery && !liveDeliveryError) {
        try { liveDelivery = deliverySnapshot(repoRoot, state); }
        catch (error) { liveDeliveryError = String((error as Error).message || error); }
      }
      return liveDelivery;
    };
    // A waiver missing plan_revision entirely was written by a runtime that could not tell a
    // round-trip from a plan that never changed, so it is stale by construction and has to be
    // re-granted rather than trusted.
    const waived = new Set(waivers.filter((item) => item.confirmed_by_user && String(item.plan_hash || "") === plan.plan_hash && Number(item.plan_revision || 0) === Number(state.plan_revision || 0) && String(item.intent_hash || "") === liveIntentHash).map((item) => String(item.requirement_id || "")));
    // The task directory normally lives in the state root, not in the repo, so the worktree to
    // fingerprint has to come from the caller's location rather than from the task's own path.
    const ownershipSnapshot = Array.isArray(state.file_ownership) && state.file_ownership.length ? ensureLiveDelivery() : undefined;
    errors.push(...ownershipErrors(state, repoRoot, evidence, ownershipSnapshot?.paths));
    for (const key of plan.required_evidence) {
      if (waived.has(key)) continue;
      const item = latestEvidence(evidence, key);
      if (!item || !evidenceSatisfied(item, plan.runtime_required_evidence.includes(key))) { errors.push(`required evidence is not recorded/passed or waived: ${key}`); continue; }
      if (String(item.plan_hash || "") !== plan.plan_hash) { errors.push(`evidence was recorded against a different plan, re-verification required: ${key}`); continue; }
      // plan_hash alone is not monotonic: a classification round-trip (e.g. managed_change
      // true -> false -> true, or any other field changed and changed back) can restore the exact
      // same plan_hash, which would let pre-existing evidence silently satisfy a gate nothing was
      // actually re-verified against. plan_revision is bumped every time plan_hash changes (see
      // task-write in transitions.ts) and never reused, so comparing it closes that replay gap.
      if (Number(item.plan_revision || 0) !== Number(state.plan_revision || 0)) { errors.push(`evidence predates the current plan revision, re-verification required: ${key}`); continue; }
      if (String(item.intent_hash || "") !== liveIntentHash) { errors.push(`evidence was recorded against a different intent (task.md Goal/Scope/Completion criteria changed), re-verification required: ${key}`); continue; }
      if (key.startsWith("role.")) errors.push(...roleFreshnessErrors(item, key, repoRoot, state, ensureLiveDelivery()));
      else {
        ensureLiveDelivery();
        if (liveDeliveryError) errors.push(`execution evidence freshness cannot be recomputed for ${key}: ${liveDeliveryError}`);
        else errors.push(...executionFreshnessErrors(item, key, repoRoot, state, liveDelivery));
      }
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

