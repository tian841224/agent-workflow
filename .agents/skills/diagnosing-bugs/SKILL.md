---
name: diagnosing-bugs
description: Debugging discipline for hard-to-find bugs or performance anomalies. Read this proactively whenever you are debugging, investigating a failure, or about to form a hypothesis about a bug's root cause — before writing any fix. Also use when the user says "diagnose", "debug this", or reports something broken, throwing errors, failing, or slow.
---

# Debugging Discipline

Six phases; skip a phase only with a clear reason. Before starting, read `CONTEXT.md` (if it exists) to build a mental model of the module, and check ADRs for the area.

## Handling Secrets

This skill will ask you to paste commands, output, and captured artifacts. Redact every secret as `<REDACTED>` first. Run loops against environment variables so credentials stay in the environment rather than appearing in what you show; if a captured artifact carries an auth header, quote only the lines that carry signal. If redaction leaves insufficient evidence to diagnose, say so explicitly and ask the user.

## Phase 1: Establish a Feedback Loop

**This is the core of the whole skill — everything else is mechanical.** Once you have a tight signal that turns red for this bug, you will find the root cause; bisection, hypothesis testing, and instrumentation only consume that loop. Without this signal, staring at code accomplishes nothing. Spend disproportionate effort here — be aggressive and creative, and don't give up easily.

For the ordering and details of loop-building techniques, see [feedback-loops.md](feedback-loops.md) (failing test → curl → CLI diff → headless browser → replay trace → throwaway harness → fuzz → bisect → differential → HITL script).

**Exit criteria**: you can name **one command** (a script path, a test invocation, a curl call) that you have **actually run at least once** (shown the invocation and output, redacted), and it satisfies all of:

- [ ] **Turns red**: it actually exercises the buggy code path and asserts the exact symptom the user described — not "no crash," but catching this specific bug.
- [ ] **Deterministic**: it produces the same result every run (see non-deterministic bugs below).
- [ ] **Fast**: seconds, not minutes.
- [ ] **Agent-runnable**: no human needs to be present; when one truly is required, use `hitl-loop.template.sh`.

If you catch yourself reading code and forming theories before this command exists, stop — skipping this step to guess at hypotheses is exactly the failure mode this skill exists to prevent. Do not enter Phase 2 without a command that turns red.

## Phase 2: Reproduce and Minimize

Run the loop and confirm it turns red on the bug. Verify: it matches the user's exact described symptom (not a different nearby issue); it reproduces repeatably (for non-deterministic bugs, see below — aim for a high-enough reproduction rate); and you've captured the exact symptom (error message, bad output, exact timing) to validate the fix in later phases.

**Minimize**: once it's red, cut inputs, callers, config, data, and steps one at a time — re-run the loop after each cut, keeping only what turns it green when removed. This narrows the hypothesis space for Phase 3 and becomes the regression test in Phase 5. Exit criteria: everything remaining is necessary — removing any single piece turns it green.

## Phase 3: Form Hypotheses

**Generate 3–5 ranked hypotheses before testing any of them.** Considering only one hypothesis anchors you to your first idea. Each hypothesis must be falsifiable: "if X is the root cause, changing Y should make the bug disappear / changing Z should make it worse." If you can't state that prediction, the hypothesis is just a hunch — drop it or sharpen it.

**Show the user the ranked list before testing.** They often have domain knowledge that lets them instantly re-rank ("we just deployed a change related to #3") or rule out a hypothesis outright. Don't wait if the user isn't available — proceed with your own ranking.

## Phase 4: Instrument

Each probe should map to one specific prediction from Phase 3, changing one variable at a time. Priority order: debugger/REPL inspection (one breakpoint beats ten log lines) > targeted logging at boundaries that discriminate between hypotheses > never "log everything and grep."

Prefix every debug log line with a unique `[DEBUG-xxxx]` tag so it can be grepped and removed in one pass at cleanup.

**Performance branch**: for performance anomalies, logging is usually useless — instead establish a baseline measurement first (timing harness, `performance.now()`, profiler, query plan), then bisect. Measure first, fix second.

## Phase 5: Fix and Regression Test

**Write the failing regression test before fixing — but only if the right seam exists.** The right seam reproduces the bug pattern in the same form it actually occurs at the call site; if the only available seam is too shallow (the bug requires multiple callers to manifest, but only a single-caller unit test is available), a regression test written there is false reassurance.

**No correct seam being available is itself a finding** — it means the architecture is not preventing this bug class from recurring; record it (maps to the Verifier's "test gap" category).

When a correct seam exists: turn the minimized repro into a failing test at that seam → confirm it fails → apply the fix → confirm it passes → re-run the Phase 1 loop against the original (non-minimized) scenario.

## Phase 6: Wrap Up

- [ ] The original repro no longer reproduces (re-run the Phase 1 loop)
- [ ] The regression test passes (or the lack of a usable seam has been recorded)
- [ ] All `[DEBUG-...]` instrumentation has been removed (confirm by grepping the prefix)
- [ ] Any throwaway prototypes have been deleted or moved to a clearly marked debug area
- [ ] The confirmed hypothesis is written into the commit/task record so the next person debugging this benefits
