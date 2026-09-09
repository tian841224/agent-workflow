import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { JsonObject, output, readJson } from "./core.js";
import { intentHash, sections } from "./intent.js";
import { evaluateTaskGate } from "./lifecycle/task-gate.js";
import { taskPath } from "./lifecycle/task-store.js";
import { compilePlanForTaskPath } from "./workflow-policy.js";

function markdown(value: unknown): string {
  return String(value ?? "").trim() || "(none)";
}

function evidenceRows(state: JsonObject): string[] {
  const evidence = Array.isArray(state.evidence) ? state.evidence.filter((item): item is JsonObject => !!item && !Array.isArray(item) && typeof item === "object") : [];
  return evidence.map((item) => {
    const id = String(item.id || item.kind || "");
    const result = item.kind === "role" ? String(item.result || "") : String(item.status || "");
    const freshness = item.evidence_kind === "execution" ? String(item.delivery_fingerprint || "missing delivery fingerprint") : "analysis/attested";
    return `| ${id} | ${result} | ${String(item.at || "")} | ${freshness} | ${markdown(item.summary)} |`;
  });
}

// Produces a read-only Markdown view from task.md intent and task.json machine state. The report is
// disposable output; it never becomes a second completion authority and never writes either source.
export function taskReport(value: string, repoRoot = process.cwd()): number {
  const path = taskPath(value);
  if (!existsSync(path)) { output({ valid: false, errors: [`task state is missing: ${path}`] }); return 1; }
  try {
    const state = readJson(path);
    const taskMdPath = join(dirname(path), "task.md");
    if (!existsSync(taskMdPath)) throw new Error("sibling task.md is missing");
    const intent = sections(readFileSync(taskMdPath, "utf8"));
    const plan = compilePlanForTaskPath(state, path);
    const gate = evaluateTaskGate(state, path, repoRoot);
    const lines = [
      `# ${String(state.id || "Task")}`,
      "",
      "## Goal",
      "",
      markdown(intent.get("goal")),
      "",
      "## Scope",
      "",
      markdown(intent.get("scope")),
      "",
      "## Completion criteria",
      "",
      markdown(intent.get("completion criteria")),
      "",
      "## Classification",
      "",
      "```json",
      JSON.stringify({ code_change: state.code_change, managed_change: state.managed_change, task_type: state.task_type, impact_scope: state.impact_scope, impact_effect: state.impact_effect, impact_confidence: state.impact_confidence, validation_profile: state.validation_profile, risk_flags: state.risk_flags, workflow_facts: state.workflow_facts }, null, 2),
      "```",
      "",
      "## Compiled plan",
      "",
      `- required: ${plan.required.join(", ") || "none"}`,
      `- selected: ${plan.selected.map((capability) => String(capability.name)).join(", ") || "none"}`,
      `- exploration profile: ${plan.exploration_profile}`,
      `- required evidence: ${plan.required_evidence.join(", ") || "none"}`,
      `- plan hash: ${plan.plan_hash}`,
      "",
      "## Project docs",
      "",
      `- read: ${Array.isArray((state.project_docs as JsonObject | undefined)?.read) ? ((state.project_docs as JsonObject).read as string[]).join(", ") || "none" : "none"}`,
      `- updated: ${Array.isArray((state.project_docs as JsonObject | undefined)?.updated) ? ((state.project_docs as JsonObject).updated as string[]).join(", ") || "none" : "none"}`,
      `- digests: ${Array.isArray((state.project_docs as JsonObject | undefined)?.digests) ? ((state.project_docs as JsonObject).digests as JsonObject[]).map((entry) => `${String(entry.path)} @ ${String(entry.content_sha256)}`).join(", ") || "none" : "none"}`,
      "",
      "## Evidence",
      "",
      "| Requirement | Result | Recorded at | Freshness | Summary |",
      "|---|---|---|---|---|",
      ...(evidenceRows(state).length ? evidenceRows(state) : ["| (none) | | | | |"]),
      "",
      "## Gate",
      "",
      `- status: ${gate.status}`,
      `- valid: ${gate.valid ? "PASS" : "BLOCKED"}`,
      ...(gate.errors.length ? ["- errors:", ...gate.errors.map((error) => `  - ${error}`)] : ["- errors: none"]),
      "",
      `- intent hash: ${intentHash(readFileSync(taskMdPath, "utf8"))}`,
      ""
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  } catch (error) { output({ valid: false, errors: [String((error as Error).message || error)] }); return 1; }
}
