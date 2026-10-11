import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as outputStream } from "node:process";
import { Frontmatter, Json, JsonObject, PRODUCT_VERSION, frontmatterBody, now, output, parseFrontmatter, projectIdentity, readJson, sha256, stateRoot, writeAtomic, writeJson } from "./core.js";

type Platform = "Claude" | "Codex" | "Antigravity";
type FileRecord = { path: string; sha256: string; kind: string; target?: string };
type InstallOptions = { action: "Install" | "Repair" | "Verify" | "Uninstall"; target: string; root: string; skills?: string; integrations: string[]; nonInteractive: boolean; dryRun: boolean; claude: string; codex: string; antigravity: string; };

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

// An integration marked "clone" is fetched into a throwaway directory and installed with the
// upstream repo's own install command ($checkout is that clone); the clone is removed afterwards,
// so this repo only records where the upstream lives.
function installUpstreamIntegration(name: string, source: string, selected: Platform[], options: InstallOptions): JsonObject {
  const manifest = readJson(join(source, "adapters", "upstream-manifest.json"));
  const integration = (manifest.integrations as JsonObject)?.[name] as JsonObject | undefined;
  if (!integration || typeof integration.source !== "string" || typeof integration.ref !== "string") throw new Error(`upstream manifest has no valid ${name} entry`);
  const commands = integration.platforms as JsonObject;
  const executables = (integration.executables || {}) as JsonObject;
  const results: Json[] = [];
  // A step that names $checkout needs the upstream tree; steps that pass $source leave the fetching to the upstream tool.
  const clone = selected.some((platform) => JSON.stringify(commands[platform] ?? []).includes("$checkout"));
  const workdir = clone ? (options.dryRun ? join(tmpdir(), `agent-workflow-${name}-XXXXXX`) : mkdtempSync(join(tmpdir(), `agent-workflow-${name}-`))) : "";
  const checkout = clone ? join(workdir, name) : "";
  const summary = (): JsonObject => ({ source: integration.source, ref: integration.ref, results });
  try {
    if (clone) {
      const cloneArgs = ["clone", "--depth", "1", "--branch", integration.ref as string, integration.source as string, checkout];
      const command = ["git", ...cloneArgs].join(" ");
      if (options.dryRun) results.push({ command, status: "planned" });
      else {
        const result = spawnSync("git", cloneArgs, { encoding: "utf8" });
        results.push({ command, status: result.status === 0 ? "installed" : "failed", exit_code: result.status ?? 1, output: `${result.stdout || ""}${result.stderr || ""}`.trim() });
        if (result.status !== 0) return summary();
      }
    }
    for (const platform of selected) {
      const executable = typeof executables[platform] === "string" ? executables[platform] as string : platform === "Claude" ? "claude" : platform === "Codex" ? "codex" : "agy";
      const steps = commands[platform] as Json[] | undefined;
      if (!Array.isArray(steps)) continue;
      for (const step of steps) {
        if (!Array.isArray(step) || !step.every((value) => typeof value === "string")) throw new Error(`invalid ${name} command for ${platform}`);
        const args = (step as string[]).map((value) => value.replaceAll("$source", integration.source as string).replaceAll("$ref", integration.ref as string).replaceAll("$checkout", checkout));
        const command = [executable, ...args].join(" ");
        if (options.dryRun) { results.push({ platform, command, status: "planned" }); continue; }
        const cwd = clone ? checkout : undefined;
        // npx is npx.cmd on Windows, which spawnSync cannot start without a shell; the arguments are manifest constants and the clone path.
        const shellCommand = [executable, ...args.map((value) => /\s/.test(value) ? `"${value}"` : value)].join(" ");
        const result = process.platform === "win32" && executable === "npx" ? spawnSync(shellCommand, { encoding: "utf8", shell: true, cwd }) : spawnSync(executable, args, { encoding: "utf8", cwd });
        results.push({ platform, command, status: result.status === 0 ? "installed" : "failed", exit_code: result.status ?? 1, output: `${result.stdout || ""}${result.stderr || ""}`.trim() });
        if (result.status !== 0) return summary();
      }
    }
    return summary();
  } finally {
    if (clone) {
      if (!options.dryRun) rmSync(workdir, { recursive: true, force: true });
      results.push({ command: `remove ${workdir}`, status: options.dryRun ? "planned" : "removed" });
    }
  }
}


