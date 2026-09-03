import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  renameSync(temporary, path);
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
  return resolve(path).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
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

export function parseArgs(argv: string[]): { positionals: string[]; values: Map<string, string | boolean | string[]> } {
  const positionals: string[] = [];
  const values = new Map<string, string | boolean | string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      positionals.push(item);
      continue;
    }
    const [key, inline] = item.slice(2).split("=", 2);
    if (inline !== undefined) {
      values.set(key, inline);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      values.set(key, true);
    } else {
      values.set(key, next);
      index += 1;
    }
  }
  return { positionals, values };
}

export function option(values: Map<string, string | boolean | string[]>, name: string, fallback = ""): string {
  const value = values.get(name);
  return typeof value === "string" ? value : fallback;
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
  return join(bundleDirectory, "schemas", name);
}

export function canonicalJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

// Lock dir create is atomic on NTFS and POSIX alike (mkdirSync throws EEXIST if held), so this
// needs no extra dependency. Atomics.wait gives a real synchronous sleep between retries.
export function withFileLock<T>(lockPath: string, fn: () => T, staleMs = 5 * 60 * 1000): T {
  for (;;) {
    try { mkdirSync(lockPath); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try { if (Date.now() - statSync(lockPath).mtimeMs > staleMs) rmSync(lockPath, { recursive: true, force: true }); }
      catch { /* another process cleared or re-acquired it first */ }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 + Math.floor(Math.random() * 20));
    }
  }
  try { return fn(); } finally { rmSync(lockPath, { recursive: true, force: true }); }
}

// The one blessed read-modify-write for a shared JSON file: lock, read, mutate in place, bump
// revision, write. A mutex under one function beats optimistic CAS since every writer routes here.
export function mutateTask<T extends JsonObject>(path: string, mutator: (state: T) => void): T {
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
