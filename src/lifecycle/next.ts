import { dirname, join } from "node:path";
import type { GateMissing, GateResult } from "./task-gate.js";

export type NextAction = { command: string; why: string };

const quote = (value: string): string => /[\s"]/.test(value) ? `"${value.replaceAll("\"", "\\\"")}"` : value;

// Turns the gate's remaining gaps into the exact commands that close them, in the order the workflow
// runs them, so an agent follows the task instead of reconstructing the protocol from documents.
// task-write takes facts nested under workflow_facts, so a flat field list is regrouped before it
// becomes the command's JSON.
function declareJson(fields: string[]): string {
  const facts = fields.filter((field) => field.startsWith("workflow_facts.")).map((field) => `"${field.slice("workflow_facts.".length)}":<value>`);
  const top = fields.filter((field) => !field.startsWith("workflow_facts.")).map((field) => `"${field}":<value>`);
  return `{${[...top, ...(facts.length ? [`"workflow_facts":{${facts.join(",")}}`] : [])].join(",")}}`;
}

export function nextActions(taskJsonPath: string, repoRoot: string, gate: Pick<GateResult, "valid" | "status" | "missing" | "errors">): NextAction[] {
  const task = quote(taskJsonPath);
  const repo = quote(repoRoot);
  if (gate.valid) return [{ command: `agent-workflow close-task --task-path ${task}`, why: "every gate item is satisfied" }];
  if (gate.status === "paused" || gate.status === "blocked") return [{ command: `agent-workflow resume --task ${task}`, why: `task is ${gate.status}` }];
  const actions: NextAction[] = [];
  const of = <K extends GateMissing["kind"]>(kind: K): Extract<GateMissing, { kind: K }>[] => gate.missing.filter((item): item is Extract<GateMissing, { kind: K }> => item.kind === kind);
  for (const item of of("intent")) actions.push({ command: `edit ${quote(join(dirname(taskJsonPath), "task.md"))}`, why: item.reason });
  const fields = [...new Set(of("classification").flatMap((item) => item.fields))];
  if (fields.length) actions.push({ command: `echo '${declareJson(fields)}' | agent-workflow task-write --task-path ${task}`, why: `declare ${fields.join(", ")}` });
  // Declaring a fact first can remove an undecided proof, which is cheaper than running it.
  const undecided = of("proof").filter((item) => item.undecided_by?.length);
  const facts = [...new Set(undecided.flatMap((item) => item.undecided_by || []))].filter((field) => !fields.includes(field));
  if (facts.length) actions.push({ command: `echo '${declareJson(facts)}' | agent-workflow task-write --task-path ${task}`, why: `declaring ${facts.join(", ")} settles whether ${undecided.map((item) => item.id).join(", ")} must run; skip if the proof applies anyway` });
  if (of("approval").length) actions.push({ command: `agent-workflow approve-intent --task-path ${task} --confirmed-by agent`, why: "freeze-required intent must be attested against the current task.md" });
  // One run can prove several cases that share a command, so cases are grouped by their Verify command.
  const byCommand = new Map<string, string[]>();
  for (const item of of("acceptance")) byCommand.set(item.command, [...(byCommand.get(item.command) || []), `acceptance.${item.id}`]);
  for (const [command, ids] of byCommand) actions.push({ command: `agent-workflow evidence-run --task-path ${task} --requirement-id ${ids.join(",")} --summary "<result>" --cwd ${repo} -- ${command || "<verify command>"}`, why: `run the Verify command of ${ids.map((id) => id.slice("acceptance.".length)).join(", ")}` });
  for (const item of of("proof")) actions.push({ command: `agent-workflow evidence-run --task-path ${task} --requirement-id ${item.id} --summary "<result>" --cwd ${repo} -- <command>`, why: item.title || item.id });
  if (of("role").length) {
    actions.push({ command: `agent-workflow pre-review --path ${repo} --task-path ${task}`, why: "opens the review round and returns its scope; dispatch the reviewer only after every run above passes" });
    actions.push({ command: `agent-workflow review-record --task-path ${task} --role reviewer --result <pass|fail> --summary "<findings or PASS>" --expected-workspace-sha256 <workspace_sha256>`, why: "records the independent reviewer's result against the tree it reviewed" });
  }
  // Some gate errors (schema, legacy evidence, base_commit, ownership) have no scripted fix; the
  // agent still needs a next step rather than an empty list beside valid:false.
  if (!actions.length) actions.push({ command: `agent-workflow task-report --task-path ${task}`, why: `resolve the gate errors first: ${gate.errors.slice(0, 3).join("; ") || "unknown gate failure"}` });
  return actions;
}
