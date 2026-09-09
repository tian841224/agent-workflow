import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const cli = join(process.cwd(), "dist", "agent-workflow.mjs");
const run = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], { cwd: process.cwd(), encoding: "utf8", ...options });

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

test("Lookup applies repository path case rules instead of lowercasing every platform", () => {
  const root = fixture("covers-case", {
    "docs/modules/case.md": "---\ndoc_type: module\ncovers: [src/Foo.ts]\n---\n\n# case\n"
  });
  const result = lookup(root, "src/foo.ts");
  if (process.platform === "win32") {
    assert.deepEqual(result.uncovered, []);
    assert.equal(result.docs[0].matched_by[0], "src/foo.ts");
  } else {
    assert.deepEqual(result.docs, []);
    assert.deepEqual(result.uncovered, ["src/foo.ts"]);
  }
});

// Need-driven doc types grow without bound, so returning the unmatched ones would make every
// Lookup cost scale with the size of docs/ rather than with the paths being changed.
test("Lookup returns matched docs and lazy overview candidates, not the whole docs tree", () => {
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

  const result = lookup(root, "src/hit/thing.ts");
  assert.deepEqual(result.docs.map((doc) => doc.doc_type).sort(), ["module"]);
  assert.deepEqual(result.overview_candidates.map((doc) => doc.doc_type).sort(), ["architecture", "dataflow", "glossary", "structure"]);
  assert.match(result.overview_candidates[0].content_sha256, /^[a-f0-9]{64}$/);
});

test("Remember persists document digests and Lookup marks only unchanged reads reusable", () => {
  const root = fixture("remember-digests", {
    "docs/architecture.md": "---\ndoc_type: architecture\ncovers: []\n---\n\n# architecture\n",
    "task/20260101-000000-digest/task.md": "# Digest\n\n## Goal\n\nRemember a document.\n\n## Scope\n\nOne document.\n\n## Completion criteria\n\n- [ ] digest is recorded\n"
  });
  const task = join(root, "task/20260101-000000-digest");
  const init = run(["task-init", "--task-path", task], { input: JSON.stringify({ code_change: false, managed_change: false }) });
  assert.equal(init.status, 0, init.stdout || init.stderr);
  const remembered = run(["project-doc", "--action", "Remember", "--repo-root", root, "--task-path", task, "--paths", "docs/architecture.md"]);
  assert.equal(remembered.status, 0, remembered.stdout || remembered.stderr);
  const body = JSON.parse(remembered.stdout);
  assert.equal(body.remembered.length, 1);
  const lookup = JSON.parse(run(["project-doc", "--action", "Lookup", "--repo-root", root, "--task-path", task, "--paths", "src/anything.ts"]).stdout);
  assert.equal(lookup.overview_candidates[0].digest_status, "reusable");
  writeFileSync(join(root, "docs/architecture.md"), "---\ndoc_type: architecture\ncovers: []\n---\n\n# changed\n");
  const stale = JSON.parse(run(["project-doc", "--action", "Lookup", "--repo-root", root, "--task-path", task, "--paths", "src/anything.ts"]).stdout);
  assert.equal(stale.overview_candidates[0].digest_status, "stale");
});

test("Check rejects malformed module docs and accepts a complete one", () => {
  const root = fixture("check-structure", {
    "docs/modules/bad.md": "---\ndoc_type: module\ncovers: []\n---\n\n# bad\n",
    "docs/modules/good.md": "---\ndoc_type: module\ncovers:\n  - src/good/\n---\n\n# good\n\n## Responsibility\n\nDoes one thing.\n\n## Entrypoints\n\nCLI.\n\n## Flow\n\nA > B.\n\n## Shared state\n\nnone.\n\n## Invariants and gotchas\n\nnone.\n\n## Unverified\n\nnone.\n"
  });
  const bad = run(["project-doc", "--action", "Check", "--repo-root", root, "--doc", "docs/modules/bad.md"]);
  assert.notEqual(bad.status, 0);
  assert.match(JSON.parse(bad.stdout)[0].issues.join(";"), /require a non-empty covers|missing required section/);
  const good = run(["project-doc", "--action", "Check", "--repo-root", root, "--doc", "docs/modules/good.md"]);
  assert.equal(good.status, 0, good.stdout || good.stderr);
  assert.deepEqual(JSON.parse(good.stdout)[0].issues, []);
});

test("Check rejects a document outside the configured doc-root", () => {
  const root = fixture("check-boundary", { "outside.md": "---\ndoc_type: module\ncovers: [src/]\n---\n\n# outside\n" });
  const result = run(["project-doc", "--action", "Check", "--repo-root", root, "--doc", "outside.md"]);
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout)[0].issues[0], /outside the configured doc-root/);
});

test("Check rejects duplicate singleton overview documents", () => {
  const root = fixture("check-duplicate-overview", {
    "docs/architecture.md": "---\ndoc_type: architecture\ncovers: []\n---\n\n# architecture\n",
    "docs/extra.md": "---\ndoc_type: architecture\ncovers: []\n---\n\n# duplicate\n"
  });
  const result = run(["project-doc", "--action", "Check", "--repo-root", root, "--doc", "docs/architecture.md"]);
  assert.notEqual(result.status, 0);
  assert.match(JSON.parse(result.stdout)[0].issues.join(";"), /duplicate singleton/);
});
