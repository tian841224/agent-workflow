import { Ajv } from "ajv";
import { readFileSync } from "node:fs";
import { canonicalJson, Json, JsonObject, schemaPath, sha256 } from "./core.js";
import { classificationContext, WorkflowContext } from "./classification/change-classifier.js";

export type { WorkflowContext };

// workflow-policy.schema.json is draft-07 (no 2020-12 features needed here), so the default ajv
// export already carries its meta-schema — unlike task.schema.json's Ajv2020 workaround in lifecycle.ts.
const ajv = new Ajv({ allErrors: true, strict: false });
const validatePolicySchema = ajv.compile(JSON.parse(readFileSync(schemaPath("workflow-policy.schema.json"), "utf8")) as JsonObject);

export type MatchResult = "match" | "no_match" | "unknown";

// An undeclared or unrecognized rank is genuinely unknown, not a match. Collapsing it to "match"
// is what silently forced every at-least capability to be required on a half-filled task.
function rankAtLeast(current: string, threshold: string, ranks: JsonObject): MatchResult {
  if (!(current in ranks) || !(threshold in ranks)) return "unknown";
  return Number(ranks[current]) >= Number(ranks[threshold]) ? "match" : "no_match";
}
const not = (result: MatchResult): MatchResult => result === "match" ? "no_match" : result === "no_match" ? "match" : "unknown";
// An undeclared classification field is unknown; only a declared value can prove a no_match.
const member = (current: string, expected: Json[]): MatchResult => !current ? "unknown" : expected.map(String).includes(current) ? "match" : "no_match";

export function evaluateCondition(condition: JsonObject, ctx: WorkflowContext, ranks: { scope: JsonObject }): MatchResult {
  if (condition.always === true) return "match";
  if (condition.not && typeof condition.not === "object" && !Array.isArray(condition.not)) return not(evaluateCondition(condition.not as JsonObject, ctx, ranks));
  if (typeof condition.fact === "string") {
    if (!(condition.fact in ctx.facts)) return "unknown";
    const expected = Array.isArray(condition.equals) ? condition.equals.map(String) : [];
    return expected.includes(String(ctx.facts[condition.fact])) ? "match" : "no_match";
  }
  if (Array.isArray(condition.risk_flags)) return condition.risk_flags.map(String).some((flag) => ctx.risk_flags.includes(flag)) ? "match" : "no_match";
  if (Array.isArray(condition.task_type)) return member(ctx.task_type, condition.task_type);
  if (Array.isArray(condition.impact_scope)) return member(ctx.impact_scope, condition.impact_scope);
  if (Array.isArray(condition.impact_effect)) return member(ctx.impact_effect, condition.impact_effect);
  if (Array.isArray(condition.impact_confidence)) return member(ctx.impact_confidence, condition.impact_confidence);
  if (typeof condition.managed_change === "boolean") return ctx.managed_change === undefined ? "unknown" : ctx.managed_change === condition.managed_change ? "match" : "no_match";
  if (typeof condition.impact_scope_at_least === "string") return rankAtLeast(ctx.impact_scope, condition.impact_scope_at_least, ranks.scope);
  // Reachable only if a condition bypassed loadPolicy's schema validation (e.g. a hand-built
  // policy object in a test) — schema-valid policies always match one of the branches above.
  throw new Error(`workflow-policy: condition has no recognized operator: ${canonicalJson(condition)}`);
}

export function evaluateGroups(groups: JsonObject[][] | undefined, ctx: WorkflowContext, ranks: { scope: JsonObject }): MatchResult {
  if (!Array.isArray(groups) || !groups.length) return "match";
  const groupResults = groups.map((all) => {
    const results = all.map((condition) => evaluateCondition(condition, ctx, ranks));
    if (results.includes("no_match")) return "no_match";
    if (results.includes("unknown")) return "unknown";
    return "match";
  });
  if (groupResults.includes("match")) return "match";
  if (groupResults.includes("unknown")) return "unknown";
  return "no_match";
}

// Names the fields a require_when group needed but the task never declared, so an
// "incomplete classification" report tells the agent exactly what to fill in.
function undeclaredFields(groups: JsonObject[][], ctx: WorkflowContext): string[] {
  const missing = new Set<string>();
  const visit = (condition: JsonObject): void => {
    if (condition.not && typeof condition.not === "object" && !Array.isArray(condition.not)) return visit(condition.not as JsonObject);
    if (typeof condition.fact === "string" && !(condition.fact in ctx.facts)) missing.add(`workflow_facts.${condition.fact}`);
    if ((Array.isArray(condition.impact_scope) || typeof condition.impact_scope_at_least === "string") && !ctx.impact_scope) missing.add("impact_scope");
    if (Array.isArray(condition.impact_effect) && !ctx.impact_effect) missing.add("impact_effect");
    if (Array.isArray(condition.impact_confidence) && !ctx.impact_confidence) missing.add("impact_confidence");
    if (Array.isArray(condition.task_type) && !ctx.task_type) missing.add("task_type");
    if (typeof condition.managed_change === "boolean" && ctx.managed_change === undefined) missing.add("managed_change");
  };
  for (const group of groups) for (const condition of group) visit(condition);
  return [...missing].sort();
}

