import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const testDir = join(root, "tests-node");
function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(full);
    return entry.name.endsWith(".test.mjs") ? [full] : [];
  });
}
const files = testFiles(testDir).sort();

if (!files.length) {
  console.error("run-tests: no *.test.mjs files found under tests-node/");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
