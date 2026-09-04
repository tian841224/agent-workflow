import { JsonObject } from "../core.js";

const DEEP_RISK_FLAGS = new Set(["financial", "authorization", "schema", "migration", "cross_feature", "irreversible"]);
const DEEP_IMPACT_EFFECTS = new Set(["shared_behavior", "schema", "data", "contract", "destructive"]);

// Derives a read_only task's model cost tier from its declared classification.
export function deriveModelProfile(task: JsonObject): "cheap_read" | "deep_read" {
  const impactScope = String(task.impact_scope || "");
  const impactEffect = String(task.impact_effect || "");
  const riskFlags = Array.isArray(task.risk_flags) ? task.risk_flags.map(String) : [];
  if (impactScope === "multi_module" || impactScope === "cross_project") return "deep_read";
  if (riskFlags.some((flag) => DEEP_RISK_FLAGS.has(flag))) return "deep_read";
  if (DEEP_IMPACT_EFFECTS.has(impactEffect)) return "deep_read";
  return "cheap_read";
}
