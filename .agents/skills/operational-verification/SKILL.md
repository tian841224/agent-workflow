---
name: operational-verification
description: Use when installing, synchronizing, provisioning, migrating, deploying, or validating an external integration, especially before claiming an environment is ready or a change is live.
---

# Operational verification

Match every completion claim to evidence from the environment where the result must work. Static configuration, local mock behavior, local runtime behavior, and remote or production behavior are separate proof layers; evidence from one layer does not establish another.

## Verification flow

1. Name the exact claim, target environment, real entrypoint, and any external mutation that still needs authorization.
2. Validate source and configuration at the static layer: parse schemas, inspect manifests, resolve required values, and confirm the intended artifact is selected.
3. Exercise the closest available runtime layer: build or install, start the process, call a health or real entrypoint, and capture the observable result.
4. When authorized to change the target environment, execute the migration, provisioning, synchronization, or deployment there. Read the resulting state back through the target system instead of treating command exit as proof.
5. Exercise at least one downstream consumer that proves the intended outcome, such as login, download and reopen, CLI invocation, workflow run, API request, or persisted-data query.
6. Report each layer as `Verified`, `Unverified`, or `Blocked`, including the command or observation and the remaining condition.

## Evidence boundaries

| Evidence | Establishes | Does not establish |
| --- | --- | --- |
| File or schema parse | Syntax and declared configuration | Runtime loading or activation |
| Mock or fixture test | Mock contract and local handling | Real authentication or external service behavior |
| Build, install, or process `Up` | Artifact creation or process start | Health, migration state, or usable feature behavior |
| Local runtime smoke test | Behavior in the tested local environment | Remote deployment or production state |
| Remote command success | The command completed against the target | End-user behavior until state is read back through a real consumer |

Treat installer success as the start of verification: follow with integrity/status checks and a real CLI or application entrypoint. Treat a migration file as planned state until it is applied to the intended database and its effect is read back. Treat CI/CD configuration as locally verified until an actual workflow run and deployed service observation exist. Keep demo, mock, staging, and production results explicitly separated.

## Completion report

State the strongest proven outcome first, then list weaker or missing layers. Use `Blocked` only with the concrete external condition or authorization that prevents the next proof step. Never convert a skipped, unavailable, or unrelated check into a pass.
