# Claude 派工模型

派工規則依共用入口的「Subagent」段落；本檔只列出各派工情況用哪個 agent 與模型。

| 派工情況 | Agent | 模型 |
|---|---|---|
| 只讀不寫的派工，例如大量讀取 | `Explore` | 派工時指定 `model: haiku` |
| 寫入範圍不重疊的平行實作 | `agent-workflow-worker` | sonnet、high（定義已固定） |
| 複審 | `general-purpose` | 派工時指定 `model: opus`、`effort: high` |
