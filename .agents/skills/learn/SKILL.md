---
name: learn
description: Save durable user-requested memories, corrections, decisions, and confirmed reusable fixes.
---

# learn

Use this skill when a memory should affect a later task. Capture only a conclusion that is reusable across turns or projects.

## When to capture

- Capture immediately when the user explicitly says remember, save, or learn.
- Capture a correction, settled decision, confirmed fix, or durable preference when it changes future work.
- Do not capture one-off choices, transient context, secrets, credentials, personal data, or an unconfirmed guess.
- Do not announce a skipped capture unless the user asked what was saved.

## Capture

1. Search the current project entries first. Reuse the existing topic and keep the current entry when it already covers the same conclusion.
2. Use `Project` for repository-specific conclusions. Use `Global` only for a cross-project preference or lesson and only with explicit user consent.
3. Save one concise conclusion with `kind` set to `explicit`, `correction`, `decision`, `error`, `preference`, or `pitfall`.
4. Run the runtime writer with the current project and the shared state root:

```text
agent-workflow learn --action Capture --cwd <cwd> --state-root <state-root> --scope Project --kind <kind> --topic <topic> --content <durable conclusion> --source-event <event>
```

5. If an existing entry is wrong, use `--supersedes` for a narrower replacement or `--forget` only when the user has said it is wrong. Keep complementary entries.
6. Tell the user briefly what was recorded only after a write succeeds.

## Shared memory

The canonical writable store is `~/.agent-workflow` (override with `AGENT_WORKFLOW_STATE_ROOT`). The installer embeds that same absolute state root in Claude, Codex, and Antigravity hooks, so `learn` writes are readable by every platform. `memory-context` also reads native platform memory directories as read-only leads marked `needs_verification`; verify those claims against the current project before relying on them.

See [memory procedure](../workflow/memory.md) for bounded selection, freshness, project scope, and verification rules.
