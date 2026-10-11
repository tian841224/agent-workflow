import { JsonObject, now, sha256 } from "../core.js";
import { covers } from "./ownership.js";

const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const objects = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(object) : [];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : [];
const time = (value: unknown): number => Date.parse(String(value || ""));
const terminal = new Set(["completed", "failed", "interrupted", "cancelled"]);
// Pending native receipts use the same sentinel in readers and writers; the intent gate still fails.
export const UNAVAILABLE_INTENT_HASH = "0".repeat(64);

export function isCodexCoordinator(state: JsonObject): boolean {
  return state.execution_platform === "Codex" && !(state.subtask_role === "worker" && Boolean(state.parent_task_id));
}

export function delegationAssessmentHash(state: JsonObject): string {
  return sha256(JSON.stringify(object(state.codex_delegation).assessment || null));
}

// task-write appends caller-attested native observations; freshness metadata is always runtime-owned.
export function applyCodexDelegationPatch(state: JsonObject, incoming: unknown, intentHash: string): void {
  if (state.execution_platform !== "Codex") throw new Error("codex_delegation requires execution_platform Codex");
  const patch = object(incoming);
  const allowed = new Set(["assessment", "native_agents", "observations"]);
  const forbidden = Object.keys(patch).filter((key) => !allowed.has(key));
  if (!incoming || Array.isArray(incoming) || typeof incoming !== "object" || forbidden.length) throw new Error(`codex_delegation patch accepts only assessment, native_agents and observations${forbidden.length ? `; runtime-owned or unknown: ${forbidden.join(", ")}` : ""}`);
  const current = { ...object(state.codex_delegation) };
  if (Object.hasOwn(patch, "assessment")) {
    if (JSON.stringify(current.assessment) !== JSON.stringify(patch.assessment)) current.assessment_revision = Number(current.assessment_revision || 0) + 1;
    current.assessment = patch.assessment;
  }
  state.codex_delegation = current;
  const stamp = { assessment_hash: delegationAssessmentHash(state), assessment_revision: Number(current.assessment_revision || 1), intent_hash: intentHash, recorded_at: now() };
  for (const field of ["native_agents", "observations"] as const) {
    if (!Object.hasOwn(patch, field)) continue;
    if (!Array.isArray(patch[field])) throw new Error(`codex_delegation.${field} must be an array`);
    const additions = objects(patch[field]);
    if (additions.some((item) => Object.keys(stamp).some((key) => Object.hasOwn(item, key)))) throw new Error(`codex_delegation.${field}: hashes, revisions and recorded_at are runtime-managed`);
    if (field === "native_agents") {
      const ids = objects(current.native_agents).map((item) => String(item.agent_id));
      for (const item of additions) {
        if (ids.includes(String(item.agent_id))) throw new Error(`Codex native agent ID cannot be reused: ${String(item.agent_id)}`);
        ids.push(String(item.agent_id));
      }
    }
    current[field] = [...objects(current[field]), ...additions.map((item) => ({ ...item, ...stamp }))];
  }
}

export function codexAssessmentErrors(state: JsonObject): string[] {
  if (!isCodexCoordinator(state)) return [];
  const delegation = object(state.codex_delegation);
  const assessment = object(delegation.assessment);
  if (!Object.keys(assessment).length) return ["Codex coordinator requires codex_delegation.assessment before delegation"];
  const errors: string[] = [];
  const subtasks = objects(assessment.subtasks);
  if (!subtasks.length) return ["Codex assessment requires at least one delegated subtask"];
  const byId = new Map<string, JsonObject>();
  for (const subtask of subtasks) {
    const id = String(subtask.id || "");
    if (byId.has(id)) errors.push(`Codex assessment has duplicate subtask id: ${id}`);
    byId.set(id, subtask);
    if (subtask.role !== "agent-workflow-worker" && strings(subtask.write_paths).length) errors.push(`Codex ${id}: readers and planners must be read-only`);
  }
  const ancestors = (id: string, visiting = new Set<string>()): Set<string> => {
    if (visiting.has(id)) { errors.push(`Codex assessment has a dependency cycle at ${id}`); return new Set(); }
    const next = new Set(visiting).add(id);
    const result = new Set<string>();
    for (const dependency of strings(byId.get(id)?.dependencies)) {
      if (!byId.has(dependency)) { errors.push(`Codex ${id}: unknown dependency ${dependency}`); continue; }
      result.add(dependency);
      for (const ancestor of ancestors(dependency, next)) result.add(ancestor);
    }
    return result;
  };
  const dependencies = new Map(subtasks.map((item) => [String(item.id), ancestors(String(item.id))]));
  let independent = false;
  for (let index = 0; index < subtasks.length; index += 1) for (const other of subtasks.slice(index + 1)) {
    const subtask = subtasks[index];
    const a = String(subtask.id); const b = String(other.id);
    const dependent = dependencies.get(a)?.has(b) || dependencies.get(b)?.has(a);
    if (!dependent) independent = true;
    for (const path of strings(subtask.write_paths)) if (strings(other.write_paths).some((value) => covers([path], value) || covers([value], path))) errors.push(`Codex write ownership overlaps between ${a} and ${b}: ${path}`);
  }
  if (subtasks.length === 1 && assessment.mode !== "single") errors.push("Codex one subtask requires single mode");
  if (subtasks.length > 1 && assessment.mode === "single") errors.push("Codex multiple subtasks require parallel or sequential mode");
  if (independent && assessment.parallel_benefit === "sufficient" && assessment.mode !== "parallel") errors.push("Codex independent subtasks with sufficient benefit must run in parallel");
  if (assessment.mode === "parallel" && !independent) errors.push("Codex parallel mode requires at least two independent subtasks");
  if (!String(assessment.reason || "").trim()) errors.push("Codex assessment requires a concrete decision reason");
  return [...new Set(errors)];
}

