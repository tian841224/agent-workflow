---
name: clean-comments
description: 程式碼註解規範。新增或修改任何程式碼註解時載入。
---

# 精簡與結構化程式碼註解規範

<!-- enforcement:start -->
| 註解類型 | 放置位置 | 核心職責 | 長度上限 |
| :--- | :--- | :--- | :--- |
| **函式註解** | 函式／介面宣告正上方 | 站在呼叫端視角說明功能目的與核心合約 | 1–2 句 |
| **流程註解** | 關鍵 `if` 分支、降級邏輯、演算法正上方 | 說明**為什麼這樣做**或非顯而易見的業務意圖 | 1 句 |
| **宣告註解** | 欄位、型別、常數正上方或右側 | 補充非顯而易見的單位（如 ms、千分比）、格式約束或邊界 | 1 句／片語 |

Go 等有慣例的語言，函式註解以函式名稱開頭。

## 規則

1. 函式註解只講對外合約，內部分支與降級條件移到該邏輯正上方。
2. 條件敘述涵蓋的範圍要與底下的 `if`／`switch` 一致，用詞可不同、可補充原因，但不得比判斷式寬或窄；判斷式改寬或改窄時，同一行的註解跟著改。
3. 判斷依據寫成可查證的事實，而不是聽起來合理的分類詞。寫不出具體依據，代表這個判斷本身還沒想清楚。
4. 依據只是尚未證實的假設時明講，例如 `// 假設 X 一定會回傳 Y（尚未跟對方確認）`。
5. 程式碼本身已說明的事留給程式碼：語法翻譯、函式上方步驟流水帳、命名複述一律刪除；嚴禁留存被註解掉的廢棄程式碼（依賴 Git 記錄歷史）。
6. 改既有註解時只在新增判斷依據、新邊界情況或新後果時才動。純換句話說的版本會讓混在同一次改動裡的真正邏輯異動被誤判成潤飾。
7. 要說明的是「一整條流程」或「跨函式的完整機制」時，寫進 `docs/flows/<slug>.md` 或 `docs/modules/<slug>.md`（見 [project-docs skill](../project-docs/SKILL.md)），程式碼裡只留 1 句目的性註解或指向文件的線索。
8. 註解描述程式碼現在的行為與原因；修改歷程（例如 `// 修正此方法原有的呼叫機制`、`// 原本用 X，改成 Y`）寫進 commit message 或 PR 說明。
9. 消除補丁式流水帳語氣：註解應從該單元目前的完整職責、合約與邊界整體描述；避免使用「也…」、「另外…」、「順便…」等追加修補的備忘口吻，以防註解退化為零碎的改動流水帳而遺失核心合約。
10. 暫存標記（TODO／FIXME）必須具備可執行的具體觸發條件、依賴任務或驗證標準，禁止留下語意模糊的無期限備忘。

例外：高風險路徑（金流、對外契約、不可逆的降級／關閉操作）上的判斷依據註解可以超過 1 句，把支撐這個判斷的具體事實、查證狀態與誤判後果一併寫出來。
<!-- enforcement:end -->

## 正反例

以下為示意，重點在註解放的位置和寫的內容，不是固定句型。

```go
// 錯誤：全堆在函式上方、混雜內部實作
// CheckLargeOutAndPrecheck 洗分金額超過本機 balanceOutLimit 門檻時，
// 出款前呼叫 Large out precheck 確認 Session/Machine 有效。
// sessionUsecase 未 wire（GameFacing 未啟用或初始化尚未完成）時安全 no-op，允許出款。
func CheckLargeOutAndPrecheck(machineID string, expectedAmount float64, routeName string) (allowPayout bool, errMsg string, err error) {
    if sessionUsecase == nil {
        return true, "", nil
    }
    return (*sessionUsecase).CheckLargeOutAndPrecheck(machineID, expectedAmount, routeName)
}

// 正確：職責分離、就近說明
// CheckLargeOutAndPrecheck 檢查是否超過大額洗分門檻並向 GameFacing 進行預檢。
func CheckLargeOutAndPrecheck(machineID string, expectedAmount float64, routeName string) (allowPayout bool, errMsg string, err error) {
    // 模組未啟用或未初始化時安全跳過，允許正常出款
    if sessionUsecase == nil {
        return true, "", nil
    }
    return (*sessionUsecase).CheckLargeOutAndPrecheck(machineID, expectedAmount, routeName)
}
```

```go
// 錯誤：補丁式流水帳語氣（以追加修補視角切入，遺失核心職責）
// sweepCandidateFields 也排除重登失敗但仍留在 Hub 的連線。
func sweepCandidateFields(c *client.Client) (token string, gameID int, eligible bool) { ... }

// 正確：整體合約導向（站在呼叫端視角說明完整合約與排除條件）
// sweepCandidateFields 檢查連線是否符合 Session 換約巡檢資格，排除非有效遊戲或重登失敗殘留的連線。
func sweepCandidateFields(c *client.Client) (token string, gameID int, eligible bool) { ... }
```

```go
// 錯誤：抽象分類詞、比判斷式窄或模糊（無法得知具體事實與後果）
// 檢查無效訂單
if order.Status == StatusCancelled || order.Status == StatusExpired || order.Items.IsEmpty() { ... }

// 正確：可查證的事實與業務原因（涵蓋範圍精確對齊判斷式）
// 排除已終止或無商品之訂單，避免進入結算管線引發金額計算異常
if order.Status == StatusCancelled || order.Status == StatusExpired || order.Items.IsEmpty() { ... }
```

```go
// 錯誤：語法翻譯、重複命名（純雜訊）
var playerID string // 玩家 ID
// 如果餘額小於下注金額則返回錯誤
if balance < bet {
    return ErrInsufficientBalance
}

// 正確：命名自明無需註解；僅在有非顯而易見單位或特殊約束時標註
var rtpMilliemes int // RTP 數值，以千分比表示（如 960 代表 96.0%）
if balance < bet {
    return ErrInsufficientBalance
}
```

```ts
// 錯誤：描述修改歷程
// 修正此方法原有的呼叫機制，改成先取 token 再呼叫
const token = await auth.refresh();
await api.submit(order, token);

// 正確：描述現在的原因
// submit 端不接受過期 token，每次送出前重新取得
const token = await auth.refresh();
await api.submit(order, token);
```
