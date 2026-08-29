---
name: architecture-review
description: Use when reviewing software architecture, detecting cross-layer coupling, oversized modules, contract drift, or migration risks in an existing codebase.
---

# Architecture review

Produce an evidence-based review of the current codebase. This skill is diagnostic and planning-oriented; it does not authorize implementation unless the user separately requests a change.

## Review posture

Inspect the actual source tree, build manifests, tests, configuration, and relevant documentation. Treat current code as the primary evidence and label documentation-only statements as planned design. Preserve dirty-worktree boundaries.

Distinguish:

- `static fact`: directly visible in source or configuration;
- `hypothesis`: a likely risk requiring runtime or test confirmation;
- `runtime proof`: demonstrated by a command, test, trace, or deployed observation.

Use the repository's vocabulary and existing architecture as the baseline. Do not recommend a framework replacement, directory rewrite, microservices split, or new abstraction merely because an external architecture template uses it.

## Finding format

For every material finding, include:

1. severity: `critical`, `high`, `medium`, or `low`;
2. current evidence with absolute path and line or symbol;
3. impact on change safety, testing, operations, or production behavior;
4. smallest recommended boundary change;
5. validation needed and whether it was actually run.

Do not treat file length alone as a defect. A large file is a signal; the finding is mixed responsibility, poor locality, missing seam, or difficult verification.

Prefer incremental migration over a rewrite. When the review needs decisions about deep modules, interface depth, adapter roles, or seam placement, read [codebase-design](../codebase-design/SKILL.md) and state those findings in its terms.

## Non-goals

Keep the review focused on the requested architecture question. State explicit non-goals when useful, such as framework migration, broad renaming, performance benchmarking, security penetration testing, or full runtime acceptance.
