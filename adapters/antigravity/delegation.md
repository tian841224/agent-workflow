# Antigravity 派工與協同規則

主對話為 coordinator（Team Leader / 大腦），核心職責為與使用者溝通、架構規劃、派工調度、整合驗證與結案。
為保持主對話 Context 極簡與決策敏銳度，嚴禁在主對話中進行大規模程式碼閱讀或直接除錯修改，所有讀取與開發任務一律依類型分派給 Subagent。

## 模型配置原則

- **全角色統一配置**：主對話與所有 Subagent 全面使用最新的 Flash 模型，並採用 High 努力值（高思考深度）。
- 派工時 invoke_subagent 的 `Model` 參數指定為 `"inherit"`（繼承主對話之 Flash High 配置）或 `"flash"`，並在 Prompt 中要求以 High effort 進行深入分析與驗證。

## 任務類型與 Subagent 派工表

| 任務類型 | 執行角色 | invoke_subagent 參數 | 回報契約（維持主對話精簡） |
|---|---|---|---|
| **讀取 / 檢索**<br>（找呼叫點、跨檔閱讀、搜尋 symbol、整理事實） | `reader` | `TypeName: "reader"`<br>`Model: "inherit"`<br>`Workspace: "inherit"` | **嚴禁回傳整段原始碼**。<br>僅回傳結構化結論摘要、關鍵檔案路徑、行號區間（格式如 `[file.ts#L10-L25](file:///...)`）。 |
| **長篇調研 / 外部探索**<br>（廣泛架構調查、Web 搜尋） | `research` | `TypeName: "research"`<br>`Model: "inherit"`<br>`Workspace: "inherit"` | 條列式整理核心發現、取捨分析與建議路徑。 |
| **開發 / 實作**<br>（程式碼編寫、功能修改、單元測試撰寫與修復） | `worker` | `TypeName: "worker"`<br>`Model: "inherit"`<br>`Workspace: "inherit"` | 實作、編譯、局部單元測試除錯均在 Subagent 內部完成。<br>完成後僅回報：<br>1. 修改的檔案路徑清單<br>2. 執行的本地驗證指令與結果<br>3. 任何未涵蓋的邊界或 blocker |
| **規劃 / 決策 / 驗證**<br>（需求分析、架構取捨、規格制定、最終驗收） | 主對話 | 不開啟 Subagent，主對話直接處理 | 負責 `task.md` 制定、執行整合測試（`evidence-run`）、Review 與結案。 |

## 主對話直接處理的例外門檻（Bypass 條件）

為避免極微小操作產生多餘的調度開銷，僅以下情境主對話可自行處理：
1. 已知精確路徑且讀取範圍小於 20 行的單一檔案讀取。
2. 5 行以內的極小型修改（例如修正錯字或微調單一設定值）。
3. Task 生命週期指令（如 `task-init`、`task-write`、`evidence-run`）與 Git 操作授權確認。

## 執行與回報閉環流程

1. **規劃與派工**：主對話依需求拆解任務，透過 invoke_subagent 指派 `reader` 或 `worker`。
2. **非同步等待**：發出派工後結束工具調用，等待系統非同步喚醒（無需輪詢）。
3. **整合驗證**：收到 `worker` 回報後，主對話核對修改清單，親自執行整合驗收指令。若驗收失敗，將具體錯誤打包再指派 `worker` 修復；驗收通過後由主對話完成 Review 並向使用者報告。

