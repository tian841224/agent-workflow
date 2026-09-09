# Expanded exploration rules

Read this when the compiled plan reports `exploration_profile: expanded`. It owns exploration depth only; reviewer scope lives in [review.md](review.md) and role boundaries in each role document.

- After reading the related code, record one concise impact map: relevant entrypoints, callers, shared state, external contracts, important error／retry／concurrency branches, and unconfirmed nodes.
- Reverse-search changed public symbols, shared state, and every unresolved node; keep the hits that change a decision.
- Trace the execution path from the real entrypoints through the boundaries selected by the compiled plan. Expand into retry, concurrency, or async branches when the change reaches those branches or leaves an unknown; a focused task keeps the direct path only.
