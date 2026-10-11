## Codex 任務委派

本節由主對話（coordinator）執行。子代理依角色與指派範圍工作，後續委派由主對話持有。

- 簡單問答、單句改寫與不需查證的說明由主對話直接回答。需要查閱程式碼、分析、規劃、修改、除錯或執行驗證的實際工作，預設透過原生 spawn 委派；單一工作也指派一個子代理。主對話負責釐清需求、切分工作、傳遞必要脈絡、協調依賴及最終驗收，持有 managed lifecycle、gate、證據登錄與必要的直接驗收操作。
- 程式查詢與事實蒐集交給 `agent-workflow-reader`；實作、修正、整合與測試交給 `agent-workflow-worker`；有架構方向、技術取捨或需求分析的規劃交給 `agent-workflow-planner`。混合任務依依賴順序交接；整合與測試指定一個 worker，主對話評估結果及驗收。
- 目標與驗收條件明確時，由 worker 自行讀碼、實作與測試；只在需要事實查詢或規劃判斷時啟動對應角色。
- workflow 要求獨立程式審查時，依其 review procedure 啟動新的 `agent-workflow-worker`，明確指派唯讀審查範圍與程序，使用 Sol／max 並維持審查獨立性。Reader 只提供事實，不能代替 review；實作 worker 的自查不能代替獨立審查。
- 大型讀取、分析或開發開始前，主對話必須評估拆分，列出子任務、依賴、角色、範圍、讀取／寫入 ownership 與各自驗收。任務大小、獨立性與協調收益由主對話依實際工作判斷。
- 有至少兩個獨立子任務，而且收益足以抵銷協調成本時，必須平行：先啟動這批可執行的子代理，再等待結果。可啟動多個 Reader 或多個 Worker；Reader 可讀相同檔案，但回答不同問題，Worker 的寫入範圍必須互斥，共用檔案只指定一個 owner。隔離方式依專案指示、共享狀態與平台能力決定。
- 循序委派必須記錄具體原因，例如相依成果尚未完成或協調成本超過收益；不能以角色固定順序或省略拆分評估代替理由。整合與測試指定 worker，主對話驗收。
- 驗收以原生 spawn 回傳的真實 agent ID（或原生 canonical name）、指派角色／範圍及狀態觀察核對。平行必須有同一次原生 `list_agents` 觀察中的至少兩個不同子任務的 running ID；先等一個完成再 spawn 下一個，或兩筆各只有一個 running 的觀察，都不算平行。

### Codex task 紀錄

Managed 任務使用既有 `task-init`，JSON 明確包含 `execution_platform: "Codex"`；runtime 也會在 `CODEX_THREAD_ID` 存在時預設此平台。不得省略或改成其他平台以避開 gate。大型唯讀工作使用 `code_change: false`、`managed_change: false` 建立輕量 Codex 紀錄；這不改變共用 managed workflow 的分流。小型、非 managed 的直接原生委派仍由主對話核對，沒有 CLI gate。

透過 `task-init` 或 `task-write` 的 `codex_delegation.assessment` 記錄 `task_size`、`mode`（single／parallel／sequential）、`parallel_benefit`（sufficient／insufficient）、具體 `reason` 與 `subtasks`。每個 subtask 填 id、role、scope、dependencies、read_paths、write_paths、acceptance；路徑用 repo-relative 檔案或目錄，不用 glob。`readiness` 缺評估時先補評估，不需要開工前就有完成紀錄。

原生工具呼叫後，用 `task-write` 追加 `codex_delegation.native_agents`（agent_id、subtask_id、role、scope、spawned_at、spawn_evidence）與 `observations`（source、observed_at、agents 的 agent_id／status、evidence）。來源使用公開原生 spawn／status 工具的結果或可定位引用，時間記錄實際觀察時刻；狀態正規化為 running／completed／failed／interrupted／cancelled。平行觀察的 source 使用 `list_agents`。不可填造 ID 或把自身推測當觀察；runtime 自行填入 freshness metadata。評估改動會使舊紀錄失效，須針對新的評估委派及觀察。

所有已登錄的當次 attempts 需有最新終態，各子任務至少一個 completed；失敗可換新 agent 重試，同一 agent 的原生 follow-up 以後續觀察更新狀態。同一子任務多個 ID 不會湊成平行。受派 worker 的 `subtask_role: "worker"` 與 `parent_task_id` 沿用父任務綁定，不自行建立 coordinator 拆分。主對話在結案前比對原生結果，再執行既有 gate／close-task。

CLI 驗證紀錄結構、決策一致性、ownership、freshness 與並行快照，無法認證原生事件或判斷理由是否充分；這些仍由主對話核對。來源與欄位形狀以目前 runtime 的 `schemas/task.schema.json` 為準，觀察紀錄不代替 acceptance／runtime evidence。

### 每次 spawn 的模型選擇

| 原生角色 | 模型系列 | reasoning effort |
| --- | --- | --- |
| `agent-workflow-reader` | 最新可用 Luna | `medium` |
| `agent-workflow-worker` | 最新可用 Sol | `max` |
| `agent-workflow-planner` | 最新可用 Astra | `high` |

以當次原生 spawn 工具公開的完整模型 ID 與 supported reasoning efforts 清單為依據，不依模型自述或記憶中的名稱選擇。以完整系列名稱辨識 Luna／Sol／Astra，對同系列可用完整 ID 的版本數字逐段比較，選最高版本；例如較大的次版本優先於字典序。先選最新版，再確認該 ID 支援角色指定的 effort；不可因 effort 不符改選較舊版。

spawn 時明確傳入角色、選出的完整模型 ID 與表列 effort。角色 TOML 固定 effort 並省略 model，讓模型由本次 spawn 決定。若工具要求覆寫模型時使用 `fork_turns="none"`，以精簡 brief 傳遞目標、必要檔案／證據、workspace、ownership、依賴與驗收條件；不複製整段對話。

清單缺失、系列不存在、版本無法判定或 effort 不支援時，回報缺少的能力與受影響工作，停止該委派並由使用者決定替代方案；不默默降版、換系列、改 effort 或繼承父模型。工具拒絕已選 ID 或 effort 時也依此處理。模型能力以當次公開清單為準；不建立模型快取、自訂 resolver、CLI 或服務，也不假設原生 `latest` 別名。
