// Two one-shot reminders that keep an agent from drifting out of the managed workflow. Both only add
// context: the platform never waits on them, and any failure ends silently, so a broken reminder can
// never stop a prompt or an edit.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Json, JsonObject, output, projectIdentity, readJson, sha256, writeAtomic } from "./core.js";
import { OPEN_STATUSES } from "./lifecycle/task-store.js";

const EDIT_THRESHOLD = 5;
const DOCUMENT_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".rst", ".adoc"]);

type SessionState = { tasks?: boolean; edits?: boolean; files?: string[] };

// Per-session scratch lives in the OS temp directory beside the other session markers: it is only
// meaningful while the session runs, and session-cleanup removes it by name.
function stateFile(sessionId: string): string {
  return join(tmpdir(), `agent-workflow-reminder-${sha256(sessionId).slice(0, 16)}.json`);
}
function loadState(file: string): SessionState {
  try {
    const parsed = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    // Anything but a plain object (a corrupted or edited file) is treated as no state.
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as SessionState : {};
  } catch { return {}; }
}
// Atomic, so a hook that reads while another writes sees the old or the new state, never half a file.
// Returns false when the state could not be stored, so a caller can avoid repeating a reminder it cannot remember.
function saveState(file: string, state: SessionState): boolean {
  try { writeAtomic(file, JSON.stringify(state)); return true; } catch { return false; }
}

type OpenTask = { path: string; status: string };

// Tasks of the current worktree that are neither closed nor superseded. A task written by an older
// runtime may lack worktree_id, so it is counted rather than hidden.
function openTasks(root: string, cwd: string): OpenTask[] {
  try {
    const identity = projectIdentity(cwd);
    const directory = join(root, "projects", identity.projectId, "tasks");
    if (!existsSync(directory)) return [];
    const result: OpenTask[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = join(directory, entry.name, "task.json");
      if (!existsSync(file)) continue;
      let task: JsonObject; try { task = readJson(file); } catch { continue; }
      const lifecycle = task.lifecycle && typeof task.lifecycle === "object" && !Array.isArray(task.lifecycle) ? task.lifecycle as JsonObject : {};
      const status = String(lifecycle.status || "");
      if (!OPEN_STATUSES.includes(status)) continue;
      if (task.worktree_id && task.worktree_id !== identity.worktreeId) continue;
      result.push({ path: join(directory, entry.name), status });
    }
    return result;
  } catch { return []; }
}

function context(event: string, text: string): Json {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

// UserPromptSubmit: unfinished work is easy to lose across prompts, so it is named once per session.
export function runTaskReminder(payload: JsonObject, root: string): void {
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  if (!sessionId) return;
  const file = stateFile(sessionId); const state = loadState(file);
  if (state.tasks) return;
  state.tasks = true;
  if (!saveState(file, state)) return;
  const open = openTasks(root, cwd);
  if (!open.length) return;
  // The path comes from the state directory; control characters and backticks are dropped so a name cannot reshape the message.
  const lines = open.map((task) => `- ${[...task.path].filter((char) => char.charCodeAt(0) > 31 && char !== "\u007f" && char !== "`").join("")} (${task.status})`).join("\n");
  output(context("UserPromptSubmit", `agent-workflow: this worktree has unfinished task(s):\n${lines}\nFinish one with \`agent-workflow close-task --task-path <task>\`, or park it with \`agent-workflow resume --task <task>\` / \`agent-workflow supersede --task <task>\`. Skip this when the current request is unrelated to them.`));
}

// PostToolUse (Edit/Write): the entry gate for managed work is the agent's own judgment, so a session
// that has changed several source files without opening a task is asked to make that judgment again.
// Only the counter file is touched until the threshold is reached.
export function runEditReminder(payload: JsonObject, root: string): void {
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
  const input = payload.tool_input && typeof payload.tool_input === "object" && !Array.isArray(payload.tool_input) ? payload.tool_input as JsonObject : {};
  const target = typeof input.file_path === "string" ? input.file_path : "";
  if (!sessionId || !target || DOCUMENT_EXTENSIONS.has(extname(target).toLowerCase())) return;
  const inside = relative(resolve(cwd), resolve(cwd, target));
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return;
  const file = stateFile(sessionId); const state = loadState(file);
  if (state.edits) return;
  const files = new Set(state.files || []); files.add(inside.replaceAll("\\", "/").toLowerCase());
  if (files.size < EDIT_THRESHOLD) { saveState(file, { ...state, files: [...files] }); return; }
  if (!saveState(file, { ...state, edits: true, files: [...files] })) return;
  if (openTasks(root, cwd).length) return;
  output(context("PostToolUse", `agent-workflow: ${files.size} source files were changed in this session and no task is open. Decide managed_change again per AGENTS.md: if the change affects behavior, data, contracts, security, delivery or verification, load the workflow skill and run task-init before continuing. If the user already said this work does not use the workflow, carry on.`));
}
