import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { JsonObject, output, projectIdentity } from "../core.js";
import { acceptanceCases, acceptanceErrors, acceptanceRequired, AcceptanceCase, intentHash } from "../intent.js";
import { compilePlanForTaskPath, CompiledWorkflowPlan } from "../workflow-policy.js";
import { deliverySnapshot, evidenceSatisfied, executionFreshnessErrors, latestEvidence, roleFreshnessErrors } from "./evidence.js";
import { NextAction, nextActions } from "./next.js";
import { ownershipErrors } from "./ownership.js";
import { freezeRequired, schemaErrors } from "./task-schema.js";
import { lifecycleOf, RUNNING_STATUSES, task, taskPath } from "./task-store.js";

// What still has to happen before close, in a shape `next` can turn into commands. Errors keep the
// full human-readable reasons; missing only names the actionable items.
export type GateMissing =
  | { kind: "intent"; reason: string }
  | { kind: "classification"; fields: string[] }
  | { kind: "approval" }
  | { kind: "acceptance"; id: string; command: string }
  | { kind: "proof"; id: string; title: string; undecided_by?: string[] }
  | { kind: "role"; id: string };
export type GateResult = { valid: boolean; status: string; compiled: JsonObject; errors: string[]; missing: GateMissing[]; plan?: CompiledWorkflowPlan; acceptance: AcceptanceCase[] };

export function acceptanceKey(id: string): string { return `acceptance.${id}`; }

