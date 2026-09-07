import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const cli = join(process.cwd(), "dist", "agent-workflow.mjs");
const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: "utf8" });

function fixture(name, files) {
  const root = join(tmpdir(), `agent-workflow-${name}-${process.pid}-${Date.now()}`);
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(full.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

const lookup = (root, paths) => JSON.parse(run(["project-doc", "--action", "Lookup", "--repo-root", root, "--paths", paths]).stdout);

// A flow-style covers list used to parse as empty, which never errors: the document simply stops
// matching every path and disappears from Lookup with nothing to notice it by.
test("covers is read from both the block and the flow YAML sequence styles", () => {
  const root = fixture("covers-styles", {
    "docs/modules/block.md": "---\ndoc_type: module\ncovers:\n  - src/block/\n  - \"src/quoted.ts\"\n---\n\n# block\n",
    "docs/modules/flow.md": "---\ndoc_type: module\ncovers: [\"src/flow/\", 'src/single.ts']\n---\n\n# flow\n"
  });

  const block = lookup(root, "src/block/thing.ts");
  assert.deepEqual(block.docs.map((doc) => doc.covers), [["src/block/", "src/quoted.ts"]]);
  assert.deepEqual(block.uncovered, []);

  const quoted = lookup(root, "src/quoted.ts");
  assert.deepEqual(quoted.uncovered, [], "a quoted block entry keeps its path once the quotes are stripped");

  const flow = lookup(root, "src/flow/thing.ts");
  assert.deepEqual(flow.docs.map((doc) => doc.covers), [["src/flow/", "src/single.ts"]]);
  assert.deepEqual(flow.uncovered, []);

  assert.deepEqual(lookup(root, "src/single.ts").uncovered, []);
});

test("an empty covers list leaves the document unmatched instead of failing", () => {
  const root = fixture("covers-empty", { "docs/modules/none.md": "---\ndoc_type: module\ncovers: []\n---\n\n# none\n" });
  const result = lookup(root, "src/anything.ts");
  assert.deepEqual(result.docs, []);
  assert.deepEqual(result.uncovered, ["src/anything.ts"]);
});

// Need-driven doc types grow without bound, so returning the unmatched ones would make every
// Lookup cost scale with the size of docs/ rather than with the paths being changed.
test("Lookup returns matched docs plus the four repo-wide overviews, not the whole docs tree", () => {
  const root = fixture("covers-scope", {
    "docs/architecture.md": "---\ndoc_type: architecture\ncovers: []\n---\n\n# arch\n",
    "docs/structure.md": "---\ndoc_type: structure\ncovers: []\n---\n\n# structure\n",
    "docs/dataflow.md": "---\ndoc_type: dataflow\ncovers: []\n---\n\n# dataflow\n",
    "docs/glossary.md": "---\ndoc_type: glossary\ncovers: []\n---\n\n# glossary\n",
    "docs/modules/hit.md": "---\ndoc_type: module\ncovers:\n  - src/hit/\n---\n\n# hit\n",
    "docs/modules/miss.md": "---\ndoc_type: module\ncovers:\n  - src/miss/\n---\n\n# miss\n",
    "docs/api/miss.md": "---\ndoc_type: api\ncovers:\n  - src/api/\n---\n\n# miss\n",
    "docs/decisions/miss.md": "---\ndoc_type: decision\ncovers:\n  - src/decided/\n---\n\n# miss\n"
  });

  const types = lookup(root, "src/hit/thing.ts").docs.map((doc) => doc.doc_type).sort();
  assert.deepEqual(types, ["architecture", "dataflow", "glossary", "module", "structure"]);
});
