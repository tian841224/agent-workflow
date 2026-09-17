import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsRaw from "ajv-formats";
import { readFileSync } from "node:fs";
import { JsonObject, schemaPath } from "../core.js";

// ajv-formats' CJS default export types as an uncallable namespace under NodeNext; the cast
// restores the real runtime shape (a plugin function) without a bundler-opaque dynamic require.
const addFormats = addFormatsRaw as unknown as (instance: InstanceType<typeof Ajv2020>) => void;
const taskSchema = JSON.parse(readFileSync(schemaPath("task.schema.json"), "utf8")) as JsonObject;
export const freezeRequired = new Set(((taskSchema.x_agent_workflow as JsonObject | undefined)?.freeze_required as string[] | undefined) || []);
const CLASSIFICATION_FIELDS = ["task_type", "impact_scope", "impact_effect", "impact_confidence", "validation_profile"] as const;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function enumValues(value: unknown): string[] {
  return value && typeof value === "object" && !Array.isArray(value) ? strings((value as JsonObject).enum) : [];
}

// Help output reads the same schema used for persistence validation, so the documented values cannot
// drift from the task contract. This function is imported only by task-init/task-write help.
export function classificationHelp(): string {
  const properties = (taskSchema.properties || {}) as JsonObject;
  const lines = CLASSIFICATION_FIELDS.map((field) => `  ${field}: ${enumValues(properties[field]).join(" | ")}`);
  const riskFlags = (properties.risk_flags as JsonObject | undefined)?.items;
  lines.push(`  risk_flags[]: ${enumValues(riskFlags).join(" | ")}`);
  const facts = (((taskSchema.$defs as JsonObject | undefined)?.workflowFacts as JsonObject | undefined)?.propertyNames) as JsonObject | undefined;
  lines.push(`  workflow_facts keys: ${enumValues(facts).join(" | ")}`);
  return lines.join("\n");
}

type ValidationError = { instancePath?: string; keyword?: string; message?: string; params?: JsonObject };

function formatValidationError(error: ValidationError): string {
  const path = `task.json${error.instancePath || ""}`;
  const allowed = error.keyword === "enum" ? strings(error.params?.allowedValues) : [];
  const suffix = allowed.length ? `; allowed values: ${allowed.join(", ")}` : "";
  return `${path} ${error.message || "schema validation failed"}${suffix}`.trim();
}

// task.schema.json declares 2020-12, which ajv's default (draft-07) export can't validate
const ajv = new Ajv2020({ allErrors: true, strict: false }); // task.schema.json carries the non-standard x_agent_workflow annotation keyword
addFormats(ajv);
const validateTask = ajv.compile(taskSchema);
export function schemaErrors(state: JsonObject): string[] {
  return validateTask(state) ? [] : (validateTask.errors || []).map((error) => formatValidationError(error as ValidationError));
}
