// Cleans up what an agent session leaves behind: processes it started and files it dropped into the
// OS temp directory. SessionStart records when a session began; the end event kills the agent's
// surviving descendants and removes temp entries created since then. Nothing here may block a
// session from ending, so every failure is logged and swallowed.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { Json, JsonObject, isWithin, output, readJson, sha256, writeJson } from "./core.js";

type Platform = "claude" | "codex" | "antigravity";
// created is the start time in epoch ms where the platform reports it cheaply (Windows).
type ProcessInfo = { pid: number; ppid: number; name: string; created?: number };
type SessionRecord = { platform: Platform; started_ms: number; transcript_path?: string; scratchpad_dir?: string };
type Cleaned = { pid: number; name: string };

// A session whose transcript (or record, when there is no transcript) is older than this is treated
// as gone: its end event never ran, so it must not hold back other sessions' cleanup forever.
const ACTIVE_WINDOW_MS = 12 * 60 * 60 * 1000;
const LOG_ROTATE_BYTES = 1024 * 1024;
const LOGGED_PATH_CAP = 200;
const SHELLS = new Set(["cmd", "powershell", "pwsh", "bash", "sh", "zsh", "dash", "fish", "conhost"]);
// Codex allows SessionEnd hooks 3 seconds at most; the others leave room for a slow temp directory.
const BUDGET_MS: Record<Platform, number> = { claude: 20000, codex: 2000, antigravity: 10000 };

function platformOf(value: string): Platform {
  const lower = value.toLowerCase();
  return lower === "codex" || lower === "antigravity" ? lower : "claude";
}

function sessionIdOf(payload: JsonObject): string | undefined {
  const id = typeof payload.session_id === "string" ? payload.session_id : payload.conversationId;
  return typeof id === "string" && id ? id : undefined;
}

function recordPath(root: string, platform: Platform, sessionId: string): string {
  return join(root, "sessions", `${platform}-${sha256(sessionId).slice(0, 16)}.json`);
}

export function runSessionStart(payload: JsonObject, root: string, platformName: string): void {
  const platform = platformOf(platformName);
  const invocationNum = typeof payload.invocationNum === "number" ? payload.invocationNum : undefined;
  // PreInvocation fires on every model call, and compaction continues the same session: only the
  // first call or a real start moves the recorded origin.
  const skip = platform === "antigravity" ? invocationNum !== 0 : payload.source === "compact";
  const sessionId = sessionIdOf(payload);
  if (!skip && sessionId) {
    try {
      const transcript = typeof payload.transcript_path === "string" ? payload.transcript_path : (typeof payload.transcriptPath === "string" ? payload.transcriptPath : undefined);
      const scratch = typeof payload.scratchpad_dir === "string" ? payload.scratchpad_dir : undefined;
      writeJson(recordPath(root, platform, sessionId), { platform, started_ms: Date.now(), ...(transcript ? { transcript_path: transcript } : {}), ...(scratch ? { scratchpad_dir: scratch } : {}) });
    } catch { /* no record only means the end event skips the temp sweep */ }
  }
  if (platform === "antigravity") output({ injectSteps: [] });
}

function readRecord(path: string): SessionRecord | undefined {
  try {
    const parsed = readJson(path);
    return typeof parsed.started_ms === "number" ? parsed as unknown as SessionRecord : undefined;
  } catch { return undefined; }
}

function isActive(path: string, record: SessionRecord, nowMs: number): boolean {
  const probe = record.transcript_path && existsSync(record.transcript_path) ? record.transcript_path : path;
  try { return nowMs - statSync(probe).mtimeMs < ACTIVE_WINDOW_MS; } catch { return false; }
}

// Other sessions that are still running, with their records pruned of the ones that are not.
function otherActiveSessions(root: string, ownFile: string, nowMs: number): SessionRecord[] {
  const dir = join(root, "sessions");
  const active: SessionRecord[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return active; }
  for (const name of names) {
    const path = join(dir, name);
    if (path === ownFile || !name.endsWith(".json")) continue;
    const record = readRecord(path);
    if (record && isActive(path, record, nowMs)) active.push(record);
    else try { rmSync(path, { force: true }); } catch { /* a stale record is only clutter */ }
  }
  return active;
}

