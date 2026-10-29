## Codex 任務委派

何時派子代理與怎麼派依共用入口的「Subagent」段落；本節只列出各派工情況用哪個原生角色與模型。

| 派工情況 | 原生角色 | 模型系列 | reasoning effort |
| --- | --- | --- | --- |
| 只讀不寫的派工，例如大量讀取 | `agent-workflow-reader` | 最新可用 Luna | `medium` |
| 寫入範圍不重疊的平行實作 | `agent-workflow-worker` | 最新可用 Sol | `max` |
| 複審 | 新的 `agent-workflow-worker`，指派唯讀審查範圍 | 最新可用 Sol | `max` |

### 每次 spawn 的模型選擇

以當次原生 spawn 工具公開的完整模型 ID 與 supported reasoning efforts 清單為依據，不依模型自述或記憶中的名稱選擇。以完整系列名稱辨識 Luna／Sol，對同系列可用完整 ID 的版本數字逐段比較，選最高版本；例如較大的次版本優先於字典序。先選最新版，再確認該 ID 支援角色指定的 effort；不可因 effort 不符改選較舊版。

spawn 時明確傳入角色、選出的完整模型 ID 與表列 effort。角色 TOML 固定 effort 並省略 model，讓模型由本次 spawn 決定。若工具要求覆寫模型時使用 `fork_turns="none"`，以精簡 brief 傳遞目標、必要檔案／證據、workspace、ownership、依賴與驗收條件；不複製整段對話。

清單缺失、系列不存在、版本無法判定或 effort 不支援時，回報缺少的能力與受影響工作，停止該委派並由使用者決定替代方案；不默默降版、換系列、改 effort 或繼承父模型。工具拒絕已選 ID 或 effort 時也依此處理。模型能力以當次公開清單為準；不建立模型快取、自訂 resolver、CLI 或服務，也不假設原生 `latest` 別名。
