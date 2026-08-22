---
name: tdd
description: Test-driven development standard. Use when source code behavior changes, a bug fix needs test-first, or the user requests red-green-refactor / integration tests; pure test-code edits still bypass workflow.
---

# Test-Driven Development

TDD is a development method that drives behavior changes through red → green → refactor. This skill defines the behavior tests should guard, test boundaries, and iteration rules; workflow is only responsible for deciding whether TDD is needed, choosing verification depth, and recording results.

## When to use

- Adding or fixing testable source code behavior.
- A bug fix, behavior change, or an explicit user request for test-first.
- A feature that needs integration behavior verified from a real entrypoint.

Pure test code refactoring, test fixture adjustments, and documentation, config, or script changes do not create a workflow task under this skill, but applicable tests or verification must still run.

Before starting, read the project instructions, relevant project docs, and any `CONTEXT.md` or ADRs, following the project's existing domain vocabulary, public interfaces, and test conventions.

## Test boundary (Seam)

A seam is the public boundary where a test observes behavior — e.g. an HTTP endpoint, CLI command, public service method, or event entrypoint (full glossary in the [codebase-design skill](../codebase-design/SKILL.md)). Tests should prefer verifying outcomes through a seam that represents caller/user-facing behavior, rather than depending directly on private methods or internal collaborators.

If the primary public interface, key execution path, or acceptance responsibility is not yet clear, confirm with the user which seam to guard; if the interface and completion criteria are already clear, there's no need to ask for every single test.

Choose the test level by behavior: primary behavior should be guarded by a public seam; purely deterministic calculations can be covered by a unit test, but a unit test must not replace an integration test that needs to be verified from a real entrypoint.

## Good tests

- Describe behavior visible to the caller/user, not implementation steps (e.g. verify "a valid cart produces a confirmed order," not "checkout internally calls a particular payment method").
- Verify outcomes through a public interface or real entrypoint.
- Expected values come from the spec, a worked example, or an independent known-good literal — never recomputed from the production algorithm.
- Focus on one behavior at a time; the test name states "what it does" and "what result it gets," not how it's implemented.
- A test should keep passing after internal refactors or collaborator swaps, as long as external behavior hasn't changed.

## Red → Green → Refactor

1. **Red**: First write a test that genuinely fails before the change and captures the target behavior.
2. **Green**: Implement only the minimal change needed to make the current test pass, without adding unverified functionality ahead of time.
3. **Refactor**: Clean up design and implementation only after the test is green; refactoring must not change already-verified behavior.

Iterate in vertical slices: pick one seam at a time, add one behavior, make the minimal implementation, then move to the next round based on the result. Don't write a full batch of tests up front and then implement the imagined complete behavior in bulk afterward.

## Common anti-patterns

- **Implementation-coupled**: Testing private methods, internal collaborators, call counts, or call order.
- **Tautological**: The expected value is recomputed using the same algorithm as the production code, so the test is guaranteed to pass.
- **Side-channel verification**: Proving behavior by directly querying internal tables or reading internal state instead of going through the public interface.
- **Horizontal slicing**: Writing a large batch of tests up front before any implementation, locking tests onto an internal shape that isn't yet understood.
- **Speculative coverage**: Writing tests for future functionality not yet supported by requirements or current behavior.

## Mocks and external boundaries

Use mocks or fakes only at external system boundaries — e.g. third-party APIs, email, time, randomness, the filesystem, or a database that can't be safely operated on in tests. Prefer real implementations for your own classes, modules, and internal collaborators, so tests don't end up just verifying mock setup.

When a mock is needed, dependencies should be passed in through an explicit interface or dependency injection, rather than having a function construct a hard-to-replace client on its own; use a clear, specific interface for each external operation instead of one generic mock with many conditional branches — a mock should return a single, concrete data shape. Prefer isolated real resources when available, while still following the Verifier's constraints on one-off test resources.
