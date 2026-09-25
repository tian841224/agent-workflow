import { Ajv } from "ajv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson, Json, JsonObject, schemaPath, sha256 } from "./core.js";
import { classificationContext, WorkflowContext } from "./classification/change-classifier.js";

export type { WorkflowContext };

// workflow-policy.schema.json is draft-07 (no 2020-12 features needed here), so the default ajv
// export already carries its meta-schema — unlike task.schema.json's Ajv2020 workaround in lifecycle.ts.
const ajv = new Ajv({ allErrors: true, strict: false });
const validatePolicySchema = ajv.compile(JSON.parse(readFileSync(schemaPath("workflow-policy.schema.json"), "utf8")) as JsonObject);

export type MatchResult = "match" | "no_match" | "unknown";

type LoadedPolicy = { policy: JsonObject; sha256: string };
const policyCache = new Map<string, LoadedPolicy>();

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
  if (typeof condition.code_change === "boolean") return ctx.code_change === undefined ? "unknown" : ctx.code_change === condition.code_change ? "match" : "no_match";
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
    if (typeof condition.code_change === "boolean" && ctx.code_change === undefined) missing.add("code_change");
  };
  for (const group of groups) for (const condition of group) visit(condition);
  return [...missing].sort();
}

function loadPolicyRecord(path: string): LoadedPolicy {
  const resolved = resolve(path);
  const raw = readFileSync(resolved);
  const digest = sha256(raw);
  const cached = policyCache.get(resolved);
  if (cached && cached.sha256 === digest) return cached;
  const policy = JSON.parse(raw.toString("utf8")) as JsonObject;
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
  const loaded = { policy, sha256: digest };
  policyCache.set(resolved, loaded);
  return loaded;
}

export function loadPolicy(path: string): JsonObject {
  return loadPolicyRecord(path).policy;
}

// Every command compiles the task through here so task-gate, waive and evidence writers agree on
// plan_hash. task.md's content feeds intent_hash separately (intent.ts).
export function compilePlanForTaskPath(task: JsonObject, _taskJsonPath: string, policyPath = schemaPath("workflow-policy.json")): CompiledWorkflowPlan {
  return compileWorkflowPlan(task, loadPolicyRecord(policyPath).policy);
}

// Only a proven match selects a step; an undecidable `when` is returned separately so the caller
// decides what an unknown means (the compiler keeps it on the checklist rather than gating on it).
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

export type PlanStep = { id: string; title: string; undecided_by?: string[] };
export type CompiledWorkflowPlan = {
  required: string[];
  classification_incomplete: JsonObject[];
  suggested: JsonObject[];
  requested: string[];
  effective: string[];
  order: string[];
  selected: JsonObject[];
  // Gate items: runtime-executed proofs plus role results. Attested analysis steps are never here.
  required_evidence: string[];
  proofs: PlanStep[];
  // Analysis steps of the selected capabilities. They steer the work and the reviewer's prompt but
  // are not gate items: an agent's own claim that it did them proves nothing the gate could check.
  checklist: PlanStep[];
  exploration_profile: "focused" | "expanded";
  policy_version: number;
  plan_hash: string;
};

