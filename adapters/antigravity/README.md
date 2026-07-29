# Antigravity adapter

Antigravity reads global instructions from `~/.gemini/GEMINI.md` and supports
rules and skills under the `.agents` structure. The installer links
`GEMINI.md` directly to the canonical `~/.agents/AGENTS.md`; shared rules and
skills remain in the canonical `.agents` directory.

Antigravity uses its own `config/hooks.json` schema. The installer registers
the same lifecycle checks as Codex, with shared PowerShell hooks that accept
Antigravity's `toolCall`/camelCase payload and return its `decision` contract.
Claude `settings.json` and Codex `hooks.json`/execpolicy files are not copied.

The Antigravity-native workflow adapters are installed as global workflows
under `~/.gemini/config/global_workflows`, so they can be invoked with slash
commands such as `/agent-workflow`. The adapter references the
same canonical rules and skills used by Codex.
