---
name: design-lab
description: Explore materially different UI directions when comparison and feedback are useful. Use repository evidence first, ask only decision-changing questions, and generate only as many variants as needed to expose real trade-offs.
---

# Design Lab

The goal is to make a design decision, not to complete a fixed interview or produce a fixed number of variants. Use the shortest path that reveals the important visual or interaction trade-offs while preserving the project's existing design system unless the user explicitly wants a departure.

## Required outcomes

A successful design exploration should establish:

- the target and scope being designed;
- the existing visual/system constraints that matter;
- the meaningful design choices still open;
- enough distinct variants or examples to compare those choices;
- the selected direction and the feedback that shaped it;
- a practical implementation handoff when the user wants one.

## Repository-first context

Before asking questions, inspect the closest evidence that can answer them: the target component/page, nearby components, shared tokens/theme, and framework conventions. Do not scan an arbitrary quota of buttons, cards, forms, fonts, or configuration files. Stop once the local design language is clear enough to make the next decision.

Reuse an existing design memory or design-system document when present and current. Do not create a second source of truth for the same rules.

## Questions and assumptions

Make low-risk, reversible decisions from repository evidence and the user's brief. Ask only when an unresolved choice materially changes product intent, information architecture, brand direction, destructive replacement of existing UI, ownership, or another high-impact outcome.

If the user already supplied a clear style direction, target, and constraints, begin producing candidate work without an interview. If information is missing but a conventional default is safe, state the assumption briefly and continue.

## Variants

Generate variants only when comparison will help. The number is adaptive: two strong alternatives may be enough; a broader design space may justify more. Each variant must differ in a meaningful structural, hierarchy, interaction, or visual-system choice — not just color swaps.

For a small component, compare the states or interaction treatments that matter instead of constructing a page-level design lab. For a page or flow, keep variants bounded to the requested scope.

## Refinement

Use feedback to converge on one direction. Preserve decisions that the user accepted and change only the parts the feedback targets. Do not restart the whole exploration because of a local revision.

When the user asks for implementation, hand off the settled direction with the concrete constraints, selected structure, relevant tokens/patterns, and acceptance details needed to build it. Do not generate a planning artifact unless it helps the requested handoff.

## Temporary artifacts and cleanup

Temporary previews or design-lab files are implementation aids, not deliverables. Remove them when they are no longer needed or when the user cancels. Do not delete existing production files, routes, or user-owned artifacts merely because a design direction changed.

## Verification reuse

Reuse a preview or validation result while the rendered artifact, relevant viewport conditions, and design inputs have not changed. Re-run visual checks only after a change that can affect the checked result or when a new finding invalidates prior evidence.
