import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { JsonObject, mutateJsonState, now, output } from "../core.js";
import { intentHash } from "../intent.js";
import { schemaErrors } from "./task-schema.js";
import { taskPath } from "./task-store.js";

// Runtime computes intent_hash itself from the sibling task.md; the caller only asserts who
// confirmed it. source is "user" only when the caller explicitly claims a real user confirmation —
// this runtime has no platform event bridge to verify that independently, so it is an honest
// attestation, not a cryptographic guarantee of user provenance.
export function approveIntent(value: string, confirmedBy: string, asUser: boolean): number {
  const path = taskPath(value);
  if (!existsSync(path)) { output({ valid: false, errors: [`task state is missing: ${path}`] }); return 1; }
  if (!confirmedBy) { output({ valid: false, errors: ["approve-intent requires --confirmed-by"] }); return 1; }
  const taskMd = join(dirname(path), "task.md");
  if (!existsSync(taskMd)) { output({ valid: false, errors: ["approve-intent: sibling task.md is missing"] }); return 1; }
  try {
    const hash = intentHash(readFileSync(taskMd, "utf8"));
    const state = mutateJsonState<JsonObject>(path, (current) => {
      current.intent_approval = { intent_hash: hash, confirmed_at: now(), confirmed_by: confirmedBy, source: asUser ? "user" : "cli-attestation" };
      current.updated_at = now();
      const errors = schemaErrors(current);
      if (errors.length) throw new Error(`approve-intent: resulting task.json fails schema: ${errors.join("; ")}`);
    });
    output({ valid: true, task: path, intent_hash: hash, intent_approval: state.intent_approval });
    return 0;
  } catch (error) { output({ valid: false, errors: [String((error as Error).message || error)] }); return 1; }
}
