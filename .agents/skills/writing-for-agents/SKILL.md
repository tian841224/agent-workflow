---
name: writing-for-agents
description: Use when writing or editing any agent or skill document under .agents/. Covers pointer wording, layered progressive disclosure, and the no-op / negation criteria that keep docs from bloating and repeating themselves.
---

# Writing Documents for Agents to Read

This skill is the shared set of criteria for writing `AGENTS.md`, `SKILL.md`, and role files (`.agents/agents/*.md`).

## Context pointers

A skill's `description`, a line in AGENTS.md — both are the same kind of object: a **context pointer**, which names an out-of-context piece of material in standing context and encodes "under what condition should this be read." What makes a trigger reliable is the **wording**, not the quality of the material itself. A necessary-but-weakly-worded pointer is a wording problem — fix the wording first; only fold the material into a standing file if you can't get the wording right.

- Put the lead keyword first — the pointer's trigger word should do its work at the start of the sentence
- One trigger word per branch; synonyms just say the same branch twice — collapse them into one
- Don't repeat in the pointer what the body already says

## Two kinds of cost

- **Context load**: the cost of standing material — a line in AGENTS.md, a skill description, anything that's in context every turn, burning tokens whether or not it's used this time
- **Cognitive load**: the cost of a human remembering which documents exist and when to open which one. The human is the index — this isn't a cost to minimize, it's the price of human judgment, and it's worth paying where it belongs

Material reachable only through a pointer trades the full-text context load for the pointer line's context load. Material with no pointer at all puts its entire cost on cognitive load.

## Progressive disclosure (information hierarchy)

Material splits into two kinds: **step** (actions an agent performs in sequence) and **reference** (definitions/rules looked up as needed). Three layers:

1. **In-file step**: what the agent does, laid out in order
2. **In-file reference**: looked up as needed, often a reasonably flat set (e.g. all the rules for one review pass at the same level) — that's not a smell
3. **Disclosed reference**: pushed out to a separate file, loaded only when a pointer triggers it

**Use branching to decide what to push down**: content every branch needs stays in the body; content only some branches use gets pushed to a disclosed reference. The test: "does every path that reaches this section need to read it?" If no, push it down one level.

Countervailing constraint: splitting a file out has its own cost (one more read). Only split when the extracted content is clearly larger than its pointer line, and only some branches actually read it — splitting for its own sake makes the common path pay an extra I/O.

## The no-op test

An instruction the model would follow by default anyway is a pure context cost when written down, not insurance. The test: does this sentence change the model's behavior relative to its default? Keep it if it changes behavior; delete the whole sentence if it doesn't (not a wording trim). This test is relative to the model, not to the reader's intuition.

## Negation is a failure mode

Steering behavior with "don't," "must not," "forbidden" pulls the forbidden behavior into context and makes it more salient, not less common. State the target behavior positively instead ("write exactly one line" beats "don't add explanation"). Keep negation only for hard constraints that can't be stated positively (e.g. secrets/credentials must never be written).

## Single source of truth

A given rule is authoritative in exactly one file; everywhere else points to it, never restates it. Restating creates two places to keep in sync on every change, and inflates that rule's apparent weight in context.

## Sediment

Only-adding-never-removing is the default fate: adding feels safe, removing feels risky. Without an active pruning habit, docs accumulate like sediment layers. Every time you edit, check in passing: does this section still affect current behavior? If not, delete it — don't keep it "just in case."
