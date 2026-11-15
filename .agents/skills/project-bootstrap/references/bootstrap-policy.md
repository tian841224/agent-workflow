# Bootstrap 的規範來源

`project-bootstrap` 只協調分析與文件初始化，不持有第二套專案文件 schema。

- 文件分類、路徑、frontmatter、`covers`、索引與必要區塊：`project-docs/references/doc-types.md`。
- 架構診斷與證據等級：`architecture-review/SKILL.md`。
- 模組邊界設計：`codebase-design/SKILL.md`（只有需要時載入）。
- 持久化決策：`learn/SKILL.md`。
- managed_change 與驗證：全域 `AGENTS.md` 和 `workflow/SKILL.md`。
- 跨任務文件載入：現有 `project-doc Lookup` 與 `task-init --paths`。

初始化不是重構授權；任何建議都應清楚區分「目前程式的事實」與「未採用的方案」。沒有阻擋性問題時直接補齊文件，非阻擋性建議不延誤交付。
