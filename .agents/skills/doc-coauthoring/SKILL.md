---
name: doc-coauthoring
description: Use for substantial documentation, proposals, technical specs, decision docs, RFCs, or similar structured writing where context transfer and reader clarity matter.
---

# Doc Co-Authoring Workflow

Use the lightest path that produces a correct document. Context gathering, drafting/refinement, and reader testing are available stages, not a mandatory conversation protocol.

## Routing

Start from the user's requested deliverable and existing repository context. If the brief already contains enough facts, structure, and audience information, begin drafting immediately instead of asking the user to choose a workflow.

Use supporting stages only when their outcome is needed:

- Need missing domain context or unresolved facts → [stage-1-context.md](stage-1-context.md)
- Need help structuring or iterating a substantial draft → [stage-2-refinement.md](stage-2-refinement.md)
- Need to verify that a fresh reader can understand a high-impact document → [stage-3-testing.md](stage-3-testing.md)

Do not load all three stage files up front.

## Decision boundary

Derive low-risk choices from the document type, nearby repository conventions, and the material already supplied. Ask the user only when a missing choice materially changes meaning, audience, ownership, commitments, destructive actions, or another high-impact outcome.

Examples of choices that normally do not require permission: heading order, a conventional file location with a clear owner, sentence-level wording, section merging, formatting, or removing obvious repetition.

If the user explicitly wants a collaborative interview, use the relevant stage interactively. Otherwise keep the workflow internal and return the requested artifact without process negotiation.

## Quality target

A finished document should preserve the user's facts and intent, expose material assumptions and trade-offs, avoid duplicate sources of truth, and work for its intended reader. Use reader testing only when the cost is justified by the document's consequence or uncertainty.

When editing an existing artifact, prefer targeted edits over reprinting or recreating unrelated content. Preserve repository conventions and user-authored material outside the requested scope.
