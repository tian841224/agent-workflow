---
doc_type: module
covers:
  - tests-node/
  - scripts/run-tests.mjs
  - package.json
---

# 程式測試

## Responsibility

測試只驗證程式行為與機器契約，涵蓋 hook、安裝器、CLI、狀態轉換、資料讀寫、schema 與錯誤處理。
文件措辭、skill 清單、文件連結與原始碼文字結構於修改時檢查，不維護成固定測試。

## Entrypoints

- `npm test`：建置後執行全部程式測試。
- `npm run test:node -- --profile affected tests-node/<name>.test.mjs`：執行指定測試。
- `npm run ci`：型別檢查、lint、建置與測試、套件封裝檢查。
- `npm run lint:contract`：修改相關文件時按需執行，不列入固定 CI。

## Flow

建置 CLI 與 hook bundle → runner 選取測試 → Node test runner 執行 → 以 exit code 回報結果。
指定路徑不存在或沒有選到測試時失敗，不偷偷改跑全套。

## Shared state

測試透過暫存 fixture 驗證檔案、任務與安裝狀態；安裝測試使用獨立 home 與平台目錄。

## Invariants and gotchas

同一案例混有文件檢查時，只移除文件斷言，保留程式輸出、副作用與失敗路徑驗證。
驗證安裝產物與來源一致屬於程式測試；驗證來源必須包含某句話則不屬於。
文件檢查器自身的解析、錯誤偵測與輸出契約仍是程式行為，使用 fixture 驗證；不把現有 repo 的文件品質當成測試通過條件。

## Unverified

程式測試不證明模型會遵循 skill 的自然語言指示；重要指示的實際效果於修改時按需求驗證。
