---
name: doc-coauthoring
description: Guide users through a structured workflow for co-authoring documentation. Use when user wants to write documentation, proposals, technical specs, decision docs, or similar structured content. This workflow helps users efficiently transfer context, refine content through iteration, and verify the doc works for readers. Trigger when user mentions writing docs, creating proposals, drafting specs, or similar documentation tasks.
---

# Doc Co-Authoring Workflow

Guide the user through three stages: Context Gathering, Refinement & Structure, Reader Testing. Each stage's full procedure is disclosed in its own file — read it when you enter that stage, not before.

## Offering the workflow

Trigger on: "write a doc", "draft a proposal", "create a spec", specific doc types ("PRD", "design doc", "decision doc", "RFC"), or the user starting a substantial writing task.

Explain the three stages briefly (context gathering → section-by-section drafting → reader testing to catch blind spots before others read it) and ask if they want this structured approach or prefer freeform. If they decline, work freeform. If they accept, go to [stage-1-context.md](stage-1-context.md).

## Stage 1: Context Gathering

**Goal:** close the gap between what the user knows and what you know, so later guidance is specific instead of generic.

Full procedure (initial questions, info-dump handling, integrations, clarifying questions): [stage-1-context.md](stage-1-context.md).

**Exit condition:** you can ask about edge cases and trade-offs without needing the basics re-explained. Then move to Stage 2.

## Stage 2: Refinement & Structure

**Goal:** build the document section by section — brainstorm options, let the user curate, draft, refine.

Full procedure (structure setup, the five-step per-section loop, near-completion pass): [stage-2-refinement.md](stage-2-refinement.md).

**Exit condition:** every section is drafted and refined, a full read-through found no contradictions or filler. Then move to Stage 3.

## Stage 3: Reader Testing

**Goal:** verify the doc works for a reader with no context, not just for its authors.

Full procedure (predicting reader questions, testing with a sub-agent or manually, iterating on gaps): [stage-3-testing.md](stage-3-testing.md).

**Exit condition:** a fresh reader consistently answers correctly and surfaces no new gaps. Then do a final pass: recommend the user re-read it themselves (they own the doc), double-check facts/links, and confirm it achieves the impact they wanted.

## Throughout all stages

- Be direct and procedural; explain rationale briefly when it affects user behavior, don't "sell" the approach.
- If the user wants to skip a stage or seems frustrated, offer to adjust the process — they keep agency over it.
- Don't let context gaps accumulate; ask as they come up, not in a batch later.
- Use `str_replace` for edits, never reprint the whole doc; provide the artifact link after each change.
