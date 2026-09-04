import { existsSync } from "node:fs";
import { changedPaths, deliveryHash, diffFingerprint, JsonObject, mutateJsonState, now, output, projectIdentity } from "../core.js";
import { compilePlanForTaskPath } from "../workflow-policy.js";
import { covers } from "./ownership.js";
import { schemaErrors } from "./task-schema.js";
import { task, taskPath } from "./task-store.js";

// The newest entry wins outright: an older PASS must never mask a later FAIL for the same
// requirement, which a "first verified entry" lookup would happily do.
export function latestEvidence(evidence: JsonObject[], key: string): JsonObject | undefined {
  const matches = evidence.filter((entry) => String(entry.id || entry.kind || "") === key);
  // Parsed, not compared as strings: an RFC 3339 offset timestamp sorts wrong lexicographically, so
  // "2026-01-01T09:00:00+08:00" would beat the later "2026-01-01T05:00:00Z".
  const instant = (entry: JsonObject): number => { const parsed = Date.parse(String(entry.at || "")); return Number.isNaN(parsed) ? -Infinity : parsed; };
  return matches.length ? matches.reduce((best, entry) => instant(entry) >= instant(best) ? entry : best) : undefined;
}
// Role evidence goes stale only when the diff it actually reviewed changes, or when the task's
// classification moved under it — not when some unrelated file elsewhere in the repo is touched.
export function roleFreshnessErrors(item: JsonObject, key: string, repoRoot: string, state: JsonObject): string[] {
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
export function evidenceSatisfied(item: JsonObject): boolean {
  if (item.kind === "step") return item.status === "recorded";
  if (item.kind === "role") return item.result === "pass";
  return false;
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
