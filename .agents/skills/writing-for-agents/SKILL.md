---
name: writing-for-agents
description: "編輯 `.agents/` 內的 agent 或 skill 文件時使用；依循 context pointer、漸進揭露、no-op 與 negation 規則撰寫。"
---

# Writing Documents for Agents to Read

This skill is the shared set of criteria for writing `AGENTS.md`, `SKILL.md`, and role files (`.agents/agents/*.md`).

涉及 agent 或 skill 的架構、contract 或跨平台 adapter 時，先讀 [architecture.md](../../../docs/architecture.md)。

## Context pointers

A skill's `description`, a line in AGENTS.md — both are the same kind of object: a **context pointer**, which names an out-of-context piece of material in standing context and encodes "under what condition should this be read." What makes a trigger reliable is the **wording**, not the quality of the material itself. A necessary-but-weakly-worded pointer is a wording problem — fix the wording first; only fold the material into a standing file if you can't get the wording right.

- Put the lead keyword first — the pointer's trigger word should do its work at the start of the sentence
- One trigger word per branch; synonyms just say the same branch twice — collapse them into one
- The pointer carries only the trigger; details live in the body
- Trigger text (a `description`, an AGENTS.md pointer line) may carry calibrated urgency, since skills tend to under-trigger; behavior text in the body explains instead of shouting

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

Keep what only the author knows: audience, environment facts, the quality bar, tool contracts, hard judgment calls, and the reasons behind constraints. Cruft is a specific instruction the model no longer needs, never a matter of length.

## Negation is judged by provenance

Style prohibitions without a stated reason ("don't be verbose", banned-phrase lists) pull the forbidden behavior into context; restate them as the target behavior ("write exactly one line"). Keep a prohibition when it encodes a real constraint (security, data, irreversible operations) or a failure that still reproduces on the current model, and put its reason beside it. Classify each line separately.

## Register and specificity

- Write at normal volume. `MUST`/`CRITICAL`/caps are a scoped fix for one instruction shown to be underweighted, with its reason; when every rule is critical the markers carry no information and the output turns rigid.
- Write requirements as requirements: "Include a summary." Hedges like "try to" or "if possible" get read as permission to skip.
- Match specificity to fragility: judgment tasks get the goal, constraints, and how to verify; exact step scripts only where exactly one sequence is safe (destructive commands, auth, compliance).
- Examples get copied in length, tone, and structure. Use several varied ones labeled illustrative, or only ones that pin a format-sensitive output.

## Write the current rule

Write as if the current rules are the only ones that ever existed. Change history ("now", "no longer", "changed to", incident IDs, PR numbers, date conditionals, pinned model names) goes in commit messages, PRs, or `docs/history/`.

Before encoding a single session's stumble as a rule, check that it would have helped most recent sessions. When narrow conditionals pile up, generalize the principle.

## Single source of truth

A given rule is authoritative in exactly one file; everywhere else points to it, never restates it. Restating creates two places to keep in sync on every change, and inflates that rule's apparent weight in context.

## Sediment

Only-adding-never-removing is the default fate: adding feels safe, removing feels risky. Without an active pruning habit, docs accumulate like sediment layers. Every time you edit, check in passing: does this section still affect current behavior? If not, delete it — don't keep it "just in case."

A rule that a hook, schema, or lint can enforce belongs there, not in prose. Deleting is a hypothesis: grep the repo for the exact text first (contract lint and tests may match it), and if behavior regresses, re-add it in its minimal form.

## 新增專案 skill

新增 skill 時，先詢問使用者要列為必裝或選擇性，再更新 managed manifest。提煉的草稿先放在 `skill-drafts/`；只有使用者在對話中明確同意才執行 Promote，操作依 [distill](../distill/SKILL.md)。
