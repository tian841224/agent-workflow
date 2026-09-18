import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Json, JsonObject, mutateJsonState, now, option, optionList, output, readJson, schemaPath, sha256, stateRoot, writeAtomic } from "./core.js";
import { taskPath as resolveTaskPath } from "./lifecycle/task-store.js";

function taskIdFor(taskFilePath: string): string {
  const directory = dirname(taskFilePath); const taskJson = join(directory, "task.json");
  if (existsSync(taskJson)) { const id = readJson(taskJson).id; if (typeof id === "string" && id) return id; }
  return basename(directory);
}

type Options = Map<string, string | boolean | string[]>;
const string = option; // single-value reads share one implementation, so a duplicate flag errors here too
const values = optionList;
function index(root: string, store: string): [string, JsonObject] { const path = join(root, store, "index.json"); return [path, existsSync(path) ? readJson(path) : { schema_version: 1, entries: [] }]; }
// Matches id.pattern (^[0-9]{8}-[0-9]{6}-[a-f0-9]{8}$) in review-cause.schema.json: now()'s own
// hyphens have to go too, or the date portion keeps its "YYYY-MM-DD" separators baked in.
function findingId(taskId: string, key: string | number): string {
  const stamp = now().slice(0, 19).replace(/[-:T]/g, "");
  return `${stamp.slice(0, 8)}-${stamp.slice(8, 14)}-${sha256(`${taskId}|${key}`).slice(0, 8)}`;
}
function entries(data: JsonObject): JsonObject[] { if (!Array.isArray(data.entries)) throw new Error("index has no entries array"); return data.entries.filter((value): value is JsonObject => !!value && !Array.isArray(value) && typeof value === "object"); }
export type ReviewCauseInput = {
  root: string; taskPath: string; round: number; cause: string; evidence: string; paths: string[];
  missCategory?: string; introducedBy?: string; proposedChange?: string;
};

// round >= 2 is a review-round constraint; a regression is found after delivery, not during a
// review round, so it is exempt (the schema's own if/then enforces this the same way).
export function roundIsValid(round: number, cause: string): boolean { return cause === "regression" ? round >= 1 : round >= 2; }

