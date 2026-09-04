import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Json, JsonObject, output, readJson } from "../core.js";
import { sections } from "../intent.js";
import { compilePlanForTaskPath } from "../workflow-policy.js";

// Named references only — pointers to real documents this repo already ships, never invented ones.
// Capabilities without a standalone procedure doc fall back to workflow-policy.json, which is the
// single source of truth for their step lists (see .agents/skills/workflow/capability-selection.md).
export const PROCEDURE_POINTERS: Record<string, string> = {
  codebase_design: ".agents/skills/codebase-design/SKILL.md",
  bug_diagnosis: ".agents/skills/diagnosing-bugs/SKILL.md",
  tdd: ".agents/skills/tdd/SKILL.md",
  reviewer: ".agents/skills/workflow/SKILL.md"
};
export const DEFAULT_PROCEDURE = "schemas/workflow-policy.json";

type ExecutionCapability = { name: string; kind: string; steps: { id: string; title: string }[] };

export type ExecutionPacket = {
  task_id: string;
  intent: { goal: string; scope: string; completion_criteria: string };
  classification: {
    code_change: boolean; managed_change: boolean; workflow_mode: string; task_type: string;
    impact_scope: string; impact_effect: string; impact_confidence: string;
    risk_flags: string[]; workflow_facts: JsonObject;
  };
  constraints: { repo_root: string; file_ownership: string[]; subtask_role?: string; parent_task_id?: string; base_commit?: string };
  workflow: { required: string[]; requested: string[]; selected: string[]; capabilities: ExecutionCapability[] };
  procedures: string[];
  required_evidence: string[];
  plan_hash: string;
  plan_revision: number;
};

function asObject(value: Json | undefined): JsonObject {
  return !value || Array.isArray(value) || typeof value !== "object" ? {} : value as JsonObject;
}

function asStrings(value: Json | undefined): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

// The single execution contract a dispatched worker runs from: intent, already-decided
// classification, the compiled capabilities and their steps, the workspace boundary it may write
// in, and the procedures those capabilities name. A worker reads this instead of re-reading the
// workflow policy and making a second capability decision of its own.
export function buildExecutionPacket(task: JsonObject, taskJsonPath: string, repoRoot = process.cwd()): ExecutionPacket {
  const plan = compilePlanForTaskPath(task, taskJsonPath);
  const taskMdPath = join(dirname(taskJsonPath), "task.md");
  const intent = existsSync(taskMdPath) ? sections(readFileSync(taskMdPath, "utf8")) : new Map<string, string>();
  const section = (name: string): string => (intent.get(name) || "").trim();
  const capabilities: ExecutionCapability[] = plan.selected.map((capability) => ({
    name: String(capability.name), kind: String(capability.kind),
    steps: (capability.steps as JsonObject[]).map((step) => ({ id: String(step.id), title: String(step.title) }))
  }));
  const selectedNames = capabilities.map((capability) => capability.name);
  const procedures = [...new Set(selectedNames.map((name) => PROCEDURE_POINTERS[name] || DEFAULT_PROCEDURE))].sort();
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
    workflow: { required: plan.required, requested: plan.requested, selected: selectedNames, capabilities },
    procedures,
    required_evidence: plan.required_evidence,
    plan_hash: plan.plan_hash,
    plan_revision: Number(task.plan_revision || 0)
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
