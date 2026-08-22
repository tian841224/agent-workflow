# Techniques for Building a Feedback Loop

Only read this list when you're stuck in Phase 1 and can't think of a command that would turn red. Techniques are roughly ordered "try this first" — you don't need to work through all of them every time:

1. **Failing test**: write it at whichever seam actually touches this bug — unit, integration, or e2e are all fine.
2. **Curl/HTTP script**: hit a running dev server directly.
3. **CLI invocation**: feed it fixture input and diff stdout against a known-good snapshot.
4. **Headless browser script** (Playwright/Puppeteer): drive the UI and assert on the DOM/console/network.
5. **Replay a captured trace**: save a real network request/payload/event log to disk and replay it through this code path in isolation.
6. **Throwaway harness**: spin up a minimal subsystem (a single service, other dependencies mocked) that reaches the bug path in one function call.
7. **Property/fuzz loop**: when the bug is "output is sometimes wrong," run thousands of random inputs to find the failure pattern.
8. **Bisection harness**: when the bug appears between two known states (commits, datasets, versions), automate "boot at state X, check, repeat" so `git bisect run` can drive it directly.
9. **Differential loop**: run the same input against the old version vs. the new version (or two configurations) and diff the output.
10. **HITL bash script**: last resort. When a human genuinely has to click something, drive them with a script like `hitl-loop.template.sh` so the loop stays structured and the captured output still feeds back to you.

## Tightening the Loop

Once you have a loop, treat it like a product and keep tightening it: can it run faster (cache setup, skip irrelevant init, narrow test scope)? Can the signal be more precise (assert the exact symptom instead of "didn't crash")? Can it be more deterministic (fixed clock, seeded randomness, isolated filesystem, frozen network)? A 30-second flaky loop is barely better than no loop; a 2-second deterministic loop is a genuine debugging superpower.

## Non-Deterministic Bugs

The goal isn't a clean repro — it's a **higher reproduction rate**. Loop the triggering action 100 times, parallelize it, add load, shrink the timing window, insert sleeps. A bug that flakes at 50% is debuggable; one at 1% isn't — work on raising the reproduction rate to something debuggable first.

## When You Truly Can't Build a Loop

Say so plainly and list what you tried. Ask the user for one of: (a) access to an environment that reproduces the issue, (b) redacted captured artifacts (HAR files, log dumps, core dumps, timestamped screen recordings), or (c) permission to add temporary production instrumentation. **Do not** start guessing without a loop — that's exactly the failure mode this skill exists to prevent.
