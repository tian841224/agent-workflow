# Antigravity

單進程切換身分扮演各角色（切換時宣告目前身分，不混著做），平行退化為序列；`<project-slug>` 需與使用者約定固定值，任務開始時沿用。

**有 hook 機械支援**：installer 會將 `adapters/antigravity/hooks.json` 合併至 `~/.gemini/config/hooks.json`。它使用 Antigravity 原生的 `PreToolUse`、`PostToolUse`、`Stop`、`PostInvocation` schema；共用 PowerShell hooks 會依 payload 平台格式輸出對應 decision。git 紀律、驗收缺件與收尾三問可由機械 hook 把關，但條文仍是 hook 未信任或失敗時的 fallback。

**Workflow 支援**：installer 會將 Antigravity-native workflow adapter 同步至 `~/.gemini/config/global_workflows`，可在 Antigravity 以 `/agent-workflow` 呼叫；adapter 會引用與 Codex 共用的 canonical rules/skills。記憶擷取與局部整理依 `rules/learning.md` 內化執行。

記憶機制同 Codex：無自動注入，session 開場（至少判軌前）主動讀專案記憶層 `MEMORY.md` 索引與 `overview.md`，沉澱寫入專案記憶層（結構見 `rules/learning.md`）。
