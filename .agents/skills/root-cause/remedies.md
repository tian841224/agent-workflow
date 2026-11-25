# 選補救與寫入

## 選補救

一項問題可以有多個補救。依下列順序由強到弱選，前面的能完全擋住時就不必往後加：

| 強度 | 補救 | 適用 |
|---|---|---|
| 1 | **讓錯誤寫不出來**：共用元件、helper、型別、API 形狀 | 同類錯誤在多處重複出現，或正確寫法需要記住多個步驟 |
| 2 | **自動檢查**：regression test、lint 規則、型別檢查、schema 驗證 | 錯誤可以被機械判定 |
| 3 | **寫成文件或規則** | 依起因，見下表 |
| 4 | **記進記憶**：依 [learn](../learn/SKILL.md)，`kind` 用 `pitfall` 或 `correction` | 只出現一次、還看不出是否為通則；層級規則（定義見 `convention_gap` 分流）不走強度 4，第一次出現就依強度 3 提案 |

強度 1、2 會修改程式或測試，屬於 managed change，依 [workflow](../workflow/SKILL.md) 處理；可以只提案，交給使用者決定是否另開任務。

強度 3 依起因決定寫到哪裡：

| 起因 | 寫到目標專案的位置 |
|---|---|
| `doc_gap` | 依 [project-docs](../project-docs/SKILL.md) 建立或更新 `docs/` 下對應 doc_type 的文件，記錄流程、契約、不變量或決策理由 |
| `convention_gap` | 依範圍分流，見表下 |
| `context_miss` | 修改原本指向該文件的那一行 pointer，讓觸發條件更明確：觸發詞放在句首，同一個情境只用一個觸發詞，pointer 只寫觸發條件、細節留在文件本身；內容本身已存在，不複製 |
| `prompt_gap` | 提案修改專案的任務模板或 `AGENTS.md`，讓下次需求一開始就講明這一點 |
| `logic_error` | 只做強度 1、2，不寫文件 |
| `regression` | 補 regression test，並寫出 `miss_category` 指出哪一道檢查該擋而沒擋 |

`convention_gap` 依範圍選一個位置：

- 單一模組內的寫法，或判斷不出是否為層級規則時（第二個模組出現同樣問題再升級）：該模組文件的[規範條目](../project-docs/references/doc-types.md#規範條目)。
- 能寫成「哪一層或哪個目錄可以／不可以做什麼」的規則（拿掉模組名稱後仍成立，且專案裡至少有另一個同層目錄也適用；以下稱層級規則）：專案 `docs/architecture.md` 的[分層段落](../project-docs/references/doc-types.md#分層段落條目)。
- 所有任務都要遵守的短規則：專案 `AGENTS.md`。
- 需要背景說明的取捨：`docs/decisions/`。
- 跨專案通用的一套做法：向使用者提出新增 skill 的建議。

寫入前先查目標位置有沒有既有內容涵蓋同一件事，有就原地更新，讓每條規則只存在一個地方。

## 依分級寫入

- **直接寫**：`doc_gap` 的專案文件、模組文件的規範條目，以及修正 `context_miss` 的 pointer。這些是專案事實或已確立的模組寫法，查證後即可寫入。
- **使用者同意後才寫**：`architecture.md` 分層段落、`AGENTS.md` 規則、任務模板、新增 skill 的建議，以及強度 1、2 的程式修改。先列出提案內容，取得對話中的明確同意。
  - 這一項有 review cause 紀錄時（managed task 的 review，第 2 輪起，`regression` 不限輪次），待同意的提案用 `review-record` 的 `--cause-proposed-change` 一起記錄；同意並寫入或拒絕後，用 `agent-workflow review-cause --action Resolve --id <id> --status applied|rejected` 更新狀態。
  - 沒有 review cause 紀錄時（workflow 以外的 review、第 1 輪的非 `regression` finding），提案只在當次回報中列出，沒有保存位置。
- **記進記憶**：證據只有一次、還不確定是否為通則的做法，交給 learn；同一類更正第二次出現時，改寫成上表的文件或規則。層級規則是例外，第一次出現就提案，不先進記憶。

## 回報

每項問題一列：

```text
| 問題 | 起因 | 證據 | 補救 | 狀態（已寫入／待同意／已記憶／unresolved） |
```

最後列出本次寫入或更新的檔案，以及等待使用者決定的提案。
