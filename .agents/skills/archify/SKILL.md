---
name: archify
description: Create polished, validated architecture, workflow, sequence, data-flow, and lifecycle/state diagrams as explorable standalone HTML. Use when the user asks to visualize technical structure or flows, convert Mermaid, or produce a checked diagram artifact.
license: MIT
metadata:
  version: "2.16"
  author: tt-a1i
  based_on: Cocoon-AI/architecture-diagram-generator (MIT, v1.0)
---

# Archify

Create a self-contained diagram from a typed JSON specification. Use the shortest authoring loop that produces a truthful, readable artifact; do not read renderer internals or the full reference set up front.

## Route the request

Choose the diagram type from the user's intent:

| Type | Use for |
|---|---|
| `architecture` | Components, services, infrastructure, security/cloud boundaries |
| `workflow` | Processes, approvals, tool calls, runbooks, CI/CD |
| `sequence` | API/request lifecycles, async traces, returns |
| `dataflow` | Pipelines, ETL/ELT, lineage, consumers |
| `lifecycle` | State/status transitions, retries, waiting, terminal states |

When the type is genuinely ambiguous, use `node bin/archify.mjs guide "<scenario>" --json` instead of guessing from a large reference scan.

For ordinary authorship, read only the matching schema, `schemas/common.schema.json`, and one matching JSON example. Mermaid input supplies topology and meaning; author fresh Archify JSON rather than copying Mermaid styling.

## Authoring loop

Write a candidate early, then use diagnostics to decide what deserves another iteration. Start with a clear main path, sparse labels, stable domain wording, and automatic routing. Add manual geometry controls only when a diagnostic shows they are needed.

During editing, validate when the specification changed in a way that can affect the prior result:

```bash
node bin/archify.mjs validate <type> <candidate.json> --quality showcase --json
```

A successful validation remains evidence for the exact same candidate bytes and validation conditions. Do not run the same validation again merely because a later reporting step says to "double-check" an unchanged candidate.

When the artifact is ready, `deliver` is the authoritative final acceptance operation:

```bash
node bin/archify.mjs deliver <type> <candidate.json> <output.html> --quality showcase --json
```

`deliver` validates the snapshot it actually renders and reports the specification/artifact receipt. If the most recent `validate` already passed for unchanged candidate bytes, go directly to `deliver`; do not insert another identical pre-handoff validation. A non-zero `deliver` is not success. Repair only the diagnosed subject, revalidate when the candidate changes, then deliver again.

After a successful delivery, run visual evidence only when the user needs a checked HTML handoff:

```bash
node bin/archify.mjs visual-check <output.html> --json
```

Reuse that visual-check result while the delivered HTML and checked viewport conditions are unchanged. If the HTML changes, the old visual evidence is stale and must be regenerated. `visualReview: "pending"` means screenshots still require actual inspection; containment success alone is not a polish claim.

## Core invariants

- Preserve exact product names, identifiers, commands, protocols, API paths, and environment names.
- One obvious main path is preferable to decorative edge density. Remove low-value relationships before adding manual routing complexity.
- Relationship labels are semantic data; do not delete meaningful protocol/action/direction information merely to make geometry easier.
- Do not invent brands, deployment facts, security boundaries, ownership, regions, or subtitles that the source material does not establish.
- Use built-in brand identity only for a real named product; otherwise omit it.
- Treat passing validation as a constraint on further edits: if you change the candidate afterward, the old receipt no longer proves the new bytes.

Read [`references/authoring-contract.md`](references/authoring-contract.md) only when you need field enums, spacing/geometry rules, repository-evidence handling, or mode-specific placement. Read [`references/delivery-contract.md`](references/delivery-contract.md) when using preview, export receipts, visual review, repository evidence, or post-delivery opening. Read [`references/viewer-runtime.md`](references/viewer-runtime.md) only when the user explicitly asks for viewer capabilities such as motion, guided stories, deep links, search/focus, presentation, or share cards.

Do not inspect renderer, validator, geometry source, tests, or benchmarks before the first candidate. Inspect internals only for an unsupported diagnostic or after focused repairs fail to explain the problem.

## Setup and fallback

Verify the bundled tooling when needed:

```bash
node bin/archify.mjs doctor
```

Use preview only for an active authoring loop; do not start it by default. When shell access is unavailable, use the bundled template and follow the delivery reference rather than pretending automated validation occurred.

## Output

Return the checked artifact path, diagram type, strongest valid receipt, and truthful visual-review status. Never claim success for a non-zero command or claim visual inspection that did not happen.
