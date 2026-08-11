---
name: grill-me
description: 使用者明確要求被 grill、或 agent-workflow 遇到 unclear_requirements 需要在解除凍結前壓力測試計畫與假設時使用；逐一提問直到決策樹清楚、下一步站得住腳。
---

# Grill Me

Use this skill after the user explicitly asks to be grilled, or when agent-workflow's `unclear_requirements` risk flag requires pressure-testing a plan or assumption before the task can be unfrozen (see the `workflow` skill). Pressure-test the plan until the decision tree is clear and the next move is defensible.

## Workflow

1. Identify the current plan, decision, or assumption being tested.
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
