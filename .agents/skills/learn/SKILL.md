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
agent_workflow.cmd learn --action Capture --cwd <cwd> --scope Project --kind <kind> --topic <topic> --content <durable conclusion> --source-event <event>
```

5. After writing, briefly tell the user in the reply "Recorded: <summary>." If the content has no lasting value, explicitly state the reason it wasn't recorded.

At session start, a hook automatically loads the current project and part of the shared global memory; memories are reference only — verify against the current repo before use, and use `knowledge --action Search` to actively look up more context when needed.
