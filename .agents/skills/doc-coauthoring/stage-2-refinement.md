# Stage 2: Refinement & Structure

## Setting up structure

If the document structure is clear, ask which section to start with — suggest whichever has the most unknowns (usually the core decision/proposal for decision docs, the technical approach for specs; summaries go last). If the user doesn't know what sections they need, suggest 3–5 sections appropriate for the doc type and confirm.

Once structure is agreed, create the initial scaffold with placeholder text (`[To be written]`) for every section — as an artifact if available, otherwise a markdown file in the working directory (name it appropriately, e.g. `decision-doc.md`).

## Per-section loop

Repeat for each section, starting with the one that has the most unknowns:

1. **Clarifying questions.** Ask 5–10 questions specific to this section's purpose and the context already gathered.
2. **Brainstorming.** Generate 5–20 numbered options depending on complexity — things that might be included, angles not yet mentioned, context that might have been forgotten. Offer to generate more if wanted.
3. **Curation.** Ask what to keep/remove/combine, with brief justification (this teaches priorities for later sections). Accept either numbered selections ("Keep 1,4,7,9"; "Remove 3 (duplicates 1)"; "Combine 11 and 12") or freeform feedback — extract preferences from freeform and apply them.
4. **Gap check.** Ask if anything important is missing given what they selected.
5. **Drafting.** Replace the placeholder with drafted content (`str_replace`, never reprint the whole doc). The first time you draft a section, tell the user: point out *what* to change rather than editing directly themselves — that's what teaches your model of their style for later sections (e.g. "Remove the X bullet — already covered by Y" beats them silently deleting it).
6. **Iterative refinement.** Apply their feedback via `str_replace` until they're satisfied. If they edit the doc directly, note what they changed as a signal of their preferences. After 3 consecutive iterations with no substantial change, ask if anything can be cut without losing information.

## Near completion

At roughly 80% of sections done, re-read the entire document for flow and consistency across sections, redundancy or contradictions, generic filler, and whether every sentence carries weight. When all sections are drafted, do one more full-document pass for coherence and completeness, then ask if they're ready for Stage 3 or want to keep refining.
