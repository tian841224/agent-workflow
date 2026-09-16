# Stage 2: Refinement & Structure

## Setting up structure

If the document structure is clear, start with the section that carries the most uncertainty and state that choice. Ask only when the starting section changes meaning, ownership, or another material outcome. If the structure is unclear, suggest a small set of sections that fit the document and confirm only when the alternatives carry a real trade-off.

Once structure is agreed, create the initial scaffold with placeholder text (`[To be written]`) for every section — as an artifact if available, otherwise a markdown file in the working directory (name it appropriately, e.g. `decision-doc.md`).

## Per-section loop

Repeat for each section, starting with the one that has the most unknowns:

1. **Clarifying questions.** Ask only questions whose answers can change this section's meaning, evidence, ownership, or commitments.
2. **Brainstorming.** Generate alternatives only when comparison will change the decision. Keep the set as small as the choice allows.
3. **Curation.** Choose the clear direction directly. Ask for keep/remove/combine feedback when more than one option remains plausible.
4. **Gap check.** Check only for omissions that could mislead the intended reader or invalidate the decision.
5. **Drafting.** Replace the placeholder with drafted content (`str_replace`, never reprint the whole doc). Preserve the user's voice and repository conventions.
6. **Iterative refinement.** Apply feedback until the section meets its acceptance criteria. Stop when further edits only restate the same point.

## Near completion

When the draft is stable, run one full-document pass for flow, consistency, redundancy, contradictions, and missing acceptance criteria. Use another pass only when the document's consequence or uncertainty justifies it. Deliver when the criteria are met; ask only if a material decision remains unresolved.
