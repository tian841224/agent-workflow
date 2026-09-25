import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { changedPaths, diffFingerprint, git, JsonObject, output, projectIdentity, sha256, stateRoot, workspaceFingerprint } from "./core.js";
import { acceptanceCases } from "./intent.js";
import { latestEvidence, pathDigests } from "./lifecycle/evidence.js";
import { task, taskPath as resolveTaskPath } from "./lifecycle/task-store.js";
import { compilePlanForTaskPath } from "./workflow-policy.js";

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

// The reviewer's brief for this round. Round 1 covers the whole delivery; a later round covers only
// the paths whose content changed since the previous review, plus that review's findings, so a fix
// is re-reviewed without re-reading everything that already passed.
function reviewScope(repoRoot: string, taskJsonPath: string): JsonObject {
  const state = task(taskJsonPath);
  const base = String(state.base_commit || "") || git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
  const current = base ? changedPaths(repoRoot, base) : [];
  const reviews = (Array.isArray(state.evidence) ? state.evidence as JsonObject[] : []).filter((item) => item.kind === "role" && item.id === "role.reviewer");
  const previous = latestEvidence(reviews, "role.reviewer");
  const recorded = previous && previous.reviewed_path_digests && typeof previous.reviewed_path_digests === "object" ? previous.reviewed_path_digests as Record<string, string> : undefined;
  let scope: "full" | "delta" = "full";
  let paths = current;
  if (recorded) {
    const candidates = [...new Set([...current, ...Object.keys(recorded)])];
    const live = pathDigests(repoRoot, candidates);
    paths = candidates.filter((path) => live[path] !== recorded[path]).sort();
    scope = "delta";
  }
  const plan = compilePlanForTaskPath(state, taskJsonPath);
  const taskMd = join(dirname(taskJsonPath), "task.md");
  const acceptance = existsSync(taskMd) ? acceptanceCases(readFileSync(taskMd, "utf8")).cases.map((item) => ({ id: item.id, given: item.given, when: item.when, then: item.then })) : [];
  return {
    round: reviews.length + 1, scope, base, paths,
    ...(previous ? { previous: { result: previous.result, summary: previous.summary } } : {}),
    acceptance,
    checklist: plan.checklist,
    risk_flags: Array.isArray(state.risk_flags) ? state.risk_flags : []
  };
}

// Opens a review round: rejects an unreviewable diff, pins the tree the resulting PASS may cover and,
// given the task, returns the round's scope and the brief the reviewer prompt is built from.
export function preReview(path: string, taskValue = ""): number {
  const workspace = resolve(path); const diff = git(workspace, ["diff", "--check"]);
  let review: JsonObject | undefined;
  const errors: string[] = diff.status === 0 ? [] : [diff.stderr || diff.stdout];
  if (taskValue) {
    try { review = reviewScope(projectIdentity(workspace).root, resolveTaskPath(taskValue)); }
    catch (error) { errors.push(String((error as Error).message || error)); }
  }
  output({ valid: errors.length === 0, check: "git diff --check", errors, workspace_sha256: workspaceFingerprint(workspace), ...(review ? { review } : {}) });
  return errors.length ? 1 : 0;
}
