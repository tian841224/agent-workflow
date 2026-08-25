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

## Review lenses

Select only the lenses relevant to the request:

- dependency direction between delivery, application, domain, persistence, and integrations;
- module cohesion, interface depth, seams, and responsibility concentration;
- DTO, domain model, persistence model, and external contract separation;
- transaction ownership, consistency boundaries, retries, idempotency, and failure handling;
- authentication, authorization, error mapping, observability, and configuration placement;
- mock, demo, seed, fixture, and production behavior boundaries;
- client page/component/composable/API boundaries and server-state versus client-state ownership;
- test levels, public seams, contract coverage, and unverified runtime behavior.

For language- or framework-specific findings, state the technology as evidence rather than turning it into a universal rule.

## Finding format

For every material finding, include:

1. severity: `critical`, `high`, `medium`, or `low`;
2. current evidence with absolute path and line or symbol;
3. impact on change safety, testing, operations, or production behavior;
4. smallest recommended boundary change;
5. validation needed and whether it was actually run.

Do not treat file length alone as a defect. A large file is a signal; the finding is mixed responsibility, poor locality, missing seam, or difficult verification.

## Recommendation order

Prefer incremental migration over a rewrite:

1. record the current entrypoint and dependency path;
2. stop new cross-layer leakage;
3. extract a DTO, port, or adapter seam only where the next change needs it;
4. isolate mock and demo behavior;
5. split oversized modules along stable business capabilities;
6. add boundary, contract, or regression tests;
7. repeat the review against the integrated change.

Use `codebase-design` when the review needs decisions about deep modules, interface depth, adapter roles, or seam placement. Use the repository's testing and workflow skills for implementation and verification rules instead of duplicating them here.

## Non-goals

Keep the review focused on the requested architecture question. State explicit non-goals when useful, such as framework migration, broad renaming, performance benchmarking, security penetration testing, or full runtime acceptance.
