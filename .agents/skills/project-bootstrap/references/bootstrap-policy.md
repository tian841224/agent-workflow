# Bootstrap 的規範來源

`project-bootstrap` 只協調分析與文件初始化，不持有第二套專案文件 schema。

- 文件分類、路徑、frontmatter、`covers`、索引與必要區塊：`project-docs/references/doc-types.md`。
- 架構診斷與證據等級：`architecture-review/SKILL.md`。
- 模組邊界設計：`codebase-design/SKILL.md`（只有需要時載入）。
- 持久化決策：`learn/SKILL.md`。
- managed_change 與驗證：全域 `AGENTS.md` 和 `workflow/SKILL.md`。
- 跨任務文件載入：現有 `project-doc Lookup` 與 `task-init --paths`。

初始化不是重構授權；任何建議都應清楚區分「目前程式的事實」與「未採用的方案」。沒有阻擋性問題時直接補齊文件，非阻擋性建議不延誤交付。

## 文件密度與規範歸屬

初始化時先維持三個入口：`AGENTS.md`、`docs/architecture.md`、`docs/structure.md`。跨層依賴寫 architecture；檔案命名、放置與專案特有的編碼／測試慣例寫 structure 的 Placement rules；執行檢查指令寫 AGENTS。短規範就地維護，避免只為了分類增加文件。

模組、流程、API 與決策文件遵守 project-docs 原有的建立條件，Bootstrap 不一次補齊全部模組。公開 API 的文件仍遵守 project-docs 對新增或修改端點的規則。

目前 Lookup／Check 不支援 coding-standards、testing-standards、patterns 這些獨立 doc_type；要拆分時必須先完成既有文件機制的相容性擴充與測試，不可建立無法被日常任務找到的孤兒文件。對可直接從程式碼查得的模式只提供路徑，不複製實作。
