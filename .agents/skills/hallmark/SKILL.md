---
name: hallmark
description: Anti-AI-slop design skill for building, auditing, redesigning, or studying interfaces when the user explicitly wants stronger visual authorship or invokes Hallmark by name.
version: 1.1.0
---

# Hallmark

Hallmark improves visual authorship without forcing every design task through the same recipe. Choose the smallest branch that matches the user's intent, preserve the project's real constraints, and let the artifact determine how much exploration and validation are necessary.

## Route by intent

- **Build / default** — create the requested component, page, or interface using the project's existing design system when one exists.
- **Audit** — inspect the target and return ranked, evidence-based design problems. Do not edit unless the user asks.
- **Redesign** — improve the requested visual/interaction layer inside the existing implementation boundaries unless the user explicitly approves broader replacement. Read [`references/verbs/redesign.md`](references/verbs/redesign.md) when the redesign changes multiple pages or design-system ownership.
- **Study** — extract reusable design characteristics from a user-provided screenshot or readable URL. Read [`references/study.md`](references/study.md) before this branch.

If a request is ambiguous between studying a reference and building from it, infer the lower-risk intent from context when possible. Ask only when the two choices would produce materially different deliverables.

## Scope first

Treat a single named component or single-component file as component scope. Treat multi-section pages, flows, or application shells as page scope. Do not run page-level machinery for a component.

For component work, preserve the surrounding design tokens and implement the states that are actually part of the component's contract. Do not invent loading, error, success, or other states merely to satisfy a checklist.

For page work, establish a coherent hierarchy and structure that fits the content. Avoid reusing the same default hero/features/CTA rhythm across unrelated briefs.

## Hard design constraints

These constraints remain explicit because they prevent recurring bad output:

- Do not invent metrics, testimonials, logos, customer counts, case-study claims, or other factual proof.
- Use the project's existing tokens and typography system when they exist. If new tokens are needed, define them centrally instead of scattering raw values through the artifact.
- Do not draw fake browser, phone, terminal, IDE, or code-window chrome merely as decoration.
- Preserve routes, component ownership, copy intent, brand assets, and production files outside the requested redesign scope.
- Treat accessibility, readable hierarchy, and responsive containment as output requirements, not optional polish.

Read [`references/anti-patterns.md`](references/anti-patterns.md) when the design is drifting toward generic AI patterns. Read [`references/responsive.md`](references/responsive.md) when responsive behavior is part of the task. Read [`references/structure.md`](references/structure.md) when page composition or structural variety is the main problem.

## Repository-first decisions

Inspect the target UI, nearby components, tokens/theme, and the smallest set of project files needed to understand the existing visual language. Stop once the local system is clear enough to make the next decision; do not scan a fixed inventory of files or components.

Make low-risk, reversible decisions from repository evidence. Ask before deleting production artifacts, replacing route/component ownership, changing information architecture, making irreversible migrations, or taking another action whose consequence is not safely inferable. Do not ask permission for ordinary spacing, hierarchy, token reuse, component composition, or other reversible design decisions when the repository already provides a clear convention.

## Exploration

Variants are optional. Produce multiple directions only when comparison will reveal a real trade-off. Use as many as needed to expose the design space; do not generate a fixed number for its own sake. Variants should differ structurally or interactionally, not only by palette.

When the user has already chosen a direction, build or refine that direction instead of reopening exploration.

## Verification

Check only the conditions that can actually fail for the requested artifact: responsive containment, interaction/state behavior, accessibility, token consistency, or other acceptance criteria implied by the task.

A passing check remains valid while the artifact, relevant viewport/runtime conditions, and inputs it covered have not changed. Reuse that evidence instead of rerunning an identical check solely because a later workflow step asks for it. Re-run after a relevant change or when a new finding invalidates the earlier result.

Use detailed reference files only when their branch is active; do not load the complete Hallmark reference set up front.