function processTable(): ProcessInfo[] {
  if (process.platform === "win32") {
    const script = "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate | Select-Object ProcessId,ParentProcessId,Name,@{n='Created';e={if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }}} | ConvertTo-Json -Compress";
    const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 8000, windowsHide: true });
    type Row = { ProcessId: number; ParentProcessId: number; Name: string; Created: number | null };
    const parsed = JSON.parse(raw) as Row[] | Row;
    return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, ...(p.Created ? { created: p.Created } : {}) }));
  }
  const raw = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8", timeout: 8000 });
  return raw.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), name: basename(match[3]) }] : [];
  });
}

function isShell(name: string): boolean {
  return SHELLS.has(name.toLowerCase().replace(/^-/, "").replace(/\.exe$/, ""));
}

// The hook's own chain (hook -> shell -> ... -> agent) is never a target: killing it would end the
// hook before it finishes, and the agent itself is not "something it started".
export function agentDescendants(table: ProcessInfo[], hookPid: number): { agent?: ProcessInfo; targets: ProcessInfo[] } {
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const chain = new Set<number>([hookPid]);
  let agent: ProcessInfo | undefined;
  for (let current = byPid.get(hookPid); current; ) {
    const parent = byPid.get(current.ppid);
    if (!parent || chain.has(parent.pid)) break;
    chain.add(parent.pid);
    if (!isShell(parent.name)) { agent = parent; break; }
    current = parent;
  }
  if (!agent) return { targets: [] };
  const children = new Map<number, ProcessInfo[]>();
  for (const p of table) children.set(p.ppid, [...(children.get(p.ppid) || []), p]);
  const targets: ProcessInfo[] = [];
  const queue = [agent];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const child of children.get(parent.pid) || []) {
      if (chain.has(child.pid) || child.pid === agent.pid) continue;
      // Windows keeps a dead parent's PID in its orphans' ppid. When a later process reuses that PID, the
      // orphan looks like its child, but a real child never starts before its parent.
      if (child.created && parent.created && child.created < parent.created) continue;
      targets.push(child);
      queue.push(child);
    }
  }
  return { agent, targets };
}

function sleep(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

// Returns the targets that are gone afterwards; a survivor is reported by its absence from the list.
function killTargets(targets: ProcessInfo[]): Cleaned[] {
  if (process.platform === "win32") {
    // No /T: the target list already is the checked descendant set, and taskkill's own tree walk would
    // follow the stale parent links that list excludes.
    if (targets.length) {
      try { execFileSync("taskkill", ["/F", ...targets.flatMap((p) => ["/PID", String(p.pid)])], { stdio: "ignore", timeout: 8000, windowsHide: true }); } catch { /* some exited already or were refused; the alive check below reports it */ }
    }
  } else {
    for (const target of targets) try { process.kill(target.pid, "SIGTERM"); } catch { /* already gone */ }
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && targets.some((p) => alive(p.pid))) sleep(50);
    for (const target of targets) if (alive(target.pid)) try { process.kill(target.pid, "SIGKILL"); } catch { /* exited in between */ }
  }
  return targets.filter((p) => !alive(p.pid)).map((p) => ({ pid: p.pid, name: p.name }));
}

type Sweep = { deleted: string[]; deletedCount: number; skipped: number; truncated: boolean };

function sweepTemp(since: number, before: number, protect: string[], deadline: number): Sweep {
  const base = tmpdir();
  const sweep: Sweep = { deleted: [], deletedCount: 0, skipped: 0, truncated: false };
  let names: string[] = [];
  try { names = readdirSync(base); } catch { return sweep; }
  for (const name of names) {
    if (Date.now() > deadline) { sweep.truncated = true; break; }
    const path = join(base, name);
    try {
      const created = lstatSync(path).birthtimeMs;
      if (!(created > 0)) { sweep.skipped += 1; continue; }
      if (created < since || created >= before) continue;
      // Something that holds the state root or another protected path is not scratch.
      if (protect.some((keep) => isWithin(keep, path))) continue;
      rmSync(path, { recursive: true, force: true });
      sweep.deletedCount += 1;
      if (sweep.deleted.length < LOGGED_PATH_CAP) sweep.deleted.push(path);
    } catch { sweep.skipped += 1; }
  }
  return sweep;
}

