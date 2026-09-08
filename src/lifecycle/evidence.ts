import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { changedPaths, deliveryHash, diffFingerprint, JsonObject, mutateJsonState, now, output, projectIdentity } from "../core.js";
import { intentHash } from "../intent.js";
import { compilePlanForTaskPath } from "../workflow-policy.js";
import { covers } from "./ownership.js";
import { schemaErrors } from "./task-schema.js";
import { assertMutable, RUNNING_STATUSES, task, taskPath } from "./task-store.js";

// Reads the sibling task.md's current intent_hash so evidence can be stamped with the requirement
// version it was actually recorded against, not just the policy plan.
function currentIntentHash(taskJsonPath: string): string {
  const taskMd = join(dirname(taskJsonPath), "task.md");
  if (!existsSync(taskMd)) throw new Error("sibling task.md is missing; cannot determine intent_hash");
  return intentHash(readFileSync(taskMd, "utf8"));
}

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
export function evidenceSatisfied(item: JsonObject, runtimeRequired = false): boolean {
  if (item.kind === "step") {
    if (item.status !== "recorded") return false;
    // An agent-reported claim is never proof that a command ran, so a runtime_execution step only
    // counts when evidence-run observed the process itself.
    if (runtimeRequired && item.trust_level !== "runtime") return false;
    // A recorded execution that exited non-zero is a failure that was written down, not a pass.
    if (item.evidence_kind === "execution" && Number(item.exit_code) !== 0) return false;
    return true;
  }
  if (item.kind === "role") return item.result === "pass";
  return false;
}

// A step is "analysis" (summary only) unless the caller reports it actually ran a command — command
// and exit_code together are what distinguish a claim from execution proof; the rest is optional detail.
export type ExecutionProof = { command: string; cwd: string; exitCode: number; startedAt: string; durationMs: number; outputDigest: string };

function requirementIds(value: string | string[]): string[] {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.flatMap((item) => String(item).split(",")).map((item) => item.trim()).filter(Boolean))];
}

function selectedEvidenceIds(plan: ReturnType<typeof compilePlanForTaskPath>): Set<string> {
  return new Set(plan.selected.filter((capability) => capability.kind === "evidence").flatMap((capability) => (capability.steps as JsonObject[]).map((step) => `${String(capability.name)}.${String(step.id)}`)));
}

// Records that the agent completed one evidence-capability step. plan_hash/at are computed here, not
// accepted from the caller — an agent can no longer backdate a step or attach it to a plan it wasn't
// actually run against. `execution`, when given, upgrades the record from an analysis claim to proof
// that a specific command actually ran (test/build/lint/migration-dry-run/operational-verification).
export function evidenceRecord(value: string, requirementId: string | string[], summary: string, actor = "agent", execution?: ExecutionProof): number {
  const path = taskPath(value);
  if (!existsSync(path)) { output({ valid: false, errors: [`task state is missing: ${path}`] }); return 1; }
  const ids = requirementIds(requirementId);
  if (!ids.length || !summary) { output({ valid: false, errors: ["evidence-record requires --requirement-id and --summary"] }); return 1; }
  if (execution && (!execution.cwd || !execution.startedAt || !execution.outputDigest || !Number.isInteger(execution.exitCode) || !Number.isInteger(execution.durationMs))) { output({ valid: false, errors: ["evidence-record --command requires --cwd, --exit-code, --started-at, --duration-ms, and --output-digest together"] }); return 1; }
  return appendStepEvidence("evidence-record", path, ids, summary, actor, "attested", execution);
}

// The one write path both evidence commands funnel through, so the plan/intent stamping, the
// selected-step check and the schema validation cannot drift between an attested and a runtime record.
// The plan/intent freshness check (and, for evidence-run, the pre-spawn `expected` comparison) is
// done again here against `current` — read fresh inside the file lock — rather than trusting the
// pre-lock computation the caller passed in: a task concurrently rewritten between that pre-lock read
// and this callback actually running must reject the write outright, not just let task-gate catch it
// afterward and leave a stale entry sitting in evidence history.
function appendStepEvidence(command: string, path: string, ids: string[], summary: string, actor: string, trustLevel: "attested" | "runtime", execution?: ExecutionProof, expected?: { plan_hash: string; intent_hash: string }): number {
  try {
    const state = mutateJsonState<JsonObject>(path, (current) => {
      assertMutable(current, command, RUNNING_STATUSES);
      const plan = compilePlanForTaskPath(current, path);
      const selectedStepIds = selectedEvidenceIds(plan);
      const invalid = ids.filter((id) => !selectedStepIds.has(id));
      if (invalid.length) throw new Error(`${command}: '${invalid.join(", ")}' is not a selected evidence step for this task; expected one of: ${[...selectedStepIds].join(", ") || "(none)"}`);
      const intent_hash = currentIntentHash(path);
      if (expected && (expected.plan_hash !== plan.plan_hash || expected.intent_hash !== intent_hash)) throw new Error(`${command}: task changed during evidence-run, re-run required`);
      const evidence = Array.isArray(current.evidence) ? current.evidence : [];
      const at = now();
      for (const id of ids) evidence.push({
        kind: "step", id, status: "recorded", at, plan_hash: plan.plan_hash, plan_revision: Number(current.plan_revision || 1), intent_hash, actor, summary, trust_level: trustLevel,
        ...(execution ? { evidence_kind: "execution", command: execution.command, cwd: execution.cwd, exit_code: execution.exitCode, started_at: execution.startedAt, duration_ms: execution.durationMs, output_digest: execution.outputDigest } : { evidence_kind: "analysis" })
      });
      current.evidence = evidence;
      current.updated_at = now();
      const errors = schemaErrors(current);
      if (errors.length) throw new Error(`${command}: resulting task.json fails schema: ${errors.join("; ")}`);
    });
    output({ valid: true, task: path, ...(ids.length === 1 ? { id: ids[0] } : { ids }), state_revision: state.state_revision });
    return 0;
  } catch (error) { output({ valid: false, errors: [String((error as Error).message || error)] }); return 1; }
}

