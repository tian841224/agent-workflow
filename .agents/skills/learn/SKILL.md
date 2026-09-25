---
name: learn
description: Save durable user-requested memories, corrections, decisions, and confirmed reusable fixes.
---

# learn

Use this skill when a memory should affect a later task. Capture only a conclusion that is reusable across turns or projects.

## When to capture

- Capture immediately when the user explicitly says remember, save, or learn.
- Capture a correction, settled decision, confirmed fix, or durable preference when it changes future work.
- Leave out one-off choices, transient context and unconfirmed guesses. Secrets, credentials and personal data are never written.

## Where it goes

| Conclusion | Destination |
|---|---|
| Project decision, business rule, or a correction of how a feature must behave | The project's `docs/`: a `decision` document, or the module/flow document that owns the behavior ([project-docs](../project-docs/SKILL.md)). Set `covers` to the affected paths so `task-init --paths` returns it. |
| Reusable project pitfall or fix (hidden second entrypoint, shared table writer, missing test infrastructure) | Project memory, below |
| Personal preference or a correction of how the agent works | Project memory; Global only for a cross-project preference with explicit user consent |

## Capture to memory

1. Search the current project entries first. Reuse the existing topic and keep the current entry when it already covers the same conclusion.
2. Save one concise conclusion with `kind` set to `explicit`, `correction`, `decision`, `error`, `preference`, or `pitfall`. Classify it with `--tags` (feature, module or business term) and `--paths` (the repo-relative files or directory prefixes ending in `/` it is about), so `task-init --paths` returns it when related work starts.

```text
agent-workflow learn --action Capture --cwd <cwd> --state-root <state-root> --scope Project --kind <kind> --topic <topic> --tags <tag1,tag2> --paths <path1,dir/> --content <durable conclusion> --source-event <event>
```

3. If an existing entry is wrong, use `--supersedes` for a narrower replacement or `--forget` only when the user has said it is wrong. Keep complementary entries.
4. Tell the user briefly what was recorded only after a write succeeds.

## Shared memory

The canonical writable store is `~/.agent-workflow` (override with `AGENT_WORKFLOW_STATE_ROOT`). The installer embeds that same absolute state root in Claude, Codex, and Antigravity hooks, so `learn` writes are readable by every platform. `memory-context` also reads native platform memory directories as read-only leads marked `needs_verification`; verify those claims against the current project before relying on them.

See [memory procedure](../workflow/memory.md) for bounded selection, freshness, project scope, and verification rules.
