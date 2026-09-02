import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as outputStream } from "node:process";
import { Json, JsonObject, PRODUCT_VERSION, now, output, readJson, sha256, stateRoot, writeAtomic, writeJson } from "./core.js";

type Platform = "Claude" | "Codex" | "Antigravity";
type FileRecord = { path: string; sha256: string; kind: string };
type InstallOptions = { action: "Install" | "Repair" | "Verify" | "Uninstall"; target: string; root: string; skills?: string; nonInteractive: boolean; dryRun: boolean; claude: string; codex: string; antigravity: string; };

const platforms: Record<Platform, { entrypoint: string; hook: string[]; skills: string[] }> = {
  Claude: { entrypoint: "CLAUDE.md", hook: ["settings.json"], skills: ["skills"] },
  Codex: { entrypoint: "AGENTS.md", hook: ["hooks.json"], skills: ["skills"] },
  Antigravity: { entrypoint: "GEMINI.md", hook: ["config", "hooks.json"], skills: ["config", "skills"] }
};

function sourceRoot(): string {
  // A package bundle lives in dist/, while an installed bundle lives directly
  // in <state>/runtime.  The latter must repair from the recorded source.
  const bundleDirectory = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(bundleDirectory, "..");
  if (existsSync(join(packageRoot, "adapters", "managed-manifest.json"))) return packageRoot;
  const state = resolve(bundleDirectory, "..");
  const managed = join(state, "managed-runtime.json");
  if (existsSync(managed)) {
    const recorded = readJson(managed).source;
    if (typeof recorded === "string" && existsSync(join(recorded, "adapters", "managed-manifest.json"))) return resolve(recorded);
  }
  throw new Error("installed runtime has no valid recorded source; run Repair from a source checkout");
}

