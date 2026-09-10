import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { diffFingerprint, git, JsonObject, output, projectIdentity, readJson, schemaPath, sha256, stateRoot, stdinJson, workspaceFingerprint } from "./core.js";
import { intentValidationErrors } from "./intent.js";
import { activeLeaseConflict } from "./lifecycle/worktree-lease.js";
import { schemaErrors } from "./lifecycle/task-schema.js";
import { compilePlanForTaskPath, compileWorkflowPlan, loadPolicy, planOutput } from "./workflow-policy.js";

export function projectResolver(path: string, root?: string): number { const identity = projectIdentity(resolve(path)); const state = stateRoot(root); output({ project_id: identity.projectId, root: identity.root, state_root: state, task_root: join(state, "projects", identity.projectId, "tasks") }); return 0; }
// With --base/--paths this also emits the reviewed_diff_sha256 a role evidence entry records, so the
// value the gate recomputes and the value a reviewer writes down come from one implementation.
export function fingerprint(path: string, base = "", paths: string[] = []): number {
  const workspace = resolve(path); const head = git(workspace, ["rev-parse", "HEAD"]); const status = git(workspace, ["status", "--porcelain=v1"]);
  const reviewedBase = base || (head.status === 0 ? head.stdout.trim() : "");
  output({
    workspace, head: head.status === 0 ? head.stdout.trim() : "", dirty_sha256: sha256(status.stdout), workspace_sha256: workspaceFingerprint(workspace),
    ...(paths.length ? { reviewed_base: reviewedBase, reviewed_paths: paths, reviewed_diff_sha256: diffFingerprint(workspace, reviewedBase, paths) } : {})
  });
  return 0;
}
export function workflowPlan(taskPath = "", policyPath = schemaPath("workflow-policy.json")): number {
  const resolvedTaskPath = taskPath ? (taskPath.endsWith(".json") || !existsSync(join(taskPath, "task.json")) ? taskPath : join(taskPath, "task.json")) : "";
  const task: JsonObject = resolvedTaskPath ? readJson(resolvedTaskPath) : stdinJson();
  try {
    const plan = resolvedTaskPath && existsSync(resolvedTaskPath) ? compilePlanForTaskPath(task, resolvedTaskPath, policyPath) : compileWorkflowPlan(task, loadPolicy(policyPath));
    output(planOutput(plan));
    return 0;
  } catch (error) { output({ valid: false, errors: [String((error as Error).message || error)] }); return 1; }
}

type PreflightStatus = "pass" | "warn" | "fail";
type PreflightCheck = { id: string; status: PreflightStatus; detail: string };

// Checks the fixed setup prerequisites once, before an agent spends time exploring or starting a
// validation command. It is deliberately read-only: task creation, activation, and evidence writes
// remain owned by their existing runtime commands.
export function preflight(taskValue = "", repoRootValue = process.cwd(), stateRootValue?: string): number {
  const repoRoot = resolve(repoRootValue);
  const checks: PreflightCheck[] = [];
  const add = (id: string, status: PreflightStatus, detail: string): void => { checks.push({ id, status, detail }); };
  const nodeMajor = Number(process.versions.node.split(".")[0] || 0);
  add("node", nodeMajor >= 20 ? "pass" : "fail", `Node.js ${process.versions.node}; requires >=20`);

  const inside = git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  const isGitRepo = inside.status === 0 && inside.stdout.trim().toLowerCase() === "true";
  add("repository", isGitRepo ? "pass" : "fail", isGitRepo ? `Git worktree: ${repoRoot}` : `not a Git worktree: ${repoRoot}`);

  const taskPath = taskValue ? (taskValue.endsWith(".json") ? resolve(taskValue) : join(resolve(taskValue), "task.json")) : "";
  let taskState: JsonObject | undefined;
  if (!taskPath) add("task", "fail", "--task-path is required so intent and delivery prerequisites can be checked");
  else if (!existsSync(taskPath)) add("task", "fail", `task.json is missing: ${taskPath}`);
  else {
    try {
      taskState = readJson(taskPath);
      const errors = schemaErrors(taskState);
      const taskMd = join(dirname(taskPath), "task.md");
      if (existsSync(taskMd)) errors.push(...intentValidationErrors(readFileSync(taskMd, "utf8")));
      else errors.push("sibling task.md is missing");
      const status = String(((taskState.lifecycle as JsonObject | undefined) || {}).status || "");
      if (status !== "in_progress") errors.push(`task lifecycle.status must be 'in_progress', got '${status || "(missing)"}'`);
      add("task", errors.length ? "fail" : "pass", errors.length ? errors.join("; ") : `task and intent are ready: ${taskPath}`);
    } catch (error) {
      add("task", "fail", `cannot read task state: ${String((error as Error).message || error)}`);
    }
  }

  if (isGitRepo) {
    try {
      const identity = projectIdentity(repoRoot);
      const conflict = activeLeaseConflict(stateRoot(stateRootValue), identity.worktreeId, String(taskState?.id || ""), taskPath);
      add("lease", conflict ? "fail" : "pass", conflict ? `worktree already has active task: ${String(conflict.id || "(unknown)")}` : "worktree lease is available");
    } catch (error) {
      add("lease", "fail", String((error as Error).message || error));
    }
    const status = git(repoRoot, ["status", "--porcelain", "--untracked-files=all"]);
    if (status.status !== 0) add("worktree", "fail", `cannot read Git status: ${status.stderr.trim()}`);
    else if (taskState?.code_change === true && String(taskState.base_commit || "")) add("worktree", "pass", "code task has an immutable delivery baseline; current changes belong to this task");
    else if (status.stdout.trim()) add("worktree", "warn", "worktree has changes; code tasks need activation or --adopt-current-diff");
    else add("worktree", "pass", "worktree is clean");
  } else add("lease", "fail", "cannot check a worktree lease outside Git");

  const packagePath = join(repoRoot, "package.json");
  if (!existsSync(packagePath)) add("dependencies", "pass", "no package.json; no Node dependency install is required");
  else {
    try {
      const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as JsonObject;
      const dependencies = [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies]
        .filter((value): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value));
      const count = dependencies.reduce((total, value) => total + Object.keys(value).length, 0);
      const modules = join(repoRoot, "node_modules");
      const dependencyReady = count === 0 || existsSync(modules);
      const strict = taskState?.managed_change === true || taskState?.code_change === true;
      add("dependencies", dependencyReady || !strict ? (dependencyReady ? "pass" : "warn") : "fail", dependencyReady ? `package dependencies ready (${count} declared)` : `node_modules is missing for ${count} declared package dependencies`);
    } catch (error) {
      add("dependencies", "fail", `package.json is invalid: ${String((error as Error).message || error)}`);
    }
  }

  add("shell", "pass", process.platform === "win32" ? "Windows: run npm evidence through cmd.exe /c npm run <script>" : "Use the repository shell launcher for package scripts");
  const failed = checks.filter((check) => check.status === "fail");
  output({ valid: failed.length === 0, repo_root: repoRoot, task: taskPath, checks, errors: failed.map((check) => `${check.id}: ${check.detail}`) });
  return failed.length ? 1 : 0;
}

// Opens a review round: rejects an unreviewable diff and pins the tree the resulting PASS may cover.
export function preReview(path: string): number {
  const workspace = resolve(path); const diff = git(workspace, ["diff", "--check"]);
  output({ valid: diff.status === 0, check: "git diff --check", errors: diff.stderr || diff.stdout, workspace_sha256: workspaceFingerprint(workspace) });
  return diff.status === 0 ? 0 : 1;
}
