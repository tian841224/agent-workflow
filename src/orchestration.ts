import { existsSync } from "node:fs";
import { join } from "node:path";
import { JsonObject, now, output, readJson, stateRoot, writeJson } from "./core.js";

type Phase = "planned" | "split" | "executing" | "integrating" | "integrated" | "failed" | "cleaned";
const transitions: Record<Phase, Phase[]> = { planned: ["split", "failed"], split: ["executing", "failed"], executing: ["integrating", "failed"], integrating: ["integrated", "failed"], integrated: ["cleaned"], failed: ["cleaned"], cleaned: [] };
export function orchestrate(options: Map<string, string | boolean | string[]>): number {
  const root = stateRoot(typeof options.get("state-root") === "string" ? options.get("state-root") as string : undefined); const id = typeof options.get("id") === "string" ? options.get("id") as string : "default"; const action = typeof options.get("action") === "string" ? options.get("action") as string : "Status"; const path = join(root, "orchestration", `${id}.json`);
  const state: JsonObject = existsSync(path) ? readJson(path) : { schema_version: 1, id, phase: "planned", history: [] }; if (action === "status") { output(state); return 0; }
  if (action === "Status" || action === "Assess" || action === "Read") { output(action === "Assess" ? { eligible: state.phase === "planned", state } : state); return 0; }
  const aliases: Record<string, Phase> = { Init: "split", RegisterNative: "split", WorkerReady: "executing", Collect: "integrating", Integrate: "integrating", Apply: "integrated", WorkerFailed: "failed", Cleanup: "cleaned" };
  const phase = String(state.phase) as Phase; const target = aliases[action] || action.toLowerCase() as Phase;
  if (target === "split" && process.env.AGENT_WORKFLOW_ORCHESTRATION_EXPERIMENTAL !== "1") throw new Error("orchestrate: this action is Experimental — it only tracks phase state and does not implement the documented worktree snapshot/patch collect-apply flow yet; set AGENT_WORKFLOW_ORCHESTRATION_EXPERIMENTAL=1 to proceed anyway, or dispatch workers manually.");
  if (!(transitions[phase] || []).includes(target)) throw new Error(`invalid OrchestrationEngine transition: ${phase} -> ${target}`);
  if (target === "cleaned" && phase !== "integrated" && phase !== "failed") throw new Error("cleanup requires integrated or failed state");
  state.phase = target; const history = Array.isArray(state.history) ? state.history : []; history.push({ at: now(), from: phase, to: target }); state.history = history; writeJson(path, state); output(state); return 0;
}
