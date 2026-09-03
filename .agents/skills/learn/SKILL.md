---
name: learn
description: Automatically captures memories the user asks to save, user corrections, settled decisions, and confirmed reusable mistakes.
---

# learn

This is the agent's automatic learning entrypoint; the user does not need to type `/learn`.

## Must-trigger cases

- The user says "remember," "learn," "save," or explicitly asks for this to carry over next time: record it immediately.
- The user corrects the agent's understanding, behavior, process, or answer: record the correction immediately.
- A decision is settled, an alternative is rejected, or the implementation direction changes during the conversation: record the decision immediately.
- An error occurs and its cause and fix are confirmed: record the reusable mistake and how to avoid it; if not yet confirmed, mark it `needs_verification`.

## Recording rules

1. Only capture the reusable conclusion — never save the full conversation, secrets, tokens, passwords, connection strings, or personal data.
2. Choose `kind` based on the event: `explicit`, `correction`, `decision`, `error`, `preference`, or `pitfall`.
3. Use `scope Project` for project-related content; use `scope Global` only for cross-project preferences or general lessons, and only with the user's explicit consent.
4. Run via the runtime:

```text
agent-workflow learn --action Capture --cwd <cwd> --scope Project --kind <kind> --topic <topic> --content <durable conclusion> --source-event <event>
```

5. Reuse an existing entry's `--topic` wording whenever the capture is about the same subject.
   Everything below finds a replaced entry by topic wording, so a fresh phrasing for an old
   subject is what makes a stale entry survive.
6. After writing, briefly tell the user in the reply "Recorded: <summary>." If the content has no lasting value, explicitly state the reason it wasn't recorded.

## Replacing what is already there

Capture returns `related`: live entries whose topic shares a word with this one. Judge each — a
capture that leaves a contradicting entry live gives the next session two current answers to one
question.

| The earlier entry is | Flag | What happens to it |
| --- | --- | --- |
| still true, just narrower or less precise | `--supersedes <id or sha>` | `status: superseded`; readable under `--status superseded`, no longer injected or distilled |
| overturned — it is now wrong | `--forget <id or sha>` | deleted outright, no tombstone |
| about something else, or genuinely complementary | `learn --action Keep --id <a> --id <b> --reason <why>` | both stay live and the pair stops being raised |

Both flags repeat, and both resolve before anything is written, so a wrong id fails the whole
capture rather than leaving the new entry beside the one it was meant to replace.

Delete only what the user has said is wrong. `--forget` and `--action Forget --id <id> --reason
<why>` are irreversible, and a merely superseded entry is the store's audit trail.

## The sweep

`learn --action Conflicts` groups live entries that read as one subject and were never
reconciled — the safety net for a capture that should have replaced an earlier entry and did
not. A count appears at session start when any group is open. Nothing can gate this at write
time: a second entry on one subject is just as likely to be the repetition `distill` exists to
notice as it is to be a contradiction, so the judgement is yours per group.

When the same kind of conclusion has been recorded several times, load the `distill` skill to turn it into a reviewable skill draft.

At session start, a hook automatically loads the current project and part of the shared global memory; memories are reference only — verify against the current repo before use, and use `knowledge --action Search` to actively look up more context when needed.
