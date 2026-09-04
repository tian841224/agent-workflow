import { Ajv } from "ajv";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { JsonObject, schemaPath } from "../core.js";

const taskSchema = JSON.parse(readFileSync(schemaPath("task.schema.json"), "utf8")) as JsonObject;
export const freezeRequired = new Set(((taskSchema.x_agent_workflow as JsonObject | undefined)?.freeze_required as string[] | undefined) || []);
// task.schema.json declares 2020-12; ajv's default export only ships the draft-07 meta-schema, and
// ajv/dist/2020 has no "exports" map entry for NodeNext to resolve statically, so pull it via require
const Ajv2020 = createRequire(import.meta.url)("ajv/dist/2020.js") as unknown as typeof Ajv;
const ajv = new Ajv2020({ allErrors: true, strict: false }); // task.schema.json carries the non-standard x_agent_workflow annotation keyword
// ajv-formats ships only a CJS default export with no "exports" map, which NodeNext can't type as callable via a static import
(createRequire(import.meta.url)("ajv-formats") as (instance: Ajv) => void)(ajv);
const validateTask = ajv.compile(taskSchema);
export function schemaErrors(state: JsonObject): string[] {
  return validateTask(state) ? [] : (validateTask.errors || []).map((error: { instancePath?: string; message?: string }) => `task.json${error.instancePath || ""} ${error.message}`.trim());
}
