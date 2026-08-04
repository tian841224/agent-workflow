# Claude Code

角色為真 subagent（`agents/*.md` spawn 時自動載入）；重軌 R2/R3 可真平行。重軌 R2 續用 PM 時以 SendMessage 接續 R1 同一隻 subagent，不重新 spawn。四支 hook 全機械強制，由 `settings.json` 自動觸發：`git-guard`（PreToolUse，攔截破壞性 git 操作）、`post-edit-check`（PostToolUse，語言快檢）、`stop-check`（Stop，驗收缺件掃描）、`knowhow-check`（Stop，收尾三問放行檢查）。專案記憶層有 auto-memory 自動注入索引，session 開場不需手動讀。
