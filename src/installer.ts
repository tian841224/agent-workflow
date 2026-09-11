import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as outputStream } from "node:process";
import { Frontmatter, Json, JsonObject, PRODUCT_VERSION, frontmatterBody, now, output, parseFrontmatter, projectIdentity, readJson, sha256, stateRoot, writeAtomic, writeJson } from "./core.js";

type Platform = "Claude" | "Codex" | "Antigravity";
type FileRecord = { path: string; sha256: string; kind: string };
type InstallOptions = { action: "Install" | "Repair" | "Verify" | "Uninstall"; target: string; root: string; skills?: string; nonInteractive: boolean; dryRun: boolean; claude: string; codex: string; antigravity: string; };

const platforms: Record<Platform, { entrypoint: string; hook: string[]; skills: string[] }> = {
  Claude: { entrypoint: "CLAUDE.md", hook: ["settings.json"], skills: ["skills"] },
  Codex: { entrypoint: "AGENTS.md", hook: ["hooks.json"], skills: ["skills"] },
  Antigravity: { entrypoint: "GEMINI.md", hook: ["config", "hooks.json"], skills: ["config", "skills"] }
};

function sourceRoot(): string {
  const bundleDirectory = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(bundleDirectory, "..");
  if (existsSync(join(packageRoot, "adapters", "managed-manifest.json"))) return packageRoot;
  const state = stateRoot();
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
function npmBinDirectory(options: InstallOptions): string | undefined {
  if (process.env.AGENT_WORKFLOW_CLI_DIR) return process.env.AGENT_WORKFLOW_CLI_DIR;
  if (stateRoot(options.root) !== stateRoot()) return undefined;
  const result = spawnSync("npm prefix -g", { encoding: "utf8", shell: true });
  const prefix = result.status === 0 ? String(result.stdout || "").trim() : "";
  if (!prefix) return undefined;
  return process.platform === "win32" ? prefix : join(prefix, "bin");
}
function installCliShims(runtimeBundle: string, options: InstallOptions, records: FileRecord[]): string | undefined {
  const binDirectory = npmBinDirectory(options);
  if (!binDirectory || !existsSync(binDirectory)) return undefined;
  const staged: FileRecord[] = [];
  try {
    copyFile(runtimeBundle, join(binDirectory, "agent-workflow"), staged, "cli-shim", options.dryRun);
    if (process.platform === "win32") {
      const shim = `@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\n"${process.execPath}" "%~dp0agent-workflow" %*\r\nexit /b %ERRORLEVEL%\r\n`;
      if (!options.dryRun) writeAtomic(join(binDirectory, "agent-workflow.cmd"), Buffer.from(shim));
      staged.push({ path: join(binDirectory, "agent-workflow.cmd"), sha256: sha256(Buffer.from(shim)), kind: "cli-shim" });
    }
    return binDirectory;
  } catch {
    return undefined;
  } finally {
    records.push(...staged);
  }
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
  const merged = topLevel ? { ...current, ...replaced } : { ...current, hooks: mergeHookEvents((current.hooks || {}) as JsonObject, (replaced.hooks || {}) as JsonObject) };
  if (!dryRun) writeJson(destination, merged);
}
function filterUnselectedSkillLines(body: string, presentSkills: string[]): string {
  return body.split(/\r?\n/).filter((line) => { const marker = line.match(/<!--\s*skill:([a-z0-9-]+)\s*-->/i); return !marker || presentSkills.includes(marker[1]); }).join("\n");
}
function managedEntrypoint(source: string, canonical: string, destinations: string[], dryRun: boolean, presentSkills: string[]): void {
  const begin = "<!-- agent-workflow v7 managed:start -->", end = "<!-- agent-workflow v7 managed:end -->";
  const strip = (value: string) => value.replace(/\r?\n?<!-- agent-workflow v[4567] managed:start -->[\s\S]*?<!-- agent-workflow v[4567] managed:end -->\r?\n?/g, "").trim();
  const candidates = [canonical, ...destinations].filter(existsSync).map((path) => strip(readFileSync(path, "utf8"))).filter(Boolean);
  if (new Set(candidates).size > 1) throw new Error("conflicting unmanaged entrypoint content found; refusing to overwrite it");
  const content = `${candidates[0] ? `${candidates[0]}\n\n` : ""}${begin}\n${filterUnselectedSkillLines(readFileSync(source, "utf8").trim(), presentSkills)}\n${end}\n`;
  if (!dryRun) for (const path of [canonical, ...destinations]) writeAtomic(path, content);
}
const workflowFrontmatterKeys = ["project_id", "worktree_id", "code_change", "workflow_mode", "task_type", "risk_flags", "impact_scope", "impact_effect", "impact_confidence", "workflow_request", "independence"];
function workflowFieldsFromFrontmatter(fields: Frontmatter): JsonObject {
  const result: JsonObject = {};
  for (const key of workflowFrontmatterKeys) if (fields[key] !== undefined) result[key] = fields[key] as Json;
  if (typeof fields.workflow_facts === "string" && fields.workflow_facts.trim()) { try { result.workflow_facts = JSON.parse(fields.workflow_facts); } catch { } }
  return result;
}
function taskMigration(root: string, backup: string): number {
  let migrated = 0;
  for (const taskMd of filesAt(join(root, "projects")).filter((path) => basename(path) === "task.md")) {
    const directory = dirname(taskMd); const taskJson = join(directory, "task.json");
    if (existsSync(taskJson)) continue;
    const legacy = readFileSync(taskMd, "utf8");
    const fields = parseFrontmatter(legacy);
    const id = typeof fields.id === "string" ? fields.id : basename(directory);
    const status = typeof fields.status === "string" && fields.status ? fields.status : "in_progress";
    writeJson(taskJson, {
      schema_version: 2, id, ...workflowFieldsFromFrontmatter(fields),
      lifecycle: { status, transitions: [{ at: now(), action: "migrate", from: "legacy", to: status, actor: "migration" }], ...(typeof fields.frozen_at === "string" && fields.frozen_at ? { frozen_at: fields.frozen_at } : {}) },
      evidence: [{ kind: "legacy-unverified", verified: false, note: "Imported from Python task.md; requires a new gate verification." }]
    });
    const backupTarget = join(backup, "tasks", relative(join(root, "projects"), taskMd)); mkdirSync(dirname(backupTarget), { recursive: true }); writeAtomic(backupTarget, legacy);
    writeAtomic(taskMd, frontmatterBody(legacy));
    migrated += 1;
  }
  return migrated;
}
function taskSchemaV1toV2Migration(root: string): number {
  let migrated = 0;
  for (const taskJson of filesAt(join(root, "projects")).filter((path) => basename(path) === "task.json")) {
    const state = readJson(taskJson);
    if (state.schema_version !== 1) continue;
    const directory = dirname(taskJson); const taskMd = join(directory, "task.md");
    if (typeof state.intent === "string" && state.intent.trim() && !existsSync(taskMd)) writeAtomic(taskMd, state.intent);
    delete state.intent; delete state.required_evidence; state.schema_version = 2;
    writeJson(taskJson, state);
    migrated += 1;
  }
  return migrated;
}
function taskSchemaV2toV3Migration(root: string): number {
  let migrated = 0;
  for (const taskJson of filesAt(join(root, "projects")).filter((path) => basename(path) === "task.json")) {
    const state = readJson(taskJson);
    if (state.schema_version !== 2) continue;
    const directory = dirname(taskJson); const taskMd = join(directory, "task.md");
    const lifecycle = (state.lifecycle && typeof state.lifecycle === "object" ? state.lifecycle : {}) as JsonObject;
    if (lifecycle.status === "frozen") lifecycle.status = "in_progress";
    const frozenAt = lifecycle.frozen_at;
    state.intent_approval = typeof frozenAt === "string" && frozenAt && existsSync(taskMd)
      ? { intent_sha256: sha256(readFileSync(taskMd)), confirmed_at: frozenAt, confirmed_by_user: "migrated" }
      : null;
    delete lifecycle.frozen_at;
    if (!Array.isArray(lifecycle.transitions) || !lifecycle.transitions.length) lifecycle.transitions = [{ at: now(), action: "migrate", from: "legacy", to: String(lifecycle.status || "in_progress"), actor: "migrate-state" }];
    state.lifecycle = lifecycle;
    state.state_revision = 1; state.plan_revision = 1;
    delete state.compiled;
    for (const retired of ["change_kind", "complexity_hint", "roles_waived", "stop_reason", "frozen_at", "required_evidence", "intent"]) delete state[retired];
    const carried = (Array.isArray(state.evidence) ? state.evidence : []).length + (Array.isArray(state.waivers) ? state.waivers : []).length;
    state.evidence = carried ? [{ kind: "legacy-unverified", verified: false, note: `Imported from schema v2; ${carried} evidence/waiver record(s) predate the v3 contract and need re-verification.` }] : [];
    state.waivers = [];
    for (const [key, fallback] of [["code_change", false], ["risk_flags", []], ["created_at", now()], ["updated_at", now()]] as [string, Json][]) if (state[key] === undefined) state[key] = fallback;
    const hexId = (value: Json | undefined) => typeof value === "string" && /^[a-f0-9]{16}$/.test(value);
    if (!hexId(state.project_id) || !hexId(state.worktree_id)) { const identity = projectIdentity(directory); if (!hexId(state.project_id)) state.project_id = identity.projectId; if (!hexId(state.worktree_id)) state.worktree_id = identity.worktreeId; }
    if (typeof state.id !== "string" || !/^[0-9]{8}-[0-9]{6}-[a-z0-9-]+$/.test(state.id)) state.id = basename(directory);
    state.schema_version = 3;
    writeJson(taskJson, state);
    migrated += 1;
  }
  return migrated;
}
function taskSchemaV3toV4Migration(root: string): number {
  let migrated = 0;
  for (const taskJson of filesAt(join(root, "projects")).filter((path) => basename(path) === "task.json")) {
    const state = readJson(taskJson);
    if (state.schema_version !== 3) continue;
    const carried = (Array.isArray(state.evidence) ? state.evidence : []).length;
    state.evidence = carried ? [{ kind: "legacy-unverified", status: "needs_reverification", note: `Imported from schema v3; ${carried} evidence record(s) predate the v4 hash model and need re-verification via evidence-record/review-record.` }] : [];
    state.waivers = [];
    if (state.intent_approval !== null && state.intent_approval !== undefined) state.intent_approval = null;
    if (state.managed_change === undefined) state.managed_change = true;
    delete state.model_profile;
    state.schema_version = 4;
    writeJson(taskJson, state);
    migrated += 1;
  }
  return migrated;
}
function taskSchemaV4toV5Migration(root: string, backup: string, dryRun = false): number {
  let migrated = 0;
  for (const taskJson of filesAt(join(root, "projects")).filter((path) => basename(path) === "task.json")) {
    const state = readJson(taskJson);
    if (state.schema_version !== 4) continue;
    if (!dryRun) {
      const backupTarget = join(backup, "tasks", relative(join(root, "projects"), taskJson));
      mkdirSync(dirname(backupTarget), { recursive: true });
      writeAtomic(backupTarget, readFileSync(taskJson));
      for (const item of Array.isArray(state.evidence) ? state.evidence : []) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        delete (item as JsonObject).started_at;
        delete (item as JsonObject).duration_ms;
      }
      state.schema_version = 5;
      writeJson(taskJson, state);
    }
    migrated += 1;
  }
  return migrated;
}
export function migrateState(root = stateRoot(), dryRun = false): JsonObject {
  const state = resolve(root); const managedPath = join(state, "managed-runtime.json"); const existing = existsSync(managedPath) ? readJson(managedPath) : {};
  const migrations = (existing.migrations && typeof existing.migrations === "object" ? existing.migrations : {}) as JsonObject;
  const alreadyPythonMigrated = existing.runtime_kind === "node" && migrations.python_to_node;
  const alreadySchemaV2Migrated = migrations.v1_to_v2_task_schema;
  const alreadySchemaV3Migrated = migrations.v2_to_v3_task_schema;
  const alreadySchemaV4Migrated = migrations.v3_to_v4_task_schema;
  const alreadySchemaV5Migrated = migrations.v4_to_v5_task_schema;
  if (alreadyPythonMigrated && alreadySchemaV2Migrated && alreadySchemaV3Migrated && alreadySchemaV4Migrated && alreadySchemaV5Migrated) return { migrated: false, reason: "already-migrated" };
  const stamp = now().replace(/[:.]/g, "-"); const backup = join(state, "migrations", `python-v6-${stamp}`);
  if (!dryRun) { mkdirSync(backup, { recursive: true }); if (existsSync(managedPath)) writeAtomic(join(backup, "managed-runtime.json"), readFileSync(managedPath)); }
  const migratedTasks = dryRun || alreadyPythonMigrated ? 0 : taskMigration(state, backup);
  const migratedSchemaV2 = dryRun || alreadySchemaV2Migrated ? 0 : taskSchemaV1toV2Migration(state);
  const migratedSchemaV3 = dryRun || alreadySchemaV3Migrated ? 0 : taskSchemaV2toV3Migration(state);
  const migratedSchemaV4 = dryRun || alreadySchemaV4Migrated ? 0 : taskSchemaV3toV4Migration(state);
  const migratedSchemaV5 = alreadySchemaV5Migrated ? 0 : taskSchemaV4toV5Migration(state, backup, dryRun);
  return { migrated: true, backup, migrated_tasks: migratedTasks, migrated_schema_v2: migratedSchemaV2, migrated_schema_v3: migratedSchemaV3, migrated_schema_v4: migratedSchemaV4, migrated_schema_v5: migratedSchemaV5, preserved: ["selected_skills", "knowledge", "review-causes", "skill-drafts"] };
}
export async function install(options: InstallOptions): Promise<number> {
  const state = stateRoot(options.root); const runtime = join(state, "runtime"); const source = sourceRoot(); const managedPath = join(state, "managed-runtime.json"); const previous = existsSync(managedPath) ? readJson(managedPath) : {};
  if (options.action === "Verify") return verify(options);
  if (options.action === "Uninstall") return uninstall(options);
  for (const bundle of ["agent-workflow.mjs", "agent-workflow-hook.mjs"]) {
    if (!existsSync(join(source, "dist", bundle))) throw new Error(`distribution bundle ${bundle} is missing; run npm run build before installing from a clone`);
  }
  const migration = migrateState(state, options.dryRun);
  const selected = targetPlatforms(options.target); const selectedSkills = await selectSkills(catalog(source), options, previous); const records: FileRecord[] = [];
  copyFile(join(source, "dist", "agent-workflow.mjs"), join(runtime, "agent-workflow.mjs"), records, "runtime", options.dryRun);
  copyFile(join(source, "dist", "agent-workflow-hook.mjs"), join(runtime, "agent-workflow-hook.mjs"), records, "runtime", options.dryRun);
  for (const folder of ["adapters", "schemas", "templates"]) if (existsSync(join(source, folder))) copyTree(join(source, folder), join(runtime, folder), records, "runtime", options.dryRun);
  pruneRuntime(runtime, records, options.dryRun);
  const cliDirectory = installCliShims(join(source, "dist", "agent-workflow.mjs"), options, records);
  const canonical = join(home(), ".agents");
  for (const skill of selectedSkills) { const sourceSkill = join(source, ".agents", "skills", skill); if (existsSync(sourceSkill)) copyTree(sourceSkill, join(canonical, "skills", skill), records, "canonical-skill", options.dryRun); }
  const targetRoots = roots(options); const destinations = selected.map((platform) => join(targetRoots[platform], platforms[platform].entrypoint));
  const entrySource = existsSync(join(source, "AGENTS.md")) ? join(source, "AGENTS.md") : join(runtime, "AGENTS.md");
  const presentSkills = existsSync(join(canonical, "skills")) ? readdirSync(join(canonical, "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
  if (existsSync(entrySource)) managedEntrypoint(entrySource, join(canonical, "AGENTS.md"), destinations, options.dryRun, presentSkills);
  const node = process.execPath;
  for (const platform of selected) {
    const root = targetRoots[platform]; const skillRoot = join(root, ...platforms[platform].skills);
    for (const skill of selectedSkills) { const sourceSkill = join(canonical, "skills", skill); if (existsSync(sourceSkill)) copyTree(sourceSkill, join(skillRoot, skill), records, "platform-skill", options.dryRun); }
    const fragment = readJson(join(source, "adapters", platform.toLowerCase(), platform === "Claude" ? "settings.hooks.json" : "hooks.json"));
    mergeHook(fragment, join(root, ...platforms[platform].hook), runtime, node, options.dryRun, platform === "Antigravity");
  }
  if (!options.dryRun) writeJson(managedPath, { schema_version: 7, product_version: PRODUCT_VERSION, runtime_kind: "node", node, runtime_hash: sha256(readFileSync(join(runtime, "agent-workflow.mjs"))), installed_at: now(), source, targets: Object.fromEntries(selected.map((name) => [name, targetRoots[name]])), selected_skills: selectedSkills, files: records, migrations: { ...((previous.migrations || {}) as JsonObject), python_to_node: migration, ...(migration.migrated ? { v1_to_v2_task_schema: true, v2_to_v3_task_schema: true, v3_to_v4_task_schema: true, v4_to_v5_task_schema: true } : {}) } });
  output({ ok: true, action: options.action, runtime, cli: cliDirectory || null, selected_skills: selectedSkills, migration }); return 0;
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
