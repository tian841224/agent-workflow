import { spawnSync } from "node:child_process";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsRaw from "ajv-formats";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildExecutionPacket } from "../execution/execution-packet.js";
import { taskInit, transitionTask } from "../lifecycle/transitions.js";
import { covers } from "../lifecycle/ownership.js";
import {
  JsonObject, canonicalJson, changedPaths, git, isWithin, mutateJsonState, normalizeRepoPath, now, output, readJson,
  sha256, schemaPath, stateRoot, workspaceFingerprint, writeAtomic, writeJson
} from "../core.js";

export type ProtocolOptions = Map<string, string | boolean | string[]>;

type WorkerPlan = {
  id: string;
  title?: string;
  goal: string;
  scope?: string;
  completion_criteria: string;
  file_ownership: string[];
  task_path?: string;
  classification?: JsonObject;
};

type ProtocolPlan = {
  parent_task_path?: string;
  repo_root?: string;
  workers: WorkerPlan[];
  has_order_dependency?: boolean;
  shared_persistent_state?: boolean;
  max_workers?: number;
};

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

function asWorkers(value: unknown): WorkerPlan[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is JsonObject => !!item && typeof item === "object" && !Array.isArray(item)).map((item) => ({
    id: String(item.id || ""), title: typeof item.title === "string" ? item.title : undefined,
    goal: String(item.goal || ""), scope: typeof item.scope === "string" ? item.scope : undefined,
    completion_criteria: String(item.completion_criteria || ""),
    file_ownership: Array.isArray(item.file_ownership) ? item.file_ownership.map(String).map((path) => normalizeRepoPath(path.replaceAll("\\", "/").replace(/^\.\//, ""))) : [],
    task_path: typeof item.task_path === "string" ? item.task_path : undefined,
    classification: asObject(item.classification)
  }));
}

function validatePlan(plan: ProtocolPlan, repoRoot: string): string[] {
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
    if (!worker.goal || !worker.completion_criteria) errors.push(`worker ${worker.id} needs goal and completion_criteria`);
    if (!worker.file_ownership.length) errors.push(`worker ${worker.id} needs file_ownership`);
    for (const raw of worker.file_ownership) {
      const value = normalizeRepoPath(raw.replaceAll("\\", "/").replace(/^\.\//, ""));
      if (!value || value.startsWith("/") || value.split("/").includes("..")) errors.push(`worker ${worker.id} has invalid ownership path: ${raw}`);
      if (owned.some((previous) => previous === value || previous.startsWith(`${value}/`) || value.startsWith(`${previous}/`))) errors.push(`ownership overlaps: ${value}`);
      owned.push(value);
      if (isWithin(resolve(repoRoot, value), repoRoot) === false) errors.push(`ownership escapes repository: ${value}`);
    }
  }
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

function removeWorktree(repoRoot: string, path: string): void {
  if (!existsSync(path)) return;
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

function createChildTask(worker: WorkerPlan, batchId: string, parent: JsonObject, parentTaskPath: string | undefined, root: string, repoRoot: string, worktree: string): { taskPath: string; packetPath: string; taskId: string } {
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
    writeJson(packetPath, buildExecutionPacket(readJson(taskJsonPath), taskJsonPath, worktree));
    return { taskPath: taskJsonPath, packetPath, taskId: childId };
  } catch (error) {
    if (created) { try { retireChildTask(taskJsonPath); } catch { /* preserve original failure */ } }
    throw error;
  }
}

function artifactFiles(repoRoot: string, base: string, ownership: string[]): ArtifactFile[] {
  const paths = changedPaths(repoRoot, base);
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
  if (!planPath || !existsSync(planPath)) throw new Error("protocol 3 Prepare requires --plan-path");
  const raw = readJson(planPath) as JsonObject;
  return {
    parent_task_path: typeof raw.parent_task_path === "string" ? raw.parent_task_path : undefined,
    repo_root: typeof raw.repo_root === "string" ? raw.repo_root : undefined,
    workers: asWorkers(raw.workers), has_order_dependency: raw.has_order_dependency === true,
    shared_persistent_state: raw.shared_persistent_state === true, max_workers: raw.max_workers === undefined ? 3 : Number(raw.max_workers)
  };
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

function prepare(options: ProtocolOptions, root: string, id: string): number {
  const plan = readPlan(options); const parentTaskOverride = stringOption(options, "parent-task-path"); if (parentTaskOverride) plan.parent_task_path = parentTaskOverride;
  if (plan.parent_task_path) plan.parent_task_path = jsonPath(plan.parent_task_path);
  const repoRoot = resolve(stringOption(options, "repo-root", plan.repo_root || process.cwd()));
  if (isWithin(root, repoRoot)) throw new Error("protocol 3 state root must be outside the repository so orchestration records do not change the parent fingerprint");
  const errors = validatePlan(plan, repoRoot); if (errors.length) throw new Error(`protocol 3 split rejected: ${errors.join("; ")}`);
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
      const child = createChildTask(worker, id, parent, plan.parent_task_path, root, repoRoot, worktree);
      workers.push({ id: worker.id, title: worker.title || worker.id, task_id: child.taskId, task_path: child.taskPath, packet_path: child.packetPath,
        worktree, file_ownership: worker.file_ownership, attempt: 1, status: "prepared", artifact_status: "uncollected" });
    }
  } catch (error) {
    for (const worker of workers) { try { retireChildTask(String(worker.task_path || "")); } catch { /* preserve original failure */ } }
    for (const worktree of createdWorktrees) { try { removeWorktree(repoRoot, worktree); } catch { /* preserve original failure */ } }
    throw error;
  }
  const state: JsonObject = {
    schema_version: 3, protocol: 3, id, experimental: false, phase: "prepared", state_revision: 1, created_at: now(), updated_at: now(),
    parent: { task_path: plan.parent_task_path || "", task_id: String(parent.id || ""), repo_root: repoRoot, snapshot_commit: snapshot.commit, snapshot_workspace_fingerprint: snapshot.fingerprint, workspace_fingerprint: workspaceFingerprint(repoRoot) },
    workers, integration: { status: "pending", root: join(directory, "integration") }, host_bindings: [], journal: [{ at: now(), action: "Prepare", status: "completed" }], history: []
  };
  assertProtocolState(state);
  writeJson(statePath(root, id), state);
  output({ protocol: 3, action: "Prepare", batch: state });
  return 0;
}

function assess(options: ProtocolOptions): number {
  const plan = readPlan(options); const parentTaskOverride = stringOption(options, "parent-task-path"); if (parentTaskOverride) plan.parent_task_path = parentTaskOverride;
  const repoRoot = resolve(stringOption(options, "repo-root", plan.repo_root || process.cwd())); const errors = validatePlan(plan, repoRoot);
  output({ protocol: 3, action: "Assess", eligible: errors.length === 0, repo_root: repoRoot, worker_count: plan.workers.length, errors }); return 0;
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
  output({ protocol: 3, action: "Bind", batch: state }); return 0;
}

function collect(options: ProtocolOptions, root: string, id: string): number {
  const workerId = stringOption(options, "worker-id"); const resultPath = stringOption(options, "result-path");
  if (!workerId || !resultPath || !existsSync(resultPath)) throw new Error("Collect requires an existing --result-path and --worker-id");
  const result = readJson(resultPath) as JsonObject; const status = String(result.status || "");
  if (!WORKER_STATUSES.has(status) || !["completed", "blocked", "failed", "cancelled"].includes(status)) throw new Error(`invalid worker result status: ${status}`);
  let artifactHash = ""; let files: ArtifactFile[] = [];
  const next = mutateJsonState<JsonObject>(statePath(root, id), (current) => {
    assertProtocolState(current); requirePhase(current, ["executing", "collecting", "integrating"]);
    const worker = workerRecord(current, workerId); const worktree = assertOwnedPath(root, id, String(worker.worktree || ""), "worker worktree");
    if (!existsSync(worktree)) throw new Error(`worker worktree is missing: ${worktree}`);
    const expectedRun = String(asObject(worker.host).run_id || ""); if (expectedRun && String(result.run_id || expectedRun) !== expectedRun) throw new Error("worker result run_id does not match host binding");
    if (result.attempt !== undefined && Number(result.attempt) !== Number(worker.attempt || 1)) throw new Error("worker result attempt does not match assignment");
    const base = String(asObject(current.parent).snapshot_commit || ""); const artifactRoot = artifactDirectory(root, id, workerId, Number(worker.attempt || 1));
    files = status === "completed" ? artifactFiles(worktree, base, Array.isArray(worker.file_ownership) ? worker.file_ownership.map(String) : []) : [];
    artifactHash = sha256(canonicalJson({ status, files, result }));
    const previous = String(worker.artifact_hash || ""); if (previous && previous !== artifactHash) throw new Error("same worker attempt returned different result content");
    if (status === "completed") { mkdirSync(artifactRoot, { recursive: true }); writeArtifactFiles(worktree, files, artifactRoot, base); }
    worker.status = status; worker.result = result; worker.artifact_status = status === "completed" ? "collected" : "rejected"; worker.artifact_root = artifactRoot; worker.artifact = files; worker.artifact_hash = artifactHash;
    current.phase = "collecting";
    current.journal = [...(Array.isArray(current.journal) ? current.journal : []), { at: now(), action: "Collect", worker_id: workerId, status, artifact_hash: artifactHash }];
    current.updated_at = now(); assertProtocolState(current);
  });
  output({ protocol: 3, action: "Collect", worker_id: workerId, artifact_hash: artifactHash, batch: next }); return 0;
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
    output({ protocol: 3, action: "Integrate", batch: next }); return 0;
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
  output({ protocol: 3, action: "Apply", batch: next }); return 0;
}

function retry(options: ProtocolOptions, root: string, id: string): number {
  const workerId = stringOption(options, "worker-id"); const state = protocolState(root, id); requirePhase(state, ["executing", "collecting"]);
  const before = workerRecord(state, workerId); if (!["blocked", "failed", "cancelled"].includes(String(before.status))) throw new Error("Retry requires a blocked, failed, or cancelled worker");
  const repoRoot = String(asObject(state.parent).repo_root || ""); const worktree = assertOwnedPath(root, id, String(before.worktree || ""), "worker worktree"); const base = String(asObject(state.parent).snapshot_commit || "");
  removeWorktree(repoRoot, worktree); addWorktree(repoRoot, worktree, base);
  const next = saveState(root, id, (current) => {
    const worker = workerRecord(current, workerId); worker.attempt = Number(worker.attempt || 1) + 1; worker.status = "prepared"; worker.artifact_status = "uncollected"; delete worker.result; delete worker.artifact; delete worker.artifact_hash; delete worker.artifact_root; current.phase = "executing"; current.journal = [...(Array.isArray(current.journal) ? current.journal : []), { at: now(), action: "Retry", worker_id: workerId, attempt: worker.attempt }];
  });
  output({ protocol: 3, action: "Retry", batch: next }); return 0;
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
  output({ protocol: 3, action: "Cleanup", batch: next }); return 0;
}

function failBatch(options: ProtocolOptions, root: string, id: string): number {
  const reason = stringOption(options, "reason", "coordinator marked batch failed");
  const next = saveState(root, id, (state) => { requirePhase(state, ["prepared", "executing", "collecting", "integrating"]); state.phase = "failed"; state.journal = [...(Array.isArray(state.journal) ? state.journal : []), { at: now(), action: "Fail", status: "failed", detail: reason }]; });
  output({ protocol: 3, action: "Fail", batch: next }); return 0;
}

export function protocol3(options: ProtocolOptions): number {
  const root = stateRoot(stringOption(options, "state-root") || undefined); const id = stringOption(options, "id"); const action = stringOption(options, "action", "Status");
  if (!id) throw new Error("protocol 3 requires --id");
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) throw new Error("protocol 3 --id must contain only letters, numbers, and hyphens");
  if (action === "Prepare") return prepare(options, root, id);
  if (action === "Assess") return assess(options);
  if (action === "Status" || action === "Read") { output({ protocol: 3, batch: protocolState(root, id) }); return 0; }
  if (action === "Bind") return bind(options, root, id);
  if (action === "Collect") return collect(options, root, id);
  if (action === "Integrate") return integrate(options, root, id);
  if (action === "Apply") return apply(options, root, id);
  if (action === "Retry") return retry(options, root, id);
  if (action === "Recover") return recover(options, root, id);
  if (action === "Fail") return failBatch(options, root, id);
  if (action === "Cleanup") return cleanup(options, root, id);
  if (action === "Cancel") { const next = saveState(root, id, (state) => { requirePhase(state, ["prepared", "executing", "collecting", "integrating"]); state.phase = "cancelled"; state.journal = [...(Array.isArray(state.journal) ? state.journal : []), { at: now(), action: "Cancel", status: "cancelled" }]; }); output({ protocol: 3, action, batch: next }); return 0; }
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
  const result = spawnSync(command[0], command.slice(1), { cwd: workspace, encoding: "utf8", shell: false });
  const stdout = result.stdout || ""; const stderr = result.stderr || ""; const exitCode = result.status ?? 1;
  output({ valid: exitCode === 0, assignment: assignmentPath, repo_root: workspace, command, cwd: workspace, exit_code: exitCode, stdout, stderr, output_digest: sha256(`${stdout}\n${stderr}`) });
  return exitCode;
}
