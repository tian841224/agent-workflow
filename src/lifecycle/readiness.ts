import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { git, JsonObject, projectIdentity, readJson, stateRoot } from "../core.js";
import { acceptanceErrors, acceptanceRequired, intentValidationErrors } from "../intent.js";
import { schemaErrors } from "./task-schema.js";
import { activeLeaseConflict } from "./worktree-lease.js";

type ReadinessStatus = "pass" | "warn" | "fail";
export type ReadinessCheck = { id: string; status: ReadinessStatus; detail: string };

// The fixed environment prerequisites of a task, checked once before exploration or validation
// starts. task-init runs this on the state it just created, so a managed task needs no second CLI
// roundtrip. Read-only by design: task creation, activation and evidence writes stay with their own
// runtime commands.
export function readinessChecks(taskPath: string, repoRootValue: string, stateRootValue?: string, knownState?: JsonObject): ReadinessCheck[] {
  const repoRoot = resolve(repoRootValue);
  const checks: ReadinessCheck[] = [];
  const add = (id: string, status: ReadinessStatus, detail: string): void => { checks.push({ id, status, detail }); };
  const nodeMajor = Number(process.versions.node.split(".")[0] || 0);
  add("node", nodeMajor >= 20 ? "pass" : "fail", `Node.js ${process.versions.node}; requires >=20`);

  const inside = git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  const isGitRepo = inside.status === 0 && inside.stdout.trim().toLowerCase() === "true";
  add("repository", isGitRepo ? "pass" : "fail", isGitRepo ? `Git worktree: ${repoRoot}` : `not a Git worktree: ${repoRoot}`);

  let taskState: JsonObject | undefined;
  if (!taskPath) add("task", "fail", "--task-path is required so intent and delivery prerequisites can be checked");
  else if (!knownState && !existsSync(taskPath)) add("task", "fail", `task.json is missing: ${taskPath}`);
  else {
    try {
      taskState = knownState || readJson(taskPath);
      const errors = schemaErrors(taskState);
      const taskMd = join(dirname(taskPath), "task.md");
      if (existsSync(taskMd)) {
        const markdown = readFileSync(taskMd, "utf8");
        errors.push(...intentValidationErrors(markdown), ...acceptanceErrors(markdown, acceptanceRequired(taskState)));
      }
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
      const dependencyReady = count === 0 || existsSync(join(repoRoot, "node_modules"));
      const strict = taskState?.managed_change === true || taskState?.code_change === true;
      add("dependencies", dependencyReady || !strict ? (dependencyReady ? "pass" : "warn") : "fail", dependencyReady ? `package dependencies ready (${count} declared)` : `node_modules is missing for ${count} declared package dependencies`);
    } catch (error) {
      add("dependencies", "fail", `package.json is invalid: ${String((error as Error).message || error)}`);
    }
  }

  add("shell", "pass", process.platform === "win32" ? "Windows: evidence-run routes .cmd shims such as npm through cmd.exe, which refuses arguments containing %, quotes or line breaks" : "Use the repository shell launcher for package scripts");
  return checks;
}

export function readinessSummary(checks: ReadinessCheck[]): JsonObject {
  const blockers = checks.filter((check) => check.status === "fail").map((check) => `${check.id}: ${check.detail}`);
  return { ready: blockers.length === 0, checks, blockers };
}
