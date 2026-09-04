import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { JsonObject, output, projectIdentity } from "../core.js";
import { intentHash } from "../intent.js";
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
    // Only a managed-change task owes an impact classification: an unmanaged (docs/read-only/etc.)
    // task never reaches the capabilities these fields gate, so demanding them would leave it with
    // no way to close. code_change no longer decides this — see managed_change in task.schema.json.
    if (state.managed_change === true) for (const entry of plan.classification_incomplete) errors.push(`workflow classification is incomplete: ${String(entry.name)} cannot be decided until ${(entry.missing as string[]).join(", ")} is declared`);
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
