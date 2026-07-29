# 平台差異（路由頁——先判斷自己是哪個平台，只讀那一份）

跨平台通用流程見 SKILL.md／light.md／standard.md／heavy.md；平台專屬細節分開放，**只讀你目前所在平台的那份**，不要三份都讀：

| 你正在哪裡執行 | 讀哪份 |
|---|---|
| Claude Code（有 `Task`/subagent 工具、常駐檔是 `CLAUDE.md`） | [platform-claude.md](platform-claude.md) |
| Codex CLI（常駐檔是 `~/.codex/AGENTS.md`，用 `hooks.json` 而非 `settings.json`） | [platform-codex.md](platform-codex.md) |
| Antigravity（常駐檔是 `~/.gemini/GEMINI.md`） | [platform-antigravity.md](platform-antigravity.md) |

判斷不出自己是哪個平台時，優先看常駐檔檔名／載入路徑（`CLAUDE.md` vs `AGENTS.md` vs `GEMINI.md`）；仍不確定就三份都讀一次，不要用「不知道」當理由跳過該讀的平台限制（尤其 hook 是否機械強制、記憶是否自動注入，直接影響能不能安全省略手動檢查）。

原則：**沉澱三問優先靠 hook 強制放行，該平台不支援 hook 時才退回條文自律**（Claude Code／Codex／Antigravity 均有 hook）——細節在各自檔案裡。三平台共用 canonical rules/skills；Antigravity 另外使用 native workflow adapters。
