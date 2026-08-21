---
name: grill-me
description: 使用者明確要求被 grill、或在討論/規劃/任務中遇到需求籠統/決策未明（unclear_requirements）需在動工或解除凍結前壓力測試計畫與假設時使用；逐一提問直到決策樹清楚、下一步站得住腳。
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
- Do not turn the session into a long checklist.
- Do not invent requirements just to keep questioning.
- Stop when the remaining uncertainty is low enough to act.
