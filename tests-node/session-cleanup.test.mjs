import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const hookBundle = join(process.cwd(), "dist", "agent-workflow-hook.mjs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha16 = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function dead(pid) {
  for (let attempt = 0; attempt < 40; attempt += 1) { if (!alive(pid)) return true; await sleep(100); }
  return false;
}

// Stands in for claude.exe or codex: it owns one long-lived child and runs the hook as its own
// child, which is the ancestry a real platform gives the hook. The hook must kill the child and
// spare itself and the agent.
const FAKE_AGENT = `import { spawn, spawnSync } from "node:child_process";
const [bundle, state, platform, payload] = process.argv.slice(2);
const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
await new Promise((resolve) => setTimeout(resolve, 300));
const run = spawnSync(process.execPath, [bundle, "session-cleanup", "--platform", platform, "--state-root", state], { input: payload, encoding: "utf8" });
console.log(JSON.stringify({ victim: victim.pid, status: run.status, stdout: run.stdout }));
// Stay alive: on Windows a child dies with its parent, which would hide whether the hook killed it.
setInterval(() => {}, 1000);
`;

// The hook must never run as a direct child of the test process unless it is told the session
// continues: it would treat this test process as the agent and kill its other children.
function sandbox(t) {
  const base = mkdtempSync(join(tmpdir(), "agent-workflow-session-cleanup-"));
  const temp = join(base, "tmp");
  const state = join(base, "state");
  mkdirSync(temp);
  const agent = join(base, "fake-agent.mjs");
  writeFileSync(agent, FAKE_AGENT);
  const spawned = [];
  t.after(() => {
    for (const pid of spawned) { try { process.kill(pid); } catch { /* already gone */ } }
    rmSync(base, { recursive: true, force: true });
  });
  const env = { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp };
  const box = {
    temp, state,
    hook: (command, platform, payload) => spawnSync(process.execPath, [hookBundle, command, "--platform", platform, "--state-root", state], { encoding: "utf8", env, input: JSON.stringify(payload) }),
    async cleanupViaAgent(platform, payload) {
      const child = spawn(process.execPath, [agent, hookBundle, state, platform, typeof payload === "string" ? payload : JSON.stringify(payload)], { env, stdio: ["ignore", "pipe", "inherit"] });
      spawned.push(child.pid);
      let received = "";
      const report = await new Promise((resolve, reject) => {
        child.stdout.on("data", (chunk) => { received += chunk; if (received.includes("\n")) resolve(JSON.parse(received.trim().split("\n").pop())); });
        child.on("exit", () => reject(new Error("fake agent exited early: " + received)));
        setTimeout(() => reject(new Error("fake agent timed out")), 30000).unref();
      });
      spawned.push(report.victim);
      assert.equal(report.status, 0);
      return report;
    },
    outsider() {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      spawned.push(child.pid);
      return child.pid;
    },
    touch: (name) => writeFileSync(join(temp, name), "x"),
    has: (name) => existsSync(join(temp, name)),
    record: (platform, id) => join(state, "sessions", `${platform}-${sha16(id)}.json`),
    lastLog() {
      const lines = readFileSync(join(state, "logs", "session-cleanup.jsonl"), "utf8").trim().split("\n");
      return JSON.parse(lines[lines.length - 1]);
    },
    start: (platform, payload) => box.hook("session-start", platform, payload)
  };
  return box;
}

test("AC1 session end kills the agent's descendants and leaves other processes alone", async (t) => {
  const box = sandbox(t);
  const outsider = box.outsider();
  assert.equal(box.start("Claude", { session_id: "s1", source: "startup" }).status, 0);
  const report = await box.cleanupViaAgent("Claude", { session_id: "s1", hook_event_name: "SessionEnd", reason: "other" });
  assert.equal(report.status, 0);
  assert.ok(await dead(report.victim), "the agent's child must be terminated");
  assert.ok(alive(outsider), "a process outside the agent's tree must survive");
  assert.ok(box.lastLog().killed.some((entry) => entry.pid === report.victim), "the log names the killed process");
});

