#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const args = process.argv.slice(2);

function option(name, fallback = undefined) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

const userRoot = process.env.USERPROFILE || process.env.HOME || "";
const memoryPath = resolve(option("--memory-path", join(userRoot, ".codex", "memories", "MEMORY.md")));
const outputPath = option("--output");
const minOccurrences = option("--min-occurrences", "3");

if (!existsSync(memoryPath)) {
  console.error(`Memory file not found: ${memoryPath}`);
  process.exit(2);
}

const memory = readFileSync(memoryPath, "utf8");
const lines = memory.split(/\r?\n/).map((line, index) => ({ line, number: index + 1 }));
const scan = spawnSync(process.execPath, [
  join(root, "dist", "agent-workflow.mjs"), "skill-draft", "--action", "Scan",
  "--cwd", root, "--min-occurrences", minOccurrences,
], { cwd: root, encoding: "utf8" });
const scanOutput = (scan.stdout || "").trim() || "[]";
const scanError = (scan.stderr || "").trim();

const patterns = [
  ["Exchange／Deferred Settlement recovery contract", "slotlanmainlandserver project doc", /deferred settlement|PendingSettlement|lease|settlement step|Redis.*MySQL|Exchange recovery/i],
  ["Google Form import／export data integrity", "ltc-system project doc", /Google Form|source_key|form_columns|RideSources|dynamic.*header|advisory lock/i],
  ["Windows safe editing and encoding", "optional reusable skill", /PowerShell.*UTF-?8|BOM|LiteralPath|os error 123|Invalid pattern|exact.*patch/i],
  ["Evidence-bound completion claims", "existing operational-verification skill or release doc", /npm whoami|npm publish|local runtime|live MySQL|live Redis|runtime proof|mock.*proof/i],
];

const candidates = patterns.map(([name, destination, regex]) => ({
  name,
  destination,
  evidence: lines.filter(({ line }) => regex.test(line)).slice(0, 8)
    .map(({ number, line }) => `MEMORY.md:${number}: ${line.trim()}`),
})).filter(({ evidence }) => evidence.length > 0);

const report = [
  "# Weekly Memory Review",
  "",
  `- Generated: ${new Date().toISOString()}`,
  `- Memory: ${memoryPath}`,
  "- Policy: advisory only; this report never creates, promotes, or rejects a skill.",
  "",
  "## Runtime Scan",
  "",
  "```json",
  scanOutput,
  "```",
  scanError ? `\nScan stderr: ${scanError}` : "",
  "",
  "## Heuristic Candidates",
  "",
  candidates.length ? candidates.flatMap(({ name, destination, evidence }) => [
    `### ${name}`, "", `Suggested destination: ${destination}`, "", "Evidence:", "",
    ...evidence.map((item) => `- ${item}`), "",
    "Decision: [ ] update existing doc  [ ] draft skill  [ ] add task rule  [ ] reject", "",
  ]).join("\n") : "No heuristic candidates found in the current memory file.\n",
  "## Review Rules",
  "",
  "- Collapse entries from the same rollout into one independent occurrence.",
  "- Read every source entry before treating a threshold as earned.",
  "- Prefer the narrowest existing document, rule, or skill owner.",
  "- Keep project facts in project docs; create a skill only for a repeatable cross-project procedure.",
  "- Ask the user before Draft, Promote, Reject, or any document change.",
].filter(Boolean).join("\n");

if (outputPath) {
  const target = resolve(outputPath);
  writeFileSync(target, `${report.trimEnd()}\n`, "utf8");
  console.log(`Wrote ${target}`);
} else {
  console.log(report.trimEnd());
}

if (scan.status !== 0) process.exit(scan.status ?? 1);
