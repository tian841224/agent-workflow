import { canonicalJson, Json, JsonObject, output, schemaPath, sha256 } from "./core.js";
import { compileWorkflowPlan, loadPolicy } from "./workflow-policy.js";

// The dimensions a policy condition can read, sampled rather than exhausted: every value of the two
// enums a require_when threshold ranks on, plus representative sets for the multi-valued inputs.
// Sampling is deliberate — the point is a stable tripwire, not a proof.
const TASK_TYPES = ["fix", "feature", "refactor", "chore", "schema", "migration", "config", "docs", "investigation", "read_only"];
const IMPACT_SCOPES = ["file", "module", "multi_module", "cross_project"];
const IMPACT_EFFECTS = ["none", "local_behavior", "shared_behavior", "data", "contract", "destructive"];
const IMPACT_CONFIDENCES = ["high", "low"];
const RISK_SETS: string[][] = [[], ["behavior_change"], ["schema", "migration"], ["financial", "data_write", "contract"], ["security", "authorization", "operational"]];
const BOOLEAN_FACTS = ["has_consumer", "schema_constraint_change", "data_transform", "destructive_operation", "changes_module_interface", "improves_testability", "introduces_adapter", "testable_behavior_change", "debug_requested", "flaky_failure", "performance_anomaly"];
// Three fact sets, because tri-state makes them three different questions: undeclared (unknown, the
// step is kept), declared true, and declared false. Only the all-false set isolates what the other
// classification fields contribute, since nothing is left unknown to keep a step alive.
const FACT_SETS: JsonObject[] = [
  {},
  { ...Object.fromEntries(BOOLEAN_FACTS.map((fact) => [fact, true])), schema_operation: "mutating" },
  { ...Object.fromEntries(BOOLEAN_FACTS.map((fact) => [fact, false])), schema_operation: "none" }
];

export type MatrixRow = { key: string; required: string[]; steps: Record<string, string[]> };

export function policyMatrix(policyPath = schemaPath("workflow-policy.json")): MatrixRow[] {
  const policy = loadPolicy(policyPath);
  const everyCapability = (policy.capabilities as JsonObject[]).map((capability) => String(capability.name));
  const rows: MatrixRow[] = [];
  for (const task_type of TASK_TYPES)
    for (const impact_scope of IMPACT_SCOPES)
      for (const impact_effect of IMPACT_EFFECTS)
        for (const impact_confidence of IMPACT_CONFIDENCES)
          for (const [riskIndex, risk_flags] of RISK_SETS.entries())
            for (const [factIndex, workflow_facts] of FACT_SETS.entries()) {
              // Requesting every capability exposes step-level selection independently of which
              // capabilities a real task would ask for.
              const plan = compileWorkflowPlan({ task_type, impact_scope, impact_effect, impact_confidence, risk_flags: risk_flags as unknown as Json, workflow_facts, workflow_request: everyCapability as unknown as Json }, policy);
              rows.push({
                key: `${task_type}|${impact_scope}|${impact_effect}|${impact_confidence}|risk${riskIndex}|facts${factIndex}`,
                required: plan.required,
                steps: Object.fromEntries(plan.selected.map((capability) => [String(capability.name), (capability.steps as JsonObject[]).map((step) => String(step.id))]))
              });
            }
  return rows;
}

// One digest per task_type, so a policy edit that changes what a given kind of task must run shows
// up as a one-line diff naming that kind, instead of as a 2000-row fixture churn.
export function policyMatrixDigests(rows: MatrixRow[]): Record<string, string> {
  const byType: Record<string, MatrixRow[]> = {};
  for (const row of rows) { const type = row.key.split("|")[0]; (byType[type] ||= []).push(row); }
  return Object.fromEntries(Object.entries(byType).map(([type, group]) => [type, sha256(canonicalJson(group as unknown as Json))]));
}

export function policyMatrixCommand(policyPath: string | undefined, mode: string, taskType = ""): number {
  const all = policyMatrix(policyPath || undefined);
  // Digests stay whole-matrix so the tripwire cannot be narrowed by accident; only the human-facing
  // row dump can be filtered, because the full dump is megabytes.
  if (mode !== "rows") { output({ rows: all.length, digests: policyMatrixDigests(all) }); return 0; }
  output((taskType ? all.filter((row) => row.key.startsWith(`${taskType}|`)) : all) as unknown as Json);
  return 0;
}
