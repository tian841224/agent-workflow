---
name: grill-me
description: Use for explicit grilling or high-risk plan assumptions; use `planning` first when requirements are still vague.
---

# Grill Me

Use this skill:
1. After the user explicitly asks to be grilled (e.g., `/grill-me` or asking to challenge/pressure-test their plan).
2. Once a plan or direction already exists — from `planning` or from the user — and its key assumptions, high-risk trade-offs, or irreversible branches still need pressure-testing.

This skill starts where `planning` ends: `planning` turns vague requirements into a direction, then this one tries to break that direction. When requirements are still vague and no plan exists yet, run `planning` first and only come here if risk remains.

Pressure-test the plan until the decision tree is clear and the next move is defensible.

## How to question

Start from the highest-risk unresolved branch. Ask exactly one question at a time, and give your recommended answer and its reason with each question. When the codebase or docs can answer it, inspect them instead of asking. Prefer questions about constraints, ownership, failure modes, rollout, verification, and reversibility, and stop once the main trade-offs, dependencies, risks, and success criteria are resolved well enough to act.
