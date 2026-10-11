# 選補救與寫入

[root-cause](SKILL.md) 第 3 步判定要繼續補救時讀本檔。每補一次，專案的文件、規則與防線就多一塊。

## 選補救

一項問題可以有多個補救。依下列順序由強到弱選，前面的能完全擋住時就不必往後加：

| 強度 | 補救 | 適用 |
|---|---|---|
| 1 | **讓錯誤寫不出來**：共用元件、helper、型別、API 形狀 | 同類錯誤在多處重複出現，或正確寫法需要記住多個步驟 |
| 2 | **自動檢查**：regression test、lint 規則、型別檢查、schema 驗證 | 錯誤可以被機械判定 |
| 3 | **寫成文件或規則** | 依起因，見下表 |
| 4 | **記進記憶**：依 [learn](../learn/SKILL.md)，`kind` 用 `pitfall` 或 `correction` | 只出現一次、還看不出是否為通則 |

強度 1、2 會修改程式或測試，屬於 managed change，依 [workflow](../workflow/SKILL.md) 處理；可以只提案，交給使用者決定是否另開任務。

強度 3 依起因決定寫到哪裡：

| 起因 | 寫到目標專案的位置 |
|---|---|
| `doc_gap` | 依 [project-docs](../project-docs/SKILL.md) 建立或更新 `docs/` 下對應 doc_type 的文件，記錄流程、契約、不變量或決策理由 |
| `convention_gap` | 所有任務都要遵守的短規則寫進專案 `AGENTS.md`；需要背景說明的寫成 `docs/decisions/`；跨專案通用的一套做法寫成 skill 草稿（依 [distill](../distill/SKILL.md#drafting-a-skill)） |
| `context_miss` | 修改原本指向該文件的那一行 pointer，讓觸發條件更明確（依 [writing-for-agents](../writing-for-agents/SKILL.md#context-pointers)）；內容本身已存在，不複製 |
| `prompt_gap` | 提案修改專案的任務模板或 `AGENTS.md`，讓下次需求一開始就講明這一點 |
| `logic_error` | 只做強度 1、2，不寫文件 |
| `regression` | 補 regression test，並寫出 `miss_category` 指出哪一道檢查該擋而沒擋 |

寫入前先查目標位置有沒有既有內容涵蓋同一件事，有就原地更新，讓每條規則只存在一個地方。

## 依分級寫入

- **直接寫**：`doc_gap` 的專案文件，以及修正 `context_miss` 的 pointer。這些是專案事實，查證後即可寫入。
- **使用者同意後才寫**：`AGENTS.md` 規則、任務模板、skill 草稿，以及強度 1、2 的程式修改。先列出提案內容，取得對話中的明確同意。
- **記進記憶**：證據只有一次、還不確定是否為通則的做法，交給 learn。累積到門檻後由 distill 升級。

## 回報

每項問題一列：

```text
| 問題 | 起因 | 證據 | 補救 | 狀態（已寫入／待同意／已記憶／unresolved） |
```

最後列出本次寫入或更新的檔案，以及等待使用者決定的提案。
