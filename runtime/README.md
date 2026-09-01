# Node runtime contract

Node.js 20 or newer is the only runtime. `dist/agent-workflow.mjs` is a
self-contained ESM bundle copied to the user state root during Install and
Repair.

Managed state records the exact Node executable and bundle SHA-256. Hooks invoke
that executable and copied bundle, with no dependency on Python, `node_modules`,
npx cache, or the source checkout.

Install state, task state, and orchestration state are independent versioned JSON
contracts. Verify checks runtime hashes, source synchronization, selected skills,
managed entrypoints, hooks, and the Codex trust boundary.
