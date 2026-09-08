import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export const PRODUCT_VERSION = "7.0.0-dev.0";

export function stateRoot(value?: string): string {
  return resolve(value || process.env.AGENT_WORKFLOW_STATE_ROOT || join(process.env.USERPROFILE || process.env.HOME || ".", ".agent-workflow"));
}

export function now(): string {
  return new Date().toISOString();
}

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function readText(path: string): string {
  return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
}

export function writeAtomic(path: string, value: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, value);
  // Windows fails the rename with EPERM/EBUSY while another process still holds a handle on the
  // destination — a scanner, or a concurrent reader — so the swap is retried briefly before giving up.
  for (let attempt = 0; ; attempt += 1) {
    try { renameSync(temporary, path); return; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 10 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) { try { rmSync(temporary, { force: true }); } catch { /* the rename failure is what matters */ } throw error; }
      const until = Date.now() + 20; while (Date.now() < until) { /* brief spin: renameSync is sync, so there is no tick to await */ }
    }
  }
}

export function readJson(path: string): JsonObject {
  const parsed: unknown = JSON.parse(readText(path));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(`JSON object required: ${path}`);
  return parsed as JsonObject;
}

export function writeJson(path: string, value: Json): void {
  writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function stdinJson(): JsonObject {
  const raw = readFileSync(0, "utf8").replace(/^\uFEFF/, "");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("JSON object stdin required");
  return parsed as JsonObject;
}

export function output(value: Json): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function stableId(value: string): string {
  return sha256(value).slice(0, 16);
}

export type ProjectIdentity = { projectId: string; worktreeId: string; root: string };

// Matches the pre-Node project_id formula exactly (git-common-dir + remote + root-commit
// fingerprint) so existing ~/.agent-workflow/projects/<id> directories keep resolving.
export function projectIdentity(path: string): ProjectIdentity {
  const resolvedPath = resolve(path);
  const probe = git(resolvedPath, ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--git-common-dir"]);
  const lines = probe.stdout.split(/\r?\n/);
  if (probe.status !== 0 || (lines[0] || "").trim().toLowerCase() !== "true") {
    return { projectId: stableId(`${normal(resolvedPath)}||`), worktreeId: stableId(normal(resolvedPath)), root: resolvedPath };
  }
  const root = resolve(lines[1].trim());
  const commonRaw = lines[2].trim();
  const commonDir = isAbsolute(commonRaw) ? resolve(commonRaw) : resolve(root, commonRaw);
  const remoteResult = git(resolvedPath, ["config", "--get", "remote.origin.url"]);
  const remote = remoteResult.status === 0 ? (remoteResult.stdout.split(/\r?\n/)[0] || "").trim().toLowerCase() : "";
  const rootsResult = git(resolvedPath, ["rev-list", "--max-parents=0", "HEAD"]);
  const fingerprint = rootsResult.status === 0
    ? [...new Set(rootsResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))].sort().join(",").toLowerCase()
    : "";
  return { projectId: stableId(`${normal(commonDir)}|${remote}|${fingerprint}`), worktreeId: stableId(normal(root)), root };
}

export function normal(path: string): string {
  const normalized = resolve(path).replaceAll("\\", "/").replace(/\/+$/, "");
  // Case-sensitive filesystems (ext4, APFS) treat two spellings as distinct files; folding there would merge real identities
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isWithin(path: string, parent: string): boolean {
  const delta = relative(resolve(parent), resolve(path));
  return delta === "" || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta));
}

export function git(cwd: string, args: string[], options: { input?: Buffer; env?: NodeJS.ProcessEnv } = {}): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    input: options.input,
    env: options.env ? { ...process.env, ...options.env } : process.env
  });
  return { status: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" };
}

export function mustGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

export function removeIfUnmodified(path: string, digest: string): boolean {
  if (!existsSync(path) || sha256(readFileSync(path)) !== digest) return false;
  rmSync(path, { force: true });
  return true;
}

export type Frontmatter = Record<string, string | boolean | string[]>;

function parseScalar(value: string): string | boolean | string[] {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const body = trimmed.slice(1, -1).trim();
    return body ? body.split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")) : [];
  }
  return trimmed.replace(/^['"]|['"]$/g, "");
}

export function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const data: Frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    data[line.slice(0, separator).trim()] = parseScalar(line.slice(separator + 1));
  }
  return data;
}

