import { Ajv } from "ajv";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, JsonObject, schemaPath, sha256 } from "./core.js";

// workflow-policy.schema.json is draft-07 (no 2020-12 features needed here), so the default ajv
// export already carries its meta-schema — unlike task.schema.json's Ajv2020 workaround in lifecycle.ts.
const ajv = new Ajv({ allErrors: true, strict: false });
const validatePolicySchema = ajv.compile(JSON.parse(readFileSync(schemaPath("workflow-policy.schema.json"), "utf8")) as JsonObject);

export type WorkflowContext = {
  facts: JsonObject;
  risk_flags: string[];
  change_kind: string;
  task_type: string;
  impact_scope: string;
  impact_effect: string;
  impact_confidence: string;
};

function contextOf(task: JsonObject): WorkflowContext {
  const facts = typeof task.workflow_facts === "string" ? JSON.parse(task.workflow_facts) as JsonObject : (task.workflow_facts || {}) as JsonObject;
  return {
    facts,
    risk_flags: Array.isArray(task.risk_flags) ? task.risk_flags.map(String) : [],
    change_kind: String(task.change_kind || ""),
    task_type: String(task.task_type || ""),
    impact_scope: String(task.impact_scope || ""),
    impact_effect: String(task.impact_effect || ""),
    impact_confidence: String(task.impact_confidence || "")
  };
}

function rankAtLeast(current: string, threshold: string, ranks: JsonObject): boolean {
  if (!(current in ranks) || !(threshold in ranks)) return true; // unrecognized value on either side is unknown; unknown keeps the step
  return Number(ranks[current]) >= Number(ranks[threshold]);
}

export type MatchResult = "match" | "no_match" | "unknown";
const not = (result: MatchResult): MatchResult => result === "match" ? "no_match" : result === "no_match" ? "match" : "unknown";

export function evaluateCondition(condition: JsonObject, ctx: WorkflowContext, ranks: { scope: JsonObject; effect: JsonObject }): MatchResult {
  if (condition.always === true) return "match";
  if (condition.not && typeof condition.not === "object" && !Array.isArray(condition.not)) return not(evaluateCondition(condition.not as JsonObject, ctx, ranks));
  if (typeof condition.fact === "string") {
    if (!(condition.fact in ctx.facts)) return "unknown";
    const expected = Array.isArray(condition.equals) ? condition.equals.map(String) : [];
    return expected.includes(String(ctx.facts[condition.fact])) ? "match" : "no_match";
  }
  if (Array.isArray(condition.risk_flags)) return condition.risk_flags.map(String).some((flag) => ctx.risk_flags.includes(flag)) ? "match" : "no_match";
  if (Array.isArray(condition.change_kind)) return condition.change_kind.map(String).includes(ctx.change_kind) ? "match" : "no_match";
  if (Array.isArray(condition.task_type)) return condition.task_type.map(String).includes(ctx.task_type) ? "match" : "no_match";
  if (Array.isArray(condition.impact_scope)) return condition.impact_scope.map(String).includes(ctx.impact_scope) ? "match" : "no_match";
  if (Array.isArray(condition.impact_effect)) return condition.impact_effect.map(String).includes(ctx.impact_effect) ? "match" : "no_match";
  if (Array.isArray(condition.impact_confidence)) return condition.impact_confidence.map(String).includes(ctx.impact_confidence) ? "match" : "no_match";
  if (typeof condition.impact_scope_at_least === "string") return rankAtLeast(ctx.impact_scope, condition.impact_scope_at_least, ranks.scope) ? "match" : "no_match";
  // Reachable only if a condition bypassed loadPolicy's schema validation (e.g. a hand-built
  // policy object in a test) — schema-valid policies always match one of the branches above.
  throw new Error(`workflow-policy: condition has no recognized operator: ${canonicalJson(condition)}`);
}