export function loadPolicy(path: string): JsonObject {
  const policy = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
  if (!validatePolicySchema(policy)) {
    const errors = (validatePolicySchema.errors || []).map((error) => `workflow-policy${error.instancePath || ""} ${error.message}`.trim());
    throw new Error(`workflow-policy schema invalid:\n${errors.join("\n")}`);
  }
  const capabilities = policy.capabilities as JsonObject[];
  const names = capabilities.map((capability) => String(capability.name));
  const duplicateNames = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicateNames.length) throw new Error(`workflow-policy: duplicate capability name(s): ${[...new Set(duplicateNames)].join(", ")}`);
  const nameSet = new Set(names);
  for (const capability of capabilities) {
    const after = Array.isArray(capability.order_after) ? capability.order_after.map(String) : [];
    const unknown = after.filter((name) => !nameSet.has(name));
    if (unknown.length) throw new Error(`workflow-policy: ${capability.name}.order_after references unknown capability: ${unknown.join(", ")}`);
    const stepIds = (Array.isArray(capability.steps) ? capability.steps as JsonObject[] : []).map((step) => String(step.id));
    const duplicateSteps = stepIds.filter((id, index) => stepIds.indexOf(id) !== index);
    if (duplicateSteps.length) throw new Error(`workflow-policy: ${capability.name} has duplicate step id(s): ${[...new Set(duplicateSteps)].join(", ")}`);
  }
  return policy;
}

// The one hash-relevant input set (policy + classification) every command must feed
// compileWorkflowPlan identically, so task-gate / waive / workflow-plan never disagree on
// plan_hash for the same task.json on disk. task.md's content feeds intent_hash separately (intent.ts).
export function compilePlanForTaskPath(task: JsonObject, taskJsonPath: string, policyPath = schemaPath("workflow-policy.json")): CompiledWorkflowPlan {
  return compileWorkflowPlan(task, loadPolicy(policyPath), { policySha256: sha256(readFileSync(policyPath)) });
}

// Mirrors the capability-level split: only a proven match selects a step, while an undecidable
// `when` is reported instead of being resolved either way by default.
export function selectSteps(capability: JsonObject, ctx: WorkflowContext, ranks: { scope: JsonObject }): { steps: JsonObject[]; incomplete: JsonObject[] } {
  const steps = Array.isArray(capability.steps) ? capability.steps as JsonObject[] : [];
  const evaluated = steps.map((step) => ({ step, result: evaluateGroups(step.when as JsonObject[][] | undefined, ctx, ranks) }));
  return {
    steps: evaluated.filter((entry) => entry.result === "match").map((entry) => entry.step),
    incomplete: evaluated.filter((entry) => entry.result === "unknown").map((entry) => ({
      capability: capability.name, id: entry.step.id,
      missing: undeclaredFields((entry.step.when as JsonObject[][] | undefined) || [], ctx)
    }))
  };
}

export function orderCapabilities(requested: string[], capabilities: JsonObject[]): string[] {
  const byName = new Map(capabilities.map((capability) => [String(capability.name), capability]));
  const nodes = requested.filter((name) => byName.has(name));
  const edges = new Map<string, Set<string>>(nodes.map((name) => [name, new Set()]));
  for (const name of nodes) {
    const after = byName.get(name)?.order_after;
    if (Array.isArray(after)) for (const dependency of after) if (nodes.includes(String(dependency))) edges.get(name)!.add(String(dependency));
  }
  const ordered: string[] = []; const done = new Set<string>();
  while (ordered.length < nodes.length) {
    const ready = nodes.filter((name) => !done.has(name) && [...edges.get(name)!].every((dependency) => done.has(dependency)));
    if (!ready.length) throw new Error(`workflow-policy cycle detected among: ${nodes.filter((name) => !done.has(name)).join(", ")}`);
    for (const name of ready.sort()) { ordered.push(name); done.add(name); }
  }
  return ordered;
}

export type CompiledWorkflowPlan = {
  required: string[];
  classification_incomplete: JsonObject[];
  step_classification_incomplete: JsonObject[];
  suggested: JsonObject[];
  requested: string[];
  effective: string[];
  order: string[];
  selected: JsonObject[];
  required_evidence: string[];
  runtime_required_evidence: string[];
  policy_version: number;
  policy_sha256?: string;
  plan_hash: string;
};