function home(): string { return process.env.USERPROFILE || process.env.HOME || "."; }
function targetPlatforms(value: string): Platform[] {
  if (value === "Both") return ["Claude", "Codex"];
  if (value === "All") return ["Claude", "Codex", "Antigravity"];
  if (value === "Claude" || value === "Codex" || value === "Antigravity") return [value];
  throw new Error(`unknown target agent: ${value}`);
}
function roots(options: InstallOptions): Record<Platform, string> { return { Claude: resolve(options.claude), Codex: resolve(options.codex), Antigravity: resolve(options.antigravity) }; }
function filesAt(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...filesAt(path)); else if (entry.isFile()) result.push(path);
  }
  return result;
}
function copyFile(source: string, destination: string, records: FileRecord[], kind: string, dryRun: boolean): void {
  const digest = sha256(readFileSync(source));
  if (!dryRun) { mkdirSync(dirname(destination), { recursive: true }); writeAtomic(destination, readFileSync(source)); }
  records.push({ path: destination, sha256: digest, kind });
}
function copyTree(source: string, destination: string, records: FileRecord[], kind: string, dryRun: boolean): void {
  for (const file of filesAt(source)) copyFile(file, join(destination, relative(source, file)), records, kind, dryRun);
}
function pruneRuntime(runtime: string, records: FileRecord[], dryRun: boolean): void {
  if (dryRun) return;
  const managed = new Set(records.filter((record) => record.kind === "runtime").map((record) => resolve(record.path)));
  for (const file of filesAt(runtime)) if (!managed.has(resolve(file))) rmSync(file, { force: true });
  const removeEmptyDirectories = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) removeEmptyDirectories(join(directory, entry.name));
    if (directory !== runtime && readdirSync(directory).length === 0) rmSync(directory, { recursive: true, force: true });
  };
  removeEmptyDirectories(runtime);
}
function catalog(root: string): Record<string, JsonObject> {
  const value = readJson(join(root, "adapters", "managed-manifest.json")).skills;
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("managed manifest has no skills catalog");
  return value as Record<string, JsonObject>;
}
function requiredSkills(value: Record<string, JsonObject>): string[] { return Object.entries(value).filter(([, meta]) => meta.required === true).map(([name]) => name); }
async function selectSkills(value: Record<string, JsonObject>, options: InstallOptions, previous: JsonObject): Promise<string[]> {
  let requested = options.skills;
  if (!requested && options.action === "Repair" && Array.isArray(previous.selected_skills)) requested = previous.selected_skills.filter((x): x is string => typeof x === "string").join(",");
  if (!requested && !options.nonInteractive && input.isTTY && outputStream.isTTY) {
    const names = Object.keys(value);
    process.stdout.write("請選擇要安裝的 optional skills（可輸入編號並以逗號分隔，0=全部）：\n");
    names.forEach((name, index) => process.stdout.write(`[${index + 1}] ${name}${value[name].required === true ? "（必裝）" : ""}：${String(value[name].description || "無說明")}\n`));
    const reader = createInterface({ input, output: outputStream });
    const answer = (await reader.question("選擇：")).trim(); reader.close();
    requested = answer === "0" ? "all" : answer.split(",").map((item) => names[Number(item.trim()) - 1]).filter(Boolean).join(",");
  }
  const names = requested === "all" || !requested ? Object.keys(value) : requested.split(",").map((item) => item.trim()).filter(Boolean);
  const unknown = names.filter((name) => !value[name]);
  if (unknown.length) throw new Error(`unknown skill(s): ${unknown.join(", ")}`);
  return [...new Set([...names, ...requiredSkills(value)])].sort();
}
function removeOwnHooks(value: Json, marker: string): Json {
  // JSON.stringify escapes each path backslash as two characters, so a raw Windows marker
  // never matches; compare both sides with backslashes collapsed to forward slashes instead.
  const needle = marker.replaceAll("\\", "/").toLowerCase();
  if (Array.isArray(value)) return value.map((item) => removeOwnHooks(item, marker)).filter((item) => JSON.stringify(item).replaceAll("\\\\", "/").toLowerCase().indexOf(needle) < 0);
  if (!value || typeof value !== "object") return value;
  const record = value as JsonObject;
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(record)) if (!key.startsWith("agent-workflow-")) result[key] = removeOwnHooks(item, marker);
  return result;
}
function mergeHookEvents(current: JsonObject, replaced: JsonObject): JsonObject {
  const merged: JsonObject = { ...current };
  for (const [event, groups] of Object.entries(replaced)) {
    const existingGroups = Array.isArray(current[event]) ? current[event] as Json[] : [];
    merged[event] = [...existingGroups, ...(Array.isArray(groups) ? groups : [])];
  }
  return merged;
}
function mergeHook(fragment: JsonObject, destination: string, runtime: string, node: string, dryRun: boolean, topLevel: boolean): void {
  const replaced = JSON.parse(JSON.stringify(fragment).replaceAll("{{RUNTIME_DIR}}", runtime.replaceAll("\\", "\\\\")).replaceAll("{{NODE_EXE}}", node.replaceAll("\\", "\\\\"))) as JsonObject;
  let current: JsonObject = {};
  if (existsSync(destination)) current = readJson(destination);
  current = removeOwnHooks(current, runtime) as JsonObject;
  // Per-event array append (not a shallow key overwrite) so a platform's own hooks on the same
  // event (e.g. a user Stop hook) survive alongside the managed ones instead of being replaced.
  const merged = topLevel ? { ...current, ...replaced } : { ...current, hooks: mergeHookEvents((current.hooks || {}) as JsonObject, (replaced.hooks || {}) as JsonObject) };
  if (!dryRun) writeJson(destination, merged);
}
function managedEntrypoint(source: string, canonical: string, destinations: string[], dryRun: boolean): void {
  const begin = "<!-- agent-workflow v7 managed:start -->", end = "<!-- agent-workflow v7 managed:end -->";
  const strip = (value: string) => value.replace(/\r?\n?<!-- agent-workflow v[4567] managed:start -->[\s\S]*?<!-- agent-workflow v[4567] managed:end -->\r?\n?/g, "").trim();
  const candidates = [canonical, ...destinations].filter(existsSync).map((path) => strip(readFileSync(path, "utf8"))).filter(Boolean);
  if (new Set(candidates).size > 1) throw new Error("conflicting unmanaged entrypoint content found; refusing to overwrite it");
  const content = `${candidates[0] ? `${candidates[0]}\n\n` : ""}${begin}\n${readFileSync(source, "utf8").trim()}\n${end}\n`;
  if (!dryRun) for (const path of [canonical, ...destinations]) writeAtomic(path, content);
}
function taskMigration(root: string, backup: string): number {
  let migrated = 0;
  for (const taskMd of filesAt(join(root, "projects")).filter((path) => basename(path) === "task.md")) {
    const directory = dirname(taskMd); const taskJson = join(directory, "task.json");
    if (existsSync(taskJson)) continue;
    const legacy = readFileSync(taskMd, "utf8");
    const header = legacy.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || "";
    const fields: JsonObject = {};
    for (const line of header.split(/\r?\n/)) { const index = line.indexOf(":"); if (index > 0) fields[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, ""); }
    const id = typeof fields.id === "string" ? fields.id : basename(directory);
    writeJson(taskJson, { schema_version: 1, id, lifecycle: { status: fields.status || "in_progress", transitions: [{ at: now(), action: "migrate", from: "legacy", to: fields.status || "in_progress", actor: "migration" }] }, evidence: [{ kind: "legacy-unverified", verified: false, note: "Imported from Python task.md; requires a new gate verification." }], intent: legacy.replace(/^---[\s\S]*?---\r?\n?/, "") });
    const backupTarget = join(backup, "tasks", relative(join(root, "projects"), taskMd)); mkdirSync(dirname(backupTarget), { recursive: true }); writeAtomic(backupTarget, legacy); rmSync(taskMd);
    migrated += 1;
  }
  return migrated;
}
export function migrateState(root = stateRoot(), dryRun = false): JsonObject {
  const state = resolve(root); const managedPath = join(state, "managed-runtime.json"); const existing = existsSync(managedPath) ? readJson(managedPath) : {};
  if (existing.runtime_kind === "node" && existing.migrations && typeof existing.migrations === "object" && (existing.migrations as JsonObject).python_to_node) return { migrated: false, reason: "already-migrated" };
  const stamp = now().replace(/[:.]/g, "-"); const backup = join(state, "migrations", `python-v6-${stamp}`);
  if (!dryRun) { mkdirSync(backup, { recursive: true }); if (existsSync(managedPath)) writeAtomic(join(backup, "managed-runtime.json"), readFileSync(managedPath)); }
  const migratedTasks = dryRun ? 0 : taskMigration(state, backup);
  return { migrated: true, backup, migrated_tasks: migratedTasks, preserved: ["selected_skills", "knowledge", "review-causes", "skill-drafts"] };
}
export async function install(options: InstallOptions): Promise<number> {
  const state = stateRoot(options.root); const runtime = join(state, "runtime"); const source = sourceRoot(); const managedPath = join(state, "managed-runtime.json"); const previous = existsSync(managedPath) ? readJson(managedPath) : {};
  if (options.action === "Verify") return verify(options);
  if (options.action === "Uninstall") return uninstall(options);
  if (!existsSync(join(source, "dist", "agent-workflow.mjs"))) throw new Error("distribution bundle is missing; run npm run build before installing from a clone");
  const migration = migrateState(state, options.dryRun);
  const selected = targetPlatforms(options.target); const selectedSkills = await selectSkills(catalog(source), options, previous); const records: FileRecord[] = [];
  copyFile(join(source, "dist", "agent-workflow.mjs"), join(runtime, "agent-workflow.mjs"), records, "runtime", options.dryRun);
  for (const folder of ["adapters", "schemas", "templates"]) if (existsSync(join(source, folder))) copyTree(join(source, folder), join(runtime, folder), records, "runtime", options.dryRun);
  pruneRuntime(runtime, records, options.dryRun);
  const canonical = join(home(), ".agents");
  for (const skill of selectedSkills) { const sourceSkill = join(source, ".agents", "skills", skill); if (existsSync(sourceSkill)) copyTree(sourceSkill, join(canonical, "skills", skill), records, "canonical-skill", options.dryRun); }
  const targetRoots = roots(options); const destinations = selected.map((platform) => join(targetRoots[platform], platforms[platform].entrypoint));
  const entrySource = existsSync(join(source, "AGENTS.md")) ? join(source, "AGENTS.md") : join(runtime, "AGENTS.md");
  if (existsSync(entrySource)) managedEntrypoint(entrySource, join(canonical, "AGENTS.md"), destinations, options.dryRun);
  const node = process.execPath;
  for (const platform of selected) {
    const root = targetRoots[platform]; const skillRoot = join(root, ...platforms[platform].skills);
    for (const skill of selectedSkills) { const sourceSkill = join(canonical, "skills", skill); if (existsSync(sourceSkill)) copyTree(sourceSkill, join(skillRoot, skill), records, "platform-skill", options.dryRun); }
    const fragment = readJson(join(source, "adapters", platform.toLowerCase(), platform === "Claude" ? "settings.hooks.json" : "hooks.json"));
    mergeHook(fragment, join(root, ...platforms[platform].hook), runtime, node, options.dryRun, platform === "Antigravity");
  }
  if (!options.dryRun) writeJson(managedPath, { schema_version: 7, product_version: PRODUCT_VERSION, runtime_kind: "node", node, runtime_hash: sha256(readFileSync(join(runtime, "agent-workflow.mjs"))), installed_at: now(), source, targets: Object.fromEntries(selected.map((name) => [name, targetRoots[name]])), selected_skills: selectedSkills, files: records, migrations: { ...((previous.migrations || {}) as JsonObject), python_to_node: migration } });
  output({ ok: true, action: options.action, runtime, selected_skills: selectedSkills, migration }); return 0;
}
export function verify(options: InstallOptions): number {
  const state = stateRoot(options.root); const runtime = join(state, "runtime"); const managedPath = join(state, "managed-runtime.json"); const errors: string[] = [];
  if (!existsSync(managedPath)) errors.push("managed state is missing"); else { const managed = readJson(managedPath); if (managed.runtime_kind !== "node") errors.push("managed runtime is not Node"); const bundle = join(runtime, "agent-workflow.mjs"); if (!existsSync(bundle)) errors.push("runtime bundle is missing"); else if (managed.runtime_hash !== sha256(readFileSync(bundle))) errors.push("runtime bundle hash mismatch"); const source = typeof managed.source === "string" ? managed.source : ""; if (!source || !existsSync(join(source, "dist", "agent-workflow.mjs"))) errors.push("recorded source bundle is missing"); else if (existsSync(bundle) && sha256(readFileSync(join(source, "dist", "agent-workflow.mjs"))) !== sha256(readFileSync(bundle))) errors.push("source and installed runtime bundle differ"); for (const item of Array.isArray(managed.files) ? managed.files : []) { if (!item || typeof item !== "object") continue; const record = item as JsonObject; if (typeof record.path !== "string" || typeof record.sha256 !== "string") { errors.push("managed state contains an invalid file record"); continue; } if (!existsSync(record.path)) errors.push(`managed file is missing: ${record.path}`); else if (sha256(readFileSync(record.path)) !== record.sha256) errors.push(`managed file hash mismatch: ${record.path}`); } }
  output({ valid: errors.length === 0, runtime_root: runtime, node: process.execPath, errors }); return errors.length ? 1 : 0;
}
export function uninstall(options: InstallOptions): number {
  const state = stateRoot(options.root); const managedPath = join(state, "managed-runtime.json"); if (!existsSync(managedPath)) { output({ ok: true, removed: 0 }); return 0; }
  const managed = readJson(managedPath); let removed = 0;
  for (const item of Array.isArray(managed.files) ? managed.files : []) { if (!item || typeof item !== "object") continue; const record = item as JsonObject; if (typeof record.path === "string" && typeof record.sha256 === "string" && existsSync(record.path) && sha256(readFileSync(record.path)) === record.sha256) { if (!options.dryRun) rmSync(record.path); removed += 1; } }
  if (!options.dryRun && existsSync(join(state, "runtime"))) rmSync(join(state, "runtime"), { recursive: true, force: true });
  output({ ok: true, removed, preserved: ["projects", "knowledge", "skills", "migrations"] }); return 0;
}