export function evaluateTaskGate(state: JsonObject, path: string, repoRootValue: string): GateResult {
  const life = lifecycleOf(state);
  const evidence = (Array.isArray(state.evidence) ? state.evidence : []).filter((item): item is JsonObject => !!item && !Array.isArray(item) && typeof item === "object");
  const errors: string[] = [...schemaErrors(state)];
  const missing: GateMissing[] = [];
  if (!RUNNING_STATUSES.includes(String(life.status))) errors.push(`task is ${String(life.status)}, not in_progress; only a running task can be closed`);
  const taskMd = join(dirname(path), "task.md");
  const markdown = existsSync(taskMd) ? readFileSync(taskMd, "utf8") : "";
  if (!markdown.trim()) { errors.push("sibling task.md requires human intent (Goal/Scope/Completion criteria)"); missing.push({ kind: "intent", reason: "task.md is missing or empty" }); }
  let liveIntentHash: string | undefined;
  if (markdown.trim()) {
    try { liveIntentHash = intentHash(markdown); }
    catch (error) { const reason = String((error as Error).message || error); errors.push(reason); missing.push({ kind: "intent", reason }); }
  }
  const acceptanceIssues = markdown.trim() ? acceptanceErrors(markdown, acceptanceRequired(state)) : [];
  if (acceptanceIssues.length) { errors.push(...acceptanceIssues); missing.push({ kind: "intent", reason: acceptanceIssues.join("; ") }); }
  const acceptance = acceptanceIssues.length ? [] : acceptanceCases(markdown).cases;
  if (evidence.some((item) => item.kind === "legacy-unverified")) errors.push("legacy-unverified evidence requires a new verification");
  if (state.code_change === true && !String(state.base_commit || "")) errors.push("code task has no base_commit; task delivery baseline is missing");
  const riskFlags = Array.isArray(state.risk_flags) ? state.risk_flags.map(String) : [];
  if (riskFlags.some((flag) => freezeRequired.has(flag))) {
    const approval = state.intent_approval;
    if (!approval || Array.isArray(approval) || typeof approval !== "object") { errors.push("intent_approval is required for a freeze-required risk flag but is missing"); missing.push({ kind: "approval" }); }
    else if (!liveIntentHash) errors.push("intent_approval cannot be verified: sibling task.md is missing or has no valid intent");
    else if (String((approval as JsonObject).intent_hash || "") !== liveIntentHash) { errors.push("intent_approval.intent_hash is stale: Goal/Scope/Completion criteria changed since approval"); missing.push({ kind: "approval" }); }
  }
  const waivers = (Array.isArray(state.waivers) ? state.waivers : []).filter((item): item is JsonObject => !!item && !Array.isArray(item) && typeof item === "object");
  let compiled: JsonObject = {};
  let plan: CompiledWorkflowPlan | undefined;
  try {
    plan = compilePlanForTaskPath(state, path);
    compiled = { policy_version: plan.policy_version, plan_hash: plan.plan_hash, exploration_profile: plan.exploration_profile };
    if (state.managed_change === true) for (const entry of plan.classification_incomplete) {
      errors.push(`workflow classification is incomplete: ${String(entry.name)} cannot be decided until ${(entry.missing as string[]).join(", ")} is declared`);
      missing.push({ kind: "classification", fields: entry.missing as string[] });
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
    // plan_hash alone can repeat after a classification round-trip; plan_revision never does, so a
    // waiver has to match both to still apply.
    const waived = new Set(waivers.filter((item) => item.confirmed_by_user && String(item.plan_hash || "") === plan!.plan_hash && Number(item.plan_revision || 0) === Number(state.plan_revision || 0) && String(item.intent_hash || "") === liveIntentHash).map((item) => String(item.requirement_id || "")));
    const ownershipSnapshot = Array.isArray(state.file_ownership) && state.file_ownership.length ? ensureLiveDelivery() : undefined;
    errors.push(...ownershipErrors(state, repoRoot, evidence, ownershipSnapshot?.paths));
    const proofSteps = new Map(plan.proofs.map((step) => [step.id, step]));
    const pending = (key: string): void => {
      if (key.startsWith("acceptance.")) { const id = key.slice("acceptance.".length); missing.push({ kind: "acceptance", id, command: acceptance.find((item) => item.id === id)?.command || "" }); }
      else if (key.startsWith("role.")) missing.push({ kind: "role", id: key });
      else { const step = proofSteps.get(key); missing.push({ kind: "proof", id: key, title: step?.title || "", ...(step?.undecided_by ? { undecided_by: step.undecided_by } : {}) }); }
    };
    const fail = (key: string, message: string): void => { errors.push(message); pending(key); };
    // Acceptance runs prove behavior against the task's intent, not against a capability plan, so a
    // reclassification leaves them valid; only a changed intent or delivery makes them stale.
    const keys = [...acceptance.map((item) => acceptanceKey(item.id)), ...plan.required_evidence];
    for (const key of keys) {
      if (waived.has(key)) continue;
      const isAcceptance = key.startsWith("acceptance.");
      const item = latestEvidence(evidence, key);
      if (!item || !evidenceSatisfied(item, !key.startsWith("role."))) { fail(key, `required evidence is not recorded/passed${isAcceptance ? "" : " or waived"}: ${key}`); continue; }
      if (!isAcceptance && String(item.plan_hash || "") !== plan.plan_hash) { fail(key, `evidence was recorded against a different plan, re-verification required: ${key}`); continue; }
      if (!isAcceptance && Number(item.plan_revision || 0) !== Number(state.plan_revision || 0)) { fail(key, `evidence predates the current plan revision, re-verification required: ${key}`); continue; }
      if (String(item.intent_hash || "") !== liveIntentHash) { fail(key, `evidence was recorded against a different intent (task.md Goal/Scope/Completion criteria changed), re-verification required: ${key}`); continue; }
      const freshness = key.startsWith("role.")
        ? roleFreshnessErrors(item, key, repoRoot, state, ensureLiveDelivery())
        : (ensureLiveDelivery(), liveDeliveryError ? [`execution evidence freshness cannot be recomputed for ${key}: ${liveDeliveryError}`] : executionFreshnessErrors(item, key, repoRoot, state, liveDelivery));
      if (freshness.length) { errors.push(...freshness); pending(key); }
    }
  } catch (error) { errors.push(`workflow-plan compile failed: ${String((error as Error).message || error)}`); }
  return { valid: errors.length === 0, status: String(life.status), compiled, errors, missing, plan, acceptance };
}

// Every writer returns its `next` from the state it just wrote; a gate that cannot be evaluated only
// loses the hint, never the write.
export function nextForState(state: JsonObject, path: string, repoRoot: string): NextAction[] {
  try { return nextActions(path, repoRoot, evaluateTaskGate(state, path, repoRoot)); }
  catch { return []; }
}

export function taskGate(value: string, repoRoot = process.cwd()): number {
  try {
    const path = taskPath(value); const state = task(path);
    const gate = evaluateTaskGate(state, path, repoRoot);
    output({ valid: gate.valid, task: path, status: gate.status, compiled: gate.compiled, errors: gate.errors, next: nextActions(path, repoRoot, gate) });
    return gate.valid ? 0 : 1;
  } catch (error) { output({ valid: false, errors: [String(error)] }); return 1; }
}