export function compileWorkflowPlan(task: JsonObject, policy: JsonObject, options: { policySha256?: string } = {}): CompiledWorkflowPlan {
  const capabilities = policy.capabilities as JsonObject[];
  const names = new Set(capabilities.map((capability) => String(capability.name)));
  const requested = Array.isArray(task.workflow_request) ? task.workflow_request.map(String) : [];
  const unknown = requested.filter((name) => !names.has(name));
  if (unknown.length) throw new Error(`workflow-plan: unknown capability: ${unknown.join(", ")}`);
  const ctx = classificationContext(task);
  const ranks = { scope: policy.scope_rank as JsonObject };
  // Two different decisions, deliberately not collapsed into one: a capability is forced only on a
  // proven match, while an undecidable require_when means the task's classification is still
  // incomplete. Reporting the second separately keeps "genuinely high risk" distinguishable from
  // "the agent has not filled the field in yet" — the gate blocks on both, for different reasons.
  const requireResults = capabilities
    .filter((capability) => Array.isArray(capability.require_when) && capability.require_when.length > 0)
    .map((capability) => ({ capability, result: evaluateGroups(capability.require_when as JsonObject[][], ctx, ranks) }));
  const required = requireResults.filter((entry) => entry.result === "match").map((entry) => String(entry.capability.name));
  // managed_change is the sole workflow entry gate: an unmanaged task must never actually start a
  // capability or role, no matter what a stale/imported workflow_request still names. required is
  // already naturally empty here (require_when reads managed_change out of ctx), but requested still
  // carried raw workflow_request into effective/selected/required_evidence below — that's the bypass
  // this guards against. classification_incomplete is suppressed too: an unmanaged task never reaches
  // the capabilities it would gate, so it must never be blocked on declaring them.
  const managedChange = task.managed_change !== false;
  const classification_incomplete = !managedChange ? [] : requireResults.filter((entry) => entry.result === "unknown").map((entry) => ({
    name: entry.capability.name,
    missing: undeclaredFields(entry.capability.require_when as JsonObject[][], ctx)
  }));
  const effective = managedChange ? [...new Set([...required, ...requested])] : [];
  const order = orderCapabilities(effective, capabilities);
  const step_classification_incomplete: JsonObject[] = [];
  const runtime_required_evidence: string[] = [];
  const selected = order.map((name) => capabilities.find((capability) => String(capability.name) === name)!).map((capability) => {
    const selection = selectSteps(capability, ctx, ranks);
    // order is already empty when unmanaged (effective is empty), so this never runs for such a task.
    step_classification_incomplete.push(...selection.incomplete);
    for (const step of selection.steps) if (capability.runtime_execution === "required" || step.runtime_execution === "required") runtime_required_evidence.push(`${String(capability.name)}.${String(step.id)}`);
    return { name: capability.name, kind: capability.kind, section: capability.section, steps: selection.steps.map((step) => ({ id: step.id, title: step.title })) };
  });
  const required_evidence = [
    ...selected.filter((capability) => capability.kind === "evidence").flatMap((capability) => capability.steps.map((step) => `${capability.name}.${String(step.id)}`)),
    ...selected.filter((capability) => capability.kind === "role").map((capability) => `role.${capability.name}`)
  ];
  const suggested = capabilities.filter((capability) => Array.isArray(capability.suggest_when) && evaluateGroups(capability.suggest_when as JsonObject[][], ctx, ranks) === "match").map((capability) => ({ name: capability.name, kind: capability.kind, section: capability.section, reason: capability.suggest_reason || "task metadata matched" }));
  const policy_version = Number(policy.version || 0);
  const selected_step_ids = [...new Set(selected.flatMap((capability) => capability.steps.map((step) => String(step.id))))].sort();
  // plan_hash covers policy + classification only — not task.md's prose, which is intent_hash's job
  // (see intent.ts). A task.md typo no longer invalidates evidence/waivers recorded against this plan.
  const plan_hash = sha256(canonicalJson({
    policy_version, policy_sha256: options.policySha256 ?? null,
    code_change: task.code_change ?? null, managed_change: task.managed_change ?? null, workflow_mode: task.workflow_mode ?? null,
    task_type: ctx.task_type, impact_scope: ctx.impact_scope, impact_effect: ctx.impact_effect, impact_confidence: ctx.impact_confidence,
    risk_flags: [...ctx.risk_flags].sort(), workflow_facts: ctx.facts,
    required: [...required].sort(), requested: [...requested].sort(), effective: [...effective].sort(), selected_step_ids
  }));
  return { required, classification_incomplete, step_classification_incomplete, suggested, requested, effective, order, selected, required_evidence, runtime_required_evidence, policy_version, ...(options.policySha256 ? { policy_sha256: options.policySha256 } : {}), plan_hash };
}
