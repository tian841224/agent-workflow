---
name: codebase-design
description: Deep-module vocabulary (module, interface, depth, seam, adapter) and design criteria. Read this when the `codebase_design` capability is selected, or when the reviewer, tdd, or architecture-review document points here. Not a standalone entry point — to review an existing codebase use `architecture-review` instead.
---

# Codebase Design

Design **deep modules**: a small interface hiding a lot of behavior, sitting on a clean seam, testable through that interface. Use this vocabulary consistently whenever designing or refactoring code — the terms only work if they stay consistent.

This file is a shared reference, loaded on the pointers listed in the description. Its purpose is cross-pass consistency: the Planner and the main conversation's Review pass work from separate context, so `seam`, `depth`, and `adapter` have to mean the same thing in each of their reports.

## Glossary

Use these terms consistently — don't substitute other words:

- **Module**: anything with an interface and an implementation, deliberately scale-agnostic — a function, a class, a package, or a slice spanning layers all count. Avoid "unit", "component", "service".
- **Interface**: everything a caller needs to know to use the module correctly — type signatures, plus invariants, ordering constraints, error modes, required configuration, and performance characteristics. Avoid "API" or "signature" (too narrow — only the type-level surface).
- **Implementation**: the code behind the module. Different from **Adapter**: something can be a small adapter over a large implementation (a Postgres repo), or a large adapter over a small implementation (an in-memory fake). Say "adapter" when discussing seams, "implementation" otherwise.
- **Depth**: the leverage an interface provides. For each unit of interface a caller (or test) learns, how much behavior can it drive? An interface hiding a lot of behavior behind a small surface is **deep**; an interface as complex as its implementation is **shallow**.
- **Seam** (Michael Feathers): a place where you can change behavior without editing it — the *location* a module's interface sits at. Where to put a seam is a design decision independent of what goes inside it. Avoid "boundary" (clashes with DDD's bounded context).
- **Adapter**: a concrete implementation that satisfies the interface at a given seam. Describes a **role** (which slot it fills), not the content.

## Criteria

- **Depth is a property of the interface, not the implementation.** A module can have both an external seam (where the interface lives) and internal seams (for its own implementation and tests only) — only the external one has to be deep.
- **The delete test**: imagine deleting this module entirely. If the complexity vanishes with it, it was just a pass-through — delete it. If the complexity regrows across N callers, it's genuinely earning its keep.
- **One adapter is only a hypothetical seam — two makes it real.** Don't introduce a seam until something actually varies at it.

Testability and mocking rules for the resulting seams live in the [tdd skill](../tdd/SKILL.md), not here.
