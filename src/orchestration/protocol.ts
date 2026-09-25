import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsRaw from "ajv-formats";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildExecutionPacket } from "../execution/execution-packet.js";
import { AcceptanceCase, acceptanceCases } from "../intent.js";
import { nextForState } from "../lifecycle/task-gate.js";
import { taskInit, transitionTask } from "../lifecycle/transitions.js";
import { covers } from "../lifecycle/ownership.js";
import {
  JsonObject, canonicalJson, changedPaths, git, isWithin, mutateJsonState, normalizeRepoPath, now, output, readJson, runCommand,
  sha256, schemaPath, stateRoot, workspaceFingerprint, writeAtomic, writeJson
} from "../core.js";
import { DEFAULT_MIN_FILES_PER_WORKER, WORKER_STATE_DIRECTORY, worthwhileReasons } from "./parallel.js";

export type ProtocolOptions = Map<string, string | boolean | string[]>;

type WorkerPlan = {
  id: string;
  title?: string;
  goal: string;
  scope?: string;
  completion_criteria: string;
  acceptance: string[];
  planned_files: string[];
  file_ownership: string[];
  task_path?: string;
  classification?: JsonObject;
};

type ProtocolPlan = {
  parent_task_path?: string;
  repo_root?: string;
  workers: WorkerPlan[];
  shared_files: string[];
  coordinator_acceptance: string[];
  has_order_dependency?: boolean;
  shared_persistent_state?: boolean;
  max_workers?: number;
  min_files_per_worker?: number;
};

type NextAction = { command: string; why: string };

// Dependency directories a fresh worktree lacks because they are gitignored; linking them lets a
// worker run the project's own test command without reinstalling. Only top-level, ignored,
// existing directories are linked, and the links are removed before any worktree removal.
const DEPENDENCY_DIRECTORIES = ["node_modules", ".venv", "venv", "vendor"];

type ArtifactFile = { path: string; kind: "file" | "delete"; sha256: string; size?: number };

const addFormats = addFormatsRaw as unknown as (instance: InstanceType<typeof Ajv2020>) => void;
const protocolValidator = new Ajv2020({ allErrors: true, strict: false });
addFormats(protocolValidator);
const validateProtocolState = protocolValidator.compile(JSON.parse(readFileSync(schemaPath("orchestration.schema.json"), "utf8")) as JsonObject);

const PHASES = new Set(["planned", "prepared", "executing", "collecting", "integrating", "applied", "cleaning", "cleaned", "failed", "cancelled"]);
const WORKER_STATUSES = new Set(["prepared", "bound", "running", "completed", "blocked", "failed", "cancelled"]);

function stringOption(options: ProtocolOptions, name: string, fallback = ""): string {
  const value = options.get(name);
  if (Array.isArray(value)) throw new Error(`duplicate option --${name}`);
  return typeof value === "string" ? value : fallback;
}

function jsonPath(value: string): string { const resolved = resolve(value); return resolved.endsWith(".json") ? resolved : join(resolved, "task.json"); }

function protocolDirectory(root: string, id: string): string { return join(root, "orchestration", "v3", id); }
function statePath(root: string, id: string): string { return join(protocolDirectory(root, id), "state.json"); }
function artifactDirectory(root: string, id: string, workerId: string, attempt: number): string {
  return join(protocolDirectory(root, id), "artifacts", workerId, String(attempt));
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function assertOwnedPath(root: string, id: string, path: string, label: string): string {
  const resolved = resolve(path);
  if (!isWithin(resolved, protocolDirectory(root, id))) throw new Error(`${label} escapes protocol batch directory: ${path}`);
  return resolved;
}

function assertProtocolState(state: JsonObject): void {
  if (validateProtocolState(state)) return;
  const errors = (validateProtocolState.errors || []).map((error: { instancePath?: string; message?: string }) => `${error.instancePath || "/"} ${error.message || "invalid"}`);
  throw new Error(`protocol 3 state fails orchestration schema: ${errors.join("; ")}`);
}

const repoPath = (path: string): string => normalizeRepoPath(path.replaceAll("\\", "/").replace(/^\.\//, ""));
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];

function asWorkers(value: unknown): WorkerPlan[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is JsonObject => !!item && typeof item === "object" && !Array.isArray(item)).map((item) => ({
    id: String(item.id || ""), title: typeof item.title === "string" ? item.title : undefined,
    goal: String(item.goal || ""), scope: typeof item.scope === "string" ? item.scope : undefined,
    completion_criteria: String(item.completion_criteria || ""),
    acceptance: strings(item.acceptance).map((id) => id.toUpperCase()),
    planned_files: strings(item.planned_files).map(repoPath),
    file_ownership: strings(item.file_ownership).map(repoPath),
    task_path: typeof item.task_path === "string" ? item.task_path : undefined,
    classification: asObject(item.classification)
  }));
}

// The parent's acceptance cases are what the split distributes: every case belongs to exactly one
// worker, or to the coordinator when it spans workers.
function parentAcceptance(parentTaskPath: string | undefined): AcceptanceCase[] | undefined {
  if (!parentTaskPath) return undefined;
  const taskMd = join(dirname(jsonPath(parentTaskPath)), "task.md");
  if (!existsSync(taskMd)) return undefined;
  const parsed = acceptanceCases(readFileSync(taskMd, "utf8"));
  return parsed.declared ? parsed.cases : undefined;
}

function validatePlan(plan: ProtocolPlan, repoRoot: string, cases?: AcceptanceCase[]): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(plan.max_workers) || Number(plan.max_workers) < 2) errors.push("max_workers must be an integer >= 2");
  if (plan.workers.length < 2) errors.push("at least two workers are required");
  if (plan.workers.length > Math.max(1, plan.max_workers || 3)) errors.push(`worker count exceeds max_workers (${plan.max_workers || 3})`);
  if (plan.has_order_dependency) errors.push("order dependency makes this batch ineligible for parallel execution");
  if (plan.shared_persistent_state) errors.push("shared persistent state makes this batch ineligible for parallel execution");
  const ids = new Set<string>(); const owned: string[] = [];
  for (const worker of plan.workers) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(worker.id)) errors.push(`invalid worker id: ${worker.id || "(missing)"}`);
    if (ids.has(worker.id)) errors.push(`duplicate worker id: ${worker.id}`);
    ids.add(worker.id);
    if (!worker.goal) errors.push(`worker ${worker.id} needs a goal`);
    if (!worker.completion_criteria && !worker.acceptance.length) errors.push(`worker ${worker.id} needs acceptance cases or completion_criteria`);
    if (!worker.file_ownership.length) errors.push(`worker ${worker.id} needs file_ownership`);
    for (const value of worker.file_ownership) {
      if (!value || value.startsWith("/") || value.split("/").includes("..")) errors.push(`worker ${worker.id} has invalid ownership path: ${value}`);
      if (owned.some((previous) => previous === value || previous.startsWith(`${value}/`) || value.startsWith(`${previous}/`))) errors.push(`ownership overlaps: ${value}`);
      owned.push(value);
      if (isWithin(resolve(repoRoot, value), repoRoot) === false) errors.push(`ownership escapes repository: ${value}`);
    }
    const unplanned = worker.planned_files.filter((path) => !covers(worker.file_ownership, path));
    if (unplanned.length) errors.push(`worker ${worker.id} plans files outside its ownership: ${unplanned.join(", ")}`);
  }
  // Shared files are written by the coordinator before Prepare; a worker owning one could rewrite
  // the contract every other worker builds against.
  for (const shared of plan.shared_files) {
    const holder = plan.workers.find((worker) => covers(worker.file_ownership, shared));
    if (holder) errors.push(`shared file ${shared} falls inside worker ${holder.id}'s ownership; shared files stay with the coordinator`);
  }
  const assigned = [...plan.workers.flatMap((worker) => worker.acceptance), ...plan.coordinator_acceptance];
  if (cases) {
    const known = new Set(cases.map((item) => item.id));
    const unknown = assigned.filter((id) => !known.has(id));
    if (unknown.length) errors.push(`acceptance case(s) not declared in the parent task.md: ${[...new Set(unknown)].join(", ")}`);
    const duplicated = assigned.filter((id, index) => assigned.indexOf(id) !== index);
    if (duplicated.length) errors.push(`acceptance case(s) assigned more than once: ${[...new Set(duplicated)].join(", ")}`);
    const unassigned = cases.map((item) => item.id).filter((id) => !assigned.includes(id));
    if (unassigned.length) errors.push(`acceptance case(s) assigned to no worker and not in coordinator_acceptance: ${unassigned.join(", ")}`);
  } else if (assigned.length) errors.push("acceptance ids need a parent task whose task.md declares them");
  return errors;
}

