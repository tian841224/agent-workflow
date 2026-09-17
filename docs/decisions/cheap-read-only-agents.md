---
doc_type: decision
covers: ["src/installer.ts", "src/experimental/orchestration.ts", "schemas/task.schema.json", "adapters/managed-manifest.json", ".agents/agents/reader.md"]
---

# Cheap read-only agent profiles

## Context

Repository inspection and explanation tasks do not need the same model or write capability as implementation workers. The existing workflow distinguishes non-code tasks, but platform agents previously inherited their normal model and had no shared profile contract.

## Decision

Use the provider-neutral `cheap_read` profile for read-only tasks. Codex receives `gpt-5.6-luna`, `none` reasoning effort, and a read-only sandbox. Claude receives the `haiku` model alias, a read-only sandbox, and only `Read`, `Glob`, and `Grep` tools. The profile is resolved at the platform adapter boundary; the default worker profile is unchanged.

## Alternatives

- Change the global Codex model: rejected because it would slow or weaken unrelated coding tasks and would not configure Claude.
- Use a boolean `thinking: false`: rejected because model availability and reasoning controls differ by platform; a named profile provides an explicit mapping and fail-closed behavior.
- Restrict only the prompt: rejected because instructions alone do not establish a write-permission boundary.

## Consequences

The installer now produces a dedicated reader agent for Codex and Claude. Read-only tasks select that installed agent through `task_type: read_only` and `model_profile: cheap_read`, or use `orchestrate --action Read`, which does not create implementation worktrees. Actual provider account access, billing, and remote model availability remain external verification concerns.