export function frontmatterBody(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export function setFrontmatter(content: string, name: string, value: string): string {
  const line = `${name}: ${value}`;
  const expression = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:.*$`, "m");
  if (expression.test(content)) return content.replace(expression, line);
  return content.replace(/^---\r?\n/, (header) => `${header}${line}\n`);
}

// A repeated flag accumulates instead of overwriting. `--id a --id b` used to keep only "b", which
// is the shape an agent naturally writes for a multi-value option and silently lost half its input.
export function parseArgs(argv: string[]): { positionals: string[]; values: Map<string, string | boolean | string[]> } {
  const positionals: string[] = [];
  const values = new Map<string, string | boolean | string[]>();
  const add = (key: string, value: string | boolean): void => {
    const existing = values.get(key);
    if (existing === undefined) values.set(key, value);
    else if (Array.isArray(existing)) values.set(key, [...existing, String(value)]);
    else values.set(key, [String(existing), String(value)]);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      positionals.push(item);
      continue;
    }
    const [key, inline] = item.slice(2).split("=", 2);
    if (inline !== undefined) {
      add(key, inline);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      add(key, true);
    } else {
      add(key, next);
      index += 1;
    }
  }
  return { positionals, values };
}

// A single-value option refuses to guess which repetition was meant, rather than picking one.
export function option(values: Map<string, string | boolean | string[]>, name: string, fallback = ""): string {
  const value = values.get(name);
  if (Array.isArray(value)) throw new Error(`duplicate option --${name} (given ${value.length} times); --${name} takes a single value`);
  return typeof value === "string" ? value : fallback;
}

// The multi-value read: accepts repeated flags, a comma-separated value, or any mix of the two.
export function optionList(values: Map<string, string | boolean | string[]>, name: string): string[] {
  const value = values.get(name);
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return raw.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
}

export function flag(values: Map<string, string | boolean | string[]>, name: string): boolean {
  return values.get(name) === true;
}

// Resolves a schemas/<name> path next to the running module: a package bundle keeps schemas/
// beside dist/, while an installed bundle keeps it one directory up from the runtime module.
export function schemaPath(name: string): string {
  const bundleDirectory = dirname(fileURLToPath(import.meta.url));
  const packageCandidate = join(bundleDirectory, "..", "schemas", name);
  if (existsSync(packageCandidate)) return packageCandidate;
  const bundleCandidate = join(bundleDirectory, "schemas", name);
  if (existsSync(bundleCandidate)) return bundleCandidate;
  // The PATH copy of the bundle sits on its own, away from the schemas the install laid down, so a
  // bundle that cannot find them beside itself falls back to the installed runtime.
  return join(stateRoot(), "runtime", "schemas", name);
}

export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

// Lock dir create is atomic on NTFS and POSIX alike (mkdirSync throws EEXIST if held), so this
// needs no extra dependency. Atomics.wait gives a real synchronous sleep between retries.
// The lock dir carries an "owner" record file (token, pid, hostname): a stale reclaim renames the whole dir aside
// (atomic) before removing it, and release only unlinks the dir if its owner token still matches —
// this stops a just-finished slow owner from deleting a newer claimant's lock (both were racing
// unconditional rmSync of the same path before this).
// A timeout alone cannot tell a crashed holder from a slow one, so a same-machine lock is reclaimed
// only once its pid is confirmed dead; another host's liveness is unknowable here, so it falls back
// to the timeout on its own.
function ownerIsGone(ownerFile: string): boolean {
  let record: JsonObject;
  try { record = readJson(ownerFile); } catch { return true; } // no readable owner record left to protect
  if (String(record.hostname || "") !== hostname()) return true;
  const pid = Number(record.pid);
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "EPERM"; } // EPERM: alive, just not ours to signal
}

export function withFileLock<T>(lockPath: string, fn: () => T, staleMs = 5 * 60 * 1000): T {
  const owner = randomUUID();
  const ownerFile = join(lockPath, "owner");
  mkdirSync(dirname(lockPath), { recursive: true }); // the lock can be the first thing ever written under a fresh state root

  for (;;) {
    try { mkdirSync(lockPath); writeJson(ownerFile, { token: owner, pid: process.pid, hostname: hostname(), acquired_at: now() }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs && ownerIsGone(ownerFile)) {
          const stale = `${lockPath}.stale.${process.pid}.${Date.now()}`;
          renameSync(lockPath, stale); // atomic hand-off: any late original owner now targets an orphaned path
          rmSync(stale, { recursive: true, force: true });
        }
      } catch { /* another process cleared, reclaimed, or re-acquired it first */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + Math.floor(Math.random() * 20));
    }
  }
  try { return fn(); }
  finally {
    try { if (readJson(ownerFile).token === owner) rmSync(lockPath, { recursive: true, force: true }); }
    catch { /* lock was reclaimed as stale while we held it; nothing left of ours to remove */ }
  }
}

// The one blessed read-modify-write for a shared JSON file: lock, read, mutate in place, bump
// revision, write. A mutex under one function beats optimistic CAS since every writer routes here.
// Generic across every JSON state file this runtime owns (task.json, orchestration index,
// review-cause/retro records) — not task.json-specific despite the historical name pressure.
export function mutateJsonState<T extends JsonObject>(path: string, mutator: (state: T) => void): T {
  return withFileLock(`${path}.lock`, () => {
    const state = (existsSync(path) ? readJson(path) : {}) as T;
    mutator(state);
    (state as JsonObject).state_revision = Number((state as JsonObject).state_revision || 0) + 1;
    writeJson(path, state);
    return state;
  });
}

export function workspaceFingerprint(cwd: string): string {
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const diffSha = sha256(git(cwd, ["diff", "--binary", "HEAD"]).stdout);
  const untracked = git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout
    .split(/\r?\n/).filter((line) => line.startsWith("?? ")).map((line) => line.slice(3).trim()).sort();
  const manifest = untracked.map((relPath) => {
    try { return `${relPath}:${sha256(readFileSync(resolve(cwd, relPath)))}`; }
    catch { return `${relPath}:missing`; }
  }).join("\n");
  return sha256(`${head.status === 0 ? head.stdout.trim() : ""}|${diffSha}|${manifest}`);
}

// Scoped counterpart to workspaceFingerprint: hashes only the diff of the paths a role actually
// reviewed against the base it reviewed them at. An unrelated edit elsewhere in the repo no longer
// invalidates the review, while any change inside the reviewed scope still does.
export function diffFingerprint(cwd: string, base: string, paths: string[]): string {
  const scope = [...new Set(paths.map((value) => value.trim()).filter(Boolean))].sort();
  const diff = git(cwd, ["diff", "--binary", base, "--", ...scope]);
  if (diff.status !== 0) throw new Error(`diff-fingerprint: git diff failed for base ${base}: ${diff.stderr.trim()}`);
  // An untracked-file listing this runtime cannot complete must never be read as "there are none":
  // a reviewer's/task's delivery fingerprint would then silently omit whatever untracked files this
  // failed enumeration was actually going to report.
  const untrackedProbe = git(cwd, ["ls-files", "--others", "--exclude-standard", "--", ...scope]);
  if (untrackedProbe.status !== 0) throw new Error(`diff-fingerprint: git ls-files failed for base ${base}: ${untrackedProbe.stderr.trim()}`);
  const untracked = untrackedProbe.stdout
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean).sort();
  const manifest = untracked.map((relPath) => {
    try { return `${relPath}:${sha256(readFileSync(resolve(cwd, relPath)))}`; }
    catch { return `${relPath}:missing`; }
  }).join("\n");
  return sha256(`${base}|${scope.join("\n")}|${sha256(diff.stdout)}|${manifest}`);
}

// Every repo-relative path this working tree touches relative to `base`, tracked or not. Pairs with
// diffFingerprint: the fingerprint says "did my scope change", this says "was my scope the right one".
//
// --name-status, not --name-only, because a rename reports both sides and a delete reports a path
// that no longer exists on disk; a scope check that only sees files still present would let a moved
// or removed file out of the reviewed set entirely.
// The whole-delivery counterpart to diffFingerprint: every path changed since base, not a
// reviewer-chosen subset. Used for the task-level delivery_hash rather than role-evidence's
// deliberately narrower reviewed_paths scoping.
export function deliveryHash(cwd: string, base: string): string {
  return diffFingerprint(cwd, base, changedPaths(cwd, base));
}

export function changedPaths(cwd: string, base: string): string[] {
  const tracked = git(cwd, ["diff", "--name-status", base]);
  if (tracked.status !== 0) throw new Error(`changed-paths: git diff failed for base ${base}: ${tracked.stderr.trim()}`);
  const result: string[] = [];
  for (const line of tracked.stdout.split(/\r?\n/)) {
    const parts = line.split("\t").map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    result.push(...parts.slice(1)); // R/C carry both the old and the new path; every other status carries one
  }
  // Same fail-closed rule as diffFingerprint: an untracked-listing failure must not collapse to "no
  // untracked files", or a reviewer/gate would see a narrower delivery than actually exists.
  const untrackedProbe = git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  if (untrackedProbe.status !== 0) throw new Error(`changed-paths: git ls-files failed for base ${base}: ${untrackedProbe.stderr.trim()}`);
  result.push(...untrackedProbe.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  return [...new Set(result)].sort();
}