function gitRequired(cwd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): string {
  const result = git(cwd, args, { input: input === undefined ? undefined : Buffer.from(input), env });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function gitUser(repoRoot: string, key: string, fallback: string): string {
  const result = git(repoRoot, ["config", "--get", key]);
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : fallback;
}

function snapshotWorkspace(repoRoot: string, directory: string): { commit: string; fingerprint: string } {
  mkdirSync(directory, { recursive: true });
  const index = join(directory, "snapshot.index");
  const env = { GIT_INDEX_FILE: index };
  try {
    gitRequired(repoRoot, ["read-tree", "HEAD"], undefined, env);
    gitRequired(repoRoot, ["add", "-A"], undefined, env);
    const tree = gitRequired(repoRoot, ["write-tree"], undefined, env);
    const commit = gitRequired(repoRoot, ["commit-tree", tree, "-p", "HEAD", "-m", "agent-workflow orchestration snapshot"], undefined, {
      ...env,
      GIT_AUTHOR_NAME: gitUser(repoRoot, "user.name", "agent-workflow"),
      GIT_AUTHOR_EMAIL: gitUser(repoRoot, "user.email", "agent-workflow@example.invalid"),
      GIT_COMMITTER_NAME: gitUser(repoRoot, "user.name", "agent-workflow"),
      GIT_COMMITTER_EMAIL: gitUser(repoRoot, "user.email", "agent-workflow@example.invalid")
    });
    return { commit, fingerprint: workspaceFingerprint(repoRoot) };
  } finally { rmSync(index, { force: true }); }
}

function addWorktree(repoRoot: string, path: string, commit: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) throw new Error(`worker worktree already exists: ${path}`);
  gitRequired(repoRoot, ["worktree", "add", "--detach", path, commit]);
}

function linkDependencies(repoRoot: string, worktree: string): string[] {
  const linked: string[] = [];
  for (const name of DEPENDENCY_DIRECTORIES) {
    const source = join(repoRoot, name); const target = join(worktree, name);
    if (!existsSync(source) || !statSync(source).isDirectory() || existsSync(target)) continue;
    if (git(repoRoot, ["check-ignore", "-q", name]).status !== 0) continue;
    try { symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir"); linked.push(name); } catch { /* the worker installs dependencies itself */ }
  }
  return linked;
}

// The links point into the parent repository, so they are removed as links before git deletes the
// worktree; a recursive delete that followed one would empty the parent's dependency directory.
function unlinkDependencies(worktree: string): void {
  for (const name of DEPENDENCY_DIRECTORIES) {
    const target = join(worktree, name);
    try { if (lstatSync(target).isSymbolicLink()) rmSync(target, { force: true }); } catch { /* absent */ }
  }
}

function removeWorktree(repoRoot: string, path: string): void {
  if (!existsSync(path)) return;
  unlinkDependencies(path);
  const result = git(repoRoot, ["worktree", "remove", "--force", path]);
  if (result.status !== 0) throw new Error(`worktree cleanup failed for ${path}: ${result.stderr.trim()}`);
}

function retireChildTask(path: string): void {
  if (!path || !existsSync(path)) return;
  const state = readJson(path); const status = String(asObject(state.lifecycle).status || "");
  if (["in_progress", "paused", "blocked"].includes(status)) transitionTask(path, "supersede", "orchestration");
}

function taskId(batchId: string, workerId: string): string {
  const iso = now();
  const stamp = `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
  return `${stamp}-${batchId.replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 24)}-${workerId}`;
}

function taskMarkdown(worker: WorkerPlan, parentMarkdown?: string): string {
  if (parentMarkdown) return `${parentMarkdown.trimEnd()}\n\n## Worker assignment\n\nWorker: ${worker.id}\nOwned files: ${worker.file_ownership.join(", ")}\nGoal: ${worker.goal}\nCompletion criteria: ${worker.completion_criteria}\n`;
  return `# Worker ${worker.id}\n\n## Goal\n\n${worker.goal}\n\n## Scope\n\n${worker.scope || worker.file_ownership.join(", ")}\n\n## Completion criteria\n\n${worker.completion_criteria}\n`;
}