export function evaluateGroups(groups: JsonObject[][] | undefined, ctx: WorkflowContext, ranks: { scope: JsonObject; effect: JsonObject }): MatchResult {
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

// The one hash-relevant input set (policy + sibling task.md) every command must feed
// compileWorkflowPlan identically, so task-gate / waive / workflow-plan never disagree on
// requirements_hash for the same task.json on disk.
export function compilePlanForTaskPath(task: JsonObject, taskJsonPath: string, policyPath = schemaPath("workflow-policy.json")): CompiledWorkflowPlan {
  const taskMd = join(dirname(taskJsonPath), "task.md");
  return compileWorkflowPlan(task, loadPolicy(policyPath), {
    taskMdSha256: existsSync(taskMd) ? sha256(readFileSync(taskMd)) : undefined,
    policySha256: sha256(readFileSync(policyPath))
  });
}

export function selectSteps(capability: JsonObject, ctx: WorkflowContext, ranks: { scope: JsonObject; effect: JsonObject }): JsonObject[] {
  const steps = Array.isArray(capability.steps) ? capability.steps as JsonObject[] : [];
  return steps.filter((step) => evaluateGroups(step.when as JsonObject[][] | undefined, ctx, ranks) !== "no_match");
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
  suggested: JsonObject[];
  requested: string[];
  effective: string[];
  order: string[];
  selected: JsonObject[];
  required_evidence: string[];
  policy_version: number;
  policy_sha256?: string;
  requirements_hash: string;
};

export function compileWorkflowPlan(task: JsonObject, policy: JsonObject, options: { taskMdSha256?: string; policySha256?: string } = {}): CompiledWorkflowPlan {
  const capabilities = policy.capabilities as JsonObject[];
  const names = new Set(capabilities.map((capability) => String(capability.name)));
  const requested = Array.isArray(task.workflow_request) ? task.workflow_request.map(String) : [];
  const unknown = requested.filter((name) => !names.has(name));
  if (unknown.length) throw new Error(`workflow-plan: unknown capability: ${unknown.join(", ")}`);
  const ctx = contextOf(task);
  const ranks = { scope: policy.scope_rank as JsonObject, effect: (policy.effect_rank || {}) as JsonObject };
  const required = capabilities.filter((capability) => Array.isArray(capability.require_when) && capability.require_when.length > 0 && evaluateGroups(capability.require_when as JsonObject[][], ctx, ranks) !== "no_match").map((capability) => String(capability.name));
  const effective = [...new Set([...required, ...requested])];
  const order = orderCapabilities(effective, capabilities);
  const selected = order.map((name) => capabilities.find((capability) => String(capability.name) === name)!).map((capability) => ({
    name: capability.name, kind: capability.kind, section: capability.section,
    steps: selectSteps(capability, ctx, ranks).map((step) => ({ id: step.id, title: step.title }))
  }));
  const required_evidence = [
    ...selected.filter((capability) => capability.kind === "evidence").flatMap((capability) => capability.steps.map((step) => `${capability.name}.${String(step.id)}`)),
    ...selected.filter((capability) => capability.kind === "role").map((capability) => `role.${capability.name}`)
  ];
  const suggested = capabilities.filter((capability) => Array.isArray(capability.suggest_when) && evaluateGroups(capability.suggest_when as JsonObject[][], ctx, ranks) === "match").map((capability) => ({ name: capability.name, kind: capability.kind, section: capability.section, reason: capability.suggest_reason || "task metadata matched" }));
  const policy_version = Number(policy.version || 0);
  const selected_step_ids = [...new Set(selected.flatMap((capability) => capability.steps.map((step) => String(step.id))))].sort();
  const requirements_hash = sha256(canonicalJson({
    policy_version, policy_sha256: options.policySha256 ?? null, task_md_sha256: options.taskMdSha256 ?? null,
    code_change: task.code_change ?? null, workflow_mode: task.workflow_mode ?? null,
    task_type: ctx.task_type, change_kind: ctx.change_kind, impact_scope: ctx.impact_scope, impact_effect: ctx.impact_effect, impact_confidence: ctx.impact_confidence,
    risk_flags: [...ctx.risk_flags].sort(), workflow_facts: ctx.facts,
    required: [...required].sort(), requested: [...requested].sort(), effective: [...effective].sort(), selected_step_ids
  }));
  return { required, suggested, requested, effective, order, selected, required_evidence, policy_version, ...(options.policySha256 ? { policy_sha256: options.policySha256 } : {}), requirements_hash };
}
