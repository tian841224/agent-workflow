# Stage 3: Reader Testing

Tests whether the doc works for a reader with no context — catching blind spots that make sense to the authors but would confuse anyone else.

## Predicting reader questions

Generate 5–10 questions a real reader would realistically ask when trying to understand this document.

## Testing

**With sub-agent access** (e.g. Claude Code): invoke a sub-agent per question, giving it only the document content and the question — no conversation context. Summarize what it got right or wrong for each. Also invoke a sub-agent to check for ambiguity, false assumptions, and contradictions; summarize any issues found.

**Without sub-agent access** (e.g. claude.ai web): the user runs the test manually. Give them: (1) open a fresh Claude conversation, (2) paste or share the document, (3) ask it the generated questions plus — for each — whether anything was ambiguous, and what context it assumed was already known. Also have them ask: "What in this doc might be ambiguous to readers?", "What context does this doc assume readers already have?", "Are there any internal contradictions?"

## Iterating

List the specific issues the reader (sub-agent or human-run test) surfaced, then loop back to Stage 2's per-section refinement for the affected sections.

**Exit condition:** the reader consistently answers correctly and stops surfacing new gaps or ambiguities.
