# Native parallel implementation

Parallel selection is owned by [workflow](SKILL.md). The coordinator assigns goals, ownership and
acceptance directly through the platform's native subagent tools; worker instructions are in
[worker](../../agents/worker.md).

After integration, follow [Finalization](evidence.md#finalization). Parent classification, approvals,
acceptance, proofs, Reviewer and closure remain the coordinator's responsibility.

The orchestration CLI and packet format are opt-in interfaces, not prerequisites for native parallel
work.

## Packet assignments

A worker assigned a packet path reads its `assignment` and uses its workspace, ownership,
acceptance, attempt and result path. This opts into the packet contract: run
`agent-workflow worker-exec --assignment-path <packet> --cwd <worktree> --acceptance <id> -- <command>`
for its acceptance receipts and write the requested JSON result at `assignment.result_path`.
