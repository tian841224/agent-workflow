---
name: design-and-refine
description: Explore multiple UI directions only when comparison and feedback would improve the design decision. Use for redesign exploration, competing UI approaches, or uncertain visual direction; skip the lab when the user already chose a concrete direction.
metadata:
  source: https://github.com/0xdesign/design-plugin
  upstream: design-and-refine
  version: "1.1.0"
  license: MIT
---

# Design and Refine

Use [`skills/design-lab/SKILL.md`](skills/design-lab/SKILL.md) when the task actually needs design exploration. The lab is adaptive: it reads the closest repository evidence, asks only decision-changing questions, and produces only as many materially different variants as needed.

If the user already supplied a concrete design direction and wants implementation rather than comparison, do not start a design lab; follow that direction within the existing project constraints.

## Platform entrypoints

- Claude Code: `/design-and-refine:start [target]` when the native plugin command is available.
- Other AI agents: invoke this skill directly and use the same adaptive Design Lab rules.

Treat bundled `commands/`, `hooks/`, templates, and feedback components as implementation support. Load them only when the active branch requires them.
