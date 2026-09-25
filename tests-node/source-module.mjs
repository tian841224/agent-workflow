import { buildSync } from "esbuild";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// Some runtime internals have no CLI of their own (the policy compiler's plan reaches agents only
// through task-init/task-write), so their tests bundle the source module directly. import.meta.url
// is pinned inside dist/ so schemaPath() resolves this checkout's schemas/, not an installed copy.
const root = process.cwd();
let sequence = 0;
export async function sourceModule(relativePath) {
  const outfile = join(tmpdir(), `agent-workflow-source-${process.pid}-${sequence++}.mjs`);
  buildSync({
    entryPoints: [join(root, relativePath)],
    bundle: true, platform: "node", format: "esm", outfile, logLevel: "error",
    define: { "import.meta.url": JSON.stringify(pathToFileURL(join(root, "dist", "source-module.mjs")).href) }
  });
  return import(pathToFileURL(outfile).href);
}
