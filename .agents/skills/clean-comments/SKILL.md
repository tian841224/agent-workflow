---
name: clean-comments
description: 指導如何撰寫精簡、高資訊密度且位置精確的程式碼註解。避免在函式上方堆疊過多內部實作細節、杜絕贅字與語法翻譯，並確保關鍵邏輯／降級策略精準就近放置在對應程式碼上方。
---

# 精簡與結構化程式碼註解規範

| 註解類型 | 放置位置 | 核心職責 | 長度上限 |
| :--- | :--- | :--- | :--- |
| **函式註解** | 函式／介面宣告正上方 | 站在呼叫端視角說明功能目的與核心合約，**不劇透內部分支與實作細節** | 1–2 句 |
| **流程註解** | 關鍵 `if` 分支、降級邏輯、演算法正上方 | 說明**為什麼這樣做**或非顯而易見的業務意圖，不翻譯程式碼在做什麼 | 1 句 |

Go 等有慣例的語言，函式註解以函式名稱開頭（例如 `// CheckLargeOutAndPrecheck 檢查是否超過大額洗分門檻並向 GameFacing 進行預檢。`）。

## 範例對照

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

## 三不原則

1. **不翻譯語法**：`// 如果 err 不等於 nil，返回錯誤` 這類註解沒有資訊量；程式碼本身就自解釋。
2. **不寫內部步驟流水帳**：不在函式上方列 `步驟1：驗證參數；步驟2：打API...`；拆分成可讀性高的子函式，或在關鍵步驟上方各寫 1 句。
3. **不過度註解顯而易見的命名**：`var userID string // 使用者 ID` 這類註解該刪——良好命名本身就是最佳註解。

## 自我檢查

- [ ] 函式上方的 doc 是否只有對外的目的說明？
- [ ] 邊界判斷／降級處理是否移到該邏輯正上方，而不是堆在函式頂端？
- [ ] 刪除這行註解會不會影響理解？會才留。