test("AC2 clear and resume keep processes running but still sweep temp files", async (t) => {
  for (const reason of ["clear", "resume"]) {
    const box = sandbox(t);
    box.touch("before");
    await sleep(80);
    box.start("Claude", { session_id: "s2", source: "startup" });
    await sleep(80);
    box.touch("after");
    const report = await box.cleanupViaAgent("Claude", { session_id: "s2", reason });
    await sleep(500);
    assert.ok(alive(report.victim), `${reason}: the agent keeps running, so its children stay`);
    assert.ok(box.has("before"), `${reason}: an entry older than the session stays`);
    assert.ok(!box.has("after"), `${reason}: an entry created during the session goes`);
  }
});

test("AC3 only entries created since the session started are deleted, plus the session's own markers", async (t) => {
  const box = sandbox(t);
  const hash = sha16("s3");
  box.touch("old.txt");
  box.touch(`agent-workflow-locale-${hash}`);
  box.touch(`agent-workflow-memory-${hash}.json`);
  await sleep(80);
  box.start("Claude", { session_id: "s3", source: "startup" });
  await sleep(80);
  box.touch("new.txt");
  mkdirSync(join(box.temp, "new-dir"));
  writeFileSync(join(box.temp, "new-dir", "inner.txt"), "x");
  const ended = box.hook("session-cleanup", "Claude", { session_id: "s3", reason: "clear" });
  assert.equal(ended.status, 0, ended.stderr);
  assert.ok(box.has("old.txt"), "an existing entry survives");
  assert.ok(!box.has("new.txt") && !box.has("new-dir"), "files and folders created during the session are removed");
  assert.ok(!box.has(`agent-workflow-locale-${hash}`) && !box.has(`agent-workflow-memory-${hash}.json`), "markers from before a resume are removed with the session");
  assert.ok(!existsSync(box.record("claude", "s3")), "the session record is removed");
  assert.equal(box.lastLog().deleted_count, 2);
});

test("AC4 an entry created while another session was running is kept", async (t) => {
  const box = sandbox(t);
  box.touch("before-a");
  await sleep(80);
  box.start("Claude", { session_id: "a", source: "startup" });
  await sleep(80);
  box.touch("only-a");
  await sleep(80);
  box.start("Claude", { session_id: "b", source: "startup" });
  await sleep(80);
  box.touch("while-b");
  const ended = box.hook("session-cleanup", "Claude", { session_id: "a", reason: "clear" });
  assert.equal(ended.status, 0, ended.stderr);
  assert.ok(box.has("before-a"), "older than the session");
  assert.ok(!box.has("only-a"), "created before the other session began");
  assert.ok(box.has("while-b"), "created while the other session was running");
  assert.ok(box.lastLog().notes.some((note) => /other active session/.test(note)));
});

test("AC4 a stale record does not hold back the sweep", async (t) => {
  const box = sandbox(t);
  mkdirSync(join(box.state, "sessions"), { recursive: true });
  const stale = box.record("claude", "ghost");
  writeFileSync(stale, JSON.stringify({ platform: "claude", started_ms: Date.now() - 3 * 86400000 }));
  const old = new Date(Date.now() - 2 * 86400000);
  utimesSync(stale, old, old);
  box.start("Claude", { session_id: "live", source: "startup" });
  await sleep(80);
  box.touch("new.txt");
  assert.equal(box.hook("session-cleanup", "Claude", { session_id: "live", reason: "clear" }).status, 0);
  assert.ok(!box.has("new.txt"));
  assert.ok(!existsSync(stale), "a record nobody refreshed is pruned");
});

