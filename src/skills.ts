import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Json, JsonObject, output, readJson, sha256, writeJson } from "./core.js";

function packageRoot(rootValue?: string): string { return resolve(rootValue || process.cwd()); }

function manifestPath(root: string): string { return join(root, "adapters", "managed-manifest.json"); }
function lockPath(root: string): string { return join(root, "skills-lock.json"); }
function skillDir(root: string, name: string): string { return join(root, ".agents", "skills", name); }

function readLock(root: string): JsonObject {
  const path = lockPath(root);
  return existsSync(path) ? readJson(path) : { version: 1, skills: {} };
}

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...filesUnder(full));
    else result.push(full);
  }
  return result.sort();
}
// A skill is a directory tree; its identity hash covers every file's relative path and content so a
// rename or a single-line edit anywhere under it is detectable, not just changes to SKILL.md.
function treeHash(directory: string): string {
  const parts = filesUnder(directory).map((file) => `${relative(directory, file).replaceAll("\\", "/")}:${sha256(readFileSync(file))}`);
  return sha256(parts.join("\n"));
}
function copyDirectory(source: string, destination: string): void {
  for (const file of filesUnder(source)) {
    const target = join(destination, relative(source, file));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(file));
  }
}

export function skillList(rootValue?: string): number {
  const root = packageRoot(rootValue);
  const manifest = readJson(manifestPath(root));
  const catalog = (manifest.skills || {}) as JsonObject;
  const lock = readLock(root);
  const lockedSkills = (lock.skills || {}) as JsonObject;
  const rows = Object.entries(catalog).map(([name, entry]) => {
    const info = entry as JsonObject;
    const present = existsSync(skillDir(root, name));
    const locked = lockedSkills[name] as JsonObject | undefined;
    return { name, required: info.required === true, description: String(info.description || ""), present, ...(locked ? { source: locked.source, source_type: locked.sourceType } : {}) };
  });
  output({ skills: rows });
  return 0;
}

// Compares a vendored skill's current on-disk hash against the hash skills-lock.json recorded the
// last time it was locked. This proves "has it drifted since it was locked", not "does it still
// match its upstream source" — re-verifying against upstream needs a network fetch, which this
// offline command does not perform.
export function skillVerify(name: string, rootValue?: string): number {
  if (!name) { output({ valid: false, errors: ["skill verify requires --name"] }); return 1; }
  const root = packageRoot(rootValue);
  const lock = readLock(root);
  const locked = (lock.skills as JsonObject | undefined)?.[name] as JsonObject | undefined;
  if (!locked) { output({ valid: true, name, note: "no skills-lock.json entry for this skill; nothing to verify" }); return 0; }
  const directory = skillDir(root, name);
  if (!existsSync(directory)) { output({ valid: false, name, errors: [`skill is locked but not vendored locally: ${directory}`] }); return 1; }
  const current = treeHash(directory);
  const recorded = String(locked.computedHash || "");
  const valid = current === recorded;
  output({ valid, name, current_hash: current, locked_hash: recorded, ...(valid ? {} : { errors: [`${name}: vendored copy does not match the hash recorded in skills-lock.json (edited locally, or the lock is stale)`] }) });
  return valid ? 0 : 1;
}

// Vendors a skill from a local directory (already fetched by the caller through whatever means)
// into .agents/skills/<name>, then records its tree hash in skills-lock.json for future skillVerify
// calls. Does not fetch anything itself — no network access from this command.
export function skillInstall(name: string, from: string, source: string, sourceType: string, skillPathValue: string, rootValue?: string): number {
  if (!name || !from) { output({ valid: false, errors: ["skill install requires --name and --from <local directory>"] }); return 1; }
  if (!existsSync(from) || !statSync(from).isDirectory()) { output({ valid: false, errors: [`--from is not a directory: ${from}`] }); return 1; }
  const root = packageRoot(rootValue);
  const directory = skillDir(root, name);
  rmSync(directory, { recursive: true, force: true });
  copyDirectory(resolve(from), directory);
  const hash = treeHash(directory);
  const lock = readLock(root);
  const skills = (lock.skills || {}) as JsonObject;
  skills[name] = { ...(source ? { source } : {}), ...(sourceType ? { sourceType } : {}), ...(skillPathValue ? { skillPath: skillPathValue } : {}), computedHash: hash };
  lock.skills = skills;
  writeJson(lockPath(root), lock as unknown as Json);
  output({ valid: true, name, installed: directory, computed_hash: hash });
  return 0;
}

export function skillUpdate(name: string, from: string, rootValue?: string): number {
  const root = packageRoot(rootValue);
  const lock = readLock(root);
  const locked = (lock.skills as JsonObject | undefined)?.[name] as JsonObject | undefined;
  if (!locked) { output({ valid: false, errors: [`skill update: '${name}' has no skills-lock.json entry; use skill install first`] }); return 1; }
  return skillInstall(name, from, String(locked.source || ""), String(locked.sourceType || ""), String(locked.skillPath || ""), rootValue);
}

export function skillRemove(name: string, rootValue?: string): number {
  if (!name) { output({ valid: false, errors: ["skill remove requires --name"] }); return 1; }
  const root = packageRoot(rootValue);
  const directory = skillDir(root, name);
  if (!existsSync(directory)) { output({ valid: false, errors: [`skill is not vendored locally: ${directory}`] }); return 1; }
  rmSync(directory, { recursive: true, force: true });
  const lock = readLock(root);
  const skills = (lock.skills || {}) as JsonObject;
  delete skills[name];
  lock.skills = skills;
  writeJson(lockPath(root), lock as unknown as Json);
  output({ valid: true, name, removed: directory });
  return 0;
}

export function skillCommand(action: string, name: string, from: string, source: string, sourceType: string, skillPathValue: string, rootValue?: string): number {
  if (action === "List") return skillList(rootValue);
  if (action === "Verify") return skillVerify(name, rootValue);
  if (action === "Install") return skillInstall(name, from, source, sourceType, skillPathValue, rootValue);
  if (action === "Update") return skillUpdate(name, from, rootValue);
  if (action === "Remove") return skillRemove(name, rootValue);
  output({ valid: false, errors: [`skill: unknown --action ${action}; expected List, Verify, Install, Update or Remove`] });
  return 1;
}
