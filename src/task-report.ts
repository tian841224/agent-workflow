import { existsSync } from "node:fs";
import { JsonObject, output, readJson } from "./core.js";
import { sections } from "./intent.js";
import { EvidenceAssessment, evaluateTaskGate } from "./lifecycle/task-gate.js";
import { taskPath } from "./lifecycle/task-store.js";

function markdown(value: unknown): string {
  return String(value ?? "").trim() || "(none)";
}

function tableCell(value: unknown): string {
  return markdown(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "&#124;").replace(/\r\n|\r|\n/g, "<br>");
}

function evidenceRows(evidence: EvidenceAssessment[]): string[] {
  return evidence.map(({ item, key, latest, errors }) => {
    let result = "UNVERIFIED";
    if (item.kind === "role" && (item.result === "pass" || item.result === "fail")) result = String(item.result).toUpperCase();
    else if (item.evidence_kind === "execution" && typeof item.exit_code === "number" && Number.isInteger(item.exit_code)) result = item.exit_code === 0 ? "PASS" : "FAIL";
    else if (item.evidence_kind === "analysis") result = "NOT EXECUTED";
    const status = !latest ? "SUPERSEDED" : errors.length ? "INVALID" : "VALID";
    const reason = !latest ? "A newer observation takes precedence." : errors.join("; ") || "Matches the current intent, plan (where required), and delivery.";
    const details = [reason, item.delivery_fingerprint ? `delivery fingerprint: ${String(item.delivery_fingerprint)}` : "", item.status ? `recorded status: ${String(item.status)}` : "", item.note, item.summary].filter(Boolean).join("\n");
    return `| ${[key, item.command, item.cwd, item.exit_code, result, status, item.at, details].map(tableCell).join(" | ")} |`;
  });
}

// Produces a read-only Markdown view from task.md intent and task.json machine state. The report is
// disposable output; it never becomes a second completion authority and never writes either source.
export function taskReport(value: string, repoRoot = process.cwd()): number {
  const path = taskPath(value);
  if (!existsSync(path)) { output({ valid: false, errors: [`task state is missing: ${path}`] }); return 1; }
  try {
    const state = readJson(path);
    const gate = evaluateTaskGate(state, path, repoRoot, { includeEvidence: true });
    if (!gate.intentMarkdown) throw new Error("sibling task.md is missing or empty");
    if (!gate.intentHash) throw new Error("sibling task.md has no valid intent");
    if (!gate.plan) throw new Error(gate.errors.join("; "));
    const intent = sections(gate.intentMarkdown);
    const plan = gate.plan;
    const rows = evidenceRows(gate.evidence);
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
      JSON.stringify({ code_change: state.code_change, managed_change: state.managed_change, task_type: state.task_type, impact_scope: state.impact_scope, impact_effect: state.impact_effect, impact_confidence: state.impact_confidence, risk_flags: state.risk_flags, workflow_facts: state.workflow_facts }, null, 2),
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
      "| Requirement | Command | Cwd | Exit code | Result | Validity | Recorded at | Details |",
      "|---|---|---|---|---|---|---|---|",
      ...(rows.length ? rows : ["| (none) | | | | | | | |"]),
      "",
      "## Gate",
      "",
      `- status: ${gate.status}`,
      `- valid: ${gate.valid ? "PASS" : "BLOCKED"}`,
      ...(gate.errors.length ? ["- errors:", ...gate.errors.map((error) => `  - ${error}`)] : ["- errors: none"]),
      "",
      `- intent hash: ${gate.intentHash}`,
      ""
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  } catch (error) { output({ valid: false, errors: [String((error as Error).message || error)] }); return 1; }
}
