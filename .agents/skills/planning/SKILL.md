---
name: planning
description: "有兩個以上可行方向而選擇會影響契約、資料或結構、需求不足以定義完成條件，或計畫含不可逆操作、資料遷移或權限變更時使用；釐清方向並質疑高風險假設，直到決策站得住。"
---

# Simple Planning Skill

Work whose goal, constraints, and completion criteria are already clear proceeds without a planning pass, unless [Pressure-testing](#pressure-testing) applies.

## Required outcomes

A useful plan establishes only what the task needs:

- the goal and important constraints;
- the chosen direction and material trade-offs;
- unresolved assumptions that could change the implementation;
- a practical way to tell whether the result worked.

Depth is proportional to consequence. A local reversible change may need only a short recommendation. A new subsystem, migration, security boundary, or irreversible decision deserves deeper analysis.

## How to decide

Prefer repository evidence and existing conventions over questions whose answer can be derived safely. When context is sufficient, make a reasonable low-risk assumption and continue. Ask the user only when an unresolved choice materially changes product intent, architecture, ownership, destructive behavior, irreversibility, external commitments, or another high-impact outcome.

When clarification is necessary, ask the smallest set of questions that unlocks the decision.

Compare alternatives only when there is a real trade-off. If one approach is clearly simpler and satisfies the known constraints, recommend it rather than manufacturing options. Apply YAGNI: do not add abstractions, extension points, or flexibility for requirements that do not exist.

## Pressure-testing

When the plan contains an irreversible operation, a data migration or an authorization change, or rests on an unverified assumption, pressure-test it before presenting it for confirmation; do the same whenever the user asks to have a plan challenged.

Start from the highest-risk unresolved branch. Ask exactly one question at a time, and give your recommended answer and its reason with each question. When the codebase or docs can answer it, inspect them instead of asking. Prefer questions about constraints, ownership, failure modes, rollout, verification, and reversibility, and stop once the main trade-offs, dependencies, risks, and success criteria are resolved well enough to act.

## Planning artifacts

Create a planning document only when the user requests one or the task explicitly requires a durable artifact.

- A **direction document** captures current state, chosen direction, why it matters, scope, major trade-offs, and high-level order.
- An **implementation sequence document** turns an already-settled direction into executable order, dependencies, purpose, and completion criteria.

Use an existing repository convention or nearby document location when one is clear. Ask for a path only when multiple plausible locations carry different ownership or semantic meaning. Prefer updating an existing owner document over creating a parallel source of truth.

Do not duplicate detailed rules already owned elsewhere.

## Lightweight self-review

Before presenting the recommendation, check whether any unresolved assumption can still invalidate the direction, whether the scope is actionable, and whether success can be verified. Fix small inconsistencies inline; escalate only material uncertainty.