// What one worker has to deliver, carried in its packet: the parent's own acceptance cases for this
// worker (not the parent's whole Completion criteria), its write boundary, the coordinator's files it
// may only read, and where it reports.
function assignmentFor(worker: WorkerPlan, plan: Pick<ProtocolPlan, "shared_files">, cases: AcceptanceCase[] | undefined, worktree: string, packetPath: string, attempt: number): JsonObject {
  const assigned = (cases || []).filter((item) => worker.acceptance.includes(item.id));
  const exec = `agent-workflow worker-exec --assignment-path "${packetPath}" --cwd "${worktree}"`;
  return {
    worker_id: worker.id, attempt, goal: worker.goal,
    ...(worker.completion_criteria ? { completion_criteria: worker.completion_criteria } : {}),
    acceptance: assigned.map((item) => ({ id: item.id, title: item.title, given: item.given, when: item.when, then: item.then, command: item.command, verify: `${exec} --acceptance ${item.id} -- ${item.command}` })),
    worktree, file_ownership: worker.file_ownership, planned_files: worker.planned_files, shared_files_read_only: plan.shared_files,
    result_path: join(worktree, WORKER_STATE_DIRECTORY, "result.json"),
    run_command: `${exec} -- <command>`
  } as unknown as JsonObject;
}

function writePacket(taskJsonPath: string, worktree: string, assignment: JsonObject): string {
  const packetPath = join(dirname(taskJsonPath), "execution-packet.json");
  writeJson(packetPath, { ...(buildExecutionPacket(readJson(taskJsonPath), taskJsonPath, worktree) as unknown as JsonObject), assignment });
  return packetPath;
}

function createChildTask(worker: WorkerPlan, batchId: string, parent: JsonObject, parentTaskPath: string | undefined, root: string, repoRoot: string, worktree: string, plan: Pick<ProtocolPlan, "shared_files">, cases: AcceptanceCase[] | undefined, attempt = 1): { taskPath: string; packetPath: string; taskId: string } {
  const childId = taskId(batchId, worker.id);
  const taskDir = worker.task_path ? resolve(worker.task_path) : join(root, "projects", String(parent.project_id || "orchestration"), "tasks", childId);
  if (!isWithin(taskDir, root)) throw new Error(`worker ${worker.id} task_path must stay under state root`);
  mkdirSync(taskDir, { recursive: true });
  const taskJsonPath = join(taskDir, "task.json");
  if (existsSync(taskJsonPath) || existsSync(join(taskDir, "task.md"))) throw new Error(`child task directory already contains task state: ${taskDir}`);
  const inheritedMarkdown = parentTaskPath && existsSync(join(dirname(parentTaskPath), "task.md")) ? readFileSync(join(dirname(parentTaskPath), "task.md"), "utf8") : undefined;
  writeAtomic(join(taskDir, "task.md"), taskMarkdown(worker, inheritedMarkdown));
  const parentFlags = Array.isArray(parent.risk_flags) ? parent.risk_flags.map(String) : [];
  const classification: JsonObject = {
    code_change: true, managed_change: parent.managed_change !== false,
    task_type: String(parent.task_type || "refactor"), impact_scope: String(parent.impact_scope || "module"),
    impact_effect: String(parent.impact_effect || "local_behavior"), impact_confidence: String(parent.impact_confidence || "medium"),
    risk_flags: parentFlags, workflow_facts: asObject(parent.workflow_facts), workflow_request: Array.isArray(parent.workflow_request) ? parent.workflow_request : [],
    ...worker.classification, independence: "native", subtask_role: "worker",
    file_ownership: worker.file_ownership, delivery_status: "pending", integration_status: "pending"
  };
  if (parent.id) classification.parent_task_id = String(parent.id);
  const runtimeSeed: JsonObject = parent.intent_approval && inheritedMarkdown ? { intent_approval: parent.intent_approval } : {};
  let created = false;
  try {
    const result = taskInit(taskDir, classification, "coordinator", root, worktree, false, false, runtimeSeed);
    if (result !== 0 || !existsSync(taskJsonPath)) throw new Error(`failed to create child task for worker ${worker.id}`);
    created = true;
    const packetPath = join(taskDir, "execution-packet.json");
    writePacket(taskJsonPath, worktree, assignmentFor(worker, plan, cases, worktree, packetPath, attempt));
    return { taskPath: taskJsonPath, packetPath, taskId: childId };
  } catch (error) {
    if (created) { try { retireChildTask(taskJsonPath); } catch { /* preserve original failure */ } }
    throw error;
  }
}

function artifactFiles(repoRoot: string, base: string, ownership: string[]): ArtifactFile[] {
  // The worker's result and receipts live in the worktree only because a sandboxed worker can write
  // nowhere else; they are reports, never delivery.
  const reserved = normalizeRepoPath(WORKER_STATE_DIRECTORY);
  const links = new Set(DEPENDENCY_DIRECTORIES.map(normalizeRepoPath));
  const paths = changedPaths(repoRoot, base).filter((path) => {
    const normalized = normalizeRepoPath(path);
    return !normalized.startsWith(`${reserved}/`) && !(links.has(normalized) && lstatSync(resolve(repoRoot, path), { throwIfNoEntry: false })?.isSymbolicLink());
  });
  const outside = paths.filter((path) => !covers(ownership, path));
  if (outside.length) throw new Error(`ownership violation: ${outside.join(", ")}`);
  const files: ArtifactFile[] = [];
  for (const path of paths) {
    const full = resolve(repoRoot, path);
    if (!isWithin(full, repoRoot)) throw new Error(`changed path escapes worktree: ${path}`);
    if (!existsSync(full)) {
      files.push({ path, kind: "delete", sha256: sha256(`${path}:delete`) });
      continue;
    }
    if (lstatSync(full).isSymbolicLink()) throw new Error(`symbolic-link changes are not supported: ${path}`);
    const content = readFileSync(full);
    const digest = sha256(content);
    files.push({ path, kind: "file", sha256: digest, size: content.length });
  }
  return files;
}

