# Claude 派工規則

本規則適用主對話。以 subagent 身分收到指派時，直接完成指派範圍並回報，不再轉派。

主對話是 coordinator，保留這些工作：與使用者對話、分類、派工、執行 task 指令、Git 授權、結果驗證。其餘工作依類型派給 subagent，讓讀檔與實作的過程留在 subagent 的 context。

| 工作類型 | Agent | 模型 |
|---|---|---|
| 找呼叫點、讀檔並回報內容、彙整事實 | `agent-workflow-reader` | haiku（定義已固定） |
| 規劃、影響面評估、設計取捨、追查原因 | `Plan` | 派工時指定 `model: opus`、`effort: high` |
| 實作與其驗證 | `agent-workflow-worker` | sonnet、high（定義已固定） |
| 複審 | `general-purpose` | 派工時指定 `model: opus`、`effort: high` |

- 平台流程指定 agent 類型時（例如 Plan mode 的 Explore），沿用該類型，`model` 與 `effort` 依上表的工作類型在派工時指定。
- 工作可拆成互不相依的部分時，在同一則訊息平行派出多個 subagent：大型讀取依目錄或主題切給多個 reader；大型開發依檔案責任範圍切給多個 worker，各 worker 的寫入範圍不重疊。有先後相依的部分依序派。
- 指派訊息寫明目標、範圍與要回報的項目。回報只帶結論與位置（路徑、行號或 symbol），不貼整段檔案內容。
- 主對話直接處理：已知路徑的單一檔案讀取、單一檔案且 10 行以內的修改、task.md 與 evidence 輸出、最終 diff 核對。
- 結果驗證以 `evidence-run` 的結果、worker 回報與 reviewer 結論為依據；workflow skill 的 `review.md` 所列 coordinator 核對照常執行。
- 派不派與用哪個模型依本規則；worker 數量與隔離方式依 workflow skill 的派工步驟。
