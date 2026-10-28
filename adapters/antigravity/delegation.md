# Antigravity 派工與協同規則

本規則適用主對話。以 subagent 身分收到指派時，直接完成指派範圍並回報，不再轉派。

何時派 subagent 依共用入口的「Subagent」段落；本檔只決定派哪個角色、怎麼派與回報格式。

## 模型配置原則

- **全角色統一配置**：主對話與所有 Subagent 全面使用最新的 Flash 模型，並採用 High 努力值（高思考深度）。
- 派工時 invoke_subagent 的 `Model` 參數指定為 `"inherit"`（繼承主對話之 Flash High 配置）或 `"flash"`，並在 Prompt 中要求以 High effort 進行深入分析與驗證。

## 派工情況與 Subagent 對應表

| 派工情況 | 執行角色 | invoke_subagent 參數 | 回報契約（維持主對話精簡） |
|---|---|---|---|
| **大量讀取 / 平行讀取**<br>（會擠滿主對話的跨檔閱讀、依主題切分的檢索） | `reader` | `TypeName: "reader"`<br>`Model: "inherit"`<br>`Workspace: "inherit"` | 不回傳整段原始碼。<br>僅回傳結構化結論摘要、關鍵檔案路徑、行號區間（格式如 `[file.ts#L10-L25](file:///...)`）。 |
| **平行外部調查**<br>（互不相依的廣泛架構調查、Web 搜尋） | `research` | `TypeName: "research"`<br>`Model: "inherit"`<br>`Workspace: "inherit"` | 條列式整理核心發現、取捨分析與建議路徑。 |
| **平行實作**<br>（寫入範圍不重疊的程式碼編寫、單元測試撰寫與修復） | `worker` | `TypeName: "worker"`<br>`Model: "inherit"`<br>`Workspace: "inherit"` | 實作、編譯、局部單元測試除錯均在 Subagent 內部完成。<br>完成後僅回報：<br>1. 修改的檔案路徑清單<br>2. 執行的本地驗證指令與結果<br>3. 任何未涵蓋的邊界或 blocker |

## 執行與回報閉環流程

1. **派工**：在同一次 invoke_subagent 的 `Subagents` 陣列派出這批互不相依的 `reader`、`research` 或 `worker`，各 `worker` 的寫入範圍不重疊；有先後相依的部分由主對話依序處理。
2. **非同步等待**：發出派工後結束工具調用，等待系統非同步喚醒（無需輪詢）。
3. **整合驗證**：收到回報後，主對話核對修改清單，親自執行整合驗收指令。驗收失敗時由主對話修正，或把具體錯誤交回原 `worker` 修復。
