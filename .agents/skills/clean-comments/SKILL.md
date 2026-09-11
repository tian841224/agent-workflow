---
name: clean-comments
description: 詳細程式碼註解規範；只有新增／重寫多行註解、public/doc comments、高風險判斷依據，或 review 發現 comment pollution 時載入。一般 logic change 只遵守 AGENTS.md 的短註解規則。
---

# 精簡與結構化程式碼註解規範

| 註解類型 | 放置位置 | 核心職責 | 長度上限 |
| :--- | :--- | :--- | :--- |
| **函式註解** | 函式／介面宣告正上方 | 站在呼叫端視角說明功能目的與核心合約 | 1–2 句 |
| **流程註解** | 關鍵 `if` 分支、降級邏輯、演算法正上方 | 說明**為什麼這樣做**或非顯而易見的業務意圖 | 1 句 |

Go 等有慣例的語言，函式註解以函式名稱開頭。

## 規則

1. 函式註解只講對外合約，內部分支與降級條件移到該邏輯正上方。
2. 條件敘述的範圍要與底下的 `if`／`switch` 逐字對得上；判斷式改寬或改窄時，同一行的註解跟著改。
3. 判斷依據寫成可查證的事實，而不是聽起來合理的分類詞。寫不出具體依據，代表這個判斷本身還沒想清楚。
4. 依據只是尚未證實的假設時明講，例如 `// 假設 X 一定會回傳 Y（尚未跟對方確認）`。
5. 程式碼本身已說明的事就留給程式碼：語法翻譯、函式上方的步驟流水帳、`var userID string // 使用者 ID` 這類命名複述，一律刪除。
6. 改既有註解時只在新增判斷依據、新邊界情況或新後果時才動。純換句話說的版本會讓混在同一次改動裡的真正邏輯異動被誤判成潤飾。
7. 要說明的是「一整條流程」或「跨函式的完整機制」時，寫進 `docs/flows/<slug>.md` 或 `docs/modules/<slug>.md`（見 [project-docs skill](../project-docs/SKILL.md)），程式碼裡只留 1 句目的性註解或指向文件的線索。

例外：高風險路徑（金流、對外契約、不可逆的降級／關閉操作）上的判斷依據註解可以超過 1 句，把支撐這個判斷的具體事實、查證狀態與誤判後果一併寫出來。

## 正反例

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