export function codexExecutionErrors(state: JsonObject, intentHash: string): string[] {
  if (!isCodexCoordinator(state) || codexAssessmentErrors(state).length) return [];
  const delegation = object(state.codex_delegation);
  const assessment = object(delegation.assessment);
  const revision = Number(delegation.assessment_revision || 0);
  const hash = delegationAssessmentHash(state);
  const fresh = (item: JsonObject): boolean => item.assessment_hash === hash && item.assessment_revision === revision && item.intent_hash === intentHash;
  const agents = objects(delegation.native_agents).filter(fresh);
  const observations = objects(delegation.observations).filter(fresh);
  const errors: string[] = [];
  const byId = new Map<string, JsonObject>();
  const subtasks = objects(assessment.subtasks);
  for (const agent of agents) {
    const id = String(agent.agent_id);
    if (byId.has(id)) errors.push(`Codex duplicate native agent ID: ${id}`);
    byId.set(id, agent);
    const subtask = subtasks.find((item) => item.id === agent.subtask_id);
    if (!subtask || subtask.role !== agent.role || subtask.scope !== agent.scope) errors.push(`Codex native agent ${id} does not match its subtask role and scope`);
    if (time(agent.spawned_at) > time(agent.recorded_at)) errors.push(`Codex native agent ${id} has a future spawn time`);
  }
  const last = new Map<string, { status: string; at: number }>();
  const completedAt = new Map<string, number>();
  let previous = -Infinity; let overlap = false;
  for (const observation of observations) {
    const at = time(observation.observed_at);
    if (at < previous || at > time(observation.recorded_at)) errors.push("Codex native observations must be chronological and cannot be in the future");
    previous = at;
    const seen = new Set<string>(); const running: JsonObject[] = [];
    for (const status of objects(observation.agents)) {
      const id = String(status.agent_id); const agent = byId.get(id);
      if (seen.has(id)) errors.push(`Codex native snapshot repeats agent ID: ${id}`);
      seen.add(id);
      if (!agent) { errors.push(`Codex native snapshot references unknown agent ID: ${id}`); continue; }
      if (at < time(agent.spawned_at)) errors.push(`Codex observation predates spawn: ${id}`);
      last.set(id, { status: String(status.status), at });
      if (status.status === "completed" && !completedAt.has(id)) completedAt.set(id, at);
      if (status.status === "running") running.push(agent);
    }
    if (observation.source === "list_agents" && new Set(running.map((agent) => agent.subtask_id)).size >= 2) overlap = true;
  }
  for (const subtask of subtasks) {
    const assigned = agents.filter((item) => item.subtask_id === subtask.id);
    if (!assigned.length) errors.push(`Codex subtask ${String(subtask.id)} has no fresh native agent ID`);
    for (const agent of assigned) if (!terminal.has(last.get(String(agent.agent_id))?.status || "")) errors.push(`Codex native agent ${String(agent.agent_id)} requires an observed terminal status`);
    if (assigned.length && !assigned.some((agent) => last.get(String(agent.agent_id))?.status === "completed")) errors.push(`Codex subtask ${String(subtask.id)} requires at least one observed completed native agent`);
    for (const agent of assigned) for (const dependency of strings(subtask.dependencies)) {
      const prior = agents.filter((item) => item.subtask_id === dependency);
      if (!prior.some((item) => completedAt.has(String(item.agent_id)) && Number(completedAt.get(String(item.agent_id))) <= time(agent.spawned_at))) errors.push(`Codex subtask ${String(subtask.id)} spawned before dependency ${dependency} completed`);
    }
  }
  if (assessment.mode === "parallel" && !overlap) errors.push("Codex parallel mode requires one native list_agents snapshot with at least two running agent IDs; sequential spawns do not prove overlap");
  return [...new Set(errors)];
}
