<!-- This file holds human-readable intent only. Classification, lifecycle, evidence, review,
     validation, hashes, waivers, and project-doc bookkeeping live in task.json or generated
     `agent-workflow task-report` output. task.json is written only through the runtime CLI.
     Write this file, including the acceptance cases, before task-init: the goal and how it will be
     accepted are settled before development starts. -->

# <Task title>

## Goal

<What needs to be accomplished or confirmed>

## Scope

<Which behaviors will be modified/reviewed/verified>

<!-- Freeze-required tasks add this inside Scope:
### Non-goals and compatibility
<What this task deliberately preserves or excludes>
-->

## Completion criteria

- [ ] <Expected behavior or review goal completed>

### Acceptance cases

<!-- Required for every code-change task; delete this section otherwise, because every case listed
     here becomes a gate item that must be run. One case per observable behavior; Verify is the exact
     command whose exit code 0 proves the case (a UI case runs the e2e test). -->

- **AC1** <case title>
  - Given <precondition, e.g. the user enters a valid email and password>
  - When <action, e.g. the user clicks the login button>
  - Then <observable result, e.g. the API returns a valid JWT and the page redirects to home>
  - Verify: `<command, e.g. npx playwright test e2e/login.spec.ts -g AC1>`
