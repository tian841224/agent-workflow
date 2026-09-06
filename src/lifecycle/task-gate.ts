import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Json, JsonObject, output, projectIdentity } from "../core.js";
import { intentHash } from "../intent.js";
import { PROCEDURE_POINTERS } from "../execution/execution-packet.js";
import { compilePlanForTaskPath } from "../workflow-policy.js";
import { evidenceSatisfied, latestEvidence, roleFreshnessErrors } from "./evidence.js";
import { ownershipErrors } from "./ownership.js";
import { freezeRequired, schemaErrors } from "./task-schema.js";
import { lifecycleOf, task, taskPath } from "./task-store.js";

export type GateResult = { valid: boolean; status: string; compiled: JsonObject; errors: string[] };
export function evaluateTaskGate(state: JsonObject, path: string, repoRootValue: string): GateResult {
  const life = lifecycleOf(state);
  const evidence = (Array.isArray(state.evidence) ? state.evidence : []).filter((item): item is JsonObject => !!item && !Array.isArray(item) && typeof item === "object");
  const errors: string[] = [...schemaErrors(state)];
  if (life.status === "closed") errors.push("task is already closed");
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
    compiled = { policy_version: plan.policy_version, plan_hash: plan.plan_hash, required: plan.required, classification_incomplete: plan.classification_incomplete as unknown as JsonObject[], step_classification_incomplete: plan.step_classification_incomplete as unknown as JsonObject[], order: plan.order, required_evidence: plan.required_evidence };
    // Only a managed-change task owes an impact classification: an unmanaged (docs/read-only/etc.)
    // task never reaches the capabilities these fields gate, so demanding them would leave it with
    // no way to close. code_change no longer decides this — see managed_change in task.schema.json.
    if (state.managed_change === true) {
      for (const entry of plan.classification_incomplete) errors.push(`workflow classification is incomplete: ${String(entry.name)} cannot be decided until ${(entry.missing as string[]).join(", ")} is declared`);
      // A step left undecidable is neither selected nor dropped: keeping it would demand evidence the
      // task never established was needed, dropping it would silently retire a check.
      for (const entry of plan.step_classification_incomplete) errors.push(`workflow step classification is incomplete: ${String(entry.capability)}.${String(entry.id)} cannot be decided until ${(entry.missing as string[]).join(", ")} is declared`);
    }
    const waived = new Set(waivers.filter((item) => item.confirmed_by_user && String(item.plan_hash || "") === plan.plan_hash && String(item.intent_hash || "") === liveIntentHash).map((item) => String(item.requirement_id || "")));
    // The task directory normally lives in the state root, not in the repo, so the worktree to
    // fingerprint has to come from the caller's location rather than from the task's own path.
    const repoRoot = projectIdentity(repoRootValue || dirname(path)).root;
    errors.push(...ownershipErrors(state, repoRoot, evidence));
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

// The skill a capability's procedure pointer names, if it has one.
function skillOf(capability: string): string | undefined {
  // PROCEDURE_POINTERS is the runtime's only capability-to-skill mapping; a capability that falls
  // back to the policy document contributes nothing rather than an invented skill name.
  return /^\.agents\/skills\/([^/]+)\//.exec(PROCEDURE_POINTERS[capability] || "")?.[1];
}

// Re-presents one evaluateTaskGate run as "what do I do now": blockers grouped by the work each
// demands, plus the command that clears the first of them.
export function taskNext(value: string, repoRoot = process.cwd()): number {
  try {
    const path = taskPath(value); const state = task(path);
    const gate = evaluateTaskGate(state, path, repoRoot);
    const strings = (key: string): string[] => (Array.isArray(gate.compiled[key]) ? gate.compiled[key] as Json[] : []).map(String);
    // A key the gate said anything about is pending, so missing, failed, stale-plan, stale-intent and
    // stale-review blockers all collapse to one membership test instead of four message parsers.
    const pending = strings("required_evidence").filter((key) => gate.errors.some((error) => error.includes(key)));
    const pendingEvidence = pending.filter((key) => !key.startsWith("role."));
    const requiredRoles = pending.filter((key) => key.startsWith("role.")).map((key) => key.slice("role.".length));
    const classification = gate.errors.filter((error) => error.startsWith("workflow classification is incomplete") || error.startsWith("workflow step classification is incomplete"));
    const category = (error: string): string => {
      if (requiredRoles.some((role) => error.includes(`role.${role}`))) return "role";
      if (pendingEvidence.some((key) => error.includes(key))) return "evidence";
      if (classification.includes(error)) return "classification";
      if (error.includes("intent_approval") || error.includes("task.md")) return "intent";
      if (error === "task is already closed") return "lifecycle";
      return "task";
    };
    let runtimeRequired: string[] = [];
    try { runtimeRequired = compilePlanForTaskPath(state, path).runtime_required_evidence; } catch { /* the gate already reported the compile failure */ }
    const missingFields = [...new Set(classification.flatMap((error) => (error.split("until ")[1] || "").replace(" is declared", "").split(", ").filter(Boolean)))];
    const nextAction = classification.length ? `resolve classification_incomplete for: ${missingFields.join(", ")}`
      : pendingEvidence.length ? runtimeRequired.includes(pendingEvidence[0])
        ? `run: agent-workflow evidence-run --task-path ${path} --requirement-id ${pendingEvidence[0]} --summary <conclusion> -- <command>`
        : `run: agent-workflow evidence-record --task-path ${path} --requirement-id ${pendingEvidence[0]} --summary <conclusion>`
      : requiredRoles.length ? `run: agent-workflow review-record --task-path ${path} --role ${requiredRoles[0]} --result pass --summary <conclusion>`
      : gate.errors.length ? `resolve: ${gate.errors[0]}`
      : "task is ready to close";
    output({
      task: path,
      blocking_reasons: gate.errors.map((detail) => ({ category: category(detail), detail })),
      required_skills: [...new Set(strings("order").map(skillOf).filter((name): name is string => !!name))].sort(),
      pending_evidence: pendingEvidence,
      required_roles: requiredRoles,
      next_action: nextAction
    });
    return gate.valid ? 0 : 1;
  } catch (error) { output({ valid: false, errors: [String((error as Error).message || error)] }); return 1; }
}

