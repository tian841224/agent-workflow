# Automatic parallel orchestration

At the start of a code task, the main conversation first completes the split decision per the workflow skill. When conditions are met, it dispatches workers through one of the two paths below; when not met, sequential development is retained. The runtime does not judge task semantics on its own — it only validates an explicit `parallelization` spec, creates or registers isolated worktrees, and collects and integrates patches.

Two dispatch paths exist, chosen per platform:

- **In-process native dispatch** (Claude Code today): the main conversation launches workers itself with the host's own sub-agent tool, bound to per-worker git worktrees, then hands the finished worktrees to the runtime with `orchestrate --action RegisterNative` for Collect/Integrate/Apply/Cleanup. See [Native dispatch (Claude Code)](#native-dispatch-claude-code) below.
- **Cross-process dispatch** (Codex, Antigravity): the runtime creates the worktrees itself and launches each worker in a separate process via `orchestrate --action Start` (`Assess -> Init`), using `AGENT_WORKFLOW_<PLATFORM>_DISPATCH_COMMAND`; that command must be able to accept JSON stdin, immediately launch a background worker, and return the acknowledgement defined in this document. The runtime calls all worker dispatchers in parallel within the same `Init`.

Prefer native dispatch whenever the host provides in-process sub-agent isolation — it needs no external dispatcher command and no cross-process handshake. Fall back to cross-process dispatch when the host has no such mechanism, or when native dispatch's base-ref limitation (below) doesn't fit.

## Split spec

At least two workers, each requiring `id`, `title`, `goal`, `completion_criteria`, and non-overlapping `file_ownership`. No sequential dependencies, no shared persistent state, and ownership must not include shared integration points such as schema, contract, route, registry, barrel, lockfile, or i18n.

When conditions aren't met, the main conversation handles it sequentially directly and records the reason.

## Dirty worktree snapshot

`Init` uses a temporary `GIT_INDEX_FILE` to turn the current tracked, staged, unstaged, and untracked content into a ref-less temporary base commit. No real `git add` may be executed, and the user's index or branch must not be changed.

Each detached worker worktree is created from that snapshot. Before applying, the main working directory snapshot is recomputed; if content has changed, Apply is refused so as not to overwrite the user's subsequent changes.

## Lifecycle

```text
Assess -> Init/Dispatch -> worker implementation -> Collect
       -> Integrate successful patches -> Apply -> Cleanup
       -> main conversation completes failed scope -> full Review/verification
```

`Init` automatically launches workers via the Codex, Claude, or Antigravity dispatcher. The dispatcher's reply must echo back the designated worktree and parent task id, otherwise the whole batch of creation fails and is cleaned up.

The dispatcher request includes at minimum `parent_task_id`, `worker_id`, `worktree`, `goal`, `file_ownership`, and `base_commit`. The native worker must use `worktree` as its actual working directory, load that worktree's task.md, and call `WorkerReady` upon completion. The dispatcher must not place the worker back in the main working directory, and must not wait for the worker to finish before returning the acknowledgement.

A worker implements only its own ownership and ends directly after reporting completion; it does not run tests, pre-review, Review, Verifier, or task gates. If a worker fails, times out, oversteps its boundary, or cannot be integrated, successful independent patches may be retained, and the main conversation completes the failed scope sequentially. The coordinator does not modify the main working directory's source directly — it can only go through the orchestrator's `Apply` action; the worker boundary is a collaborative guard, not a security sandbox.

The main conversation only begins Review or verification after all original completion criteria have been met.

## Platform adapters

All three platforms receive JSON stdin via `AGENT_WORKFLOW_<PLATFORM>_DISPATCH_COMMAND`. The reply JSON must be:

```json
{"accepted": true, "dispatch_id": "native-id", "worker_root": "<designated worktree>", "parent_task_id": "<parent task>"}
```

Platform command name mapping is as follows: `AGENT_WORKFLOW_CODEX_DISPATCH_COMMAND`, `AGENT_WORKFLOW_CLAUDE_DISPATCH_COMMAND`, `AGENT_WORKFLOW_ANTIGRAVITY_DISPATCH_COMMAND`. When unset or acknowledgement validation fails, `Start` does not pretend to succeed — it cleans up any worker worktrees already created and reports an error.

The adapter must use the platform's native mechanism to create a worktree-bound agent; sharing the main working directory does not satisfy this contract. Each platform must complete real dual-worker acceptance testing before it can be marked as supporting automatic parallelism.
