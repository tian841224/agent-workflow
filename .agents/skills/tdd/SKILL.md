---
name: tdd
description: 測試驅動開發規範。當 source code 行為變更、bug fix 需要 test-first，或使用者要求 red-green-refactor／integration test 時使用；純 test code 修改仍 bypass workflow。
---

# Test-Driven Development

TDD 是以 red → green → refactor 驅動行為變更的開發方法。本 skill 定義測試應該守住的行為、測試邊界與迭代規則；workflow 只負責判斷是否需要 TDD、選擇驗證深度與回填結果。

## 何時使用

- 新增或修正可測試的 source code 行為。
- bug fix、behavior change 或使用者明確要求 test-first。
- 需要從實際入口驗證整合行為的功能。

純 test code 重整、測試 fixture 調整、文件、設定與 script 修改不因本 skill 建立 workflow task，但仍須執行適用的測試或驗證。

開始前先讀取專案 instructions、相關 project docs，以及存在時的 `CONTEXT.md` 或 ADR，沿用專案的 domain vocabulary、公開介面與既有測試慣例。

## 測試邊界（Seam）

Seam 是測試觀察行為的公開邊界，例如 HTTP endpoint、CLI command、公開 service method 或事件入口。測試應優先從能代表 caller／使用者行為的 seam 驗證結果，而不是直接依賴 private method 或內部 collaborator。

若主要公開介面、關鍵 execution path 或驗收責任尚未明確，先和使用者確認要守住的 seam；若介面與完成條件已明確，不需要為每個測試逐一詢問。

測試層級依行為選擇：主要行為應由 public seam 守住；純 deterministic calculation 可以補 unit test，但不能用它取代需要從 real entrypoint 驗證的整合測試。

## 好的測試

- 描述 caller／使用者看得到的行為，而不是實作步驟。
- 透過 public interface 或 real entrypoint 驗證結果。
- 預期值來自規格、worked example 或獨立的 known-good literal，不重新複製 production algorithm。
- 一次聚焦一個行為，測試名稱能說明「做什麼」與「得到什麼結果」。
- 測試應能在內部 refactor、替換 collaborator 後繼續有效，只要外部行為沒有改變。

## Red → Green → Refactor

1. **Red**：先寫一個在修改前確實失敗、且能捕捉目標行為的測試。
2. **Green**：只實作讓目前測試通過所需的最小修改，不預先加入未驗證的功能。
3. **Refactor**：測試變綠後才整理設計與實作；重構不能改變已驗證的行為。

以 vertical slice 迭代：一次選一個 seam、補一個行為、做最小實作，再根據結果進入下一輪。不要先批次寫完所有測試，再批次實作想像中的完整行為。

## 常見反模式

- **Implementation-coupled**：測 private method、內部 collaborator、呼叫次數或呼叫順序。
- **Tautological**：expected value 用與 production code 相同的演算法重新算出，導致測試必然通過。
- **Side-channel verification**：不透過公開介面，而直接查內部資料表或讀取內部狀態來證明行為。
- **Horizontal slicing**：先一次寫完大量測試，之後才實作，讓測試鎖定尚未理解的內部形狀。
- **Speculative coverage**：為尚未被需求或目前行為支持的未來功能先寫測試。

## Mock 與外部邊界

只在外部系統邊界使用 mock 或 fake，例如第三方 API、寄信、時間、隨機性、檔案系統或無法在測試中安全操作的資料庫。自己的 class、module 與內部 collaborator 優先使用真實實作，避免測試變成驗證 mock 設定。

需要 mock 時，依賴應透過明確介面或 dependency injection 傳入；每個外部操作使用清楚且具體的介面，不用一個包含大量條件分支的 generic mock。

## 與 workflow 的分工

- 本 skill：定義測試設計與 red → green → refactor 方法。
- `workflow`：依 source code 的 impact／risk 決定是否建立 task、選擇 capability 與驗證深度。
- Reviewer：確認測試守住本次行為，且測試在修改前確實失敗。
- Verifier：依 task 的 execution path 從 real entrypoint 驗證完整路徑；不把 local unit test 當成整體流程證據。
- Retrospective：若測試缺口源於 TDD 未遵循，記錄為 `test_gap` 並回到本 skill 找出缺漏。

詳細的測試案例與 mock 邊界見 [`tests.md`](tests.md) 與 [`mocking.md`](mocking.md)。
