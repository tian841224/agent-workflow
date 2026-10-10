# Native parallel implementation

Parallel selection is owned by [workflow](SKILL.md). The coordinator assigns goals, ownership and
acceptance directly through the platform's native subagent tools; worker instructions are in
[worker](../../agents/worker.md).

After integration, follow [Finalization](evidence.md#finalization). Parent classification, approvals,
acceptance, proofs, Reviewer and closure remain the coordinator's responsibility.

This path remains available to legacy coordinator procedure pointers. The existing orchestration
CLI and packet format are compatibility interfaces, not prerequisites for native parallel work.
