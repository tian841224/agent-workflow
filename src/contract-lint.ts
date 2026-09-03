import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { JsonObject, output, readJson } from "./core.js";

// Retired names that a schema/CLI reference check cannot catch on its own, because nothing in the
// current contract is shaped like them any more. Each entry says what replaced it so the finding is
// actionable without opening the git history.
const RETIRED: { pattern: RegExp; replacement: string }[] = [
  { pattern: /\borchestrate\.py\b/, replacement: "agent-workflow orchestrate" },
  { pattern: /\bsplit-plan\.py\b/, replacement: "agent-workflow split-plan" },
  { pattern: /\bpre-review\.py\b/, replacement: "agent-workflow pre-review" },
  { pattern: /\bclose-task\.py\b/, replacement: "agent-workflow close-task" },
  { pattern: /\bknowledge\.py\b/, replacement: "agent-workflow knowledge" },
  { pattern: /\bretro\.py\b/, replacement: "agent-workflow retro" },
  { pattern: /\breview_cause\.py\b/, replacement: "agent-workflow review-cause" },
  { pattern: /\bagent_workflow\.cmd\b/, replacement: "agent-workflow <command>" },
  { pattern: /\bwaive-roles\b/, replacement: "agent-workflow waive --requirement-id <id> --confirmed-by-user <text>" },
  { pattern: /\blifecycle\.frozen_at\b/, replacement: "intent_approval" },
  { pattern: /\bfrozen_at\b/, replacement: "intent_approval" },
  { pattern: /\broles_waived\b/, replacement: "task.json waivers[]" },
  { pattern: /\bchange_kind\b/, replacement: "task_type" },
  { pattern: /\bcomplexity_hint\b/, replacement: "workflow_facts" },
  { pattern: /\bdiff_sha256\b/, replacement: "reviewed_diff_sha256 (role evidence) or workspace_sha256 (worktree-fingerprint)" },
  { pattern: /\bstale_pending\b/, replacement: "project-doc --action Stale, which reports one condition only" }
];
const SCANNED = [".agents", "templates", "adapters", "docs", "README.md", "AGENTS.md"];
// The vocabulary rules only apply where this framework owns the vocabulary. Bundled third-party
// skills carry their own schemas and their own identifiers, and holding them to this contract would
// report their fields as drift.
const FRAMEWORK_OWNED = [
  ".agents/agents/", ".agents/skills/workflow/", ".agents/skills/distill/", ".agents/skills/learn/",
  ".agents/skills/project-docs/", ".agents/skills/codebase-design/", ".agents/skills/tdd/",
  "templates/", "adapters/", "docs/", "README.md", "AGENTS.md"
];
const SKIPPED = ["docs/history", "node_modules", "dist", "bench", ".git"];

type Finding = { file: string; line: number; rule: string; detail: string };

