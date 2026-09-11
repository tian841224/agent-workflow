---
name: planning
description: Use for architecture direction, feature planning, refactoring strategy, technical trade-offs, or genuinely unclear requirements where choosing a direction matters before implementation.
---

# Simple Planning Skill

Use planning to reach a defensible direction with the least discussion needed for the decision. Do not turn planning into a mandatory ceremony for work whose goal, constraints, and completion criteria are already clear.

## Required outcomes

A useful plan establishes only what the task needs:

- the goal and important constraints;
- the chosen direction and material trade-offs;
- unresolved assumptions that could change the implementation;
- a practical way to tell whether the result worked.

Depth is proportional to consequence. A local reversible change may need only a short recommendation. A new subsystem, migration, security boundary, or irreversible decision deserves deeper analysis.

## How to decide

Prefer repository evidence and existing conventions over questions whose answer can be derived safely. When context is sufficient, make a reasonable low-risk assumption and continue. Ask the user only when an unresolved choice materially changes product intent, architecture, ownership, destructive behavior, irreversibility, external commitments, or another high-impact outcome.

When clarification is necessary, ask the smallest set of questions that unlocks the decision. There is no required question count or interview sequence.

Compare alternatives only when there is a real trade-off. If one approach is clearly simpler and satisfies the known constraints, recommend it rather than manufacturing options. Apply YAGNI: do not add abstractions, extension points, or flexibility for requirements that do not exist.

If a settled direction still contains a high-risk unresolved assumption or irreversible branch, use `grill-me` to pressure-test that specific uncertainty. Do not run `planning` and `grill-me` as overlapping rituals.

## Planning artifacts

Create a planning document only when the user requests one or the task explicitly requires a durable artifact.

- A **direction document** captures current state, chosen direction, why it matters, scope, major trade-offs, and high-level order.
- An **implementation sequence document** turns an already-settled direction into executable order, dependencies, purpose, and completion criteria.

Use an existing repository convention or nearby document location when one is clear. Ask for a path only when multiple plausible locations carry different ownership or semantic meaning. Prefer updating an existing owner document over creating a parallel source of truth.

Keep artifacts aligned with repository reality. Do not duplicate detailed rules already owned elsewhere.

## Lightweight self-review

Before presenting the recommendation, check whether any unresolved assumption can still invalidate the direction, whether the scope is actionable, and whether success can be verified. Fix small inconsistencies inline; escalate only material uncertainty.
