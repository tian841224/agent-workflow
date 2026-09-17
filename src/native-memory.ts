import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { JsonObject, frontmatterBody, readJson } from "./core.js";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILES_PER_ROOT = 256;
const TEXT_EXTENSIONS = new Set([".md", ".txt"]);
const EXCLUDED_PARTS = new Set(["rollout_summaries", "sessions", "automations"]);
const EXCLUDED_NAMES = new Set(["instructions.md", "memory_summary.md"]);
const CREDENTIAL_ASSIGNMENT = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|private[_-]?key)\b\s*[:=]\s*[^\s<>{}[\]]{8,}/i;

export type NativeMemoryCandidate = {
  path: string;
  fields: JsonObject;
  updatedAt: string;
  line: string;
  haystack: string;
  content: string;
  native: true;
  source: string;
};

type NativeRoot = { root: string; source: string };

function files(root: string, base = root): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  try {
    for (const item of readdirSync(root, { withFileTypes: true })) {
      if (item.isSymbolicLink()) continue;
      const path = join(root, item.name);
      if (item.isDirectory()) result.push(...files(path, base));
      else if (item.isFile() && TEXT_EXTENSIONS.has(extname(item.name).toLowerCase()) && !EXCLUDED_NAMES.has(item.name.toLowerCase()) && !relative(base, path).split(/[\\/]/).some((part) => EXCLUDED_PARTS.has(part.toLowerCase()))) result.push(path);
    }
  } catch {
    return result;
  }
  return result;
}

function body(path: string): string | undefined {
  try {
    const raw = readFileSync(path);
    if (raw.byteLength > MAX_FILE_BYTES) return undefined;
    const text = raw.toString("utf8").replace(/^\uFEFF/, "").trim();
    if (!text || CREDENTIAL_ASSIGNMENT.test(text)) return undefined;
    const value = frontmatterBody(text).trim().replace(/\s+/g, " ");
    return value || undefined;
  } catch {
    return undefined;
  }
}

function configuredTargets(state: string): Record<string, string> | undefined {
  const path = join(state, "managed-runtime.json");
  if (!existsSync(path)) return undefined;
  try {
    const value = readJson(path).targets;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value as JsonObject).filter(([, item]) => typeof item === "string").map(([name, item]) => [name, resolve(item as string)]));
  } catch {
    return {};
  }
}

function projectSlug(cwd: string): string {
  const slug = resolve(cwd).replace(/[:\\/]/g, "-");
  return process.platform === "win32" ? slug.replace(/^-+/, "") : slug;
}

function roots(state: string, cwd: string): NativeRoot[] {
  const targets = configuredTargets(state);
  if (!targets) return [];
  const home = homedir();
  const claude = targets.Claude || join(home, ".claude");
  const codex = targets.Codex || join(home, ".codex");
  const antigravity = targets.Antigravity || join(home, ".gemini");
  return [
    { root: join(claude, "memory"), source: "claude" },
    { root: join(claude, "projects", projectSlug(cwd), "memory"), source: "claude-project" },
    { root: join(codex, "memories"), source: "codex" },
    { root: join(codex, "memory"), source: "codex" },
    { root: join(antigravity, "antigravity", "brain"), source: "antigravity" }
  ];
}

export function nativeMemoryCandidates(state: string, cwd: string): NativeMemoryCandidate[] {
  const seen = new Set<string>();
  return roots(state, cwd).flatMap((sourceRoot) => files(sourceRoot.root).slice(0, MAX_FILES_PER_ROOT).flatMap((path) => {
    const key = resolve(path).toLowerCase();
    if (seen.has(key)) return [];
    seen.add(key);
    const value = body(path);
    if (!value) return [];
    let updatedAt = "";
    try { updatedAt = statSync(path).mtime.toISOString(); } catch { /* the file may disappear during a scan */ }
    const label = "[needs_verification:" + sourceRoot.source + "] " + path;
    return [{ path, fields: { status: "needs_verification", origin: "native", project_id: "", source: sourceRoot.source }, updatedAt, line: label + ": " + value.slice(0, 120), haystack: (sourceRoot.source + " " + path + " " + value).toLowerCase(), content: (sourceRoot.source + " " + path + " " + value).toLowerCase(), native: true as const, source: sourceRoot.source }];
  }));
}
