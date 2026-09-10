import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
  assert.equal(plan.exploration_profile, "expanded");
});

test("execution-packet output matches its declared shape in cli-output.schema.json", () => {
  const root = join(tmpdir(), `agent-workflow-output-packet-${process.pid}-${Date.now()}`);
  const task = join(root, "20260101-000000-output-packet");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Packet shape\n\n## Goal\n\nVerify execution packet output.\n\n## Scope\n\nNo source change.\n\n## Completion criteria\n\n- [ ] output validates\n");
  const init = run(["task-init", "--task-path", task], { input: JSON.stringify({ code_change: false, managed_change: false }) });
  assert.equal(init.status, 0, init.stderr);
  const initBody = JSON.parse(init.stdout);
  assert.ok(initBody.plan && Array.isArray(initBody.procedures), init.stdout);
  const result = run(["execution-packet", "--task-path", task]);
  assert.equal(result.status, 0, result.stderr);
  const validate = validatorFor("execution-packet");
  assert.ok(validate(JSON.parse(result.stdout)), JSON.stringify(validate.errors));
  assert.equal(JSON.parse(result.stdout).workflow.exploration_profile, "focused");
});

test("task-report renders intent, compiled plan, project docs, evidence, and gate status without writing", () => {
  const root = join(tmpdir(), `agent-workflow-task-report-${process.pid}-${Date.now()}`);
  const task = join(root, "20260101-000000-task-report"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Report\n\n## Goal\n\nRender a report.\n\n## Scope\n\nOnly report output.\n\n## Completion criteria\n\n- [ ] report contains the current plan\n");
  const init = run(["task-init", "--task-path", task], { input: JSON.stringify({ code_change: false, managed_change: false, validation_profile: "focused" }) });
  assert.equal(init.status, 0, init.stdout || init.stderr);
  const remembered = run(["project-doc", "--action", "Remember", "--repo-root", process.cwd(), "--task-path", task, "--paths", "docs/architecture.md"]);
  assert.equal(remembered.status, 0, remembered.stdout || remembered.stderr);
  const before = readFileSync(join(task, "task.json"), "utf8");
  const report = run(["task-report", "--task-path", task]);
  assert.equal(report.status, 0, report.stdout || report.stderr);
  assert.match(report.stdout, /## Goal/);
  assert.match(report.stdout, /## Compiled plan/);
  assert.match(report.stdout, /exploration profile: focused/);
  assert.match(report.stdout, /"validation_profile": "focused"/);
  assert.match(report.stdout, /docs\/architecture\.md/);
  assert.match(report.stdout, /digests:/);
  assert.equal(readFileSync(join(task, "task.json"), "utf8"), before, "task-report must be read-only");
});

test("review-record can attach optional cause telemetry without a separate critical-path command", () => {
  const root = join(tmpdir(), `agent-workflow-review-cause-inline-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo"); mkdirSync(repo, { recursive: true });
  spawnSync("git", ["-C", repo, "init", "-q"]); spawnSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); spawnSync("git", ["-C", repo, "config", "user.name", "test"]);
  writeFileSync(join(repo, "f.txt"), "one"); spawnSync("git", ["-C", repo, "add", "."]); spawnSync("git", ["-C", repo, "commit", "-q", "-m", "init"]); writeFileSync(join(repo, "f.txt"), "two");
  const task = join(root, "20260101-000000-review-cause"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Review\n\n## Goal\n\nRecord review cause.\n\n## Scope\n\nOne file.\n\n## Completion criteria\n\n- [ ] cause is stored\n");
  const stateRoot = join(root, "state");
  const init = run(["task-init", "--task-path", task, "--repo-root", repo, "--state-root", stateRoot, "--adopt-current-diff"], { input: JSON.stringify({ code_change: true, managed_change: true, workflow_mode: "main", task_type: "fix", impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high", workflow_request: ["reviewer"] }) });
  assert.equal(init.status, 0, init.stdout || init.stderr);
  const reviewed = run(["review-record", "--task-path", task, "--repo-root", repo, "--state-root", stateRoot, "--role", "reviewer", "--result", "fail", "--summary", "found a missing invariant", "--cause-round", "2", "--cause", "logic_error", "--cause-evidence", "The branch condition was inverted.", "--cause-paths", "f.txt"]);
  assert.equal(reviewed.status, 0, reviewed.stdout || reviewed.stderr);
  const body = JSON.parse(reviewed.stdout);
  assert.equal(body.review_cause.cause, "logic_error");
  const index = JSON.parse(readFileSync(join(stateRoot, "review-causes", "index.json"), "utf8"));
  assert.equal(index.entries.length, 1);
});

test("review-record rejects a workspace that changed after the pre-review fingerprint", () => {
  const root = join(tmpdir(), `agent-workflow-review-fingerprint-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo"); mkdirSync(repo, { recursive: true });
  spawnSync("git", ["-C", repo, "init", "-q"]); spawnSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); spawnSync("git", ["-C", repo, "config", "user.name", "test"]);
  writeFileSync(join(repo, "f.txt"), "one"); spawnSync("git", ["-C", repo, "add", "."]); spawnSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);
  const task = join(root, "20260101-000000-review-fingerprint"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Review\n\n## Goal\n\nBind review to the pre-review workspace.\n\n## Scope\n\nOne file.\n\n## Completion criteria\n\n- [ ] fingerprint is enforced\n");
  const stateRoot = join(root, "state");
  const init = run(["task-init", "--task-path", task, "--repo-root", repo, "--state-root", stateRoot, "--adopt-current-diff"], { input: JSON.stringify({ code_change: true, managed_change: true, workflow_mode: "main", task_type: "fix", impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high", workflow_request: ["reviewer"] }) });
  assert.equal(init.status, 0, init.stdout || init.stderr);
  writeFileSync(join(repo, "f.txt"), "two");
  const opened = JSON.parse(run(["pre-review", "--path", repo]).stdout);
  assert.equal(opened.valid, true);
  assert.equal(opened.workspace_sha256, JSON.parse(run(["worktree-fingerprint", "--path", repo]).stdout).workspace_sha256);
  const preReview = opened.workspace_sha256;
  writeFileSync(join(repo, "f.txt"), "three");
  const stale = run(["review-record", "--task-path", task, "--repo-root", repo, "--state-root", stateRoot, "--role", "reviewer", "--result", "pass", "--summary", "reviewed tree", "--expected-workspace-sha256", preReview]);
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /workspace changed since the pre-review fingerprint/);
  const fresh = JSON.parse(run(["pre-review", "--path", repo]).stdout).workspace_sha256;
  const accepted = run(["review-record", "--task-path", task, "--repo-root", repo, "--state-root", stateRoot, "--role", "reviewer", "--result", "pass", "--summary", "reviewed tree", "--expected-workspace-sha256", fresh]);
  assert.equal(accepted.status, 0, accepted.stdout || accepted.stderr);
  const state = JSON.parse(readFileSync(join(task, "task.json"), "utf8"));
  const review = state.evidence.at(-1);
  assert.equal(review.reviewed_diff_sha256, review.delivery_hash);
});

// A managed non-code task never activates, so it has no base_commit. review-record used to demand one
// unconditionally, which left `managed_change: true` + `code_change: false` + a required reviewer with
// no way to record the role evidence its own plan required, and so no way through the gate.
test("a required reviewer on a non-code managed task can be recorded and clears the gate", () => {
  const root = join(tmpdir(), `agent-workflow-review-noncode-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo"); mkdirSync(repo, { recursive: true });
  spawnSync("git", ["-C", repo, "init", "-q"]); spawnSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); spawnSync("git", ["-C", repo, "config", "user.name", "test"]);
  writeFileSync(join(repo, "config.json"), "{}\n"); spawnSync("git", ["-C", repo, "add", "."]); spawnSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);
  const task = join(root, "20260101-000000-review-noncode"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Config review\n\n## Goal\n\nReview a config-only change.\n\n## Scope\n\nOne config file.\n\n## Completion criteria\n\n- [ ] review is recorded\n");
  const stateRoot = join(root, "state");
  const init = run(["task-init", "--task-path", task, "--repo-root", repo, "--state-root", stateRoot], { input: JSON.stringify({ code_change: false, managed_change: true, task_type: "fix", impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high", risk_flags: ["operational"], workflow_request: ["reviewer"] }) });
  assert.equal(init.status, 0, init.stdout || init.stderr);
  writeFileSync(join(repo, "config.json"), "{\"retries\": 3}\n");
  const head = spawnSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  const reviewed = run(["review-record", "--task-path", task, "--repo-root", repo, "--state-root", stateRoot, "--role", "reviewer", "--result", "pass", "--summary", "config change reviewed"]);
  assert.equal(reviewed.status, 0, reviewed.stdout || reviewed.stderr);
  const recorded = JSON.parse(readFileSync(join(task, "task.json"), "utf8")).evidence.at(-1);
  assert.equal(recorded.reviewed_base, head);
  assert.deepEqual(recorded.reviewed_paths, ["config.json"]);
  const gated = JSON.parse(run(["task-gate", "--task-path", task, "--repo-root", repo]).stdout);
  assert.ok(!gated.errors.some((error) => error.includes("role.reviewer")), gated.errors.join("; "));
});

test("review-record still refuses a code task whose activation never recorded a base_commit", () => {
  const root = join(tmpdir(), `agent-workflow-review-nobase-${process.pid}-${Date.now()}`);
  const repo = join(root, "repo"); mkdirSync(repo, { recursive: true });
  spawnSync("git", ["-C", repo, "init", "-q"]); spawnSync("git", ["-C", repo, "config", "user.email", "test@example.com"]); spawnSync("git", ["-C", repo, "config", "user.name", "test"]);
  writeFileSync(join(repo, "f.txt"), "one"); spawnSync("git", ["-C", repo, "add", "."]); spawnSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);
  const task = join(root, "20260101-000000-review-nobase"); mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Missing baseline\n\n## Goal\n\nKeep code tasks pinned to activation.\n\n## Scope\n\nOne file.\n\n## Completion criteria\n\n- [ ] activation is still required\n");
  const stateRoot = join(root, "state");
  const init = run(["task-init", "--task-path", task, "--repo-root", repo, "--state-root", stateRoot], { input: JSON.stringify({ code_change: true, managed_change: true, task_type: "fix", impact_scope: "file", impact_effect: "local_behavior", impact_confidence: "high", workflow_request: ["reviewer"] }) });
  assert.equal(init.status, 0, init.stdout || init.stderr);
  const state = JSON.parse(readFileSync(join(task, "task.json"), "utf8"));
  delete state.base_commit; // the pre-activation state this guard exists for
  writeFileSync(join(task, "task.json"), JSON.stringify(state));
  writeFileSync(join(repo, "f.txt"), "two");
  const refused = run(["review-record", "--task-path", task, "--repo-root", repo, "--state-root", stateRoot, "--role", "reviewer", "--result", "pass", "--summary", "should not be accepted"]);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stdout, /task has no base_commit/);
});

test("the focused test runner rejects missing or outside paths instead of silently running the full suite", () => {
  const missing = spawnSync(process.execPath, ["scripts/run-tests.mjs", "tests-node/no-such-test.test.mjs"], { cwd: process.cwd(), encoding: "utf8" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /no requested test files found/);
  const outside = spawnSync(process.execPath, ["scripts/run-tests.mjs", "package.json"], { cwd: process.cwd(), encoding: "utf8" });
  assert.notEqual(outside.status, 0);
  assert.match(outside.stderr, /no requested test files found/);
});

test("the validation runner exposes deterministic focused, affected, regression, and full profiles", () => {
  const focused = spawnSync(process.execPath, ["scripts/run-tests.mjs", "--profile", "focused", "--", "tests-node/cli.test.mjs"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(focused.status, 0, focused.stderr);
  assert.match(focused.stderr, /profile=focused files=1/);
  const affected = spawnSync(process.execPath, ["scripts/run-tests.mjs", "--profile=affected", "--", "tests-node/cli.test.mjs"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(affected.status, 0, affected.stderr);
  assert.match(affected.stderr, /profile=affected files=1/);
  const fullWithPath = spawnSync(process.execPath, ["scripts/run-tests.mjs", "--profile", "full", "--", "tests-node/cli.test.mjs"], { cwd: process.cwd(), encoding: "utf8" });
  assert.notEqual(fullWithPath.status, 0);
  assert.match(fullWithPath.stderr, /full profile does not accept explicit paths/);
  const unknown = spawnSync(process.execPath, ["scripts/run-tests.mjs", "--profile", "unknown"], { cwd: process.cwd(), encoding: "utf8" });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unknown validation profile/);
});

test("project-doc Remember output matches its declared shape", () => {
  const root = join(tmpdir(), `agent-workflow-project-doc-remember-${process.pid}-${Date.now()}`);
  const task = join(root, "20260101-000000-project-doc-remember");
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(task, { recursive: true });
  writeFileSync(join(root, "docs", "architecture.md"), "---\ndoc_type: architecture\ncovers: []\n---\n\n# architecture\n");
  writeFileSync(join(task, "task.md"), "# Remember\n\n## Goal\n\nRecord a digest.\n\n## Scope\n\nOne document.\n\n## Completion criteria\n\n- [ ] digest is recorded\n");
  const init = run(["task-init", "--task-path", task], { input: JSON.stringify({ code_change: false, managed_change: false }) });
  assert.equal(init.status, 0, init.stdout || init.stderr);
  const result = run(["project-doc", "--action", "Remember", "--repo-root", root, "--task-path", task, "--paths", "docs/architecture.md"]);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const validate = validatorFor("project-doc-remember");
  assert.ok(validate(JSON.parse(result.stdout)), JSON.stringify(validate.errors));
});

test("task-gate and contract-lint output match their declared shapes", () => {
  const root = join(tmpdir(), `agent-workflow-output-gate-${process.pid}-${Date.now()}`);
  const task = join(root, "task");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Shape\n\n## Goal\n\nVerify the declared output shape.\n\n## Scope\n\nTest fixture scope.\n\n## Completion criteria\n\n- [ ] fixture is valid\n");
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

test("next categorizes the gate's blockers and names the command that clears the first one", () => {
  const root = join(tmpdir(), `agent-workflow-output-next-${process.pid}-${Date.now()}`);
  const task = join(root, "20260101-000000-output-next");
  mkdirSync(task, { recursive: true });
  writeFileSync(join(task, "task.md"), "# Next shape\n\n## Goal\n\nVerify next output.\n\n## Scope\n\nNo source change.\n\n## Completion criteria\n\n- [ ] output validates\n");
  const init = run(["task-init", "--task-path", task], { input: JSON.stringify({
    // The ui flag is what draws baseline_validation: managed_change alone no longer requires any
    // capability, so a confident, risk-free change would have nothing pending to categorize.
    code_change: false, managed_change: true, workflow_mode: "main", task_type: "fix", risk_flags: ["ui"],
    impact_scope: "module", impact_effect: "local_behavior", impact_confidence: "high", workflow_request: ["reviewer"]
  }) });
  assert.equal(init.status, 0, init.stderr);
  const result = run(["next", "--task-path", task]);
  const plan = JSON.parse(result.stdout);
  const validate = validatorFor("next");
  assert.ok(validate(plan), JSON.stringify(validate.errors));
  assert.deepEqual(plan.required_roles, ["reviewer"]);
  assert.ok(plan.pending_evidence.includes("baseline_validation.BV1"), result.stdout);
  // The role blocker carries a different category from the evidence ones it is mixed in with.
  assert.deepEqual([...new Set(plan.blocking_reasons.map((reason) => reason.category))].sort(), ["evidence", "role"]);
  assert.match(plan.next_action, /^run: agent-workflow evidence-record .*baseline_validation\.BV1/);
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
  writeFileSync(join(root, ".agents", "skills", "workflow", "evidence.md"), readFileSync(join(process.cwd(), ".agents", "skills", "workflow", "evidence.md")));
  writeFileSync(join(root, ".agents", "skills", "workflow", "review.md"), readFileSync(join(process.cwd(), ".agents", "skills", "workflow", "review.md")));
  for (const pointer of [".agents/skills/workflow/elevated.md", ".agents/skills/workflow/orchestration.md", ".agents/agents/worker.md", ".agents/skills/project-docs/SKILL.md"]) {
    mkdirSync(join(root, dirname(pointer)), { recursive: true });
    cpSync(join(process.cwd(), pointer), join(root, pointer));
  }
  writeFileSync(join(root, "templates", "task.md"), templateLines.join("\n"));
  for (const [name, lines] of Object.entries(extraSkills)) {
    mkdirSync(join(root, ".agents", "skills", name), { recursive: true });
    writeFileSync(join(root, ".agents", "skills", name, "SKILL.md"), lines.join("\n"));
  }
  return root;
}
