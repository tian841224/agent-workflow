---
name: codebase-design
description: Shared vocabulary for designing deep modules. Use when designing or improving a module's interface, finding deepening opportunities, deciding where to place a seam, or making code easier to test or navigate by agents; also referenced by other skills that need deep-module vocabulary.
---

# Codebase Design

Design **deep modules**: a small interface hiding a lot of behavior, sitting on a clean seam, testable through that interface. Use this vocabulary consistently whenever designing or refactoring code — the terms only work if they stay consistent.

## Glossary

Use these terms consistently — don't substitute other words:

- **Module**: anything with an interface and an implementation, deliberately scale-agnostic — a function, a class, a package, or a slice spanning layers all count. Avoid "unit", "component", "service".
- **Interface**: everything a caller needs to know to use the module correctly — type signatures, plus invariants, ordering constraints, error modes, required configuration, and performance characteristics. Avoid "API" or "signature" (too narrow — only the type-level surface).
- **Implementation**: the code behind the module. Different from **Adapter**: something can be a small adapter over a large implementation (a Postgres repo), or a large adapter over a small implementation (an in-memory fake). Say "adapter" when discussing seams, "implementation" otherwise.
- **Depth**: the leverage an interface provides. For each unit of interface a caller (or test) learns, how much behavior can it drive? An interface hiding a lot of behavior behind a small surface is **deep**; an interface as complex as its implementation is **shallow**.
- **Seam** (Michael Feathers): a place where you can change behavior without editing it — the *location* a module's interface sits at. Where to put a seam is a design decision independent of what goes inside it. Avoid "boundary" (clashes with DDD's bounded context).
- **Adapter**: a concrete implementation that satisfies the interface at a given seam. Describes a **role** (which slot it fills), not the content.
- **Leverage**: what depth gives the caller — each unit of interface learned buys more capability; one implementation pays off across N callers and M tests.
- **Locality**: what depth gives the maintainer — changes, bugs, knowledge, and verification stay in one place instead of scattering across callers. Fix it once, it's fixed everywhere.

## Criteria

- **Depth is a property of the interface, not the implementation.** A deep module can be built internally from small, mockable, replaceable pieces — those pieces aren't part of the interface. A module can have both an external seam (where the interface lives) and internal seams (for its own implementation and tests only).
- **The delete test**: imagine deleting this module entirely. If the complexity vanishes with it, it was just a pass-through — delete it. If the complexity regrows across N callers, it's genuinely earning its leverage.
- **The interface is the test interface.** Callers and tests go through the same seam; needing to test past the interface usually means the module is shaped wrong.
- **One adapter is only a hypothetical seam — two makes it real.** Don't introduce a seam until something actually varies at it.

## Designing for testability

- Accept dependencies, don't construct them (`processOrder(order, paymentGateway)`, not an internal `new StripeGateway()`).
- Return results, don't cause side effects (`calculateDiscount(cart): Discount`, not `applyDiscount(cart): void` mutating `cart.total` directly).
- Smaller interfaces are better — fewer methods means fewer cases to test, fewer parameters means simpler test setup.
