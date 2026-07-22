# Antigravity adapter

Antigravity reads global instructions from `~/.gemini/GEMINI.md` and supports
rules and skills under the `.agents` structure. The installer links
`GEMINI.md` directly to the canonical `~/.agents/AGENTS.md`; shared rules and
skills remain in the canonical `.agents` directory.

This adapter intentionally does not copy Claude `settings.json` or Codex
`hooks.json`/execpolicy files. Antigravity-specific hooks or plugin schemas
should be added here only when their official format is established.
