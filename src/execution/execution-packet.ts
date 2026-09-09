import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Json, JsonObject, output, readJson } from "../core.js";
import { intentHash, sections } from "../intent.js";
import { freezeRequired, schemaErrors } from "../lifecycle/task-schema.js";
import { compilePlanForTaskPath } from "../workflow-policy.js";

// Named references only — pointers to real documents this repo already ships, never invented ones.
// The packet carries the compact evidence procedure by default; workflow-policy.json remains the
// source of truth for capability selection and step titles (see capability-selection.md).
export const PROCEDURE_POINTERS: Record<string, string> = {
  codebase_design: ".agents/skills/codebase-design/SKILL.md",
  bug_diagnosis: ".agents/skills/diagnosing-bugs/SKILL.md",
  tdd: ".agents/skills/tdd/SKILL.md",
  operational_verification: ".agents/skills/operational-verification/SKILL.md",
  reviewer: ".agents/skills/workflow/review.md"
};
export const DEFAULT_PROCEDURE = ".agents/skills/workflow/evidence.md";
export const PROFILE_PROCEDURES = {
  expanded: ".agents/skills/workflow/elevated.md",
  coordinator: ".agents/skills/workflow/orchestration.md",
  worker: ".agents/agents/worker.md",
  projectDocs: ".agents/skills/project-docs/SKILL.md"
} as const;

type ExecutionCapability = { name: string; kind: string; steps: { id: string; title: string }[] };

// Resolve every agent-facing procedure from the same compiled plan. Profile and role documents
// are added only when their context is present, so focused tasks do not pay for expanded guidance.
export function resolveProcedures(plan: Pick<import("../workflow-policy.js").CompiledWorkflowPlan, "order" | "exploration_profile">, task: JsonObject = {}): string[] {
  // managed_change:false is the explicit workflow bypass. Keep the packet free of workflow
  // procedures even if a caller supplies stale role/code metadata alongside that classification.
  if (task.managed_change === false) return [];
  const procedures = plan.order.map((name) => PROCEDURE_POINTERS[name] || DEFAULT_PROCEDURE);
  const role = String(task.subtask_role || "");
  if (plan.exploration_profile === "expanded" || role === "coordinator" || role === "worker") procedures.push(PROFILE_PROCEDURES.expanded);
  if (role === "coordinator") procedures.push(PROFILE_PROCEDURES.coordinator);
  if (role === "worker") procedures.push(PROFILE_PROCEDURES.worker);
  if (task.code_change === true) procedures.push(PROFILE_PROCEDURES.projectDocs);
  return [...new Set(procedures)].sort();
}

export type ExecutionPacket = {
  task_id: string;
  intent: { goal: string; scope: string; completion_criteria: string };
  classification: {
    code_change: boolean; managed_change: boolean; workflow_mode: string; task_type: string;
    impact_scope: string; impact_effect: string; impact_confidence: string;
    risk_flags: string[]; workflow_facts: JsonObject;
  };
  constraints: { repo_root: string; file_ownership: string[]; subtask_role?: string; parent_task_id?: string; base_commit?: string };
  workflow: { required: string[]; requested: string[]; selected: string[]; capabilities: ExecutionCapability[]; exploration_profile: "focused" | "expanded" };
  procedures: string[];
  required_evidence: string[];
  plan_hash: string;
  plan_revision: number;
  intent_hash: string;
};

function asObject(value: Json | undefined): JsonObject {
  return !value || Array.isArray(value) || typeof value !== "object" ? {} : value as JsonObject;
}

function asStrings(value: Json | undefined): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

// A worker must never start from a packet whose premise could already be wrong: unresolved
// classification would leave it guessing at capabilities the policy hasn't actually settled on, and
// a stale freeze-required approval would leave it building against a Goal/Scope/Completion criteria
// the user never actually confirmed. This is a preflight, not the close gate: it only demands what
// must hold before implementation starts, never post-implementation evidence (task-gate owns that).
type ReadinessResult = { errors: string[]; plan?: ReturnType<typeof compilePlanForTaskPath> };

