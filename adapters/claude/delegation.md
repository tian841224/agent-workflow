# Claude 派工規則

本規則適用主對話。以 subagent 身分收到指派時，直接完成指派範圍並回報，不再轉派。

何時派 subagent 依共用入口的「Subagent」段落；本檔只決定派哪個 agent 與模型。

| 派工情況 | Agent | 模型 |
|---|---|---|
| 會擠滿主對話的大量讀取、依主題切分的平行讀取 | `Explore` | 派工時指定 `model: haiku` |
| 寫入範圍不重疊的平行實作 | `agent-workflow-worker` | sonnet、high（定義已固定） |
| 複審 | `general-purpose` | 派工時指定 `model: opus`、`effort: high` |

- 平台流程指定 agent 類型時（例如 Plan mode 的 Explore），沿用該類型，`model` 與 `effort` 依上表的派工情況在派工時指定。
- 平行的部分在同一則訊息派出多個 subagent，各 worker 的寫入範圍不重疊；有先後相依的部分由主對話依序處理。
- 回報只帶結論與位置（路徑、行號或 symbol），不貼整段檔案內容。
- worker 數量與隔離方式依 workflow skill 的派工步驟。
