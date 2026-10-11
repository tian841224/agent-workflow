# 註解正反例

以下都是示意，不是固定句型，也不是使用者核准的案例集。每例的判斷依賴所列情境；實際修改前要核對實作與契約。重點是補足資訊或修正錯誤，不是把既有註解改成相同長度或語氣。

## 呼叫端降級契約與局部風險

情境：只知道下列 wrapper 的實作，尚未查證 `sessionUsecase` 為 nil 的原因、被委派方法的門檻規則或跳過預檢的業務安全性。反例把這些推測寫成事實；正例只承諾可觀察行為，並在函式契約保留呼叫端看得到的降級結果。

```go
// 錯誤：混入未查證的門檻、nil 原因與安全保證。
// CheckLargeOutAndPrecheck 洗分金額超過本機 balanceOutLimit 門檻時，
// 出款前呼叫 Large out precheck 確認 Session/Machine 有效。
// sessionUsecase 未 wire（GameFacing 未啟用或初始化尚未完成）時安全 no-op，允許出款。
func CheckLargeOutAndPrecheck(machineID string, expectedAmount float64, routeName string) (allowPayout bool, errMsg string, err error) {
    if sessionUsecase == nil {
        return true, "", nil
    }
    return (*sessionUsecase).CheckLargeOutAndPrecheck(machineID, expectedAmount, routeName)
}

// 正確：對外契約與分支風險各自放在需要的位置。
// CheckLargeOutAndPrecheck 委派出款預檢並回傳結果；sessionUsecase 為 nil 時，
// 不執行預檢，回傳 allowPayout=true、空錯誤訊息與 nil error。
func CheckLargeOutAndPrecheck(machineID string, expectedAmount float64, routeName string) (allowPayout bool, errMsg string, err error) {
    // 此分支沒有執行預檢，因此 true 不代表預檢通過。
    // nil 的成因與允許跳過的業務依據尚未查證。
    // 若呼叫端把 true 當成預檢通過，就可能在未預檢的情況下出款。
    if sessionUsecase == nil {
        return true, "", nil
    }
    return (*sessionUsecase).CheckLargeOutAndPrecheck(machineID, expectedAmount, routeName)
}
```

這裡保留多行，是因為金流分支需要交代事實、查證狀態與誤判後果。若既有註解已準確說明這些資訊，就保留；只有找到可信的初始化與業務依據後，才補上已查證的局部原因，不能只為了寫「為什麼」而猜測。

## 函式的完整職責

情境：假設實作與測試已確認，此函式判斷 Session 換約巡檢資格，並排除非有效遊戲及重登失敗後殘留的連線。反例只描述其中一項排除條件，讓呼叫端看不到完整職責。

```go
// 錯誤：只記下追加的排除條件。
// sweepCandidateFields 也排除重登失敗但仍留在 Hub 的連線。
func sweepCandidateFields(c *client.Client) (token string, gameID int, eligible bool) { ... }

// 正確：說明整體契約與排除條件。
// sweepCandidateFields 檢查連線是否符合 Session 換約巡檢資格，排除非有效遊戲或重登失敗殘留的連線。
func sweepCandidateFields(c *client.Client) (token string, gameID int, eligible bool) { ... }
```

若既有文字已交代相同的資格與邊界，不必改成正例句型；若實作還有其他呼叫端需要知道的條件，就應補齊，而不是為了維持一句而省略。

## 條件範圍與可查證的原因

情境：假設結算契約只接受未取消、未過期且有商品的訂單。`無效` 沒有指出是哪種無效；正例對齊三個條件，原因則來自這項已確認的契約。

```go
// 錯誤：分類模糊，沒有交代結算限制。
// 檢查無效訂單
if order.Status == StatusCancelled || order.Status == StatusExpired || order.Items.IsEmpty() { ... }

// 正確：範圍與契約依據明確。
// 結算只接受未取消、未過期且有商品的訂單，因此排除任一不符者。
if order.Status == StatusCancelled || order.Status == StatusExpired || order.Items.IsEmpty() { ... }
```

若既有註解已準確表達這項限制，就保留。不能僅憑這段判斷式宣稱會「引發金額計算異常」；只有實作、測試或契約能支撐時，才寫出該後果。

## 宣告限制與重複命名

情境：`playerID` 與餘額比較的名稱和動作已清楚；`rtpMilliemes` 的數值尺度則是讀者需要知道的表示法。

```go
// 錯誤：只翻譯名稱與語法。
var playerID string // 玩家 ID
// 如果餘額小於下注金額則返回錯誤
if balance < bet {
    return ErrInsufficientBalance
}

// 正確：保留非顯而易見的單位與換算，略去自明的敘述。
var playerID string
var rtpMilliemes int // RTP 數值，以千分比表示（如 960 代表 96.0%）
if balance < bet {
    return ErrInsufficientBalance
}
```

既有 RTP 註解已足夠，不必再潤飾。若餘額註解另有程式碼看不出的幣別、精度或比較前提，應保留那些資訊，不能把整段當成語法翻譯刪除。

## 目前契約與修改歷程

情境：假設已確認 `submit` 不接受過期 token，而 `refresh` 會取得有效 token。反例只說明修改經過；正例說明目前呼叫順序的依據。

```ts
// 錯誤：描述修改歷程。
// 修正此方法原有的呼叫機制，改成先取 token 再呼叫
const token = await auth.refresh();
await api.submit(order, token);

// 正確：描述已確認的契約與目前行為。
// submit 端不接受過期 token，每次送出前重新取得。
const token = await auth.refresh();
await api.submit(order, token);
```

若既有文字已說明 token 有效性要求與順序依據，就保留；僅看到先後呼叫，不能推定 `refresh` 的有效性保證或伺服器拒絕規則。