function readinessErrors(task: JsonObject, taskJsonPath: string, taskMdContent: string | null): ReadinessResult {
  const errors = schemaErrors(task);
  const status = String((task.lifecycle as JsonObject | undefined)?.status || "");
  if (status !== "in_progress") errors.push(`task lifecycle.status must be 'in_progress' to build an execution packet, got '${status || "(missing)"}'`);
  if (taskMdContent === null) errors.push("sibling task.md is missing; Goal/Scope/Completion criteria cannot be verified");
  let liveIntentHash: string | undefined;
  if (taskMdContent !== null) {
    try { liveIntentHash = intentHash(taskMdContent); }
    catch (error) { errors.push(String((error as Error).message || error)); }
  }
  let plan: ReturnType<typeof compilePlanForTaskPath> | undefined;
  try {
    plan = compilePlanForTaskPath(task, taskJsonPath);
    // Same exemption task-gate applies: an unmanaged task never reaches the capabilities these
    // fields gate, so demanding them here would leave a legitimate managed_change:false task unable
    // to ever produce a packet.
    if (task.managed_change === true) {
      for (const entry of plan.classification_incomplete) errors.push(`workflow classification is incomplete: ${String(entry.name)} cannot be decided until ${(entry.missing as string[]).join(", ")} is declared`);
      for (const entry of plan.step_classification_incomplete) errors.push(`workflow step classification is incomplete: ${String(entry.capability)}.${String(entry.id)} cannot be decided until ${(entry.missing as string[]).join(", ")} is declared`);
    }
  } catch (error) { errors.push(`workflow-plan compile failed: ${String((error as Error).message || error)}`); }
  const riskFlags = Array.isArray(task.risk_flags) ? task.risk_flags.map(String) : [];
  if (riskFlags.some((flag) => freezeRequired.has(flag))) {
    const approval = task.intent_approval;
    if (!approval || Array.isArray(approval) || typeof approval !== "object") errors.push("intent_approval is required for a freeze-required risk flag but is missing");
    else if (!liveIntentHash) errors.push("intent_approval cannot be verified: sibling task.md is missing or has no valid intent");
    else if (String((approval as JsonObject).intent_hash || "") !== liveIntentHash) errors.push("intent_approval.intent_hash is stale: Goal/Scope/Completion criteria changed since approval");
  }
  return { errors, plan };
}

// The single execution contract a dispatched worker runs from: intent, already-decided
// classification, the compiled capabilities and their steps, the workspace boundary it may write
// in, and the procedures those capabilities name. A worker reads this instead of re-reading the
// workflow policy and making a second capability decision of its own.
export function buildExecutionPacket(task: JsonObject, taskJsonPath: string, repoRoot = process.cwd()): ExecutionPacket {
  const taskMdPath = join(dirname(taskJsonPath), "task.md");
  const taskMdContent = existsSync(taskMdPath) ? readFileSync(taskMdPath, "utf8") : null;
  const readiness = readinessErrors(task, taskJsonPath, taskMdContent);
  if (readiness.errors.length) throw new Error(`execution-packet is not ready: ${readiness.errors.join("; ")}`);
  if (!readiness.plan) throw new Error("execution-packet is not ready: workflow plan is unavailable");
  const plan = readiness.plan;
  const intent = taskMdContent !== null ? sections(taskMdContent) : new Map<string, string>();
  const section = (name: string): string => (intent.get(name) || "").trim();
  const capabilities: ExecutionCapability[] = plan.selected.map((capability) => ({
    name: String(capability.name), kind: String(capability.kind),
    steps: (capability.steps as JsonObject[]).map((step) => ({ id: String(step.id), title: String(step.title) }))
  }));
  const selectedNames = capabilities.map((capability) => capability.name);
  const procedures = resolveProcedures(plan, task);
  const constraints: ExecutionPacket["constraints"] = { repo_root: resolve(repoRoot), file_ownership: asStrings(task.file_ownership) };
  if (typeof task.subtask_role === "string") constraints.subtask_role = task.subtask_role;
  if (typeof task.parent_task_id === "string") constraints.parent_task_id = task.parent_task_id;
  if (typeof task.base_commit === "string") constraints.base_commit = task.base_commit;
  return {
    task_id: String(task.id || ""),
    intent: { goal: section("goal"), scope: section("scope"), completion_criteria: section("completion criteria") },
    classification: {
      code_change: task.code_change === true,
      managed_change: task.managed_change === true,
      workflow_mode: String(task.workflow_mode || ""),
      task_type: String(task.task_type || ""),
      impact_scope: String(task.impact_scope || ""),
      impact_effect: String(task.impact_effect || ""),
      impact_confidence: String(task.impact_confidence || ""),
      risk_flags: asStrings(task.risk_flags),
      workflow_facts: asObject(task.workflow_facts)
    },
    constraints,
    workflow: { required: plan.required, requested: plan.requested, selected: selectedNames, capabilities, exploration_profile: plan.exploration_profile },
    procedures,
    required_evidence: plan.required_evidence,
    plan_hash: plan.plan_hash,
    plan_revision: Number(task.plan_revision || 0),
    intent_hash: intentHash(taskMdContent as string)
  };
}

export function executionPacketCommand(value: string, repoRoot = process.cwd()): number {
  const path = value.endsWith(".json") ? resolve(value) : join(resolve(value), "task.json");
  if (!existsSync(path)) { output({ valid: false, errors: [`task state is missing: ${path}`] }); return 1; }
  try {
    output(buildExecutionPacket(readJson(path) as JsonObject, path, repoRoot) as unknown as Json);
    return 0;
  } catch (error) { output({ valid: false, errors: [String((error as Error).message || error)] }); return 1; }
}
