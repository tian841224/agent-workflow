# Expanded work

Read this when the compiled plan reports `exploration_profile: expanded`. Exploration then covers the
callers, shared state and boundaries the compiled plan selected, beyond the direct path a focused task
keeps to; record what it finds in the task's [shared evidence map](evidence.md#shared-analysis).
Reviewer scope lives in [review.md](review.md) and role boundaries in each role document.

## Ordered implementation slices

When expanded work contains several independent behaviors or crosses module boundaries, the
coordinator writes ordered slices before implementation. Every slice names its goal, scope,
acceptance criteria, local verification command, and dependencies. A dependent slice waits until the
previous slice's local feedback passes. Each slice receives local feedback only; the whole task gets
one Reviewer after every slice is stable. Keep slices in the coordinator's working plan; they
are not new task state or ExecutionPacket authority. Native parallel decisions follow [workflow](SKILL.md); dependent work stays ordered. Once all slices are stable,
follow [Finalization](evidence.md#finalization).