// Inline spans plus whole lines inside a fenced block. Scanning inline spans alone made the
// command rule blind to exactly where commands are written: every invocation in this repo's skills
// lives in a ```text fence with no backticks of its own.
function codeSpans(text: string, insideFence: boolean): string[] {
  return insideFence ? [text] : [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

// Terms that are legitimately snake_case in agent docs without being contract fields: runtime
// concepts, environment variables and directory names. Anything outside this set has to come from a
// schema, the policy or the CLI, which is the whole point of the check.
const VOCABULARY_ALLOWLIST = [
  "agent_workflow", "task_json", "task_md", "node_modules",
  "AGENT_WORKFLOW_STATE_ROOT", "AGENT_WORKFLOW_ORCHESTRATION_EXPERIMENTAL", "GIT_INDEX_FILE",
  // The orchestration subsystem is experimental and its worker handshake has no schema yet; these
  // stay allowlisted until it does, rather than being invented into cli-output.schema.json.
  "worker_id", "worker_root", "ownership_request",
  "x_agent_workflow" // the annotation keyword itself; its contents are collected below
];
// Every name the contract actually defines: schema properties and enum values across schemas/,
// plus policy capability and step ids, plus CLI option names. A backticked snake_case token in a
// document has to be one of these or it is naming something that no longer exists.
function contractVocabulary(root: string, policy: JsonObject, capabilityNames: string[], stepIds: Set<string>, commandOptions: Record<string, string[]>): Set<string> {
  const vocabulary = new Set<string>([...VOCABULARY_ALLOWLIST, ...capabilityNames, ...stepIds, ...Object.keys(commandOptions), ...Object.values(commandOptions).flat()]);
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(collect); return; }
    if (!node || typeof node !== "object") return;
    const record = node as JsonObject;
    for (const [key, value] of Object.entries(record)) {
      if ((key === "properties" || key === "$defs") && value && typeof value === "object" && !Array.isArray(value)) Object.keys(value).forEach((name) => vocabulary.add(name));
      if ((key === "enum" || key === "propertyNames") && value) for (const item of Array.isArray(value) ? value : Object.values(value as JsonObject).flat()) if (typeof item === "string") vocabulary.add(item);
      collect(value);
    }
  };
  const schemasDirectory = join(root, "schemas");
  if (existsSync(schemasDirectory)) for (const entry of readdirSync(schemasDirectory)) if (entry.endsWith(".json")) collect(readJson(join(schemasDirectory, entry)));
  // x_agent_workflow holds real contract values (remedy routing, freeze-required flags) under a
  // non-standard keyword, so its keys and string values count as defined names too.
  const annotations = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(annotations); return; }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as JsonObject)) {
      if (key === "x_agent_workflow" && value && typeof value === "object") {
        const walkValues = (item: unknown): void => {
          if (typeof item === "string") { vocabulary.add(item); return; }
          if (Array.isArray(item)) { item.forEach(walkValues); return; }
          if (item && typeof item === "object") { Object.keys(item).forEach((name) => vocabulary.add(name)); Object.values(item).forEach(walkValues); }
        };
        walkValues(value);
      }
      annotations(value);
    }
  };
  if (existsSync(schemasDirectory)) for (const entry of readdirSync(schemasDirectory)) if (entry.endsWith(".json")) annotations(readJson(join(schemasDirectory, entry)));
  collect(policy);
  return vocabulary;
}

function resolvesUpwards(directory: string, root: string, reference: string): boolean {
  for (let current = directory; ; current = dirname(current)) {
    if (existsSync(join(current, reference))) return true;
    if (current === root || dirname(current) === current) return false;
  }
}

function markdownFiles(root: string, target: string): string[] {
  const full = join(root, target);
  if (!existsSync(full)) return [];
  if (statSync(full).isFile()) return [full];
  const result: string[] = [];
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const child = join(target, entry.name);
    if (SKIPPED.some((skip) => child.replaceAll("\\", "/").startsWith(skip))) continue;
    if (entry.isDirectory()) result.push(...markdownFiles(root, child));
    else if (/\.(md|json)$/i.test(entry.name)) result.push(join(root, child));
  }
  return result;
}

