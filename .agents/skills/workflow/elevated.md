# Expanded exploration rules

Read this when the compiled plan reports `exploration_profile: expanded`. It owns exploration depth only; reviewer scope lives in [review.md](review.md) and role boundaries in each role document.

- After reading the related code, record one concise impact map: relevant entrypoints, callers, shared state, external contracts, important error／retry／concurrency branches, and unconfirmed nodes.
- Reverse-search changed public symbols, shared state, and every unresolved node; keep the hits that change a decision.
- Trace the execution path from the real entrypoints through the boundaries selected by the compiled plan. Expand into retry, concurrency, or async branches when the change reaches those branches or leaves an unknown; a focused task keeps the direct path only.

## Ordered implementation slices

When expanded work contains several independent behaviors or crosses module boundaries, the
coordinator writes ordered slices before implementation. Every slice names its goal, scope,
acceptance criteria, local verification command, and dependencies. Implement and give local feedback
on one slice before starting a dependent slice. Keep slices in the coordinator's working plan; they
are not new task state, ExecutionPacket authority, or automatic orchestration. Once all slices are
stable, continue with affected/regression validation and the selected Reviewer/DV1 gates.