function home(): string { return homedir(); }
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
function linkedAncestor(path: string): boolean {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) return true;
    if (dirname(current) === current) return false;
  }
}
function pathKey(path: string): string { return process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path); }
function rootIdentity(path: string): string {
  let parent = resolve(path); const suffix: string[] = [];
  while (!existsSync(parent) && dirname(parent) !== parent) { suffix.unshift(basename(parent)); parent = dirname(parent); }
  return pathKey(join(existsSync(parent) ? realpathSync.native(parent) : parent, ...suffix));
}
function linkMatches(path: string, target: string): boolean {
  return Boolean(lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) && rootIdentity(resolve(dirname(path), readlinkSync(path))) === rootIdentity(target) && existsSync(target);
}
function skillEntries(directory: string): Map<string, string> {
  const entries = new Map<string, string>();
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`nested skill link requires manual migration: ${child}`);
      entries.set(relative(directory, child), entry.isDirectory() ? "directory" : sha256(readFileSync(child)));
      if (entry.isDirectory()) visit(child);
    }
  };
  visit(directory);
  return entries;
}
function skillDigest(directory: string): string { return sha256(JSON.stringify([...skillEntries(directory)])); }
function unchangedSkill(directory: string, previous: JsonObject, kind: string): boolean {
  try {
    const tree = [...skillEntries(directory)];
    const entries = tree.filter(([, digest]) => digest !== "directory");
    const recorded = (Array.isArray(previous.files) ? previous.files : []).filter((item): item is JsonObject =>
      Boolean(item && typeof item === "object" && !Array.isArray(item) && item.kind === kind && typeof item.path === "string" && pathKey(item.path).startsWith(pathKey(directory) + sep)));
    return tree.every(([path, digest]) => digest !== "directory" || entries.some(([file]) => file.startsWith(path + sep))) && entries.length > 0 && entries.length === recorded.length && entries.every(([path, digest]) =>
      recorded.some((item) => pathKey(String(item.path)) === pathKey(join(directory, path)) && item.sha256 === digest));
  } catch { return false; }
}
function linkSkill(target: string, destination: string, backup: string, records: FileRecord[], dryRun: boolean): void {
  if (linkedAncestor(dirname(destination))) throw new Error(`skills root must be an ordinary directory: ${dirname(destination)}`);
  const existing = lstatSync(destination, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink() && !linkMatches(destination, target)) throw new Error(`unexpected skill link: ${destination}; expected ${target}`);
  if (existing && !existing.isSymbolicLink() && !existing.isDirectory()) throw new Error(`skill path is not a directory: ${destination}`);
  if (!dryRun && !existing?.isSymbolicLink()) {
    mkdirSync(dirname(destination), { recursive: true });
    if (existing) { mkdirSync(dirname(backup), { recursive: true }); renameSync(destination, backup); }
    try { symlinkSync(resolve(target), destination, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if (existing) renameSync(backup, destination); throw error; }
  }
  records.push({ path: destination, target: resolve(target), sha256: sha256(resolve(target)), kind: "platform-skill-link" });
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
const MANAGED_ASSET_KINDS = new Set(["canonical-skill", "platform-skill", "platform-skill-link", "canonical-template", "platform-agent", "platform-rule", "platform-entrypoint"]);
type AgentPlatformConfig = { tools?: string; model?: string; effort?: string; sandbox_mode?: string; orchestration_writable?: boolean; model_reasoning_effort?: string; instructions_source?: string };
type NativeAgentDefinition = { id: string; description: string; body: string; config: AgentPlatformConfig };
function managedSourceFile(source: string, value: Json | undefined, label: string): string {
  if (typeof value !== "string" || !value.trim() || isAbsolute(value) || /[\\:]/.test(value) || value.split("/").some((part) => part === ".." || !part)) throw new Error(`invalid ${label}: expected a repository-relative file path`);
  const path = resolve(source, value);
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`${label} is missing: ${path}`);
  const delta = relative(realpathSync(source), realpathSync(path));
  if (isAbsolute(delta) || delta === ".." || delta.startsWith(`..${sep}`)) throw new Error(`invalid ${label}: path leaves the source repository`);
  return path;
}
function codexSourceFile(source: string, value: Json | undefined, label: string): string {
  const path = managedSourceFile(source, value, label);
  const delta = relative(realpathSync(join(source, "adapters", "codex")), realpathSync(path));
  if (isAbsolute(delta) || delta === ".." || delta.startsWith(`..${sep}`)) throw new Error(`invalid ${label}: path leaves the Codex adapter`);
  return path;
}
function nativeAgentDefinitions(source: string, manifest: JsonObject, selected: Platform[], codex?: JsonObject): Record<Platform, NativeAgentDefinition[]> {
  const definitions: Record<Platform, NativeAgentDefinition[]> = { Claude: [], Codex: [], Antigravity: [] };
  for (const platform of selected.filter((value) => value !== "Antigravity")) {
    const agents = (platform === "Codex" ? codex : manifest)?.agents ?? {};
    if (!agents || typeof agents !== "object" || Array.isArray(agents)) throw new Error(`invalid ${platform} agents: expected an object`);
    for (const [name, settings] of Object.entries(agents)) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`invalid agent definition: ${name}`);
      const allowed = settings.platforms;
      if (allowed !== undefined && (!Array.isArray(allowed) || !allowed.length || allowed.some((value) => value !== "Claude" && value !== "Codex"))) throw new Error(`invalid platforms for agent ${name}: expected a non-empty list of Claude or Codex`);
      if (platform === "Codex" && Array.isArray(allowed) && allowed.some((value) => value !== "Codex")) throw new Error(`invalid platforms for agent ${name}: the Codex adapter only supports Codex`);
      if (Array.isArray(allowed) && !allowed.includes(platform)) continue;
      const value = platform === "Codex" ? settings : settings[platform.toLowerCase()] ?? {};
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid ${platform} settings for agent ${name}`);
      const config = value as AgentPlatformConfig;
      if (config.model_reasoning_effort !== undefined && !["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(config.model_reasoning_effort)) throw new Error(`invalid reasoning effort for agent ${name} (${platform})`);
      const sourceFile = platform === "Codex" ? codexSourceFile : managedSourceFile;
      const sourcePath = settings.source === undefined ? managedSourceFile(source, `.agents/agents/${name}.md`, `agent source for ${name}`) : sourceFile(source, settings.source, `agent source for ${name}`);
      const raw = readFileSync(sourcePath, "utf8");
      let body = frontmatterBody(raw).trim();
      if (config.instructions_source !== undefined) body += `\n\n${readFileSync(sourceFile(source, config.instructions_source, `agent instructions source for ${name} (${platform})`), "utf8").trim()}`;
      if (!body.trim()) throw new Error(`agent source for ${name} has no instructions`);
      if (platform === "Codex" && body.includes("'''")) throw new Error(`${sourcePath} contains ''' and cannot be embedded in a TOML literal string`);
      definitions[platform].push({ id: `agent-workflow-${name}`, description: String(parseFrontmatter(raw).description || name), body, config });
    }
  }
  return definitions;
}
// Native platforms discover generated role files; canonical bodies may have platform-specific supplements.
function installAgents(definitions: NativeAgentDefinition[], platform: Platform, platformRoot: string, state: string, records: FileRecord[], dryRun: boolean): void {
  if (platform === "Antigravity") return;
  const directory = join(platformRoot, "agents");
  // Temp files a previous generator left behind would otherwise sit next to the real definitions forever.
  if (!dryRun && existsSync(directory)) for (const name of readdirSync(directory)) if (/^\.agent-workflow-.*\.tmp$/.test(name)) rmSync(join(directory, name), { force: true });
  for (const { id, description, body, config } of definitions) {
    let destination: string; let content: string;
    if (platform === "Claude") {
      destination = join(directory, `${id}.md`);
      content = `---\nname: ${id}\ndescription: ${description}\n${config.tools ? `tools: ${config.tools}\n` : ""}${config.model ? `model: ${config.model}\n` : ""}${config.effort ? `effort: ${config.effort}\n` : ""}---\n\n${body}\n`;
    } else {
      destination = join(directory, `${id}.toml`);
      // Workers write into batch worktrees under the state root, outside the parent's workspace, so
      // that directory has to be an explicit writable root of the sandbox.
      const writable = config.orchestration_writable ? `\n[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(join(state, "orchestration"))}]\n` : "";
      content = `# agent-workflow managed agent\nname = ${JSON.stringify(id)}\ndescription = ${JSON.stringify(description)}\n${config.sandbox_mode ? `sandbox_mode = ${JSON.stringify(config.sandbox_mode)}\n` : ""}${config.model_reasoning_effort ? `model_reasoning_effort = ${JSON.stringify(config.model_reasoning_effort)}\n` : ""}developer_instructions = '''\n${body}\n'''\n${writable}`;
    }
    if (!dryRun) writeAtomic(destination, content);
    records.push({ path: destination, sha256: sha256(content), kind: "platform-agent" });
  }
}
// Path of a platform's delegation rule relative to that platform's root; the entry file imports it by this path.
const PLATFORM_DELEGATION = ["agent-workflow", "delegation.md"];
// Installs a platform's delegation rule into that platform's root, the only location that holds it, so no
// other platform's entrypoint, skill directory or agent definition leads to it.
function installPlatformDelegation(sourcePath: string, platformRoot: string, records: FileRecord[], dryRun: boolean): void {
  const destination = join(platformRoot, ...PLATFORM_DELEGATION);
  const content = readFileSync(sourcePath, "utf8");
  if (!dryRun) writeAtomic(destination, content);
  records.push({ path: destination, sha256: sha256(content), kind: "platform-rule" });
}
// Claude subagents may only touch the project and its additional directories; the batch worktrees
// live under the state root, so that directory is added once and removed again by uninstall.
function ensureClaudeOrchestrationDirectory(settingsPath: string, state: string, dryRun: boolean): string | undefined {
  const directory = join(state, "orchestration");
  const current = existsSync(settingsPath) ? readJson(settingsPath) : {};
  const permissions = current.permissions && typeof current.permissions === "object" && !Array.isArray(current.permissions) ? current.permissions as JsonObject : {};
  const listed = Array.isArray(permissions.additionalDirectories) ? permissions.additionalDirectories.map(String) : [];
  if (listed.some((item) => resolve(item) === resolve(directory))) return directory;
  if (!dryRun) writeJson(settingsPath, { ...current, permissions: { ...permissions, additionalDirectories: [...listed, directory] } });
  return directory;
}
function pruneManagedAssets(previous: JsonObject, records: FileRecord[], canonical: string, selected: Platform[], targetRoots: Record<Platform, string>, rewrittenSkillRoots: string[], dryRun: boolean): void {
  const keep = new Set(records.filter((record) => MANAGED_ASSET_KINDS.has(record.kind)).map((record) => pathKey(record.path)));
  const managedRoots = [canonical, ...selected.map((platform) => targetRoots[platform])].map(pathKey);
  const rewritten = rewrittenSkillRoots.map(pathKey);
  for (const item of Array.isArray(previous.files) ? previous.files : []) {
    if (!item || typeof item !== "object") continue;
    const record = item as JsonObject;
    if (typeof record.kind !== "string" || !MANAGED_ASSET_KINDS.has(record.kind)) continue;
    if (typeof record.path !== "string" || typeof record.sha256 !== "string") continue;
    const path = resolve(record.path);
    const key = pathKey(path);
    if (keep.has(key) || !managedRoots.some((root) => key === root || key.startsWith(root + sep))) continue;
    // A canonical skill rewritten this run has every source file in `records`, so a record outside
    // that list is a file deleted from the source. Other canonical skills keep their recovery copy.
    const skillRoot = record.kind === "canonical-skill" ? rewritten.find((root) => key.startsWith(root + sep)) : undefined;
    if (record.kind === "canonical-skill" && !skillRoot) continue;
    if (record.kind === "platform-skill-link") {
      if (typeof record.target === "string" && safeSkillLink(record, previous) && linkMatches(path, record.target) && !dryRun) unlinkSync(path);
      continue;
    }
    if (record.kind === "platform-entrypoint") {
      // Let removal failures stop installation before target metadata advances, so Repair can retry.
      removeManagedEntryBlock(path, record.sha256, dryRun);
      continue;
    }
    if (linkedAncestor(path) || !existsSync(path)) continue;
    try {
      if (sha256(readFileSync(path)) !== record.sha256 || dryRun) continue;
      rmSync(path);
      // An emptied directory would keep the skill digest different from the source on every install.
      if (skillRoot) for (let directory = dirname(path); pathKey(directory).startsWith(skillRoot + sep) && readdirSync(directory).length === 0; directory = dirname(directory)) rmdirSync(directory);
    } catch { /* preserve files that cannot be checked or removed */ }
  }
}
function catalog(root: string): Record<string, JsonObject> {
  const value = readJson(join(root, "adapters", "managed-manifest.json")).skills;
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("managed manifest has no skills catalog");
  for (const [name, meta] of Object.entries(value as Record<string, JsonObject>)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error(`invalid skill entry: ${name}`);
    if (meta.platforms !== undefined && (!Array.isArray(meta.platforms) || !meta.platforms.length || meta.platforms.some((platform) => typeof platform !== "string" || !Object.hasOwn(platforms, platform)))) {
      throw new Error(`invalid platforms for skill ${name}: expected a non-empty list of Claude, Codex or Antigravity`);
    }
  }
  return value as Record<string, JsonObject>;
}
function safeSkillLink(record: JsonObject, managed: JsonObject): boolean {
  if (typeof record.path !== "string" || typeof record.target !== "string") return false;
  const name = basename(record.path);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || rootIdentity(record.target) !== rootIdentity(join(home(), ".agents", "skills", name)) || linkedAncestor(record.target)) return false;
  const targets = (managed.targets || {}) as JsonObject;
  return (Object.keys(platforms) as Platform[]).some((platform) => typeof targets[platform] === "string" && pathKey(record.path as string) === pathKey(join(resolve(targets[platform] as string), ...platforms[platform].skills, name)) && !linkedAncestor(dirname(record.path as string)));
}
function requiredSkills(value: Record<string, JsonObject>): string[] { return Object.entries(value).filter(([, meta]) => meta.required === true).map(([name]) => name); }
async function selectSkills(value: Record<string, JsonObject>, options: InstallOptions, previous: JsonObject): Promise<string[]> {
  let requested = options.skills;
  const previousSelection = Array.isArray(previous.selected_skills)
    ? previous.selected_skills.filter((x): x is string => typeof x === "string" && Boolean(value[x]))
    : [];
  if (!requested && options.action === "Repair" && Array.isArray(previous.selected_skills)) {
    requested = previousSelection.length ? previousSelection.join(",") : requiredSkills(value).join(",");
  }
  if (!requested && !options.nonInteractive && input.isTTY && outputStream.isTTY) {
    const names = Object.keys(value);
    process.stdout.write("請選擇要安裝的 optional skills（可輸入編號並以逗號分隔，0=全部）：\n");
    names.forEach((name, index) => process.stdout.write(`[${index + 1}] ${name}${value[name].required === true ? "（必裝）" : ""}：${String(value[name].description || "無說明")}\n`));
    const reader = createInterface({ input, output: outputStream });
    const answer = (await reader.question("選擇：")).trim(); reader.close();
    requested = answer === "0" ? "all" : answer.split(",").map((item) => names[Number(item.trim()) - 1]).filter(Boolean).join(",");
  }
  // "all" installs every optional skill. With no request at all, a re-install keeps whatever the
  // previous install selected, because dropping to the required set here would silently uninstall
  // optional skills the user already had. Only a genuinely fresh install falls back to the
  // manifest's required set, instead of pulling in every optional skill's reference tree.
  const fallback = previousSelection.length ? previousSelection : requiredSkills(value);
  const names = requested === "all" ? Object.keys(value) : !requested ? fallback : requested.split(",").map((item) => item.trim()).filter(Boolean);
  const unknown = names.filter((name) => !value[name]);
  if (unknown.length) throw new Error(`unknown skill(s): ${unknown.join(", ")}`);
  return [...new Set([...names, ...requiredSkills(value)])].sort();
}
// A prompt-type hook carries no runtime path to identify it by, so it self-identifies with this
// literal marker instead; both are checked so command hooks and prompt hooks are both recognized as ours.
const OWN_HOOK_MARKER = "[agent-workflow managed:";
function isOwnHook(item: Json, needle: string): boolean {
  const text = JSON.stringify(item).replaceAll("\\\\", "/").toLowerCase();
  return text.indexOf(needle) >= 0 || text.indexOf(OWN_HOOK_MARKER.toLowerCase()) >= 0;
}
function hasEmptyHooks(item: Json): boolean {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const hooks = (item as JsonObject).hooks;
  return Array.isArray(hooks) && hooks.length === 0;
}
function removeOwnHooks(value: Json, marker: string): Json {
  const needle = marker.replaceAll("\\", "/").toLowerCase();
  if (Array.isArray(value)) {
    return value.map((item) => removeOwnHooks(item, marker)).filter((item) => !isOwnHook(item, needle))
      // a hook group left with no hooks (ours just removed, or already stale) does nothing; drop it
      // instead of letting empty {"hooks":[]} groups accumulate across repeated installs.
      .filter((item) => !hasEmptyHooks(item));
  }
  if (!value || typeof value !== "object") return value;
  const record = value as JsonObject;
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(record)) if (!key.startsWith("agent-workflow-")) result[key] = removeOwnHooks(item, marker);
  return result;
}
type LocaleTerm = { avoid: string; use: string; exceptions: string[] };
// Only the <!-- lint:start/end --> block feeds the injected locale context; the rest of vocabulary.md is human reference.
function localeLintTerms(source: string): LocaleTerm[] {
  const path = join(source, ".agents", "skills", "localization-tw", "references", "vocabulary.md");
  if (!existsSync(path)) throw new Error(`locale lint source missing: ${path}`);
  const match = readFileSync(path, "utf8").match(/<!-- lint:start -->([\s\S]*?)<!-- lint:end -->/);
  if (!match) throw new Error("localization-tw vocabulary.md has no <!-- lint:start/end --> block");
  const terms: LocaleTerm[] = [];
  for (const row of match[1].split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("|")).slice(2)) {
    const cells = row.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2) continue;
    const avoids = cells[0].split("/").map((cell) => cell.trim()).filter(Boolean);
    const uses = cells[1].split("/").map((cell) => cell.trim());
    const exceptions = (cells[2] || "").split(/、|,/).map((cell) => cell.trim()).filter(Boolean);
    avoids.forEach((avoid, index) => terms.push({ avoid, use: uses[index] || uses[0], exceptions }));
  }
  // Longer terms must be checked first so a shorter substring (數據 inside 數據庫) doesn't fire twice.
  return terms.sort((a, b) => b.avoid.length - a.avoid.length);
}
// The skill's own core rules travel with the vocabulary, so the per-prompt injection is the skill
// itself rather than a lookup table; locale.md stays their single source.
function localeCoreRules(source: string): string[] {
  const path = join(source, ".agents", "skills", "localization-tw", "locale.md");
  if (!existsSync(path)) throw new Error(`locale rules source missing: ${path}`);
  const section = readFileSync(path, "utf8").match(/^## Core rules\s*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  if (!section) throw new Error("localization-tw locale.md has no '## Core rules' section");
  return section[1].split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim());
}
function writeLocalizationPolicy(source: string, runtime: string, records: FileRecord[], dryRun: boolean): void {
  const content = `${JSON.stringify({ rules: localeCoreRules(source), terms: localeLintTerms(source) }, null, 2)}\n`;
  const destination = join(runtime, "localization-tw-policy.json");
  if (!dryRun) writeAtomic(destination, content);
  records.push({ path: destination, sha256: sha256(content), kind: "runtime" });
}
function mergeHookEvents(current: JsonObject, replaced: JsonObject): JsonObject {
  const merged: JsonObject = { ...current };
  for (const [event, groups] of Object.entries(replaced)) {
    const existingGroups = Array.isArray(current[event]) ? current[event] as Json[] : [];
    merged[event] = [...existingGroups, ...(Array.isArray(groups) ? groups : [])];
  }
  return merged;
}
// The adapter's hook prompt embeds a skill's enforcement rules by reference ({{POLICY:<skill>}})
// so the rules stay single-sourced in the skill file instead of duplicated into the hook JSON.
function policyBlock(source: string, skill: string): string {
  const path = join(source, ".agents", "skills", skill, "SKILL.md");
  if (!existsSync(path)) throw new Error(`policy source missing for {{POLICY:${skill}}}: ${path}`);
  const match = readFileSync(path, "utf8").match(/<!-- enforcement:start -->([\s\S]*?)<!-- enforcement:end -->/);
  if (!match) throw new Error(`${skill}/SKILL.md has no <!-- enforcement:start/end --> block for {{POLICY:${skill}}}`);
  return match[1].trim();
}
let cachedNodeOnPath: boolean | undefined;
function isNodeOnPath(): boolean {
  if (cachedNodeOnPath !== undefined) return cachedNodeOnPath;
  try {
    const probe = spawnSync("node", ["--version"], { encoding: "utf8", windowsHide: true });
    cachedNodeOnPath = probe.status === 0;
  } catch {
    cachedNodeOnPath = false;
  }
  return cachedNodeOnPath;
}

function normalizeHookCommand(command: string, platform: Platform, node: string): string {
  if (platform === "Antigravity") {
    if (isNodeOnPath()) {
      return command.replace(/^"\{\{NODE_EXE\}\}"\s*/, "node ").replace(/^\{\{NODE_EXE\}\}\s*/, "node ");
    }
    const withNode = command.replaceAll("{{NODE_EXE}}", node);
    return process.platform === "win32" ? `"${withNode}"` : withNode;
  }
  return command.replaceAll("{{NODE_EXE}}", node);
}

function normalizeHookCommands(value: Json, platform: Platform, node: string): Json {
  if (Array.isArray(value)) return value.map((item) => normalizeHookCommands(item, platform, node));
  if (!value || typeof value !== "object") return value;
  const record = value as JsonObject;
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === "command" && typeof item === "string") {
      result[key] = normalizeHookCommand(item, platform, node);
    } else {
      result[key] = normalizeHookCommands(item, platform, node);
    }
  }
  return result;
}

function mergeHook(fragment: JsonObject, destination: string, runtime: string, state: string, node: string, dryRun: boolean, platform: Platform, source: string): void {
  let templated = JSON.stringify(fragment)
    .replaceAll("{{RUNTIME_DIR}}", runtime.replaceAll("\\", "\\\\"))
    .replaceAll("{{STATE_ROOT}}", state.replaceAll("\\", "\\\\"));
  // JSON.stringify on the extracted block yields a quoted, escaped string; stripping its outer
  // quotes gives exactly the escaped form the surrounding JSON string literal needs.
  templated = templated.replace(/\{\{POLICY:([a-z0-9-]+)\}\}/g, (_match, skill: string) => JSON.stringify(policyBlock(source, skill)).slice(1, -1));
  const replaced = JSON.parse(templated) as JsonObject;
  const normalizedReplaced = normalizeHookCommands(replaced, platform, node) as JsonObject;
  let current: JsonObject = {};
  if (existsSync(destination)) current = readJson(destination);
  current = removeOwnHooks(current, runtime) as JsonObject;
  const topLevel = platform === "Antigravity";
  const merged = topLevel ? { ...current, ...normalizedReplaced } : { ...current, hooks: mergeHookEvents((current.hooks || {}) as JsonObject, (normalizedReplaced.hooks || {}) as JsonObject) };
  if (!dryRun) writeJson(destination, merged);
}
// Turns the repository's AGENTS.md into the entrypoint installed for every project: lines that only
// apply inside this repository or name a skill that is not installed are dropped, and links into
// .agents/ point at the canonical home copy, the one place they resolve from another project.
function installedEntryBody(body: string, presentSkills: string[]): string {
  return body.split(/\r?\n/).filter((line) => {
    if (/<!--\s*repo-only\s*-->/i.test(line)) return false;
    const marker = line.match(/<!--\s*skill:([a-z0-9-]+)\s*-->/i); return !marker || presentSkills.includes(marker[1]);
  }).join("\n").replaceAll("](.agents/", "](~/.agents/");
}
function managedEntryBlock(value: string): string | undefined {
  return value.match(/<!-- agent-workflow v[4567] managed:start -->[\s\S]*?<!-- agent-workflow v[4567] managed:end -->/)?.[0];
}
function removeManagedEntryBlock(path: string, digest: string, dryRun: boolean): boolean {
  if (linkedAncestor(path) || !existsSync(path)) return false;
  const raw = readFileSync(path, "utf8"); const block = managedEntryBlock(raw);
  if (!block || sha256(block) !== digest) return false;
  if (!dryRun) writeAtomic(path, raw.replace(block, "").trim());
  return true;
}
// `imports` maps a destination to the import lines that replace the copied body in its managed block,
// for a platform whose entrypoint can include the canonical file instead of carrying a copy.
function managedEntrypoint(source: string, canonical: string, destinations: { path: string; instructions?: string }[], records: FileRecord[], dryRun: boolean, presentSkills: string[], imports: Map<string, string[]> = new Map()): void {
  const begin = "<!-- agent-workflow v7 managed:start -->", end = "<!-- agent-workflow v7 managed:end -->";
  const strip = (value: string) => value.replace(/\r?\n?<!-- agent-workflow v[4567] managed:start -->[\s\S]*?<!-- agent-workflow v[4567] managed:end -->\r?\n?/g, "").trim();
  const body = installedEntryBody(readFileSync(source, "utf8").trim(), presentSkills);
  for (const { path, instructions } of [{ path: canonical, instructions: undefined }, ...destinations]) {
    const managed = imports.get(path)?.join("\n") ?? body;
    const block = `${begin}\n${managed}${instructions ? `\n\n${instructions}` : ""}\n${end}`;
    // Each file preserves its own unmanaged content, so platform-specific rules stay at their source.
    if (!dryRun) {
      const own = existsSync(path) ? strip(readFileSync(path, "utf8")) : "";
      writeAtomic(path, `${own ? `${own}\n\n` : ""}${block}\n`);
    }
    if (instructions !== undefined) records.push({ path, sha256: sha256(block), kind: "platform-entrypoint" });
  }
}
const workflowFrontmatterKeys = ["project_id", "worktree_id", "code_change", "workflow_mode", "task_type", "risk_flags", "impact_scope", "impact_effect", "impact_confidence", "workflow_request", "independence"];
function workflowFieldsFromFrontmatter(fields: Frontmatter): JsonObject {
  const result: JsonObject = {};
  for (const key of workflowFrontmatterKeys) if (fields[key] !== undefined) result[key] = fields[key] as Json;
  if (typeof fields.workflow_facts === "string" && fields.workflow_facts.trim()) {
    try { result.workflow_facts = JSON.parse(fields.workflow_facts); } catch { return result; }
  }
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
    state.evidence = carried ? [{ kind: "legacy-unverified", status: "needs_reverification", note: `Imported from schema v3; ${carried} evidence record(s) predate the v4 hash model and need re-verification via evidence-run/review-record.` }] : [];
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
// workflow_mode, model_profile and validation_profile were legacy-compatibility or inert fields
// with no active plan_hash/gate consumer; dropping them here rather than carrying them forever
// keeps the active contract free of fields nothing reads.
function taskSchemaV5toV6Migration(root: string, backup: string, dryRun = false): number {
  let migrated = 0;
  for (const taskJson of filesAt(join(root, "projects")).filter((path) => basename(path) === "task.json")) {
    const state = readJson(taskJson);
    if (state.schema_version !== 5) continue;
    if (!dryRun) {
      // A distinct subdirectory from the v4->v5 backup: a task migrated in the same call already
      // has a "tasks" backup entry there, and writing this step's backup to that same relative path
      // would silently overwrite the pre-v5 snapshot (losing the fields v4->v5 stripped) instead of
      // adding a second one.
      const backupTarget = join(backup, "tasks-v6", relative(join(root, "projects"), taskJson));
      mkdirSync(dirname(backupTarget), { recursive: true });
      writeAtomic(backupTarget, readFileSync(taskJson));
      delete state.workflow_mode; delete state.model_profile; delete state.validation_profile;
      state.schema_version = 6;
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
  const alreadySchemaV6Migrated = migrations.v5_to_v6_task_schema;
  if (alreadyPythonMigrated && alreadySchemaV2Migrated && alreadySchemaV3Migrated && alreadySchemaV4Migrated && alreadySchemaV5Migrated && alreadySchemaV6Migrated) return { migrated: false, reason: "already-migrated" };
  const stamp = now().replace(/[:.]/g, "-"); const backup = join(state, "migrations", `python-v6-${stamp}`);
  if (!dryRun) { mkdirSync(backup, { recursive: true }); if (existsSync(managedPath)) writeAtomic(join(backup, "managed-runtime.json"), readFileSync(managedPath)); }
  const migratedTasks = dryRun || alreadyPythonMigrated ? 0 : taskMigration(state, backup);
  const migratedSchemaV2 = dryRun || alreadySchemaV2Migrated ? 0 : taskSchemaV1toV2Migration(state);
  const migratedSchemaV3 = dryRun || alreadySchemaV3Migrated ? 0 : taskSchemaV2toV3Migration(state);
  const migratedSchemaV4 = dryRun || alreadySchemaV4Migrated ? 0 : taskSchemaV3toV4Migration(state);
  const migratedSchemaV5 = alreadySchemaV5Migrated ? 0 : taskSchemaV4toV5Migration(state, backup, dryRun);
  const migratedSchemaV6 = alreadySchemaV6Migrated ? 0 : taskSchemaV5toV6Migration(state, backup, dryRun);
  return { migrated: true, backup, migrated_tasks: migratedTasks, migrated_schema_v2: migratedSchemaV2, migrated_schema_v3: migratedSchemaV3, migrated_schema_v4: migratedSchemaV4, migrated_schema_v5: migratedSchemaV5, migrated_schema_v6: migratedSchemaV6, preserved: ["selected_skills", "knowledge", "review-causes", "skill-drafts"] };
}
export async function install(options: InstallOptions): Promise<number> {
  const state = stateRoot(options.root); const runtime = join(state, "runtime"); const source = sourceRoot(); const managedPath = join(state, "managed-runtime.json"); const previous = existsSync(managedPath) ? readJson(managedPath) : {};
  if (options.action === "Verify") return verify(options);
  if (options.action === "Uninstall") return uninstall(options);
  for (const bundle of ["agent-workflow.mjs", "agent-workflow-hook.mjs"]) {
    if (!existsSync(join(source, "dist", bundle))) throw new Error(`distribution bundle ${bundle} is missing; run npm run build before installing from a clone`);
  }
  if (options.integrations.length) {
    const known = (readJson(join(source, "adapters", "upstream-manifest.json")).integrations || {}) as JsonObject;
    const unknown = options.integrations.filter((name) => !known[name]);
    // Fail before anything is written, so a typo does not leave a half-finished install.
    if (unknown.length) throw new Error(`unknown integration: ${unknown.join(", ")} (known: ${Object.keys(known).join(", ")})`);
  }
  const skillCatalog = catalog(source);
  const manifest = readJson(join(source, "adapters", "managed-manifest.json"));
  const retiredSkills = manifest.retired_skills || [];
  if (!Array.isArray(retiredSkills) || retiredSkills.some((name) => typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || skillCatalog[name])) throw new Error("invalid retired_skills: expected non-catalog skill names");
  const selected = targetPlatforms(options.target); const selectedSkills = await selectSkills(skillCatalog, options, previous); const records: FileRecord[] = [];
  const codex = selected.includes("Codex") ? readJson(codexSourceFile(source, "adapters/codex/managed-config.json", "Codex configuration source")) : undefined;
  const agents = nativeAgentDefinitions(source, manifest, selected, codex);
  let codexInstructions: string | undefined;
  if (codex) {
    codexInstructions = readFileSync(codexSourceFile(source, codex.coordinator_source, "Codex coordinator source"), "utf8").trim();
    if (!codexInstructions) throw new Error("Codex coordinator source has no instructions");
  }
  const canonical = join(home(), ".agents"); const sharedSkills = join(canonical, "skills"); const targetRoots = roots(options);
  const skillBackup = join(state, "migrations", `skills-${now().replace(/[:.]/g, "-")}-${process.pid}`);
  const imports = new Map<string, string[]>();
  const materializedSkills = new Set(selectedSkills);
  const exposures: { platform: Platform; name: string; destination: string }[] = [];
  const retirements: { platform: Platform; name: string; path: string; status: string }[] = [];
  const retirementActions: (() => void)[] = [];
  const platformSkillRoots = selected.map((platform) => rootIdentity(join(targetRoots[platform], ...platforms[platform].skills))); const sharedIdentity = rootIdentity(sharedSkills);
  if (new Set(platformSkillRoots).size !== platformSkillRoots.length || platformSkillRoots.some((root) => root === sharedIdentity || root.startsWith(sharedIdentity + sep) || sharedIdentity.startsWith(root + sep))) throw new Error("platform skills roots must be distinct and outside the shared skills directory");
  if (linkedAncestor(sharedSkills)) throw new Error(`shared skills root must be an ordinary directory: ${sharedSkills}`);
  // Preflight every exposure before writing: unknown skills have no authoritative version to pick.
  for (const platform of selected) {
    const skillRoot = join(targetRoots[platform], ...platforms[platform].skills);
    if (linkedAncestor(skillRoot)) throw new Error(`skills root must be an ordinary directory: ${skillRoot}`);
    for (const name of retiredSkills as string[]) {
      const destination = join(skillRoot, name); const shared = join(sharedSkills, name);
      const existing = lstatSync(destination, { throwIfNoEntry: false });
      if (!existing) continue;
      const oldRecords = (Array.isArray(previous.files) ? previous.files : []).filter((item): item is FileRecord => Boolean(item && typeof item === "object" && !Array.isArray(item) && typeof item.path === "string" && (pathKey(item.path) === pathKey(destination) || pathKey(item.path).startsWith(pathKey(destination) + sep))));
      const link = oldRecords.find((item) => item.kind === "platform-skill-link" && pathKey(item.path) === pathKey(destination));
      const safeLink = Boolean(link && safeSkillLink(link, previous) && link.target === resolve(shared) && link.sha256 === sha256(resolve(shared)) && linkMatches(destination, shared) && unchangedSkill(shared, previous, "canonical-skill"));
      const safeCopy = Boolean(!existing.isSymbolicLink() && existing.isDirectory() && unchangedSkill(destination, previous, "platform-skill"));
      const safe = safeLink || safeCopy;
      retirements.push({ platform, name, path: destination, status: safe ? (options.dryRun ? "planned" : "retired") : "preserved" });
      if (safe) retirementActions.push(() => {
        if (safeLink) unlinkSync(destination);
        else { const backup = join(skillBackup, platform, name); mkdirSync(dirname(backup), { recursive: true }); renameSync(destination, backup); }
      });
      // Prevent generic pruning from deleting a preserved, user-modified retirement candidate.
      if (!safe) records.push(...oldRecords);
    }
    const names = new Set(selectedSkills.filter((skill) => !Array.isArray(skillCatalog[skill].platforms) || (skillCatalog[skill].platforms as Json[]).includes(platform)));
    if (existsSync(skillRoot)) for (const name of readdirSync(skillRoot)) {
      const allowed = skillCatalog[name]?.platforms;
      if (!retiredSkills.includes(name) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && (!Array.isArray(allowed) || allowed.includes(platform)) && existsSync(join(skillRoot, name, "SKILL.md"))) names.add(name);
    }
    for (const name of names) {
      if (skillCatalog[name]) materializedSkills.add(name);
      const destination = join(skillRoot, name); const shared = join(sharedSkills, name); const existing = lstatSync(destination, { throwIfNoEntry: false });
      if (linkedAncestor(shared)) throw new Error(`shared skill must be an ordinary directory: ${shared}`);
      if (existing?.isSymbolicLink()) {
        if (!linkMatches(destination, shared)) throw new Error(`unexpected skill link: ${destination}; expected ${shared}`);
      } else if (existing) {
        if (!existing.isDirectory()) throw new Error(`skill path is not a directory: ${destination}`);
        const entries = skillEntries(destination);
        if (!skillCatalog[name]) {
          const originals = imports.get(name) || [];
          for (const authority of [...(existsSync(shared) ? [shared] : []), ...originals]) {
            const authoritativeEntries = skillEntries(authority);
            if ([...entries].some(([path, digest]) => authoritativeEntries.has(path) && authoritativeEntries.get(path) !== digest)) throw new Error(`conflicting shared skill ${name}: ${destination} differs from ${authority}; originals preserved`);
          }
          imports.set(name, [...originals, destination]);
        }
      }
      exposures.push({ platform, name, destination });
    }
  }
  for (const skill of materializedSkills) {
    const sourceSkill = join(source, ".agents", "skills", skill); const shared = join(sharedSkills, skill);
    if (!existsSync(join(sourceSkill, "SKILL.md"))) throw new Error(`skill source is missing: ${sourceSkill}`);
    skillDigest(sourceSkill);
    if (linkedAncestor(shared)) throw new Error(`shared skill must be an ordinary directory: ${shared}`);
    if (existsSync(shared)) skillDigest(shared);
  }
  const migration = migrateState(state, options.dryRun);
  if (!options.dryRun) for (const retire of retirementActions) retire();
  copyFile(join(source, "dist", "agent-workflow.mjs"), join(runtime, "agent-workflow.mjs"), records, "runtime", options.dryRun);
  copyFile(join(source, "dist", "agent-workflow-hook.mjs"), join(runtime, "agent-workflow-hook.mjs"), records, "runtime", options.dryRun);
  // Platform instruction Markdown and the Codex adapter stay out of the shared runtime.
  for (const folder of ["adapters", "schemas"]) {
    for (const file of existsSync(join(source, folder)) ? filesAt(join(source, folder)) : []) {
      const inside = relative(join(source, folder), file);
      if (folder === "adapters" && inside.split(/[\\/]/)[0] === "codex") continue;
      if (folder === "adapters" && /\.md$/i.test(inside) && /[\\/]/.test(inside)) continue;
      copyFile(file, join(runtime, folder, inside), records, "runtime", options.dryRun);
    }
  }
  pruneRuntime(runtime, records, options.dryRun);
  if (selectedSkills.includes("localization-tw")) writeLocalizationPolicy(source, runtime, records, options.dryRun);
  const cliDirectory = installCliShims(join(source, "dist", "agent-workflow.mjs"), options, records);
  // Templates are agent-facing reference documents, not runtime inputs, so they belong beside the
  // canonical skills every agent reads rather than in the runtime tree next to the bundle.
  if (existsSync(join(source, "templates"))) copyTree(join(source, "templates"), join(canonical, "templates"), records, "canonical-template", options.dryRun);
  if (!options.dryRun) for (const [name, originals] of imports) for (const original of originals) cpSync(original, join(sharedSkills, name), { recursive: true, force: false });
  for (const skill of materializedSkills) {
    const sourceSkill = join(source, ".agents", "skills", skill); const shared = join(sharedSkills, skill);
    if (!options.dryRun && existsSync(shared) && skillDigest(sourceSkill) !== skillDigest(shared)) cpSync(shared, join(skillBackup, "canonical", skill), { recursive: true, errorOnExist: true, force: false });
    copyTree(sourceSkill, shared, records, "canonical-skill", options.dryRun);
  }
  for (const exposure of exposures) linkSkill(join(sharedSkills, exposure.name), exposure.destination, join(skillBackup, exposure.platform, exposure.name), records, options.dryRun);
  const destinations = selected.map((platform) => ({ path: join(targetRoots[platform], platforms[platform].entrypoint), instructions: platform === "Codex" ? codexInstructions : undefined }));
  const entrySource = existsSync(join(source, "AGENTS.md")) ? join(source, "AGENTS.md") : join(runtime, "AGENTS.md");
  const presentSkills = existsSync(join(canonical, "skills")) ? readdirSync(join(canonical, "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) : [];
  // Claude and Antigravity reference the canonical rules and their own delegation rule; Codex supplements
  // the generated shared body within its managed block.
  const delegationSources = new Map<Platform, string>();
  const entryImports = new Map<string, string[]>();
  for (const platform of ["Claude", "Antigravity"] as const) {
    if (!selected.includes(platform)) continue;
    const rule = join(source, "adapters", platform.toLowerCase(), "delegation.md");
    if (existsSync(rule)) delegationSources.set(platform, rule);
    const entry = join(targetRoots[platform], platforms[platform].entrypoint);
    // Claude expands the home directory; Antigravity resolves a reference against the rule file's own directory.
    const shared = platform === "Claude" ? "@~/.agents/AGENTS.md" : `@${relative(dirname(entry), join(canonical, "AGENTS.md")).replaceAll("\\", "/")}`;
    entryImports.set(entry, [shared, ...(delegationSources.has(platform) ? [`@${PLATFORM_DELEGATION.join("/")}`] : [])]);
  }
  if (existsSync(entrySource)) managedEntrypoint(entrySource, join(canonical, "AGENTS.md"), destinations, records, options.dryRun, presentSkills, entryImports);
  // Written after the entrypoints, so a failed entrypoint write leaves the installed rule matching its record.
  for (const [platform, rule] of delegationSources) installPlatformDelegation(rule, targetRoots[platform], records, options.dryRun);
  const node = process.execPath;
  for (const platform of selected) {
    const root = targetRoots[platform];
    const fragment = readJson(join(source, "adapters", platform.toLowerCase(), platform === "Claude" ? "settings.hooks.json" : "hooks.json"));
    mergeHook(fragment, join(root, ...platforms[platform].hook), runtime, state, node, options.dryRun, platform, source);
    installAgents(agents[platform], platform, root, state, records, options.dryRun);
    if (platform === "Claude") ensureClaudeOrchestrationDirectory(join(root, ...platforms[platform].hook), state, options.dryRun);
  }
  const previousTargets = previous.targets && typeof previous.targets === "object" && !Array.isArray(previous.targets) ? previous.targets as JsonObject : {};
  const previousRoots = { ...targetRoots, ...Object.fromEntries(Object.entries(previousTargets).filter(([, value]) => typeof value === "string").map(([name, value]) => [name, resolve(value as string)])) };
  const rewrittenSkillRoots = [...materializedSkills].map((skill) => join(sharedSkills, skill));
  pruneManagedAssets(previous, records, canonical, selected, previousRoots, rewrittenSkillRoots, options.dryRun);
  // A single-platform repair must keep the other platforms visible to Verify and Uninstall.
  for (const item of Array.isArray(previous.files) ? previous.files : []) {
    if (!item || typeof item !== "object") continue;
    const record = item as FileRecord;
    if (typeof record.path !== "string" || records.some((current) => pathKey(current.path) === pathKey(record.path))) continue;
    // `records` already holds the full file list of every canonical skill rewritten this run. A
    // source-deleted file still on disk with its recorded hash could not be removed; keeping its
    // record lets the next run retry.
    if (record.kind === "canonical-skill" && rewrittenSkillRoots.some((root) => pathKey(record.path).startsWith(pathKey(root) + sep))) {
      let removalPending = false;
      try { removalPending = existsSync(record.path) && sha256(readFileSync(record.path)) === record.sha256; } catch { /* an unreadable file is not retried */ }
      if (!removalPending) continue;
    }
    const inSelectedPlatform = selected.some((platform) => pathKey(record.path).startsWith(pathKey(previousRoots[platform]) + sep) || pathKey(record.path).startsWith(pathKey(targetRoots[platform]) + sep));
    if (!inSelectedPlatform && record.kind !== "runtime" && record.kind !== "cli-shim" && record.kind !== "canonical-template") records.push(record);
  }
  if (!options.dryRun) writeJson(managedPath, { schema_version: 7, product_version: PRODUCT_VERSION, runtime_kind: "node", node, runtime_hash: sha256(readFileSync(join(runtime, "agent-workflow.mjs"))), installed_at: now(), source, targets: { ...previousTargets, ...Object.fromEntries(selected.map((name) => [name, targetRoots[name]])) }, selected_skills: selectedSkills, files: records, migrations: { ...((previous.migrations || {}) as JsonObject), python_to_node: migration, ...(migration.migrated ? { v1_to_v2_task_schema: true, v2_to_v3_task_schema: true, v3_to_v4_task_schema: true, v4_to_v5_task_schema: true, v5_to_v6_task_schema: true } : {}) } });
  const integrations = options.integrations;
  const native = integrations.length ? integrations.map((name) => installUpstreamIntegration(name, source, selected, options)) : null;
  const failed = native?.some((item) => (item.results as Json[]).some((result) => (result as JsonObject).status === "failed")) || false;
  output({ ok: !failed, action: options.action, runtime, cli: cliDirectory || null, selected_skills: selectedSkills, retired_skills: retirements, native, migration, skill_backup: !options.dryRun && existsSync(skillBackup) ? skillBackup : null }); return failed ? 1 : 0;
}
export function verify(options: InstallOptions): number {
  const state = stateRoot(options.root); const runtime = join(state, "runtime"); const managedPath = join(state, "managed-runtime.json"); const errors: string[] = [];
  if (!existsSync(managedPath)) errors.push("managed state is missing"); else {
    const managed = readJson(managedPath);
    if (managed.runtime_kind !== "node") errors.push("managed runtime is not Node");
    const bundle = join(runtime, "agent-workflow.mjs");
    if (!existsSync(bundle)) errors.push("runtime bundle is missing"); else if (managed.runtime_hash !== sha256(readFileSync(bundle))) errors.push("runtime bundle hash mismatch");
    const source = typeof managed.source === "string" ? managed.source : "";
    if (!source || !existsSync(join(source, "dist", "agent-workflow.mjs"))) errors.push("recorded source bundle is missing");
    else if (existsSync(bundle) && sha256(readFileSync(join(source, "dist", "agent-workflow.mjs"))) !== sha256(readFileSync(bundle))) errors.push("source and installed runtime bundle differ");
    for (const item of Array.isArray(managed.files) ? managed.files : []) {
      if (!item || typeof item !== "object") continue;
      const record = item as JsonObject;
      if (typeof record.path !== "string" || typeof record.sha256 !== "string") { errors.push("managed state contains an invalid file record"); continue; }
      try {
        if (record.kind === "platform-skill-link") {
          if (!safeSkillLink(record, managed) || typeof record.target !== "string" || record.sha256 !== sha256(resolve(record.target)) || !linkMatches(record.path, record.target)) errors.push(`managed skill link mismatch: ${record.path}`);
        } else if (record.kind === "platform-entrypoint") {
          if (!existsSync(record.path) || sha256(managedEntryBlock(readFileSync(record.path, "utf8")) || "") !== record.sha256) errors.push(`managed entrypoint block mismatch: ${record.path}`);
        } else if (!existsSync(record.path)) errors.push(`managed file is missing: ${record.path}`);
        else if (sha256(readFileSync(record.path)) !== record.sha256) errors.push(`managed file hash mismatch: ${record.path}`);
      } catch { errors.push(`managed path cannot be verified: ${record.path}`); }
    }
  }
  output({ valid: errors.length === 0, runtime_root: runtime, node: process.execPath, errors }); return errors.length ? 1 : 0;
}
export function uninstall(options: InstallOptions): number {
  const state = stateRoot(options.root); const managedPath = join(state, "managed-runtime.json"); if (!existsSync(managedPath)) { output({ ok: true, removed: 0 }); return 0; }
  const managed = readJson(managedPath); let removed = 0;
  for (const item of Array.isArray(managed.files) ? managed.files : []) {
    if (!item || typeof item !== "object") continue;
    const record = item as JsonObject;
    // Uninstall leaves the entrypoints in place, so the rule CLAUDE.md imports stays with them.
    if (typeof record.path !== "string" || typeof record.sha256 !== "string" || record.kind === "canonical-skill" || record.kind === "platform-rule") continue;
    if (record.kind === "platform-skill-link") {
      if (safeSkillLink(record, managed) && typeof record.target === "string" && linkMatches(record.path, record.target)) { if (!options.dryRun) unlinkSync(record.path); removed += 1; }
      continue;
    }
    if (linkedAncestor(record.path)) continue;
    if (record.kind === "platform-entrypoint") {
      if (removeManagedEntryBlock(record.path, record.sha256, options.dryRun)) removed += 1;
      continue;
    }
    if (existsSync(record.path) && sha256(readFileSync(record.path)) === record.sha256) { if (!options.dryRun) rmSync(record.path); removed += 1; }
  }
  const claudeRoot = managed.targets && typeof managed.targets === "object" && !Array.isArray(managed.targets) ? (managed.targets as JsonObject).Claude : undefined;
  const claudeSettings = typeof claudeRoot === "string" ? join(claudeRoot, ...platforms.Claude.hook) : "";
  if (!options.dryRun && claudeSettings && existsSync(claudeSettings)) {
    const settings = readJson(claudeSettings); const permissions = settings.permissions as JsonObject | undefined;
    if (permissions && Array.isArray(permissions.additionalDirectories)) {
      const orchestration = resolve(join(state, "orchestration"));
      permissions.additionalDirectories = permissions.additionalDirectories.filter((item) => resolve(String(item)) !== orchestration);
      writeJson(claudeSettings, settings);
    }
  }
  if (!options.dryRun && existsSync(join(state, "runtime"))) rmSync(join(state, "runtime"), { recursive: true, force: true });
  output({ ok: true, removed, preserved: ["projects", "knowledge", "skills", "migrations"] }); return 0;
}
