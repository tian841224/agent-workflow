# Expanded exploration rules

Read this when the compiled plan reports `exploration_profile: expanded`. It owns exploration depth only; reviewer scope lives in [review.md](review.md) and role boundaries in each role document.

- Extend the task's [shared evidence map](evidence.md#shared-analysis) with the findings below; implementation and review reuse that map.
- Reverse-search changed public symbols, shared state, and every unresolved node; keep the hits that change a decision.
- Trace the execution path from the real entrypoints through the boundaries selected by the compiled plan. Expand into retry, concurrency, or async branches when the change reaches those branches or leaves an unknown; a focused task keeps the direct path only.

## Ordered implementation slices

When expanded work contains several independent behaviors or crosses module boundaries, the
coordinator writes ordered slices before implementation. Every slice names its goal, scope,
acceptance criteria, local verification command, and dependencies. A dependent slice waits until the
previous slice's local feedback passes. Each slice receives local feedback only; the whole task gets
one Reviewer after every slice is stable. Keep slices in the coordinator's working plan; they
are not new task state or ExecutionPacket authority. Native parallel decisions follow [workflow](SKILL.md); dependent work stays ordered. Once all slices are stable,
follow [Finalization](evidence.md#finalization).
