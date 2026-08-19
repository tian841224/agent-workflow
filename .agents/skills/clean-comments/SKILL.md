---
name: clean-comments
description: 指導如何撰寫精簡、高資訊密度且位置精確的程式碼註解。避免在函式上方堆疊過多內部實作細節、杜絕贅字與語法翻譯，並確保關鍵邏輯／降級策略精準就近放置在對應程式碼上方（1~2 句以內）。
---

# 精簡與結構化程式碼註解規範 (Clean Comments)

本規範旨在避免 AI 或開發者產生過度冗長、位置錯置或解釋語法廢話的註解，讓程式碼保持乾淨且具高可讀性。

---

## 核心原則：職責分離與就近原則

| 註解類型 | 放置位置 | 核心職責 | 長度上限 |
| :--- | :--- | :--- | :--- |
| **函式註解 (Doc Comment)** | 函式 / 介面宣告正上方 | 站在**呼叫端 (Caller)** 視角說明「功能目的」與「核心合約」。**不劇透內部分支與實作細節**。 | 1 ~ 2 句 |
| **流程註解 (Inline Comment)** | 關鍵 `if` 分支、降級邏輯、演算法正上方 | 說明**「為什麼這樣做 (Why)」**或**非顯而易見的業務意圖**。 | 1 句 |

---

## 1. 函式註解 (Function Doc) 規範

* **只講 What & Why（對外合約）**：說明這個函式的核心目的。
* **禁止堆疊內部實作細節**：不要把內部所有的參數驗證、nil check、降級行為全部寫在函式上方。
* **符合語言風格**：如 Go 語言以函式名稱開頭（例如：`// CheckLargeOutAndPrecheck 檢查是否超過大額洗分門檻並向 GameFacing 進行預檢。`）。

---

## 2. 流程與分支註解 (Inline Flow) 規範

* **就近放置**：特殊處置、邊界防禦、降級邏輯（Fallback / No-op）直接放在對應的程式碼區塊正上方。
* **解釋 Why，而非 What**：解釋「為什麼要這樣判斷／降級」，不要翻譯程式碼（例如不要寫「檢查變數是否為空」）。
* **極簡扼要**：控制在 1 句話以內，讓讀者掃視程式碼時能瞬間理解意圖。

---

## 3. 範例對照

### ❌ 錯誤示範（全堆在函式上方、混雜內部實作）：
```go
// CheckLargeOutAndPrecheck 洗分金額超過本機 balanceOutLimit 門檻時，
// 出款前呼叫 Large out precheck 確認 Session/Machine 有效。
// sessionUsecase 未 wire（GameFacing 未啟用或初始化尚未完成）時安全 no-op，允許出款。
func CheckLargeOutAndPrecheck(machineID string, expectedAmount float64, routeName string) (allowPayout bool, errMsg string, err error) {
    if sessionUsecase == nil {
        return true, "", nil
    }

    return (*sessionUsecase).CheckLargeOutAndPrecheck(machineID, expectedAmount, routeName)
}
```

###  正確示範（職責分離、就近說明）：
```go
// CheckLargeOutAndPrecheck 檢查是否超過大額洗分門檻並向 GameFacing 進行預檢。
func CheckLargeOutAndPrecheck(machineID string, expectedAmount float64, routeName string) (allowPayout bool, errMsg string, err error) {
    // 模組未啟用或未初始化時安全跳過，允許正常出款
    if sessionUsecase == nil {
        return true, "", nil
    }

    return (*sessionUsecase).CheckLargeOutAndPrecheck(machineID, expectedAmount, routeName)
}
```

---

## 4. 三不原則（反模式清單）

1. **不翻譯語法（No Syntax Translation）**
   * ❌ `// 如果 err 不等於 nil，返回錯誤`
   *  有意義的註解是解釋業務原因，若無特殊原因直接讓程式碼自解釋。
2. **不寫內部步驟流水帳（No Method Spoilers）**
   * ❌ 在函式上方列出 `步驟1：驗證參數；步驟2：打API；步驟3：存資料庫...`
   *  拆分成可讀性高的子函式，或在關鍵步驟上方寫 1 句簡述。
3. **不過度註解顯而易見的命名（No Redundant Comments）**
   * ❌ `var userID string // 使用者 ID`
   *  良好命名的變數與函式本身就是最佳註解。

---

## 5. 撰寫前自我檢查清單

* [ ] 函式上方的 Doc 是否只有 1~2 句對外的目的說明？
* [ ] 內部的邊界判斷／降級處理（如 `if ... == nil`）是否有移至該邏輯正上方？
* [ ] 每一行註解是否都在解釋「為什麼（Why）」而非「做什麼（What）」？
* [ ] 刪除這行註解是否會影響理解？如果程式碼本身就很清楚，直接刪除。
