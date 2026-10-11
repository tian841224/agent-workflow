---
name: tdd
description: "compiled workflow plan 選用 tdd 時使用；以紅燈、綠燈、重構推動行為變更，並明確測試邊界與驗證證據。"
---

# Test-Driven Development

Load this skill only when the compiled workflow plan selects `tdd`. Whether a change enters the managed workflow, and how weakened or deleted tests are handled, is decided by the [workflow skill](../workflow/SKILL.md). Follow the project's existing domain vocabulary, public interfaces, and test conventions.

## Test boundary (Seam)

A seam is the public boundary where a test observes behavior — an HTTP endpoint, CLI command, public service method, or event entrypoint. Guard primary behavior through a seam that represents caller-facing behavior. A unit test may cover a purely deterministic calculation, but it does not replace an integration test that has to run from a real entrypoint. When which seam to guard is itself in question, read [codebase-design](../codebase-design/SKILL.md); ask the user only when the primary interface or acceptance responsibility is still unclear.

## Iteration

Work in vertical slices: one seam, one behavior, a test that fails before the change, the minimal implementation that passes it, then refactor without changing verified behavior. Writing a full batch of tests before any implementation locks them onto an internal shape that is not yet understood.

## Test rules

- Expected values come from the spec, a worked example, or an independent known-good literal. A value recomputed with the production algorithm makes the test pass by construction.
- Assert the outcome a caller sees through the public interface. Private methods, call counts, call order and direct reads of internal tables or state couple the test to the implementation, so it breaks on a refactor that changes no behavior.
- Cover behavior that current requirements support; leave future functionality untested until it exists.

## Mocks and external boundaries

Use mocks or fakes only at external system boundaries — third-party APIs, email, time, randomness, the filesystem, or a database that can't be safely operated on in tests. Use real implementations for your own modules, so tests don't end up verifying mock setup.

Give each external operation its own specific mock interface returning a single concrete data shape, instead of one generic mock with conditional branches. Prefer isolated real resources when available, using only one-off, cleanly disposable Docker/SQL resources — never mount or mutate existing containers, databases, or volumes.
