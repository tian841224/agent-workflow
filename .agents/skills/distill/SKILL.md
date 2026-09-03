---
name: distill
description: Turn accumulated evidence into a rule. Use when the SessionStart context reports recurring memory patterns or review causes at threshold, when the user asks to turn repeated corrections into a rule, or when the same kind of conclusion or the same kind of review push-back has happened several times.
---

# distill

Two things accumulate on their own: memory entries written by [learn](../learn/SKILL.md), and review
causes recorded per push-back round. Both stay inert until enough of the same thing has happened.
This skill is the single exit — it decides what the accumulation has earned.

The runtime counts and routes; you write the prose; the user decides what takes effect.

## Source 1 — recurring memory patterns

```text
agent-workflow skill-draft --action Scan --cwd <cwd>
```

Each cluster carries `cluster_id`, `topic`, `occurrences` and `source_entries`. Read the entries
behind a cluster before judging it — a topic and a count are routinely too thin to draft from.

Before counting the threshold as earned:

- Collapse entries from the same rollout, source event, or user decision into one independent
  occurrence. Several records of one correction are one piece of evidence.
- Confirm every member states the same procedure or decision rule. A shared broad token such as
  `skill`, `test`, or `workflow` is not semantic agreement.
- Recheck the current `AGENTS.md`, skills, schemas, source, and configuration. Superseded decisions
  and drift-prone environment snapshots are evidence about history, not rules for future work.
- Choose the narrowest existing destination first: update a project doc, task rule, global guard, or
  existing skill when it already owns the behavior. Create a new skill only when none owns it.

Draft it when all six hold:

- The threshold is met by independent occurrences, not duplicated records of one event.
- The cluster is semantically coherent after reading every source entry.
- The entries describe a **repeatable procedure or decision rule**, not one project's facts.
- A future session would act differently for having read it.
- No installed skill already covers this — check the skill list yourself; Scan does not match against it.
- The rule stays true outside the specific files the entries mention.

Otherwise leave it in memory or reject the candidate. Reject a cluster that is incoherent,
superseded, or already covered so the same stale pattern does not return on every scan.

## Source 2 — review causes at threshold

```text
agent-workflow review-cause --action Escalate --min-occurrences <n>
```

Each group carries `cause`, `remedy_kind`, `occurrences`, `finding_ids`, `paths` and the per-round
`evidence`. The remedy follows the cause — the same push-back means different work depending on what
was actually missing:

| remedy_kind | Cause | What to produce |
| --- | --- | --- |
| `project_doc` | `doc_gap` | Write the missing doc per [project-docs](../project-docs/SKILL.md). Run `agent-workflow project-doc --action Lookup --paths <the group's paths>` to see which of them no doc covers. |
| `task_spec` | `prompt_gap` | Propose the concrete field or rule to add to `templates/task.md` or `AGENTS.md`, so the next task states the requirement up front. |
| `skill` | `convention_gap`, `context_miss` | Draft a skill, below. |

`logic_error` never reaches this list: a plain coding mistake has no input to fix.

After the remedy lands, close the findings that earned it:

```text
agent-workflow review-cause --action Resolve --id <id>,<id> --status applied
```

Use `--status rejected` when the group is real but the remedy is not worth it, and say why in the
note — rejected findings stop counting either way.

## Drafting a skill

Load [writing-for-agents](../writing-for-agents/SKILL.md) first — a draft is judged as a skill
document, so trigger wording and progressive disclosure apply from the first version.

```text
agent-workflow skill-draft --action Draft --name <slug> --description <trigger sentence> --content <body> --cluster-id <cluster_id> --source-entry <sha>,<sha>
```

For a memory cluster, pass every id from `source_entries`: that set is what suppresses a rejected pattern
later, and a partial set makes the same cluster resurface.

The draft lands in `<state>/skill-drafts/<name>/SKILL.md`, outside every platform skill directory.
It is inert until promoted.

## Handing it to the user

Show what you produced and ask for a decision. Every remedy needs the user's explicit approval in the
conversation; the flags below record that approval and never substitute for it.

```text
agent-workflow skill-draft --action Promote --name <slug> --approved-by-user
agent-workflow skill-draft --action Reject --name <slug> --note <why>
```

Promote writes `<state>/skills/<name>/SKILL.md` and makes it visible to every installed platform
immediately. Reject records the cluster's current entries as suppressed, so the pattern returns only
after enough genuinely new entries accumulate.
