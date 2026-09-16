# Stage 3: Reader Testing

Tests whether the doc works for a reader with no context — catching blind spots that make sense to the authors but would confuse anyone else.

## Predicting reader questions

Generate only the reader questions needed to expose likely ambiguity or missing context. The number is adaptive; a clear short document may need none.

## Testing

**With independent reader access** (e.g. a fresh model or reviewer): run one reader pass over the document and the selected questions. Add separate readers only when their perspectives resolve a real uncertainty. Check ambiguity, false assumptions, and contradictions in the same pass when practical.

**Without independent reader access** (e.g. claude.ai web): the user can run one fresh-reader pass manually. Give them the document and selected questions, then ask what was ambiguous, what context it assumed, and whether contradictions remain.

## Iterating

List the specific issues the reader (sub-agent or human-run test) surfaced, then loop back to Stage 2's per-section refinement for the affected sections.

**Exit condition:** the reader consistently answers correctly and stops surfacing new gaps or ambiguities.
