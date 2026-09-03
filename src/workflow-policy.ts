import { readFileSync } from "node:fs";
import { JsonObject, sha256 } from "./core.js";

export type WorkflowContext = {
  facts: JsonObject;
  risk_flags: string[];
  change_kind: string;
  task_type: string;
  impact_scope: string;
  impact_effect: string;
};

function contextOf(task: JsonObject): WorkflowContext {
  const facts = typeof task.workflow_facts === "string" ? JSON.parse(task.workflow_facts) as JsonObject : (task.workflow_facts || {}) as JsonObject;
  return {
    facts,
    risk_flags: Array.isArray(task.risk_flags) ? task.risk_flags.map(String) : [],
    change_kind: String(task.change_kind || ""),
    task_type: String(task.task_type || ""),
    impact_scope: String(task.impact_scope || ""),
    impact_effect: String(task.impact_effect || "")
  };
}

function rankAtLeast(current: string, threshold: string, ranks: JsonObject): boolean {
  if (!(current in ranks) || !(threshold in ranks)) return true; // unrecognized value on either side is unknown; unknown keeps the step
  return Number(ranks[current]) >= Number(ranks[threshold]);
}

export function evaluateCondition(condition: JsonObject, ctx: WorkflowContext, ranks: { scope: JsonObject; effect: JsonObject }): boolean {
  if (condition.always === true) return true;
  if (condition.not && typeof condition.not === "object" && !Array.isArray(condition.not)) return !evaluateCondition(condition.not as JsonObject, ctx, ranks);
  if (typeof condition.fact === "string") {
    const expected = Array.isArray(condition.equals) ? condition.equals.map(String) : [];
    return expected.includes(String(ctx.facts[condition.fact]));
  }
  if (Array.isArray(condition.risk_flags)) return condition.risk_flags.map(String).some((flag) => ctx.risk_flags.includes(flag));
  if (Array.isArray(condition.change_kind)) return condition.change_kind.map(String).includes(ctx.change_kind);
  if (Array.isArray(condition.task_type)) return condition.task_type.map(String).includes(ctx.task_type);
  if (Array.isArray(condition.impact_scope)) return condition.impact_scope.map(String).includes(ctx.impact_scope);
  if (Array.isArray(condition.impact_effect)) return condition.impact_effect.map(String).includes(ctx.impact_effect);
  if (typeof condition.impact_scope_at_least === "string") return rankAtLeast(ctx.impact_scope, condition.impact_scope_at_least, ranks.scope);
  if (typeof condition.impact_effect_at_least === "string") return rankAtLeast(ctx.impact_effect, condition.impact_effect_at_least, ranks.effect);
  return false;
}

export function evaluateGroups(groups: JsonObject[][] | undefined, ctx: WorkflowContext, ranks: { scope: JsonObject; effect: JsonObject }): boolean {
  if (!Array.isArray(groups) || !groups.length) return true;
  return groups.some((all) => all.every((condition) => evaluateCondition(condition, ctx, ranks)));
}

export function loadPolicy(path: string): JsonObject {
  const policy = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
  if (!Array.isArray(policy.capabilities)) throw new Error("workflow-policy: capabilities must be an array");
  if (!policy.scope_rank || typeof policy.scope_rank !== "object") throw new Error("workflow-policy: scope_rank is missing");
  if (!policy.effect_rank || typeof policy.effect_rank !== "object") throw new Error("workflow-policy: effect_rank is missing");
  return policy;
}

export function selectSteps(capability: JsonObject, ctx: WorkflowContext, ranks: { scope: JsonObject; effect: JsonObject }): JsonObject[] {
  const steps = Array.isArray(capability.steps) ? capability.steps as JsonObject[] : [];
  return steps.filter((step) => evaluateGroups(step.when as JsonObject[][] | undefined, ctx, ranks));
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
  suggested: JsonObject[];
  requested: string[];
  order: string[];
  selected: JsonObject[];
  required_evidence: string[];
  policy_version: number;
  requirements_hash: string;
};

export function compileWorkflowPlan(task: JsonObject, policy: JsonObject): CompiledWorkflowPlan {
  const capabilities = policy.capabilities as JsonObject[];
  const names = new Set(capabilities.map((capability) => String(capability.name)));
  const requested = Array.isArray(task.workflow_request) ? task.workflow_request.map(String) : [];
  const unknown = requested.filter((name) => !names.has(name));
  if (unknown.length) throw new Error(`workflow-plan: unknown capability: ${unknown.join(", ")}`);
  const ctx = contextOf(task);
  const ranks = { scope: policy.scope_rank as JsonObject, effect: policy.effect_rank as JsonObject };
  const order = orderCapabilities(requested, capabilities);
  const selected = order.map((name) => capabilities.find((capability) => String(capability.name) === name)!).map((capability) => ({
    name: capability.name, kind: capability.kind, section: capability.section,
    steps: selectSteps(capability, ctx, ranks).map((step) => ({ id: step.id, title: step.title }))
  }));
  const required_evidence = [
    ...selected.filter((capability) => capability.kind === "evidence").flatMap((capability) => capability.steps.map((step) => String(step.id))),
    ...selected.filter((capability) => capability.kind === "role").map((capability) => `${capability.name}:role`)
  ];
  const suggested = capabilities.filter((capability) => Array.isArray(capability.suggest_when) && evaluateGroups(capability.suggest_when as JsonObject[][], ctx, ranks)).map((capability) => ({ name: capability.name, kind: capability.kind, section: capability.section, reason: capability.suggest_reason || "task metadata matched" }));
  const policy_version = Number(policy.version || 0);
  const requirements_hash = sha256(JSON.stringify({ policy_version, requested: [...requested].sort(), risk_flags: [...ctx.risk_flags].sort(), facts: ctx.facts, impact_scope: ctx.impact_scope, impact_effect: ctx.impact_effect }));
  return { suggested, requested, order, selected, required_evidence, policy_version, requirements_hash };
}
