# Codex

單進程切換身分扮演各角色（切換時宣告目前身分，不混著做），平行退化為序列。任務目錄的 `<project-slug>` 沒有自動路徑編碼，任務開始時與使用者約定固定 slug（建議用 repo 名稱）並沿用。

**hooks 有機械支援**：`~/.codex/hooks.json` 已隨 installer 寫入同一套 `stop-check.ps1`／`knowhow-check.ps1`／`post-edit-check.ps1`（見 `adapters/codex/hooks.json`），與 Claude Code 共用同一份腳本——但須先在 `/hooks` 審查信任才會生效；未信任或執行失敗時，本檔案列出的規則要手動遵守（git 紀律、收尾三問、驗收缺件自查）。

已知限制：`knowhow-check.ps1`／`stop-check.ps1` 預設檢查 `~/.claude/projects/<slug>/...`（可用環境變數 `AI_WORKFLOW_HOME` 覆蓋），若 Codex 的記憶/acceptance 實際落在別處（例如專案 repo 內 `AGENTS.memory/`），hook 的「記憶已更新」判斷可能找不到最新檔案——這種情況下仍要在回覆文字明寫「已沉澱」/「無可沉澱」，這是 hook 讀 transcript 辨識的主要訊號，不完全依賴記憶目錄時間戳。

記憶無 Claude 式自動注入：session 開場（至少判軌前）主動讀專案記憶層 `MEMORY.md` 索引與 `overview.md`，不能假設「應該記得」上次內容；沉澱寫入 repo 內記憶層（既有慣例或 `AGENTS.memory/`，結構見 `rules/learning.md`）。
