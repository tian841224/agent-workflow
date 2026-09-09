import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testDir = join(root, "tests-node");
const VALID_PROFILES = new Set(["focused", "affected", "regression", "full"]);
function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(full);
    return entry.name.endsWith(".test.mjs") ? [full] : [];
  });
}
const rawArgs = process.argv.slice(2);
const requested = [];
let declaredProfile = "";
for (let index = 0; index < rawArgs.length; index += 1) {
  const value = rawArgs[index];
  if (value === "--") continue;
  if (value === "--profile") {
    declaredProfile = rawArgs[++index] || "";
    continue;
  }
  if (value.startsWith("--profile=")) {
    declaredProfile = value.slice("--profile=".length);
    continue;
  }
  requested.push(value);
}
const profile = declaredProfile || (requested.length ? "focused" : "full");
if (!VALID_PROFILES.has(profile)) {
  console.error(`run-tests: unknown validation profile '${profile}'; expected focused, affected, regression, or full`);
  process.exit(1);
}
const allFiles = testFiles(testDir).sort();
function resolveRequested(values) {
  const missing = [];
  const resolved = values.flatMap((value) => {
    const candidate = join(root, value);
    const delta = relative(testDir, candidate);
    const withinTests = delta === "" || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta));
    if (!withinTests) { missing.push(value); return []; }
    if (existsSync(candidate) && statSync(candidate).isFile() && candidate.endsWith(".test.mjs")) return [candidate];
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return testFiles(candidate);
    missing.push(value);
    return [];
  }).filter((value, index, list) => list.indexOf(value) === index).sort();
  if (missing.length) {
    console.error(`run-tests: no requested test files found: ${missing.join(", ")}`);
    process.exit(1);
  }
  return resolved;
}
let files;
if (profile === "full") {
  if (requested.length) {
    console.error("run-tests: the full profile does not accept explicit paths; use focused, affected, or regression");
    process.exit(1);
  }
  files = allFiles;
} else if (profile === "regression") {
  files = requested.length ? resolveRequested(requested) : allFiles;
} else {
  if (!requested.length) {
    console.error(`run-tests: the ${profile} profile requires one or more test paths`);
    process.exit(1);
  }
  files = resolveRequested(requested);
}

if (!files.length) {
  console.error("run-tests: no *.test.mjs files selected under tests-node/");
  process.exit(1);
}

console.error(`run-tests: profile=${profile} files=${files.length}`);
const result = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
