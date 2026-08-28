---
name: design-and-refine
description: Explore UI design directions through a structured interview, five meaningfully different variations, interactive feedback, refinement, and an implementation plan. Use when the user wants to design or redesign a component or page, compare UI approaches, or make a frontend design decision.
metadata:
  source: https://github.com/0xdesign/design-plugin
  upstream: design-and-refine
  version: "1.1.0"
  license: MIT
---

# Design and Refine

Use the complete workflow in [`skills/design-lab/SKILL.md`](skills/design-lab/SKILL.md). Read that file before beginning a design session; it defines the interview, project style inference, variation generation, feedback overlay, refinement, final preview, cleanup, and implementation-plan requirements.

## Platform entrypoints

- Claude Code: `/design-and-refine:start [target]` when the native plugin command is available.
- Other AI agents: invoke this skill directly and follow the same Design Lab workflow.

Use the bundled templates under `templates/` and feedback components under `templates/feedback/`. Treat the upstream `commands/` and `hooks/` files as Claude plugin integration metadata; the platform-neutral workflow is the root skill plus `skills/design-lab/SKILL.md`.
