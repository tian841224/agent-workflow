import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsRaw from "ajv-formats";
import { readFileSync } from "node:fs";
import { JsonObject, schemaPath } from "../core.js";

// ajv-formats' CJS default export types as an uncallable namespace under NodeNext; the cast
// restores the real runtime shape (a plugin function) without a bundler-opaque dynamic require.
const addFormats = addFormatsRaw as unknown as (instance: InstanceType<typeof Ajv2020>) => void;
const taskSchema = JSON.parse(readFileSync(schemaPath("task.schema.json"), "utf8")) as JsonObject;
export const freezeRequired = new Set(((taskSchema.x_agent_workflow as JsonObject | undefined)?.freeze_required as string[] | undefined) || []);
// task.schema.json declares 2020-12, which ajv's default (draft-07) export can't validate
const ajv = new Ajv2020({ allErrors: true, strict: false }); // task.schema.json carries the non-standard x_agent_workflow annotation keyword
addFormats(ajv);
const validateTask = ajv.compile(taskSchema);
export function schemaErrors(state: JsonObject): string[] {
  return validateTask(state) ? [] : (validateTask.errors || []).map((error: { instancePath?: string; message?: string }) => `task.json${error.instancePath || ""} ${error.message}`.trim());
}
