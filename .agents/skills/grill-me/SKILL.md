---
name: grill-me
description: Use when the user explicitly asks to be grilled, or when discussions/planning/tasks hit vague requirements or unclear decisions (unclear_requirements) and the plan and assumptions need to be pressure-tested before starting work or unfreezing; ask one question at a time until the decision tree is clear and the next step is defensible.
---

# Grill Me

Use this skill:
1. After the user explicitly asks to be grilled (e.g., `/grill-me` or asking to challenge/pressure-test their plan).
2. During discussions, planning, Q&A, conceptual design, or agent-workflow tasks whenever encountering vague or underspecified requirements (`unclear_requirements`) where key assumptions, high-risk trade-offs, or irreversible branches must be pressure-tested.

Pressure-test the plan until the decision tree is clear and the next move is defensible.

## Workflow

1. Identify the current plan, decision, or assumption being tested (usually formulated after or alongside `planning`).
2. Pick the highest-risk unresolved branch first.
3. Ask exactly one question at a time.
4. For each question, include your recommended answer and the reason.
5. If the answer can be found in the codebase or docs, inspect them instead of asking.
6. Continue until the main tradeoffs, dependencies, risks, and success criteria are resolved.

## Question Style

- Be direct and specific.
- Prefer questions about constraints, ownership, failure modes, rollout, verification, and reversibility.
- Keep it a focused conversation, not a long checklist.
- Only ask about real unresolved uncertainty; stop once the remaining uncertainty is low enough to act.
