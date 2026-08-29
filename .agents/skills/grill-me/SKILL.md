---
name: grill-me
description: Use when the user explicitly asks to be grilled, or when a plan already exists and its high-risk assumptions, irreversible branches, or major trade-offs still need pressure-testing before work starts or a task unfreezes; ask one question at a time until the decision tree is clear and the next step is defensible. For requirements that are still vague and have no plan yet, use `planning` first.
---

# Grill Me

Use this skill:
1. After the user explicitly asks to be grilled (e.g., `/grill-me` or asking to challenge/pressure-test their plan).
2. Once a plan or direction already exists — from `planning` or from the user — and its key assumptions, high-risk trade-offs, or irreversible branches still need pressure-testing.

This skill starts where `planning` ends: `planning` turns vague requirements into a direction, then this one tries to break that direction. When requirements are still vague and no plan exists yet, run `planning` first and only come here if risk remains.

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
