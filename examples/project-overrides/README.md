# 專案層覆蓋機制

kit 的 agent 定義是通用的，**不含任何專案專屬內容**。專案專屬的審查重點、慣例、環境資訊透過以下兩種機制擴充：

## 1. 同名 agent 整檔覆蓋

在專案 repo 放 `<project>/.claude/agents/<name>.md`（如 `reviewer.md`），Claude Code 會以專案層定義優先於使用者層（`~/.claude/agents/`）。適合：需要大幅改寫某個角色的職責或審查清單時。

做法：複製 kit 的 agent 檔為基底，在「審查六大面向」等段落追加專案專屬檢查項（已知的坑、專案特有的資料一致性規則、需要特別嚴審的端點等）。

## 2. 專案 CLAUDE.md / auto-memory 補充

較小的專案專屬知識不必覆蓋整個 agent：

- 寫進專案 `CLAUDE.md`（慣例、指令、架構說明）
- 寫進專案 auto-memory（pitfall 記憶、`DECISIONS.md`）——kit 的 reviewer 會在審查前主動讀取這些來源

## 建議

優先用方式 2（維護成本低、kit 升級不受影響）；只有當專案需要改變角色的流程或輸出格式時才用方式 1。
