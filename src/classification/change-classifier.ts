import { JsonObject } from "../core.js";

export type WorkflowContext = {
  facts: JsonObject;
  managed_change: boolean | undefined;
  risk_flags: string[];
  task_type: string;
  impact_scope: string;
  impact_effect: string;
  impact_confidence: string;
};

// Reads task.json's declared classification fields into the shape workflow-policy's condition
// evaluator consumes. This is the one place that owns "what did the task declare" — policy
// decides what those facts require, runtime enforces it.
export function classificationContext(task: JsonObject): WorkflowContext {
  const facts = typeof task.workflow_facts === "string" ? JSON.parse(task.workflow_facts) as JsonObject : (task.workflow_facts || {}) as JsonObject;
  return {
    facts,
    managed_change: typeof task.managed_change === "boolean" ? task.managed_change : undefined,
    risk_flags: Array.isArray(task.risk_flags) ? task.risk_flags.map(String) : [],
    task_type: String(task.task_type || ""),
    impact_scope: String(task.impact_scope || ""),
    impact_effect: String(task.impact_effect || ""),
    impact_confidence: String(task.impact_confidence || "")
  };
}
