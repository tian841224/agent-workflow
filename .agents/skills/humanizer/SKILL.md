---
name: humanizer
description: Rewrite AI-sounding prose when requested or when a concrete style problem needs correction; preserve meaning, facts, and voice.
license: MIT
metadata:
  version: "2.11.2"
---

# Humanizer

Use this skill only when the user asks for a rewrite or the text shows a concrete AI-writing problem. Preserve every claim, fact, citation, link, and deliberate voice choice. Do not invent factual details. In fiction, follow the requested creative brief while preserving established story facts.

## Rewrite

1. Read the source and any writing sample before editing. A supplied sample sets the voice and dash style.
2. Identify only patterns that are present. Read [patterns](references/patterns.md) for the relevant group instead of loading every example.
3. Rewrite the passage as a whole so the point, actor, rhythm, and level of formality are clear.
4. Check that no claim, name, number, date, quote, citation, code block, YAML field, or link target was added, lost, or changed.
5. Keep useful uncertainty, objections, alternatives, personality, and intentional repetition. A single polished phrase is not proof of AI writing.

## Output

Return the final rewrite by default. Include a draft, pattern list, or review questions only when the user asks for them.

- **Pasted text:** return only the final rewrite unless the user asks for notes.
- **File mode:** write only the final prose to the named file. Keep code blocks, YAML metadata, data, and link targets unchanged, then report the change briefly.
- **Embedded mode:** return only the final text.

## Source

The pattern groups are adapted from [Wikipedia: Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing), maintained by WikiProject AI Cleanup.
