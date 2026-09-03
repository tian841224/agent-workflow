import { existsSync } from "node:fs";
import { join } from "node:path";
import { JsonObject, mutateTask, now, option, output, readJson, stateRoot } from "./core.js";

type Phase = "planned" | "split" | "executing" | "integrating" | "integrated" | "failed" | "cleaned";
const transitions: Record<Phase, Phase[]> = { planned: ["split", "failed"], split: ["executing", "failed"], executing: ["integrating", "failed"], integrating: ["integrated", "failed"], integrated: ["cleaned"], failed: ["cleaned"], cleaned: [] };
const aliases: Record<string, Phase> = { Init: "split", RegisterNative: "split", WorkerReady: "executing", Collect: "integrating", Integrate: "integrating", Apply: "integrated", WorkerFailed: "failed", Cleanup: "cleaned" };
const EXPERIMENTAL_NOTICE = "orchestrate: this subsystem is Experimental — it tracks phase state only and does not implement the documented worktree snapshot / patch collect-apply flow; set AGENT_WORKFLOW_ORCHESTRATION_EXPERIMENTAL=1 to proceed anyway, or dispatch workers manually.";

function initialState(id: string): JsonObject {
  return { schema_version: 2, id, experimental: true, phase: "planned", workers: [], integration: [], history: [] };
}

export function orchestrate(options: Map<string, string | boolean | string[]>): number {
  const root = stateRoot(option(options, "state-root") || undefined);
  const id = option(options, "id", "default");
  const action = option(options, "action", "Status");
  const path = join(root, "orchestration", `${id}.json`);
  if (["status", "Status", "Assess", "Read"].includes(action)) {
    const state = existsSync(path) ? readJson(path) : initialState(id);
    output(action === "Assess" ? { eligible: state.phase === "planned", experimental: true, state } : state);
    return 0;
  }
  // Guard the phase, not one action name: Init, a raw --action split and any future alias all reach
  // the same runtime-created-worktree path. RegisterNative is exempt because the host, not the
  // runtime, creates those worktrees.
  if (action !== "RegisterNative" && (aliases[action] || action.toLowerCase()) === "split" && process.env.AGENT_WORKFLOW_ORCHESTRATION_EXPERIMENTAL !== "1") throw new Error(EXPERIMENTAL_NOTICE);
  // Every phase change is a read-modify-write on state shared by the coordinator and each worker
  // process, which is exactly where an unlocked readJson/writeJson pair loses a concurrent update.
  const state = mutateTask<JsonObject>(path, (current) => {
    if (!current.phase) Object.assign(current, initialState(id));
    const phase = String(current.phase) as Phase;
    const target = aliases[action] || action.toLowerCase() as Phase;
    if (!(transitions[phase] || []).includes(target)) throw new Error(`invalid OrchestrationEngine transition: ${phase} -> ${target}`);
    if (target === "cleaned" && phase !== "integrated" && phase !== "failed") throw new Error("cleanup requires integrated or failed state");
    current.phase = target;
    const history = Array.isArray(current.history) ? current.history : [];
    history.push({ at: now(), from: phase, to: target, action });
    current.history = history;
  });
  output(state);
  return 0;
}
