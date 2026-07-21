# Mocking Guidelines

## Default: don't mock what you own

If a collaborator is part of your own codebase, prefer running its real implementation in the test. Mocking internal collaborators locks the test to today's internal call graph — the test breaks on a pure refactor even though behavior didn't change, which is exactly the anti-pattern this skill exists to prevent.

Mock only at true **external boundaries** — things outside your code's control:

- Network calls to third-party services
- Filesystem / OS-level I/O
- Wall-clock time and randomness
- Paid or rate-limited APIs
- Anything genuinely slow or nondeterministic to run for real (e.g. sending a real email)

Everything else — your own services, repositories, domain logic, internal HTTP handlers — should run for real in the test, exercised through the seam under test.

## Prefer fakes over mocks when a boundary must be doubled

A **mock** asserts on *how* it was called (call count, argument shape) — this couples the test to implementation detail almost as tightly as not mocking at all would avoid. A **fake** is a lightweight real implementation (in-memory database, in-memory queue) that behaves correctly but skips the expensive/nondeterministic part. Fakes let the test assert on *outcome* (state after the call) instead of *interaction* (was this method invoked with these arguments) — outcome assertions survive refactors, interaction assertions don't.

Order of preference when a boundary needs a test double:

1. **Fake** — real logic, fake backend (in-memory repo instead of real DB)
2. **Stub** — returns canned data, no logic, used when the boundary's behavior is irrelevant to this test
3. **Spy** — records calls for cases where the interaction itself (e.g. "did we call the payment gateway exactly once") is the behavior under test
4. **Mock** — full expectation-setting test double; reach for this last, only when you specifically need to assert an interaction pattern and a spy isn't enough

## Red flags that you're mocking too much

- The test file has more mock setup lines than assertion lines
- You're mocking a function defined in the same module/package as the code under test
- The mock has to replicate real business logic (e.g. a mocked validator that reimplements validation rules) — at that point you have two implementations to keep in sync
- Changing an internal function's name or signature breaks tests that don't call it directly

## Time, randomness, and IDs

These are the most common accidental external dependencies. Inject them (clock, RNG, ID generator) rather than mocking the global — this keeps the seam explicit and lets tests pass a fixed value instead of patching a global at runtime.
