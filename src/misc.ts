import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { diffFingerprint, git, JsonObject, output, projectIdentity, readJson, schemaPath, sha256, stateRoot, stdinJson, workspaceFingerprint } from "./core.js";
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
// Opens a review round: rejects an unreviewable diff and pins the tree the resulting PASS may cover.
export function preReview(path: string): number {
  const workspace = resolve(path); const diff = git(workspace, ["diff", "--check"]);
  output({ valid: diff.status === 0, check: "git diff --check", errors: diff.stderr || diff.stdout, workspace_sha256: workspaceFingerprint(workspace) });
  return diff.status === 0 ? 0 : 1;
}
