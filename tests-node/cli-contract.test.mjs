import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js");
const addFormats = require("ajv-formats");
const cli = join(process.cwd(), "dist", "agent-workflow.mjs");
const run = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: "utf8", ...options });

function validatorFor(command) {
  const schema = JSON.parse(readFileSync(join(process.cwd(), "schemas", "cli-output.schema.json"), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema, "cli-output");
  return ajv.compile({ $ref: `cli-output#/$defs/${command}` });
}

// A repeated flag is the shape an agent naturally writes for a multi-value option; keeping only the
// last value discarded half the input with no error at all.
test("a repeated multi-value option accumulates instead of keeping only the last value", () => {
  const root = join(tmpdir(), `agent-workflow-dup-multi-${process.pid}-${Date.now()}`);
  const state = join(root, "state");
  const first = run(["knowledge", "--action", "Upsert", "--scope", "Global", "--approved-by-user", "--topic", "dup-a", "--content", "A", "--state-root", state]);
  const second = run(["knowledge", "--action", "Upsert", "--scope", "Global", "--approved-by-user", "--topic", "dup-b", "--content", "B", "--state-root", state]);
  const ids = [first, second].map((result) => JSON.parse(result.stdout).path);
  const forgotten = run(["learn", "--action", "Forget", "--scope", "Global", "--reason", "test", "--state-root", state,
    "--id", ids[0].replace(/^.*[\\/]/, "").replace(/\.md$/, ""), "--id", ids[1].replace(/^.*[\\/]/, "").replace(/\.md$/, "")]);
  assert.equal(forgotten.status, 0, forgotten.stderr);
  assert.equal(JSON.parse(forgotten.stdout).removed.length, 2, "both repeated --id values must be read");
});

test("a repeated single-value option is an error rather than a silent overwrite", () => {
  const result = run(["worktree-fingerprint", "--path", process.cwd(), "--base", "HEAD", "--base", "HEAD~1"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate option --base/);
});

test("comma form and repeated form of a multi-value option are equivalent", () => {
  const repeated = JSON.parse(run(["worktree-fingerprint", "--path", process.cwd(), "--base", "HEAD", "--paths", "src", "--paths", "schemas"]).stdout);
  const comma = JSON.parse(run(["worktree-fingerprint", "--path", process.cwd(), "--base", "HEAD", "--paths", "src,schemas"]).stdout);
  assert.deepEqual(repeated.reviewed_paths, comma.reviewed_paths);
  assert.equal(repeated.reviewed_diff_sha256, comma.reviewed_diff_sha256);
});

test("workflow-plan output matches its declared shape in cli-output.schema.json", () => {
  const root = join(tmpdir(), `agent-workflow-output-plan-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const path = join(root, "task.json");
  writeFileSync(path, JSON.stringify({ workflow_request: ["reviewer"], risk_flags: ["schema"], task_type: "schema", impact_scope: "module", impact_effect: "schema", impact_confidence: "high" }));
  const validate = validatorFor("workflow-plan");
  const plan = JSON.parse(run(["workflow-plan", "--task-path", path]).stdout);
  assert.ok(validate(plan), JSON.stringify(validate.errors));
});

test("execution-packet output matches its declared shape in cli-output.schema.json", () => {
  const root = join(tmpdir(), `agent-workflow-output-packet-${process.pid}-${Date.now()}`);
  const task = join(root, "20260101-000000-output-packet");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Packet shape\n\n## Goal\n\nVerify execution packet output.\n\n## Scope\n\nNo source change.\n\n## Completion criteria\n\n- [ ] output validates\n");
  const init = run(["task-init", "--task-path", task], { input: JSON.stringify({ code_change: false, managed_change: false }) });
  assert.equal(init.status, 0, init.stderr);
  const result = run(["execution-packet", "--task-path", task]);
  assert.equal(result.status, 0, result.stderr);
  const validate = validatorFor("execution-packet");
  assert.ok(validate(JSON.parse(result.stdout)), JSON.stringify(validate.errors));
});

test("task-gate and contract-lint output match their declared shapes", () => {
  const root = join(tmpdir(), `agent-workflow-output-gate-${process.pid}-${Date.now()}`);
  const task = join(root, "task");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Shape\n\n## Goal\n\nVerify the declared output shape.\n");
  writeFileSync(join(task, "task.json"), JSON.stringify({
    schema_version: 3, id: "20260101-000000-shape", project_id: "0123456789abcdef", worktree_id: "0123456789abcdef",
    code_change: false, risk_flags: [], created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
    state_revision: 1, plan_revision: 1,
    lifecycle: { status: "in_progress", transitions: [{ at: "2026-01-01T00:00:00.000Z", action: "create", from: "new", to: "in_progress", actor: "test" }] },
    evidence: [], waivers: []
  }));
  const gateValidator = validatorFor("task-gate");
  const gate = JSON.parse(run(["task-gate", "--task-path", join(task, "task.json")]).stdout);
  assert.ok(gateValidator(gate), JSON.stringify(gateValidator.errors));
  const lintValidator = validatorFor("contract-lint");
  const lint = JSON.parse(run(["contract-lint", "--root", process.cwd()]).stdout);
  assert.ok(lintValidator(lint), JSON.stringify(lintValidator.errors));
});

test("contract-lint rejects a documented option the named command does not accept", () => {
  const root = lintFixture([
    "```text",
    "agent-workflow task-gate --task-path <path> --nonexistent-flag",
    "```"
  ]);
  const findings = JSON.parse(run(["contract-lint", "--root", root]).stdout).findings;
  assert.ok(findings.some((finding) => finding.rule === "unknown-option" && finding.detail.includes("--nonexistent-flag")), JSON.stringify(findings));
});

test("contract-lint rejects a contract term and a step id that nothing defines", () => {
  const root = lintFixture(["The `made_up_field` is set alongside step ZZ9."]);
  const findings = JSON.parse(run(["contract-lint", "--root", root]).stdout).findings;
  assert.ok(findings.some((finding) => finding.rule === "unknown-term" && finding.detail.includes("made_up_field")), JSON.stringify(findings));
  assert.ok(findings.some((finding) => finding.rule === "unknown-step-id" && finding.detail.includes("ZZ9")), JSON.stringify(findings));
});

test("contract-lint accepts a real field, capability, step id and option", () => {
  const root = lintFixture(["`impact_scope` and `plan_revision` drive `execution_path_review` step EP4; run `agent-workflow task-gate --repo-root <repo>`."]);
  assert.deepEqual(JSON.parse(run(["contract-lint", "--root", root]).stdout).findings, []);
});

// The vocabulary belongs to this framework, so a bundled third-party skill with its own field names
// must not be reported as drift.
test("contract-lint does not apply the vocabulary rules to a bundled third-party skill", () => {
  const root = lintFixture(["placeholder"], { "third-party": ["Its `own_field_name` and codec AV1 are not this contract's."] });
  assert.deepEqual(JSON.parse(run(["contract-lint", "--root", root]).stdout).findings, []);
});

function lintFixture(templateLines, extraSkills = {}) {
  const root = join(tmpdir(), `agent-workflow-lint-fixture-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(root, "schemas"), { recursive: true });
  mkdirSync(join(root, "templates"), { recursive: true });
  mkdirSync(join(root, ".agents", "skills", "workflow"), { recursive: true });
  // Every schema, because the vocabulary is the union of all of them: copying a subset would make
  // the fixture report names that are perfectly well defined in the real repository.
  for (const schema of readdirSync(join(process.cwd(), "schemas")).filter((name) => name.endsWith(".json"))) {
    writeFileSync(join(root, "schemas", schema), readFileSync(join(process.cwd(), "schemas", schema)));
  }
  writeFileSync(join(root, ".agents", "skills", "workflow", "SKILL.md"), readFileSync(join(process.cwd(), ".agents", "skills", "workflow", "SKILL.md")));
  writeFileSync(join(root, "templates", "task.md"), templateLines.join("\n"));
  for (const [name, lines] of Object.entries(extraSkills)) {
    mkdirSync(join(root, ".agents", "skills", name), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", name, "SKILL.md"), lines.join("\n"));
  }
  return root;
}
