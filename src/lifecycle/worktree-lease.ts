import { existsSync } from "node:fs";
import { join } from "node:path";
import { git, JsonObject, ProjectIdentity, now, readJson, writeJson } from "../core.js";

const ACTIVE_STATUSES = new Set(["in_progress", "paused", "blocked"]);
export function worktreeLeasePath(root: string, worktreeId: string): string { return join(root, "worktree-leases", `${worktreeId}.json`); }
// A code task exclusively owns its worktree so two deliveries can never blend under review. The
// lease is self-healing rather than explicitly released: if the task it names is no longer active
// (closed/superseded, or its task.json is gone), the lease is treated as stale and a new task may
// claim the worktree, regardless of where task directories physically live.
export function activeLeaseConflict(root: string, worktreeId: string, excludeTaskId: string): JsonObject | undefined {
  const leasePath = worktreeLeasePath(root, worktreeId);
  if (!existsSync(leasePath)) return undefined;
  let lease: JsonObject;
  try { lease = readJson(leasePath); } catch { return undefined; }
  const taskId = String(lease.task_id || "");
  if (!taskId || taskId === excludeTaskId) return undefined;
  const taskJsonPath = String(lease.task_path || "");
  if (!taskJsonPath || !existsSync(taskJsonPath)) return undefined;
  let candidate: JsonObject;
  try { candidate = readJson(taskJsonPath); } catch { return undefined; }
  const status = String(((candidate.lifecycle as JsonObject | undefined) || {}).status || "");
  return ACTIVE_STATUSES.has(status) ? candidate : undefined;
}
export function writeLease(root: string, worktreeId: string, taskId: string, taskJsonPath: string): void {
  writeJson(worktreeLeasePath(root, worktreeId), { worktree_id: worktreeId, task_id: taskId, task_path: taskJsonPath, acquired_at: now() });
}
// Shared by task-init and task-write so a code task's activation — worktree lease, dirty check,
// base_commit — is defined exactly once regardless of whether code_change starts true or flips
// true partway through the task's life.
export function activateCodeTask(label: string, taskId: string, root: string, identity: ProjectIdentity, repoRootValue: string, adoptCurrentDiff: boolean): string {
  const conflict = activeLeaseConflict(root, identity.worktreeId, taskId);
  if (conflict) throw new Error(`${label}: worktree already has an active code task (${conflict.id}); close/supersede it first, or use a different worktree`);
  const status = git(repoRootValue, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.status !== 0) throw new Error(`${label}: cannot read git status for ${repoRootValue}: ${status.stderr.trim()}`);
  if (status.stdout.trim() && !adoptCurrentDiff) throw new Error(`${label}: worktree has uncommitted changes; commit/stash them first, or pass --adopt-current-diff to treat the current diff as this task's delivery`);
  const head = git(repoRootValue, ["rev-parse", "HEAD"]);
  if (head.status !== 0 || !head.stdout.trim()) throw new Error(`${label}: cannot resolve HEAD for base_commit in ${repoRootValue}: ${head.stderr.trim()}`);
  return head.stdout.trim();
}