test("AC4 another running Codex session keeps Codex from killing the shared agent's children", async (t) => {
  const box = sandbox(t);
  box.start("Codex", { session_id: "c1", source: "startup" });
  box.start("Codex", { session_id: "c2", source: "startup" });
  const report = await box.cleanupViaAgent("Codex", { session_id: "c1", reason: "other" });
  await sleep(500);
  assert.ok(alive(report.victim), "the other session's processes share this agent");
  assert.ok(box.lastLog().notes.some((note) => /other codex session active/.test(note)));
});

test("AC5 Antigravity Stop sweeps temp files, never kills, and waits for background tasks", async (t) => {
  const box = sandbox(t);
  const first = box.start("Antigravity", { conversationId: "g1", invocationNum: 0 });
  assert.deepEqual(JSON.parse(first.stdout), { injectSteps: [] });
  const recorded = readFileSync(box.record("antigravity", "g1"), "utf8");
  await sleep(80);
  assert.deepEqual(JSON.parse(box.start("Antigravity", { conversationId: "g1", invocationNum: 3 }).stdout), { injectSteps: [] });
  assert.equal(readFileSync(box.record("antigravity", "g1"), "utf8"), recorded, "a later invocation keeps the original start");
  box.touch("after");
  const busy = await box.cleanupViaAgent("Antigravity", { conversationId: "g1", terminationReason: "model_stop", fullyIdle: false });
  assert.deepEqual(JSON.parse(busy.stdout), { decision: "stop" });
  assert.ok(box.has("after"), "background work still running: nothing is cleaned");
  const idle = await box.cleanupViaAgent("Antigravity", { conversationId: "g1", terminationReason: "model_stop", fullyIdle: true });
  assert.deepEqual(JSON.parse(idle.stdout), { decision: "stop" });
  await sleep(500);
  assert.ok(!box.has("after"), "temp entry removed once idle");
  assert.ok(alive(busy.victim) && alive(idle.victim), "Antigravity never kills processes");
  assert.ok(existsSync(box.record("antigravity", "g1")), "the conversation continues, so its record stays");
});

test("AC6 a missing record or unreadable payload still exits 0 and logs why", async (t) => {
  const box = sandbox(t);
  box.touch("keep.txt");
  const unreadable = await box.cleanupViaAgent("Claude", "not json");
  assert.equal(unreadable.status, 0);
  assert.ok(box.lastLog().notes.some((note) => /no session record/.test(note)));
  const unknown = await box.cleanupViaAgent("Claude", { session_id: "never-started", reason: "other" });
  assert.equal(unknown.status, 0);
  assert.ok(box.lastLog().notes.some((note) => /no session record/.test(note)));
  assert.ok(box.has("keep.txt"), "without a start time nothing is swept");
});

test("agentDescendants spares the hook's own chain and rejects a child that predates its parent", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "agent-workflow-session-cleanup-unit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outfile = join(dir, "session-cleanup.mjs");
  buildSync({ entryPoints: [join(process.cwd(), "src", "session-cleanup.ts")], bundle: true, format: "esm", platform: "node", outfile, logLevel: "silent" });
  const { agentDescendants } = await import(pathToFileURL(outfile).href);
  const { agent, targets } = agentDescendants([
    { pid: 1, ppid: 0, name: "claude.exe", created: 100 },
    { pid: 2, ppid: 1, name: "cmd.exe", created: 200 },
    { pid: 3, ppid: 2, name: "node.exe", created: 210 },
    { pid: 4, ppid: 1, name: "node.exe", created: 150 },
    { pid: 5, ppid: 4, name: "esbuild.exe", created: 160 },
    // An orphan whose dead parent's PID was reused by the agent: it started before the agent did.
    { pid: 6, ppid: 1, name: "ghost.exe", created: 50 },
    { pid: 7, ppid: 6, name: "ghost-child.exe", created: 60 },
    { pid: 8, ppid: 99, name: "unrelated.exe", created: 10 }
  ], 3);
  assert.equal(agent.pid, 1);
  assert.deepEqual(targets.map((entry) => entry.pid).sort(), [4, 5]);
});