function writeArtifactFiles(repoRoot: string, files: ArtifactFile[], directory: string, base: string): void {
  for (const file of files) {
    if (file.kind === "delete") continue;
    const source = resolve(repoRoot, file.path);
    if (!existsSync(source) || lstatSync(source).isSymbolicLink()) throw new Error(`artifact source changed: ${file.path}`);
    const content = readFileSync(source);
    if (sha256(content) !== file.sha256) throw new Error(`artifact source changed during collection: ${file.path}`);
    const target = join(directory, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeAtomic(target, content);
  }
  writeJson(join(directory, "manifest.json"), { base, files });
}

function changedArtifacts(repoRoot: string, base: string, ownership: string[], directory: string): ArtifactFile[] {
  const files = artifactFiles(repoRoot, base, ownership);
  writeArtifactFiles(repoRoot, files, directory, base);
  return files;
}

function applyArtifact(artifactRoot: string, targetRoot: string, files: ArtifactFile[]): void {
  for (const file of files) {
    const target = resolve(targetRoot, file.path);
    if (!isWithin(target, targetRoot)) throw new Error(`artifact path escapes target worktree: ${file.path}`);
    if (file.kind === "delete") { rmSync(target, { force: true }); continue; }
    const source = resolve(artifactRoot, file.path); if (!isWithin(source, artifactRoot)) throw new Error(`artifact path escapes artifact root: ${file.path}`);
    if (lstatSync(source).isSymbolicLink()) throw new Error(`symbolic-link artifacts are not supported: ${file.path}`);
    if (!existsSync(source) || sha256(readFileSync(source)) !== file.sha256) throw new Error(`artifact content changed: ${file.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeAtomic(target, readFileSync(source));
  }
}

function parentState(plan: ProtocolPlan): JsonObject {
  if (!plan.parent_task_path) return {};
  const path = jsonPath(plan.parent_task_path);
  if (!existsSync(path)) throw new Error(`parent task is missing: ${path}`);
  return readJson(path);
}

function readPlan(options: ProtocolOptions): ProtocolPlan {
  const planPath = stringOption(options, "plan-path");
  if (!planPath || !existsSync(planPath)) throw new Error("this protocol 3 action requires --plan-path");
  const raw = readJson(planPath) as JsonObject;
  const plan: ProtocolPlan = {
    parent_task_path: typeof raw.parent_task_path === "string" ? raw.parent_task_path : undefined,
    repo_root: typeof raw.repo_root === "string" ? raw.repo_root : undefined,
    workers: asWorkers(raw.workers), has_order_dependency: raw.has_order_dependency === true,
    shared_files: strings(raw.shared_files).map(repoPath),
    coordinator_acceptance: strings(raw.coordinator_acceptance).map((id) => id.toUpperCase()),
    shared_persistent_state: raw.shared_persistent_state === true, max_workers: raw.max_workers === undefined ? 3 : Number(raw.max_workers),
    min_files_per_worker: raw.min_files_per_worker === undefined ? DEFAULT_MIN_FILES_PER_WORKER : Number(raw.min_files_per_worker)
  };
  const parentTaskOverride = stringOption(options, "parent-task-path");
  if (parentTaskOverride) plan.parent_task_path = parentTaskOverride;
  if (plan.parent_task_path) plan.parent_task_path = jsonPath(plan.parent_task_path);
  return plan;
}

// Every command a coordinator runs next names the same batch and state root it was given.
function orchestrateCommand(options: ProtocolOptions, action: string, id: string, extra = ""): string {
  const root = stringOption(options, "state-root");
  return `agent-workflow orchestrate --action ${action} --id ${id}${root ? ` --state-root "${root}"` : ""}${extra ? ` ${extra}` : ""}`;
}

function workersOf(state: JsonObject): JsonObject[] { return (Array.isArray(state.workers) ? state.workers : []).map(asObject); }

// Collect → Retry/Integrate routing: what is still outstanding decides the next command.
function collectionNext(options: ProtocolOptions, state: JsonObject, id: string): NextAction[] {
  const workers = workersOf(state);
  const rejected = workers.filter((worker) => worker.artifact_status === "rejected");
  const pending = workers.filter((worker) => worker.artifact_status === "uncollected");
  const actions: NextAction[] = [];
  for (const worker of rejected) actions.push({ command: orchestrateCommand(options, "Retry", id, `--worker-id ${String(worker.id)}`), why: `worker ${String(worker.id)} was rejected: ${String(worker.rejected_reason || `status ${String(worker.status)}`)}; add --plan-path to widen its ownership, or Cancel the batch and continue sequentially` });
  for (const worker of pending) actions.push({ command: orchestrateCommand(options, "Collect", id, `--worker-id ${String(worker.id)}`), why: `collect worker ${String(worker.id)} once it reports` });
  if (!rejected.length && !pending.length) actions.push({ command: orchestrateCommand(options, "Integrate", id), why: "every worker artifact is collected" });
  return actions;
}

function protocolState(root: string, id: string): JsonObject {
  const path = statePath(root, id);
  if (!existsSync(path)) throw new Error(`orchestration batch is missing: ${id}`);
  const state = readJson(path); assertProtocolState(state); return state;
}

function saveState(root: string, id: string, patch: (state: JsonObject) => void): JsonObject {
  return mutateJsonState<JsonObject>(statePath(root, id), (state) => { patch(state); state.updated_at = now(); assertProtocolState(state); });
}

function requirePhase(state: JsonObject, phases: string[]): void {
  const phase = String(state.phase || "");
  if (!phases.includes(phase)) throw new Error(`protocol 3 action is invalid in phase ${phase}; expected ${phases.join(", ")}`);
}

function workerRecord(state: JsonObject, id: string): JsonObject {
  const worker = (Array.isArray(state.workers) ? state.workers : []).find((item) => String(asObject(item).id) === id);
  if (!worker) throw new Error(`worker assignment is missing: ${id}`);
  return asObject(worker);
}

function workerRecordFor(worker: WorkerPlan, child: { taskPath: string; packetPath: string; taskId: string }, worktree: string, attempt: number): JsonObject {
  return {
    id: worker.id, title: worker.title || worker.id, task_id: child.taskId, task_path: child.taskPath, packet_path: child.packetPath,
    worktree, file_ownership: worker.file_ownership, attempt, status: "prepared", artifact_status: "uncollected",
    goal: worker.goal, acceptance: worker.acceptance, planned_files: worker.planned_files
  };
}

function prepare(options: ProtocolOptions, root: string, id: string): number {
  const plan = readPlan(options);
  const repoRoot = resolve(stringOption(options, "repo-root", plan.repo_root || process.cwd()));
  if (isWithin(root, repoRoot)) throw new Error("protocol 3 state root must be outside the repository so orchestration records do not change the parent fingerprint");
  const cases = parentAcceptance(plan.parent_task_path);
  const errors = validatePlan(plan, repoRoot, cases); if (errors.length) throw new Error(`protocol 3 split rejected: ${errors.join("; ")}`);
  const directory = protocolDirectory(root, id); if (existsSync(statePath(root, id))) throw new Error(`orchestration batch already exists: ${id}`);
  mkdirSync(directory, { recursive: true });
  const parent = parentState(plan); const snapshot = snapshotWorkspace(repoRoot, join(directory, "snapshot"));
  const workers: JsonObject[] = [];
  const createdWorktrees: string[] = [];
  try {
    for (const worker of plan.workers) {
      const worktree = join(directory, "worktrees", worker.id);
      addWorktree(repoRoot, worktree, snapshot.commit);
      createdWorktrees.push(worktree);
      const child = createChildTask(worker, id, parent, plan.parent_task_path, root, repoRoot, worktree, plan, cases);
      // After the child task's activation, which requires a clean worktree: git reports a directory
      // link as an untracked file that a `node_modules/` ignore rule does not match.
      linkDependencies(repoRoot, worktree);
      workers.push(workerRecordFor(worker, child, worktree, 1));
    }
  } catch (error) {
    for (const worker of workers) { try { retireChildTask(String(worker.task_path || "")); } catch { /* preserve original failure */ } }
    for (const worktree of createdWorktrees) { try { removeWorktree(repoRoot, worktree); } catch { /* preserve original failure */ } }
    throw error;
  }
  const state: JsonObject = {
    schema_version: 3, protocol: 3, id, experimental: false, phase: "prepared", state_revision: 1, created_at: now(), updated_at: now(),
    parent: { task_path: plan.parent_task_path || "", task_id: String(parent.id || ""), repo_root: repoRoot, snapshot_commit: snapshot.commit, snapshot_workspace_fingerprint: snapshot.fingerprint, workspace_fingerprint: workspaceFingerprint(repoRoot) },
    workers, plan: { shared_files: plan.shared_files, coordinator_acceptance: plan.coordinator_acceptance },
    integration: { status: "pending", root: join(directory, "integration") }, host_bindings: [], journal: [{ at: now(), action: "Prepare", status: "completed" }], history: []
  };
  assertProtocolState(state);
  writeJson(statePath(root, id), state);
  // Dispatch happens on the host platform, all workers in the same turn; the runtime can only say
  // what each one needs.
  const dispatch = workers.map((worker) => ({ worker_id: worker.id, packet_path: worker.packet_path, worktree: worker.worktree, result_path: join(String(worker.worktree), WORKER_STATE_DIRECTORY, "result.json") }));
  const next: NextAction[] = [
    { command: "dispatch every worker in parallel in one turn: Claude → Agent tool subagent_type agent-workflow-worker (run_in_background); Codex → spawn_agent agent_type agent-workflow-worker; the message is only: \"Execute the assignment in <packet_path>\"", why: "each worker reads its packet; continue other coordinator work meanwhile" },
    ...workers.map((worker) => ({ command: orchestrateCommand(options, "Bind", id, `--worker-id ${String(worker.id)} --run-id <platform run id> --platform <Claude|Codex>`), why: `record the host run of worker ${String(worker.id)} right after dispatch` })),
    ...workers.map((worker) => ({ command: orchestrateCommand(options, "Collect", id, `--worker-id ${String(worker.id)}`), why: `after worker ${String(worker.id)} reports` }))
  ];
  output({ protocol: 3, action: "Prepare", batch: state, dispatch, next });
  return 0;
}

function assess(options: ProtocolOptions, id: string): number {
  const plan = readPlan(options);
  const repoRoot = resolve(stringOption(options, "repo-root", plan.repo_root || process.cwd()));
  const cases = parentAcceptance(plan.parent_task_path);
  const errors = validatePlan(plan, repoRoot, cases);
  const parent = plan.parent_task_path && existsSync(plan.parent_task_path) ? readJson(plan.parent_task_path) : {};
  const reasons = worthwhileReasons(plan.workers, parent, plan.min_files_per_worker);
  const eligible = errors.length === 0; const worthwhile = reasons.length === 0;
  const recommendation = eligible && worthwhile ? "parallel" : "sequential";
  const planPath = stringOption(options, "plan-path");
  const next: NextAction[] = recommendation === "parallel"
    ? [{ command: orchestrateCommand(options, "Prepare", id, `--plan-path "${planPath}"`), why: "the split is safe and worth its setup; tell the user how the work is split, then prepare the batch" }]
    : [{ command: "continue with ordered slices in the parent task (workflow/elevated.md)", why: [...errors, ...reasons].join("; ") }];
  output({ protocol: 3, action: "Assess", eligible, worthwhile, recommendation, repo_root: repoRoot, worker_count: plan.workers.length, errors, reasons, next }); return 0;
}

function bind(options: ProtocolOptions, root: string, id: string): number {
  const workerId = stringOption(options, "worker-id"); const runId = stringOption(options, "run-id"); const platform = stringOption(options, "platform");
  if (!workerId || !runId || !platform) throw new Error("Bind requires --worker-id, --run-id and --platform");
  const state = saveState(root, id, (current) => {
    requirePhase(current, ["prepared", "executing", "collecting"]); const worker = workerRecord(current, workerId);
    if (!["prepared", "bound"].includes(String(worker.status))) throw new Error(`worker ${workerId} cannot bind from status ${String(worker.status || "(missing)")}`);
    const assignedWorktree = assertOwnedPath(root, id, String(worker.worktree || ""), "worker worktree");
    const workspace = stringOption(options, "workspace", assignedWorktree);
    if (resolve(workspace) !== assignedWorktree) throw new Error("host workspace does not match the assignment worktree");
    const binding = { worker_id: workerId, platform, run_id: runId, workspace, bound_at: now() };
    worker.host = binding; worker.status = "bound"; current.host_bindings = [...(Array.isArray(current.host_bindings) ? current.host_bindings : []).filter((item) => String(asObject(item).worker_id) !== workerId), binding];
    current.phase = "executing"; current.journal = [...(Array.isArray(current.journal) ? current.journal : []), { at: now(), action: "Bind", worker_id: workerId, run_id: runId }];
  });
  output({ protocol: 3, action: "Bind", batch: state, next: [{ command: orchestrateCommand(options, "Collect", id, `--worker-id ${workerId}`), why: `after worker ${workerId} reports` }] }); return 0;
}

// Latest worker-exec receipt per acceptance id for this attempt. Receipts are the worker's own runs in
// its worktree: enough to reject an unfinished worker early, never a substitute for parent evidence.
function acceptanceReceipts(worktree: string, attempt: number): Record<string, JsonObject> {
  const path = join(worktree, WORKER_STATE_DIRECTORY, "receipts.jsonl");
  const results: Record<string, JsonObject> = {};
  if (!existsSync(path)) return results;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)) {
    let receipt: JsonObject; try { receipt = JSON.parse(line) as JsonObject; } catch { continue; }
    if (Number(receipt.attempt || 1) !== attempt) continue;
    for (const acceptanceId of strings(receipt.acceptance)) results[acceptanceId] = { exit_code: Number(receipt.exit_code), command: String(receipt.command || ""), at: String(receipt.at || "") };
  }
  return results;
}

function collect(options: ProtocolOptions, root: string, id: string): number {
  const workerId = stringOption(options, "worker-id");
  if (!workerId) throw new Error("Collect requires --worker-id");
  let artifactHash = ""; let rejectedReason = "";
  const next = mutateJsonState<JsonObject>(statePath(root, id), (current) => {
    assertProtocolState(current); requirePhase(current, ["executing", "collecting", "integrating"]);
    const worker = workerRecord(current, workerId); const worktree = assertOwnedPath(root, id, String(worker.worktree || ""), "worker worktree");
    if (!existsSync(worktree)) throw new Error(`worker worktree is missing: ${worktree}`);
    const resultPath = stringOption(options, "result-path", join(worktree, WORKER_STATE_DIRECTORY, "result.json"));
    if (!existsSync(resultPath)) throw new Error(`worker ${workerId} has not written its result yet: ${resultPath}`);
    const result = readJson(resultPath) as JsonObject; let status = String(result.status || "");
    if (!WORKER_STATUSES.has(status) || !["completed", "blocked", "failed", "cancelled"].includes(status)) throw new Error(`invalid worker result status: ${status}`);
    const attempt = Number(worker.attempt || 1);
    const expectedRun = String(asObject(worker.host).run_id || ""); if (expectedRun && String(result.run_id || expectedRun) !== expectedRun) throw new Error("worker result run_id does not match host binding");
    if (result.attempt !== undefined && Number(result.attempt) !== attempt) throw new Error("worker result attempt does not match assignment");
    const base = String(asObject(current.parent).snapshot_commit || ""); const artifactRoot = artifactDirectory(root, id, workerId, attempt);
    const receipts = acceptanceReceipts(worktree, attempt);
    let files: ArtifactFile[] = [];
    if (status === "completed") {
      // A worker that finished outside its boundary or without its cases passing is recorded as
      // rejected rather than aborting Collect, so the batch stays recoverable through Retry.
      try { files = artifactFiles(worktree, base, strings(worker.file_ownership)); }
      catch (error) { rejectedReason = String((error as Error).message || error); }
      const unverified = strings(worker.acceptance).filter((acceptanceId) => !receipts[acceptanceId] || Number(receipts[acceptanceId].exit_code) !== 0);
      if (!rejectedReason && unverified.length) rejectedReason = `acceptance case(s) not passing in the worktree: ${unverified.join(", ")}`;
      if (rejectedReason) { status = "failed"; files = []; }
    } else rejectedReason = `worker reported ${status}${result.ownership_request ? `; ownership request: ${JSON.stringify(result.ownership_request)}` : ""}`;
    artifactHash = sha256(canonicalJson({ status, files, result }));
    const previous = String(worker.artifact_hash || ""); if (previous && previous !== artifactHash) throw new Error("same worker attempt returned different result content");
    if (status === "completed") { mkdirSync(artifactRoot, { recursive: true }); writeArtifactFiles(worktree, files, artifactRoot, base); }
    worker.status = status; worker.result = result; worker.artifact_status = status === "completed" ? "collected" : "rejected"; worker.artifact_root = artifactRoot; worker.artifact = files; worker.artifact_hash = artifactHash;
    worker.acceptance_results = receipts;
    if (rejectedReason) worker.rejected_reason = rejectedReason; else delete worker.rejected_reason;
    current.phase = "collecting";
    current.journal = [...(Array.isArray(current.journal) ? current.journal : []), { at: now(), action: "Collect", worker_id: workerId, status, artifact_hash: artifactHash, ...(rejectedReason ? { detail: rejectedReason } : {}) }];
    current.updated_at = now(); assertProtocolState(current);
  });
  output({ protocol: 3, action: "Collect", worker_id: workerId, artifact_hash: artifactHash, ...(rejectedReason ? { rejected_reason: rejectedReason } : {}), batch: next, next: collectionNext(options, next, id) }); return 0;
}

function integrate(options: ProtocolOptions, root: string, id: string): number {
  const state = protocolState(root, id); requirePhase(state, ["collecting", "integrating"]);
  const parent = asObject(state.parent); const repoRoot = String(parent.repo_root || ""); const base = String(parent.snapshot_commit || "");
  const workers = (Array.isArray(state.workers) ? state.workers : []).map(asObject);
  if (workers.some((worker) => String(worker.artifact_status) !== "collected")) throw new Error("all workers must have collected artifacts before Integrate");
  const integrationRoot = assertOwnedPath(root, id, String(asObject(state.integration).root || join(protocolDirectory(root, id), "integration")), "integration worktree");
  if (existsSync(integrationRoot)) removeWorktree(repoRoot, integrationRoot);
  addWorktree(repoRoot, integrationRoot, base);
  const seen = new Map<string, string>();
  try {
    for (const worker of workers) for (const raw of Array.isArray(worker.artifact) ? worker.artifact : []) {
      const artifact = asObject(raw); const path = String(artifact.path || ""); const previous = seen.get(path);
      if (previous && previous !== String(worker.id)) throw new Error(`integration conflict: ${path} changed by ${previous} and ${String(worker.id)}`);
      seen.set(path, String(worker.id));
      applyArtifact(assertOwnedPath(root, id, String(worker.artifact_root || ""), "worker artifact"), integrationRoot, [artifact as unknown as ArtifactFile]);
    }
    const fingerprint = workspaceFingerprint(integrationRoot);
    const next = saveState(root, id, (current) => { current.phase = "integrating"; current.integration = { root: integrationRoot, status: "integrated", paths: [...seen.keys()].sort(), fingerprint }; current.journal = [...(Array.isArray(current.journal) ? current.journal : []), { at: now(), action: "Integrate", status: "completed", fingerprint }]; });
    output({ protocol: 3, action: "Integrate", batch: next, next: [{ command: orchestrateCommand(options, "Apply", id), why: "copy the integrated delivery into the parent worktree; keep the parent worktree untouched until then" }] }); return 0;
  } catch (error) { try { removeWorktree(repoRoot, integrationRoot); } catch { /* retain for recovery */ } throw error; }
}

function apply(options: ProtocolOptions, root: string, id: string): number {
  const state = protocolState(root, id); requirePhase(state, ["integrating"]);
  const parent = asObject(state.parent); const repoRoot = resolve(String(parent.repo_root || ""));
  if (workspaceFingerprint(repoRoot) !== String(parent.workspace_fingerprint || "")) throw new Error("parent workspace changed since Prepare; Apply is blocked");
  const integration = asObject(state.integration); const integrationRoot = assertOwnedPath(root, id, String(integration.root || ""), "integration worktree"); if (!existsSync(integrationRoot)) throw new Error("integration worktree is missing");
  const base = String(parent.snapshot_commit || ""); const paths = changedPaths(integrationRoot, base); const artifactRoot = assertOwnedPath(root, id, join(protocolDirectory(root, id), "integrated-artifact"), "integrated artifact");
  const files = paths.length ? changedArtifacts(integrationRoot, base, paths, artifactRoot) : [];
  applyArtifact(artifactRoot, repoRoot, files);
  const next = saveState(root, id, (current) => { current.phase = "applied"; current.integration = { ...asObject(current.integration), status: "applied", applied_paths: files.map((file) => file.path), applied_fingerprint: workspaceFingerprint(repoRoot) }; current.journal = [...(Array.isArray(current.journal) ? current.journal : []), { at: now(), action: "Apply", status: "completed" }]; });
  const parentTask = String(parent.task_path || "");
  const parentNext = parentTask && existsSync(parentTask) ? nextForState(readJson(parentTask), parentTask, repoRoot) : [];
  output({ protocol: 3, action: "Apply", batch: next, next: [{ command: orchestrateCommand(options, "Cleanup", id), why: "remove the worker worktrees and retire the child tasks" }, ...parentNext] }); return 0;
}

// A retry starts the worker over from the snapshot. With --plan-path the worker's assignment is
// replaced first (typically a widened ownership after an ownership request), which needs a new child
// task and packet; without it only the packet's attempt changes.
function retry(options: ProtocolOptions, root: string, id: string): number {
  const workerId = stringOption(options, "worker-id"); const state = protocolState(root, id); requirePhase(state, ["executing", "collecting"]);
  const before = workerRecord(state, workerId); if (!["blocked", "failed", "cancelled"].includes(String(before.status))) throw new Error("Retry requires a blocked, failed, or cancelled worker");
  const parentRecord = asObject(state.parent);
  const repoRoot = String(parentRecord.repo_root || ""); const worktree = assertOwnedPath(root, id, String(before.worktree || ""), "worker worktree"); const base = String(parentRecord.snapshot_commit || "");
  const parentTaskPath = String(parentRecord.task_path || "") || undefined;
  const cases = parentAcceptance(parentTaskPath);
  const batchPlan = asObject(state.plan);
  let replacement: WorkerPlan | undefined;
  if (stringOption(options, "plan-path")) {
    const plan = readPlan(options);
    replacement = plan.workers.find((worker) => worker.id === workerId);
    if (!replacement) throw new Error(`plan has no worker ${workerId}`);
    const others = workersOf(state).filter((worker) => String(worker.id) !== workerId).map((worker) => ({
      id: String(worker.id), goal: String(worker.goal || worker.id), completion_criteria: "", acceptance: strings(worker.acceptance), planned_files: strings(worker.planned_files), file_ownership: strings(worker.file_ownership)
    }));
    const errors = validatePlan({ ...plan, workers: [...others, replacement], shared_files: strings(batchPlan.shared_files), coordinator_acceptance: strings(batchPlan.coordinator_acceptance) }, repoRoot, cases);
    if (errors.length) throw new Error(`Retry plan rejected: ${errors.join("; ")}`);
  }
  const attempt = Number(before.attempt || 1) + 1;
  removeWorktree(repoRoot, worktree); addWorktree(repoRoot, worktree, base);
  let record: JsonObject | undefined;
  if (replacement) {
    retireChildTask(String(before.task_path || ""));
    const parent = parentTaskPath && existsSync(parentTaskPath) ? readJson(parentTaskPath) : {};
    const child = createChildTask(replacement, `${id}-r${attempt}`, parent, parentTaskPath, root, repoRoot, worktree, { shared_files: strings(batchPlan.shared_files) }, cases, attempt);
    record = workerRecordFor(replacement, child, worktree, attempt);
  } else {
    const current: WorkerPlan = { id: workerId, goal: String(before.goal || workerId), completion_criteria: "", acceptance: strings(before.acceptance), planned_files: strings(before.planned_files), file_ownership: strings(before.file_ownership) };
    writePacket(String(before.task_path), worktree, assignmentFor(current, { shared_files: strings(batchPlan.shared_files) }, cases, worktree, String(before.packet_path), attempt));
  }
  linkDependencies(repoRoot, worktree);
  const next = saveState(root, id, (current) => {
    const worker = workerRecord(current, workerId);
    if (record) Object.assign(worker, record);
    worker.attempt = attempt; worker.status = "prepared"; worker.artifact_status = "uncollected";
    for (const key of ["result", "artifact", "artifact_hash", "artifact_root", "acceptance_results", "rejected_reason", "host"]) delete worker[key];
    current.phase = "executing"; current.journal = [...(Array.isArray(current.journal) ? current.journal : []), { at: now(), action: "Retry", worker_id: workerId, attempt }];
  });
  const packet = String(workerRecord(next, workerId).packet_path || "");
  output({ protocol: 3, action: "Retry", batch: next, next: [
    { command: `dispatch a new worker with only: "Execute the assignment in ${packet}"`, why: `attempt ${attempt} of worker ${workerId}` },
    { command: orchestrateCommand(options, "Bind", id, `--worker-id ${workerId} --run-id <platform run id> --platform <Claude|Codex>`), why: "record the new host run" },
    { command: orchestrateCommand(options, "Collect", id, `--worker-id ${workerId}`), why: "after the worker reports" }
  ] }); return 0;
}

function recover(options: ProtocolOptions, root: string, id: string): number {
  const state = protocolState(root, id); const errors: string[] = [];
  if (!PHASES.has(String(state.phase))) errors.push("unknown orchestration phase");
  const parent = asObject(state.parent); if (parent.repo_root && !existsSync(String(parent.repo_root))) errors.push("parent repository is missing");
  for (const worker of (Array.isArray(state.workers) ? state.workers : []).map(asObject)) {
    if (!WORKER_STATUSES.has(String(worker.status))) errors.push(`worker ${String(worker.id)} has invalid status`);
    if (worker.worktree && !existsSync(String(worker.worktree))) errors.push(`worker ${String(worker.id)} worktree is missing`);
  }
  output({ protocol: 3, action: "Recover", recoverable: errors.length === 0, errors, batch: state }); return errors.length ? 1 : 0;
}

function cleanup(options: ProtocolOptions, root: string, id: string): number {
  const state = protocolState(root, id); requirePhase(state, ["prepared", "executing", "collecting", "integrating", "applied", "failed", "cancelled", "cleaning"]);
  const repoRoot = String(asObject(state.parent).repo_root || "");
  for (const worker of (Array.isArray(state.workers) ? state.workers : []).map(asObject)) { retireChildTask(String(worker.task_path || "")); if (worker.worktree) removeWorktree(repoRoot, assertOwnedPath(root, id, String(worker.worktree), "worker worktree")); }
  const integrationRoot = String(asObject(state.integration).root || ""); if (integrationRoot) removeWorktree(repoRoot, assertOwnedPath(root, id, integrationRoot, "integration worktree"));
  const next = saveState(root, id, (current) => { current.phase = "cleaned"; current.journal = [...(Array.isArray(current.journal) ? current.journal : []), { at: now(), action: "Cleanup", status: "completed" }]; });
  const parentTask = String(asObject(state.parent).task_path || "");
  const parentNext = parentTask && existsSync(parentTask) ? nextForState(readJson(parentTask), parentTask, repoRoot) : [];
  output({ protocol: 3, action: "Cleanup", batch: next, next: parentNext }); return 0;
}

// Ending a batch early leaves its worktrees for inspection but must release the child tasks, or
// their worktree leases would outlive the batch.
function endBatch(options: ProtocolOptions, root: string, id: string, action: "Fail" | "Cancel"): number {
  const reason = stringOption(options, "reason", action === "Fail" ? "coordinator marked batch failed" : "coordinator cancelled batch");
  const next = saveState(root, id, (state) => {
    requirePhase(state, ["prepared", "executing", "collecting", "integrating"]);
    state.phase = action === "Fail" ? "failed" : "cancelled";
    state.journal = [...(Array.isArray(state.journal) ? state.journal : []), { at: now(), action, status: String(state.phase), detail: reason }];
  });
  for (const worker of workersOf(next)) { try { retireChildTask(String(worker.task_path || "")); } catch { /* Cleanup retries it */ } }
  output({ protocol: 3, action, batch: next, next: [{ command: orchestrateCommand(options, "Cleanup", id), why: "remove the batch worktrees, then continue the parent task sequentially" }] }); return 0;
}

// Protocol 3 is the only orchestration engine. The protocol 2 phase tracker had no worker semantics
// and is retired: a leftover v2 state file stays readable so it can be inspected and removed, but
// nothing creates or advances one.
export function orchestrate(options: ProtocolOptions): number {
  const requested = stringOption(options, "protocol", "3");
  if (requested === "3") return protocol3(options);
  const action = stringOption(options, "action", "Status"); const id = stringOption(options, "id");
  if (requested === "2" && (action === "Status" || action === "Read") && /^[a-z0-9][a-z0-9-]*$/i.test(id)) {
    const legacy = join(stateRoot(stringOption(options, "state-root") || undefined), "orchestration", `${id}.json`);
    output({ protocol: 2, retired: true, state: existsSync(legacy) ? readJson(legacy) : null }); return 0;
  }
  throw new Error(`orchestrate: protocol ${requested} is retired; use protocol 3 (the default). Only --protocol 2 --action Read of a leftover state remains.`);
}

export function protocol3(options: ProtocolOptions): number {
  const root = stateRoot(stringOption(options, "state-root") || undefined); const id = stringOption(options, "id"); const action = stringOption(options, "action", "Status");
  if (!id) throw new Error("protocol 3 requires --id");
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) throw new Error("protocol 3 --id must contain only letters, numbers, and hyphens");
  if (action === "Prepare") return prepare(options, root, id);
  if (action === "Assess") return assess(options, id);
  if (action === "Status" || action === "Read") { output({ protocol: 3, batch: protocolState(root, id) }); return 0; }
  if (action === "Bind") return bind(options, root, id);
  if (action === "Collect") return collect(options, root, id);
  if (action === "Integrate") return integrate(options, root, id);
  if (action === "Apply") return apply(options, root, id);
  if (action === "Retry") return retry(options, root, id);
  if (action === "Recover") return recover(options, root, id);
  if (action === "Fail" || action === "Cancel") return endBatch(options, root, id, action);
  if (action === "Cleanup") return cleanup(options, root, id);
  throw new Error(`unsupported protocol 3 action: ${action}`);
}

export function workerCheck(options: ProtocolOptions): number {
  const assignmentPath = stringOption(options, "assignment-path"); if (!assignmentPath || !existsSync(assignmentPath)) throw new Error("worker-check requires --assignment-path");
  const packet = readJson(assignmentPath) as JsonObject; const rawWorkspace = String(asObject(packet.constraints).repo_root || ""); if (!rawWorkspace) throw new Error("worker assignment has no repo_root");
  const workspace = resolve(rawWorkspace); const cwd = resolve(stringOption(options, "cwd", process.cwd()));
  if (cwd !== workspace) throw new Error(`worker cwd mismatch: expected ${workspace}, got ${cwd}`);
  const ownership = Array.isArray(asObject(packet.constraints).file_ownership) ? (asObject(packet.constraints).file_ownership as string[]).map(String) : [];
  if (!ownership.length) throw new Error("worker assignment has no file_ownership");
  output({ valid: true, assignment: assignmentPath, repo_root: workspace, file_ownership: ownership }); return 0;
}

export function workerExec(options: ProtocolOptions, command: string[]): number {
  const assignmentPath = stringOption(options, "assignment-path"); if (!assignmentPath || !existsSync(assignmentPath)) throw new Error("worker-exec requires --assignment-path");
  if (!command.length) throw new Error("worker-exec requires a command after --");
  const packet = readJson(assignmentPath) as JsonObject; const rawWorkspace = String(asObject(packet.constraints).repo_root || ""); if (!rawWorkspace) throw new Error("worker assignment has no repo_root");
  const workspace = resolve(rawWorkspace); const cwd = resolve(stringOption(options, "cwd", process.cwd()));
  if (cwd !== workspace) throw new Error(`worker cwd mismatch: expected ${workspace}, got ${cwd}`);
  const acceptance = [...new Set(strings(stringOption(options, "acceptance").split(",")).map((item) => item.toUpperCase()))];
  const assignedCases = asObject(packet.assignment).acceptance;
  const assigned = Array.isArray(assignedCases) ? assignedCases.map((item) => String(asObject(item).id || "")) : [];
  const foreign = acceptance.filter((item) => !assigned.includes(item));
  if (foreign.length) throw new Error(`worker-exec: ${foreign.join(", ")} is not assigned to this worker; assigned: ${assigned.join(", ") || "(none)"}`);
  const result = runCommand(command, workspace);
  const stdout = result.stdout.toString("utf8"); const stderr = result.stderr.toString("utf8"); const exitCode = result.status ?? 1;
  const outputDigest = sha256(`${stdout}\n${stderr}`);
  if (acceptance.length) {
    // Written inside the worktree because a sandboxed worker can write nowhere else; Collect reads it
    // and excludes the directory from the delivery.
    const receipts = join(workspace, WORKER_STATE_DIRECTORY, "receipts.jsonl");
    mkdirSync(dirname(receipts), { recursive: true });
    appendFileSync(receipts, `${JSON.stringify({ at: now(), attempt: Number(asObject(packet.assignment).attempt || 1), acceptance, command: command.join(" "), exit_code: exitCode, output_digest: outputDigest })}\n`);
  }
  output({ valid: exitCode === 0, assignment: assignmentPath, repo_root: workspace, command, cwd: workspace, exit_code: exitCode, ...(acceptance.length ? { acceptance } : {}), stdout, stderr, output_digest: outputDigest });
  return exitCode;
}
