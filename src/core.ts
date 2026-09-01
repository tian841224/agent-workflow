import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
