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

export type ExecutionPacket = {
  task_id: string;
  intent: { goal: string };
  classification: { task_type: string; impact_scope: string; impact_effect: string; risk_flags: string[] };
  workflow: { required: string[]; requested: string[]; selected: string[] };
  procedures: string[];
  required_evidence: string[];
  plan_hash: string;
  plan_revision: number;
};

// Bundles one task's intent, classification and compiled workflow plan into the single object an
// implementing agent needs, so it can load only the procedures its selected capabilities name
// instead of re-reading the whole policy and skill.
export function buildExecutionPacket(task: JsonObject, taskJsonPath: string): ExecutionPacket {
  const plan = compilePlanForTaskPath(task, taskJsonPath);
  const taskMdPath = join(dirname(taskJsonPath), "task.md");
  const goal = existsSync(taskMdPath) ? (sections(readFileSync(taskMdPath, "utf8")).get("goal") || "").trim() : "";
  const selectedNames = plan.selected.map((capability) => String(capability.name));
  const procedures = [...new Set(selectedNames.map((name) => PROCEDURE_POINTERS[name] || DEFAULT_PROCEDURE))].sort();
  return {
    task_id: String(task.id || ""),
    intent: { goal },
    classification: {
      task_type: String(task.task_type || ""),
      impact_scope: String(task.impact_scope || ""),
      impact_effect: String(task.impact_effect || ""),
      risk_flags: Array.isArray(task.risk_flags) ? task.risk_flags.map(String) : []
    },
    workflow: { required: plan.required, requested: plan.requested, selected: selectedNames },
    procedures,
    required_evidence: plan.required_evidence,
    plan_hash: plan.plan_hash,
    plan_revision: Number(task.plan_revision || 0)
  };
}

export function executionPacketCommand(value: string): number {
  const path = value.endsWith(".json") ? resolve(value) : join(resolve(value), "task.json");
  if (!existsSync(path)) { output({ valid: false, errors: [`task state is missing: ${path}`] }); return 1; }
  try {
    output(buildExecutionPacket(readJson(path) as JsonObject, path) as unknown as Json);
    return 0;
  } catch (error) { output({ valid: false, errors: [String((error as Error).message || error)] }); return 1; }
}
