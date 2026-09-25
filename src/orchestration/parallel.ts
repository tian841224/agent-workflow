import { JsonObject } from "../core.js";

// Risks whose correctness depends on one ordered sequence of changes: a schema or data migration,
// an irreversible operation, or requirements still being settled cannot be split into independent
// workers without one worker invalidating another's premise.
export const SEQUENTIAL_FLAGS = ["migration", "irreversible", "schema", "unclear_requirements"];
export const MIN_ACCEPTANCE_FOR_PARALLEL = 3;
export const DEFAULT_MIN_FILES_PER_WORKER = 3;
export const WORKER_STATE_DIRECTORY = ".agent-workflow-worker";

export type ParallelHint = { candidate: boolean; reasons: string[] };

const flagsOf = (state: JsonObject): string[] => Array.isArray(state.risk_flags) ? state.risk_flags.map(String) : [];

// A cheap first filter computed at task-init. It only says whether splitting is worth considering;
// the split plan itself is judged by `orchestrate --action Assess`.
export function parallelHint(state: JsonObject, explorationProfile: string, acceptanceCount: number): ParallelHint {
  const reasons: string[] = [];
  if (state.managed_change !== true || state.code_change !== true) reasons.push("only a managed code-change task can be split");
  const scope = String(state.impact_scope || "");
  if (explorationProfile !== "expanded" && !["module", "multi_module", "cross_project"].includes(scope)) reasons.push("focused file-scope work finishes faster in one conversation");
  if (acceptanceCount < MIN_ACCEPTANCE_FOR_PARALLEL) reasons.push(`${acceptanceCount} acceptance case(s); at least ${MIN_ACCEPTANCE_FOR_PARALLEL} are needed to form two independent work packages`);
  const blocking = flagsOf(state).filter((flag) => SEQUENTIAL_FLAGS.includes(flag));
  if (blocking.length) reasons.push(`risk flag(s) ${blocking.join(", ")} require one ordered sequence of changes`);
  return { candidate: reasons.length === 0, reasons };
}

// Reasons a split that is safe is still not worth its setup, handoff and integration cost.
export function worthwhileReasons(workers: { id: string; acceptance: string[]; planned_files: string[] }[], parent: JsonObject, minFiles = DEFAULT_MIN_FILES_PER_WORKER): string[] {
  const reasons: string[] = [];
  if (workers.length < 2) reasons.push("fewer than two workers leaves nothing to run in parallel");
  for (const worker of workers) {
    if (!worker.acceptance.length) reasons.push(`worker ${worker.id} owns no acceptance case, so it has no independently verifiable outcome`);
    if (worker.planned_files.length < minFiles) reasons.push(`worker ${worker.id} plans ${worker.planned_files.length} file(s) (< ${minFiles}); too small to outweigh worktree setup and integration`);
  }
  const blocking = flagsOf(parent).filter((flag) => SEQUENTIAL_FLAGS.includes(flag));
  if (blocking.length) reasons.push(`parent risk flag(s) ${blocking.join(", ")} require one ordered sequence of changes`);
  return reasons;
}