// Runs the command itself and records what it observed, so command/exit_code/duration/output digest
// are measurements rather than caller assertions.
export function evidenceRun(value: string, requirementId: string | string[], summary: string, actor: string, argv: string[], cwdValue = process.cwd()): number {
  const path = taskPath(value);
  if (!existsSync(path)) { output({ valid: false, errors: [`task state is missing: ${path}`] }); return 1; }
  const ids = requirementIds(requirementId);
  if (!ids.length || !summary) { output({ valid: false, errors: ["evidence-run requires --requirement-id and --summary"] }); return 1; }
  if (!argv.length) { output({ valid: false, errors: ["evidence-run requires a command after `--`"] }); return 1; }
  let expected: { plan_hash: string; intent_hash: string };
  // Checked before the spawn as well as inside the lock: a task that can never accept the result has
  // no business running the command at all.
  try {
    const current = task(path);
    assertMutable(current, "evidence-run", RUNNING_STATUSES);
    const plan = compilePlanForTaskPath(current, path);
    const selectedStepIds = selectedEvidenceIds(plan);
    const invalid = ids.filter((id) => !selectedStepIds.has(id));
    if (invalid.length) throw new Error(`evidence-run: '${invalid.join(", ")}' is not a selected evidence step for this task; expected one of: ${[...selectedStepIds].join(", ") || "(none)"}`);
    expected = { plan_hash: plan.plan_hash, intent_hash: currentIntentHash(path) };
  }
  catch (error) { output({ valid: false, errors: [String((error as Error).message || error)] }); return 1; }
  // Nothing holds the task lock across the spawn: a long command must not block every other writer.
  // appendStepEvidence re-checks both hashes afterwards, so a task edited meanwhile is rejected.
  const startedAt = new Date();
  const result = spawnSync(argv[0], argv.slice(1), { cwd: cwdValue, encoding: "buffer" });
  if (result.error) { output({ valid: false, errors: [`evidence-run: command could not be started: ${String(result.error.message)}`] }); return 1; }
  const execution: ExecutionProof = {
    command: argv.join(" "), cwd: cwdValue, exitCode: result.status ?? 1, startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    outputDigest: createHash("sha256").update(result.stdout || Buffer.alloc(0)).update(result.stderr || Buffer.alloc(0)).digest("hex")
  };
  return appendStepEvidence("evidence-run", path, ids, summary, actor, "runtime", execution, expected);
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
    const roleKey = roleId.startsWith("role.") ? roleId : `role.${roleId}`;
    const repoRoot = projectIdentity(repoRootValue).root;
    // Selected-role check, base_commit, plan/intent stamping and the diff fingerprint are all
    // recomputed here against `current` (read fresh inside the file lock) rather than an earlier
    // pre-lock read: a task concurrently reclassified or re-activated between that read and this
    // callback running must reject the write, not record a review against state that already changed.
    const state = mutateJsonState<JsonObject>(path, (current) => {
      assertMutable(current, "review-record", RUNNING_STATUSES);
      const plan = compilePlanForTaskPath(current, path);
      const selectedRoles = new Set(plan.selected.filter((capability) => capability.kind === "role").map((capability) => `role.${String(capability.name)}`));
      if (!selectedRoles.has(roleKey)) throw new Error(`review-record: '${roleKey}' is not a selected role for this task; expected one of: ${[...selectedRoles].join(", ") || "(none)"}`);
      // No HEAD fallback: a code task always gets base_commit from activation (task-init or
      // task-write), so a missing one means activation was skipped or the state predates it, not
      // something safe to paper over with the working tree's current HEAD.
      const base = String(current.base_commit || "");
      if (!base) throw new Error("review-record: task has no base_commit; the code task was not correctly activated");
      const paths = changedPaths(repoRoot, base);
      if (!paths.length) throw new Error("review-record: no changed paths found between reviewed_base and the working tree; nothing to review");
      const reviewedDiffSha256 = diffFingerprint(repoRoot, base, paths);
      const delivery = deliveryHash(repoRoot, base);
      const intent_hash = currentIntentHash(path);
      const evidence = Array.isArray(current.evidence) ? current.evidence : [];
      evidence.push({ kind: "role", id: roleKey, result, at: now(), plan_hash: plan.plan_hash, intent_hash, plan_revision: Number(current.plan_revision || 1), reviewed_base: base, reviewed_paths: paths, reviewed_diff_sha256: reviewedDiffSha256, delivery_hash: delivery, summary });
      current.evidence = evidence;
      current.updated_at = now();
      const errors = schemaErrors(current);
      if (errors.length) throw new Error(`review-record: resulting task.json fails schema: ${errors.join("; ")}`);
    });
    const recorded = (state.evidence as JsonObject[]).at(-1) as JsonObject;
    output({ valid: true, task: path, id: roleKey, result, reviewed_base: recorded.reviewed_base, reviewed_paths: recorded.reviewed_paths, delivery_hash: recorded.delivery_hash, state_revision: state.state_revision });
    return 0;
  } catch (error) { output({ valid: false, errors: [String((error as Error).message || error)] }); return 1; }
}
