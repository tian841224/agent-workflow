# Weekly Memory Review

`weekly-memory-review.mjs` reviews the current indexed memory and produces decision material for the user. It combines the runtime `skill-draft Scan` result with conservative keyword-based evidence grouping.

The script is intentionally advisory:

- it does not create a skill draft;
- it does not Promote or Reject anything;
- it does not modify `MEMORY.md`;
- the user decides whether a candidate becomes a project document, task rule, existing-skill update, new skill, or nothing.

## Run manually

From the repository root:

```text
npm run memory-review
```

Write a report to a chosen path:

```text
npm run memory-review -- --output C:\Users\jacky\.agent-workflow\reports\weekly-memory-review.md
```

Override the memory source or threshold when needed:

```text
node scripts/weekly-memory-review.mjs --memory-path <MEMORY.md> --min-occurrences 3
```

## Review procedure

```text
user or maintenance session starts a review
      |
      v
read MEMORY.md + run skill-draft Scan
      |
      v
group evidence and show proposed destinations
      |
      v
user decides: doc / existing skill / new skill / task rule / reject
      |
      v
only after approval: create Draft, update doc, Promote, or Reject
```

The report must distinguish independent occurrences from duplicated records in one rollout. Project-specific facts belong in the relevant project document; a new skill is appropriate only when the procedure remains useful outside the named repository.

## When it runs

The review is maintenance, never part of task delivery: `close-task` only closes the task and does not
check or prompt for it. Run it explicitly. `agent-workflow memory-review --action Check` reports
whether seven days have passed since the last prompt or completed review; after a review, record it
with `agent-workflow memory-review --action Reviewed`.