export function contractLint(rootValue: string, commandOptions: Record<string, string[]>): number {
  const root = resolve(rootValue);
  const findings: Finding[] = [];
  const policy = readJson(join(root, "schemas", "workflow-policy.json"));
  const taskSchema = readJson(join(root, "schemas", "task.schema.json"));
  const capabilityNames = (policy.capabilities as JsonObject[]).map((capability) => String(capability.name));
  const commandSet = new Set(Object.keys(commandOptions));
  const stepIds = new Set((policy.capabilities as JsonObject[]).flatMap((capability) => (Array.isArray(capability.steps) ? capability.steps as JsonObject[] : []).map((step) => String(step.id))));
  const vocabulary = contractVocabulary(root, policy, capabilityNames, stepIds, commandOptions);

  for (const file of SCANNED.flatMap((target) => markdownFiles(root, target))) {
    const relativePath = relative(root, file).replaceAll("\\", "/");
    const directory = dirname(file);
    const frameworkOwned = FRAMEWORK_OWNED.some((owned) => relativePath === owned || relativePath.startsWith(owned));
    let insideFence = false;
    readFileSync(file, "utf8").split(/\r?\n/).forEach((text, index) => {
      const line = index + 1;
      if (/^\s*```/.test(text)) { insideFence = !insideFence; return; }
      // A changelog or migration note has to name what was removed; the marker names the one rule it
      // silences, so it cannot quietly disable the others on the same line.
      const allowed = text.match(/contract-lint:allow(?:=([a-z-]+))?/);
      const suppresses = (rule: string) => !!allowed && (!allowed[1] || allowed[1] === rule);
      if (!suppresses("retired-name")) for (const entry of RETIRED) if (entry.pattern.test(text)) findings.push({ file: relativePath, line, rule: "retired-name", detail: `${entry.pattern.source} is retired; use ${entry.replacement}` });
      // Only literal invocations count: prose like "the agent-workflow runtime" is not a command.
      // Both spellings are checked, since `node <path>/agent-workflow.mjs <verb>` is how the
      // installed bundle is invoked and would otherwise never be validated.
      // Inside a fence the whole line is the span, so the token has to sit where a command actually
      // starts; otherwise a directory-tree diagram mentioning the name reads as an invocation.
      const invocation = insideFence ? /^\s*(?:[$>]\s+)?(?:node\s+)?(?:\S*[\\/])?agent-workflow(?:\.mjs)?\s+([a-z][a-z-]*)/g : /agent-workflow(?:\.mjs)?\s+([a-z][a-z-]*)/g;
      if (!suppresses("unknown-command")) for (const span of codeSpans(text, insideFence)) for (const match of span.matchAll(invocation)) if (!commandSet.has(match[1])) findings.push({ file: relativePath, line, rule: "unknown-command", detail: `'agent-workflow ${match[1]}' is not a CLI command` });
      // A schema path may be written relative to the repo root or to any ancestor directory of the
      // document (a skill bundling its own schemas/ does the latter), so resolve upwards.
      if (!suppresses("missing-schema")) for (const match of text.matchAll(/(?<![\w./-])schemas\/[A-Za-z0-9._/-]+\.json/g)) if (!resolvesUpwards(directory, root, match[0])) findings.push({ file: relativePath, line, rule: "missing-schema", detail: `${match[0]} does not exist` });
      // Options are checked per invocation, so a flag that belongs to another command is a finding
      // too, not just a flag no command reads at all.
      if (!suppresses("unknown-option")) for (const span of codeSpans(text, insideFence)) {
        const named = span.match(insideFence ? /^\s*(?:[$>]\s+)?(?:node\s+)?(?:\S*[\\/])?agent-workflow(?:\.mjs)?\s+([a-z][a-z-]*)/ : /agent-workflow(?:\.mjs)?\s+([a-z][a-z-]*)/);
        const accepted = named && commandOptions[named[1]];
        if (!accepted) continue;
        for (const flag of span.matchAll(/(?<=\s)--([a-z][a-z-]*)/g)) if (!accepted.includes(flag[1])) findings.push({ file: relativePath, line, rule: "unknown-option", detail: `'agent-workflow ${named[1]}' does not accept --${flag[1]}` });
      }
      // A backticked snake_case token is, in these documents, always a contract name.
      if (frameworkOwned && !suppresses("unknown-term")) for (const match of text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) if (!vocabulary.has(match[1])) findings.push({ file: relativePath, line, rule: "unknown-term", detail: `\`${match[1]}\` is not a field, enum value, capability, step id or CLI option defined by the contract` });
      // Step ids are the one contract name agents copy by hand into evidence lines.
      if (frameworkOwned && !suppresses("unknown-step-id")) for (const match of text.matchAll(/\b([A-Z]{2,3}[0-9])\b/g)) if (!stepIds.has(match[1])) findings.push({ file: relativePath, line, rule: "unknown-step-id", detail: `${match[1]} is not a step id in workflow-policy.json` });
    });
  }

  const skillPath = join(root, ".agents", "skills", "workflow", "SKILL.md");
  const skillText = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : "";
  for (const name of capabilityNames) if (!skillText.includes(name)) findings.push({ file: ".agents/skills/workflow/SKILL.md", line: 0, rule: "undocumented-capability", detail: `capability '${name}' exists in workflow-policy.json but the workflow skill never names it` });

  const declaredFacts = new Set(((((taskSchema.$defs as JsonObject).workflowFacts as JsonObject).propertyNames as JsonObject).enum as string[]) || []);
  const usedFacts = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== "object") return;
    const node = value as JsonObject;
    if (typeof node.fact === "string") usedFacts.add(node.fact);
    Object.values(node).forEach(walk);
  };
  walk(policy.capabilities);
  for (const fact of usedFacts) if (!declaredFacts.has(fact)) findings.push({ file: "schemas/task.schema.json", line: 0, rule: "undeclared-fact", detail: `workflow-policy.json uses fact '${fact}' that task.schema.json does not allow` });
  for (const fact of declaredFacts) if (!usedFacts.has(fact)) findings.push({ file: "schemas/workflow-policy.json", line: 0, rule: "unused-fact", detail: `task.schema.json declares fact '${fact}' that no policy condition reads` });

  output({ valid: findings.length === 0, root, scanned: SCANNED, findings });
  return findings.length ? 1 : 0;
}
