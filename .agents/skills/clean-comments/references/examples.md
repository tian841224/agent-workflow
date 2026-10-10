# 註解正反例

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