function appendLog(root: string, entry: JsonObject): void {
  const log = join(root, "logs", "session-cleanup.jsonl");
  try {
    mkdirSync(join(root, "logs"), { recursive: true });
    try { if (statSync(log).size > LOG_ROTATE_BYTES) renameSync(log, `${log}.1`); } catch { /* no log yet */ }
    appendFileSync(log, `${JSON.stringify(entry)}\n`);
  } catch { /* the cleanup result matters more than its record */ }
}

export function runSessionCleanup(payload: JsonObject, root: string, platformName: string): void {
  const platform = platformOf(platformName);
  const reason = typeof payload.reason === "string" ? payload.reason : (typeof payload.terminationReason === "string" ? payload.terminationReason : "");
  const sessionId = sessionIdOf(payload);
  const nowMs = Date.now();
  const deadline = nowMs + BUDGET_MS[platform];
  const entry: JsonObject = { at: new Date(nowMs).toISOString(), platform, reason, session: sessionId ? sha256(sessionId).slice(0, 16) : "", killed: [], deleted: [], deleted_count: 0, skipped: 0, notes: [] };
  const notes = entry.notes as string[];
  try {
    const ownFile = sessionId ? recordPath(root, platform, sessionId) : "";
    const own = ownFile ? readRecord(ownFile) : undefined;
    const others = otherActiveSessions(root, ownFile, nowMs);
    // Antigravity's Stop fires after every run, and fullyIdle=false means background work still goes on.
    const settled = platform !== "antigravity" || payload.fullyIdle !== false;
    const sessionContinues = platform === "claude" && (reason === "clear" || reason === "resume");
    const mayKill = platform !== "antigravity" && !sessionContinues && (platform !== "codex" || others.every((other) => other.platform !== "codex"));
    if (!settled) notes.push("background tasks still running; nothing cleaned");
    else {
      if (mayKill) {
        try {
          const { agent, targets } = agentDescendants(processTable(), process.pid);
          if (!agent) notes.push("agent process not found; processes left alone");
          else {
            const gone = killTargets(targets);
            entry.killed = gone as unknown as Json;
            if (gone.length < targets.length) notes.push(`${targets.length - gone.length} process(es) survived`);
          }
        } catch (error) { notes.push(`process cleanup failed: ${(error as Error).message}`); }
      } else notes.push(platform === "antigravity" ? "antigravity: processes are never killed" : (sessionContinues ? "session continues; processes left alone" : "other codex session active; processes left alone"));
      // Entries that hold the state root or another running session's scratchpad are not scratch of ours.
      const protect = [root, ...others.flatMap((other) => other.scratchpad_dir ? [other.scratchpad_dir] : [])];
      if (others.length) notes.push(`${others.length} other active session(s) limit the sweep`);
      if (!own) notes.push("no session record; temp sweep skipped");
      else {
        const before = Math.min(Infinity, ...others.map((other) => other.started_ms));
        const swept = sweepTemp(own.started_ms, before, protect, deadline);
        entry.deleted = swept.deleted; entry.deleted_count = swept.deletedCount; entry.skipped = swept.skipped;
        if (swept.truncated) notes.push("time budget reached; sweep incomplete");
      }
      // The scratchpad is session-owned and holds nothing the next session needs.
      const scratch = typeof payload.scratchpad_dir === "string" ? resolve(payload.scratchpad_dir) : "";
      if (scratch && isAbsolute(scratch) && scratch !== resolve(tmpdir()) && isWithin(scratch, resolve(tmpdir()))) {
        try { rmSync(scratch, { recursive: true, force: true }); (entry.deleted as string[]).push(scratch); entry.deleted_count = (entry.deleted_count as number) + 1; } catch { entry.skipped = (entry.skipped as number) + 1; }
      }
      // Antigravity's conversation goes on after Stop, so only the real end removes the bookkeeping.
      if (platform !== "antigravity" && sessionId) {
        const hash = sha256(sessionId).slice(0, 16);
        for (const file of [ownFile, join(tmpdir(), `agent-workflow-locale-${hash}`), join(tmpdir(), `agent-workflow-memory-${hash}.json`)]) try { rmSync(file, { force: true }); } catch { /* clutter only */ }
      }
    }
  } catch (error) { notes.push(`cleanup failed: ${(error as Error).message}`); }
  appendLog(root, entry);
  if (platform === "antigravity") output({ decision: "stop" });
}
