# Antigravity 派工模型

派工規則依共用入口的「Subagent」段落；本檔只列出各派工情況用哪個角色與模型。

| 派工情況 | TypeName | 模型 |
|---|---|---|
| 只讀不寫的派工，例如大量讀取 | `reader` | `Model: "inherit"` |
| 寫入範圍不重疊的平行實作 | `worker` | `Model: "inherit"` |
| 複審 | 新的 `worker`，指派唯讀審查範圍 | `Model: "inherit"` |

主對話與所有 subagent 使用最新的 Flash 模型與 High effort。invoke_subagent 的 `Model` 與 `Workspace` 都指定 `"inherit"`，並在 prompt 中要求以 High effort 分析與驗證。
