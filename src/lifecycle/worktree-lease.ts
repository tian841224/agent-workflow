import { existsSync } from "node:fs";
import { join } from "node:path";
import { git, JsonObject, ProjectIdentity, now, readJson, writeJson } from "../core.js";

const ACTIVE_STATUSES = new Set(["in_progress", "paused", "blocked"]);
export function worktreeLeasePath(root: string, worktreeId: string): string { return join(root, "worktree-leases", `${worktreeId}.json`); }
// A code task exclusively owns its worktree so two deliveries can never blend under review. The
// lease is self-healing rather than explicitly released, but only for a stale state that's actually
// provable: the task it names is gone, or its recorded lifecycle.status is a genuine terminal state
// (closed/superseded). Anything this function cannot read or make sense of — a corrupt lease, a
// corrupt candidate task, a lease bound to the wrong worktree, a task_id that doesn't match the
// candidate it points to, or a lifecycle.status this runtime doesn't recognize as either active or
// terminal — throws instead of silently reporting "no conflict"; "unknown" must never be read as
// "safe to reclaim".
export function activeLeaseConflict(root: string, worktreeId: string, excludeTaskId: string, excludeTaskPath: string): JsonObject | undefined {
  const leasePath = worktreeLeasePath(root, worktreeId);
  if (!existsSync(leasePath)) return undefined;
  let lease: JsonObject;
  try { lease = readJson(leasePath); } catch (error) { throw new Error(`worktree lease is corrupt and cannot be read (${leasePath}): ${String((error as Error).message || error)}`); }
  if (String(lease.worktree_id || "") !== worktreeId) throw new Error(`worktree lease at ${leasePath} is bound to worktree_id '${String(lease.worktree_id || "")}', not the expected '${worktreeId}'`);
  const taskId = String(lease.task_id || "");
  const taskJsonPath = String(lease.task_path || "");
  if (!taskId || !taskJsonPath) throw new Error(`worktree lease at ${leasePath} is missing task_id/task_path`);
  if (taskId === excludeTaskId && taskJsonPath === excludeTaskPath) return undefined; // this is the caller's own lease
  if (!existsSync(taskJsonPath)) return undefined; // the task it names is gone: definitively stale
  let candidate: JsonObject;
  try { candidate = readJson(taskJsonPath); } catch (error) { throw new Error(`task referenced by worktree lease is corrupt and cannot be read (${taskJsonPath}): ${String((error as Error).message || error)}`); }
  if (String(candidate.id || "") !== taskId) throw new Error(`worktree lease's task_id ('${taskId}') does not match the id recorded in ${taskJsonPath} ('${String(candidate.id || "")}')`);
  const status = String(((candidate.lifecycle as JsonObject | undefined) || {}).status || "");
  if (status === "closed" || status === "superseded") return undefined; // a genuine terminal state: definitively stale
  if (ACTIVE_STATUSES.has(status)) return candidate;
  throw new Error(`worktree lease's task (${taskJsonPath}) has lifecycle.status '${status || "(missing)"}', neither a recognized active nor terminal state; cannot determine whether the lease is stale`);
}
export function writeLease(root: string, worktreeId: string, taskId: string, taskJsonPath: string): void {
  writeJson(worktreeLeasePath(root, worktreeId), { worktree_id: worktreeId, task_id: taskId, task_path: taskJsonPath, acquired_at: now() });
}
// Shared by task-init and task-write so a code task's activation — worktree lease, dirty check,
// base_commit — is defined exactly once regardless of whether code_change starts true or flips
// true partway through the task's life.
export function activateCodeTask(label: string, taskId: string, root: string, identity: ProjectIdentity, repoRootValue: string, adoptCurrentDiff: boolean, taskJsonPath: string): string {
  const conflict = activeLeaseConflict(root, identity.worktreeId, taskId, taskJsonPath);
  if (conflict) throw new Error(`${label}: worktree already has an active code task (${conflict.id}); close/supersede it first, or use a different worktree`);
  const status = git(repoRootValue, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.status !== 0) throw new Error(`${label}: cannot read git status for ${repoRootValue}: ${status.stderr.trim()}`);
  if (status.stdout.trim() && !adoptCurrentDiff) throw new Error(`${label}: worktree has uncommitted changes; commit/stash them first, or pass --adopt-current-diff to treat the current diff as this task's delivery`);
  const head = git(repoRootValue, ["rev-parse", "HEAD"]);
  if (head.status !== 0 || !head.stdout.trim()) throw new Error(`${label}: cannot resolve HEAD for base_commit in ${repoRootValue}: ${head.stderr.trim()}`);
  return head.stdout.trim();
}