export function compileWorkflowPlan(task: JsonObject, policy: JsonObject): CompiledWorkflowPlan {
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
  // managed_change is the sole workflow entry gate: an unmanaged task must never actually start a
  // capability or role, no matter what its classification or a stale/imported workflow_request still
  // names. Every derived field is zeroed rather than only the selected ones — a required/suggested
  // list computed from stale classification reads as an obligation even when nothing can select it.
  // classification_incomplete is suppressed for the same reason: an unmanaged task never reaches the
  // capabilities it would gate, so it must never be blocked on declaring them. requested is left as
  // recorded, since it is the task's own input rather than something this compilation derived.
  const managedChange = task.managed_change !== false;
  const required = !managedChange ? [] : requireResults.filter((entry) => entry.result === "match").map((entry) => String(entry.capability.name));
  const classification_incomplete = !managedChange ? [] : requireResults.filter((entry) => entry.result === "unknown").map((entry) => ({
    name: entry.capability.name,
    missing: undeclaredFields(entry.capability.require_when as JsonObject[][], ctx)
  }));
  const effective = managedChange ? [...new Set([...required, ...requested])] : [];
  const order = orderCapabilities(effective, capabilities);
  const proofs: PlanStep[] = [];
  const checklist: PlanStep[] = [];
  const selected = order.map((name) => capabilities.find((capability) => String(capability.name) === name)!).map((capability) => {
    const selection = selectSteps(capability, ctx, ranks);
    const allSteps = Array.isArray(capability.steps) ? capability.steps as JsonObject[] : [];
    const undecided = new Map(selection.incomplete.map((entry) => [String(entry.id), entry.missing as string[]]));
    // An undecidable step is kept rather than dropped, so an undeclared fact never removes work:
    // an analysis step joins the checklist, and a runtime step stays a gate proof until the fact
    // is declared. undecided_by names the facts that, once declared, settle whether it applies.
    const kept = allSteps.filter((step) => selection.steps.includes(step) || undecided.has(String(step.id)));
    for (const step of kept) {
      const missing = undecided.get(String(step.id));
      const entry: PlanStep = { id: `${String(capability.name)}.${String(step.id)}`, title: String(step.title), ...(missing?.length ? { undecided_by: missing } : {}) };
      if (capability.runtime_execution === "required" || step.runtime_execution === "required") proofs.push(entry);
      else checklist.push(entry);
    }
    return { name: capability.name, kind: capability.kind, section: capability.section, steps: kept.map((step) => ({ id: step.id, title: step.title })) };
  });
  const required_evidence = [
    ...proofs.map((step) => step.id),
    ...selected.filter((capability) => capability.kind === "role").map((capability) => `role.${capability.name}`)
  ];
  const suggested = (!managedChange ? [] : capabilities.filter((capability) => Array.isArray(capability.suggest_when) && evaluateGroups(capability.suggest_when as JsonObject[][], ctx, ranks) === "match")).map((capability) => ({ name: capability.name, kind: capability.kind, section: capability.section, reason: capability.suggest_reason || "task metadata matched" }));
  // A local behavior flag does not by itself justify expanded repository exploration. Scope,
  // confidence, effect and cross-boundary risks already identify the cases that need the deeper map.
  const expandedRisk = ["contract", "schema", "data_write", "authorization", "cross_feature", "migration", "irreversible", "unclear_requirements", "test_integrity", "security", "operational"];
  // A high-confidence, file-local financial fix already carries mutation evidence and a Reviewer;
  // exploring the whole repository adds reading, not verification. Wider financial scope still expands.
  const expandedFlag = (flag: string) => expandedRisk.includes(flag) || (flag === "financial" && ctx.impact_scope !== "file");
  const exploration_profile = !managedChange ? "focused" : (ctx.impact_scope === "multi_module" || ctx.impact_scope === "cross_project" || ["medium", "low"].includes(ctx.impact_confidence) || ["schema", "data", "contract", "destructive"].includes(ctx.impact_effect) || ctx.risk_flags.some(expandedFlag) ? "expanded" : "focused");
  const policy_version = Number(policy.version || 0);
  // plan_hash covers only what the gate demands (plus the exploration depth), not the policy file or
  // the raw classification: a policy edit or reclassification that leaves the gate items unchanged
  // must not invalidate evidence already recorded against them. task.md's prose is intent_hash's job.
  const plan_hash = sha256(canonicalJson({
    effective: [...effective].sort(), required_evidence: [...required_evidence].sort(), exploration_profile
  }));
  return { required, classification_incomplete, suggested, requested, effective, order, selected, required_evidence, proofs, checklist, exploration_profile, policy_version, plan_hash };
}

export function planOutput(plan: CompiledWorkflowPlan): JsonObject {
  return {
    required: plan.required,
    classification_incomplete: plan.classification_incomplete,
    suggested: plan.suggested,
    requested: plan.requested,
    selected: plan.selected.map((capability) => capability.name),
    exploration_profile: plan.exploration_profile,
    required_evidence: plan.required_evidence,
    proofs: plan.proofs,
    checklist: plan.checklist,
    plan_hash: plan.plan_hash,
    roles: plan.selected.filter((capability) => capability.kind === "role").map((capability) => capability.name)
  } as unknown as JsonObject;
}