// Review cause is learning telemetry, not a second completion gate. Keeping the write helper
// callable from review-record makes attribution optional on the delivery critical path while
// preserving the standalone review-cause command for explicit maintenance or older integrations.
// `cause: "regression"` is the one structured store for "a fix turned out to be a regression" too
// — there is no second escalation index to keep in sync with this one.
export function recordReviewCause(rawInput: ReviewCauseInput): JsonObject {
  // Accepts a task directory or the task.json file itself, the same way every other TASK_TARGET
  // command does — taskIdFor's dirname() assumes the latter, so a bare directory silently resolved
  // to the wrong task_id (its parent directory's name) before this normalization.
  const input: ReviewCauseInput = { ...rawInput, taskPath: rawInput.taskPath ? resolveTaskPath(rawInput.taskPath) : rawInput.taskPath };
  if (!existsSync(input.taskPath) || !roundIsValid(input.round, input.cause) || !input.cause || !input.evidence) throw new Error("review cause needs an existing task path, a valid round (>=2, or >=1 for a regression), cause, and evidence");
  if (input.cause === "regression" && !input.missCategory) throw new Error("review cause needs --miss-category when --cause is regression");
  const [path] = index(input.root, "review-causes");
  const schema = readJson(schemaPath("review-cause.schema.json")); const configuration = (schema.x_agent_workflow || {}) as JsonObject; const threshold = Number(configuration.escalate_threshold || 2); const routing = (configuration.remedy_routing || {}) as JsonObject;
  const allowedCauses = Array.isArray((schema.properties as JsonObject | undefined)?.cause && ((schema.properties as JsonObject).cause as JsonObject).enum) ? (((schema.properties as JsonObject).cause as JsonObject).enum as Json[]).map(String) : [];
  if (allowedCauses.length && !allowedCauses.includes(input.cause)) throw new Error(`review cause has unsupported cause: ${input.cause}`);
  const taskId = taskIdFor(input.taskPath); let ident = "";
  const locked = mutateJsonState(path, (state: JsonObject) => {
    if (!Array.isArray(state.entries)) state.entries = [];
    const list = entries(state); const existing = list.find((item) => item.task_id === taskId && item.round === input.round);
    ident = existing ? String(existing.id) : findingId(taskId, input.round);
    const item = existing || { id: ident, task_id: taskId, round: input.round, created_at: now() };
    Object.assign(item, {
      cause: input.cause, evidence: input.evidence, paths: input.paths, status: "open", updated_at: now(),
      ...(input.missCategory ? { miss_category: input.missCategory } : {}),
      ...(input.introducedBy ? { introduced_by: input.introducedBy } : {}),
      ...(input.proposedChange ? { proposed_change: input.proposedChange } : {})
    });
    if (!existing) list.push(item); state.entries = list; state.updated_at = now();
  });
  writeAtomic(join(input.root, "review-causes", "findings", `${ident}.md`), `---\nid: ${ident}\ntask_id: ${taskId}\nround: ${input.round}\ncause: ${input.cause}\nstatus: open\n---\n\n# ${taskId} round ${input.round}\n\n## What was missing\n\n${input.evidence}\n${input.proposedChange ? `\n## Proposed change\n\n${input.proposedChange}\n` : ""}`);
  const occurrences = entries(locked).filter((entry) => entry.cause === input.cause && entry.status === "open").length;
  return { ok: true, id: ident, cause: input.cause, remedy_kind: routing[input.cause] || "none", occurrences, escalate: routing[input.cause] !== "none" && occurrences >= threshold };
}
export function reviewCause(options: Options): number {
  const root = stateRoot(string(options, "state-root") || undefined); const action = string(options, "action"); const [path, data] = index(root, "review-causes"); const all = entries(data); const cause = string(options, "cause"); const status = string(options, "status");
  if (action === "List") { output(all.filter((item) => (!cause || item.cause === cause) && (!status || item.status === status)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))); return 0; }
  const schema = readJson(schemaPath("review-cause.schema.json")); const configuration = (schema.x_agent_workflow || {}) as JsonObject; const threshold = Number(configuration.escalate_threshold || 2); const routing = (configuration.remedy_routing || {}) as JsonObject;
  if (action === "Escalate") { const groups = new Map<string, JsonObject[]>(); for (const item of all) if (item.status === "open") groups.set(String(item.cause), [...(groups.get(String(item.cause)) || []), item]); output([...groups.entries()].filter(([key, group]) => routing[key] !== "none" && group.length >= Number(string(options, "min-occurrences") || threshold)).map(([key, group]) => ({ cause: key, remedy_kind: routing[key] || "none", occurrences: group.length, finding_ids: group.map((item) => item.id), task_ids: [...new Set(group.map((item) => item.task_id))], paths: [...new Set(group.flatMap((item) => Array.isArray(item.paths) ? item.paths : []))] }))); return 0; }
  if (action === "Resolve") { if (!["applied", "rejected"].includes(status)) throw new Error("Resolve needs --status applied or rejected"); const ids = values(options, "id"); mutateJsonState(path, (locked: JsonObject) => { if (!Array.isArray(locked.entries)) locked.entries = []; const list = entries(locked); for (const id of ids) { const item = list.find((entry) => entry.id === id); if (!item) throw new Error(`finding is missing: ${id}`); item.status = status; item.updated_at = now(); } locked.entries = list; locked.updated_at = now(); }); output({ ok: true, resolved: ids, status }); return 0; }
  if (action !== "Record") throw new Error(`unsupported review-cause action: ${action}`);
  const taskPath = string(options, "task-path"); const evidence = string(options, "evidence"); const round = Number(string(options, "round"));
  const result = recordReviewCause({ root, taskPath, round, cause, evidence, paths: values(options, "paths"), missCategory: string(options, "miss-category") || undefined, introducedBy: string(options, "introduced-by") || undefined, proposedChange: string(options, "proposed-change") || undefined });
  output(result); return 0;
}
