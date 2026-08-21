# 測試案例指引

## 以行為為中心

好的測試從 public interface 或 real entrypoint 進入，描述 caller 關心的結果。例如不要驗證 checkout 內部是否呼叫某個 payment method，而應驗證有效購物車最後產生已確認的訂單。

測試名稱應描述行為與結果；測試內容可以使用 fixture 或 builder，但 expected value 應來自獨立的規格案例、已知範例或明確常數。

## 需要避免的測試

- 直接測 private method 或內部 helper。
- 只檢查 collaborator 被呼叫幾次、以什麼順序呼叫。
- 查詢內部資料庫 row、cache key 或全域狀態，取代透過公開介面驗證結果。
- 用同一套計算邏輯產生 actual 與 expected。
- 測試名稱描述實作方式，而不是功能行為。

## 測試層級

從主要 seam 建立能守住使用者行為的測試；對複雜且純粹的 calculation，可另補快速 unit test。兩者目的不同：unit test 保護局部規則，integration／service test 保護元件組合後的實際行為。
