<!-- 僅供程式任務使用；一般專案規劃由單一主 agent 處理，不建立 acceptance 文件。 -->
<!-- template: 複製到 ~/.claude/projects/<project-slug>/acceptance/<task-slug>/plan.md -->

# <任務標題> — 實作藍圖

- project: <專案根目錄絕對路徑>
- track: 重軌
- created: <YYYY-MM-DD>

## 方案摘要

<architect 選定方案與理由；大改動附落選方案一句話對比>

## 要改的檔案與模組職責

- <path> — <職責/改動要點>

## 子任務分解表（R3a 由 architect 協調模式填；拆不出 ≥2 個獨立 sub task 就整段留空並註明「不拆，走單人序列 R3」）

> 規則：`T<n>` 前綴（勿用 R<n>，避免被 stop-check 誤判為階段 checkbox）；各 sub task 的
> 檔案/模組範圍必須互斥（按目錄/package 切分）；每項溯源到 checklist 條目/`S<n>`。

| ID | 檔案/模組範圍（互斥） | 依賴 | TDD seam（取自 spec.md） | 對應 checklist/S<n> | status |
|----|----------------------|------|--------------------------|---------------------|--------|
| T1 | <dir/package>        | 無   | <seam>                   | A?/S?               | [ ]    |
| T2 | <dir/package>        | 無   | <seam>                   | A?/S?               | [ ]    |

## R3 整合確認（R3c 由 architect 協調模式逐項勾，全過才交棒 R4）

- [ ] 全部 sub task 回報完成，涵蓋分解表每一項無遺漏
- [ ] 介面對齊：各 sub task 產出的介面/contract 一致、無重複或衝突實作
- [ ] 合併後整體 build + 全套測試綠（跑整體，非只各 sub task 自己那段）
- [ ] 對照凍結 spec.md/checklist 範圍無缺漏

## 回合記錄（orchestrator 每輪結束補一行，回合上限判定以此為準，見 WORKFLOW.md §5）

| 日期 | 計數器 | 第幾輪 | 結果 |
|------|--------|--------|------|
| <YYYY-MM-DD> | <reviewer↔architect / PM↔architect / R4-R5打回 / R3c打回> | <n> | <一句話結論> |

## 階段進度

- [ ] R1 商業規格書（PM：spec.md 商業規格部分完成、開放問題清空）
- [ ] R2 技術規格 + 方案與藍圖（architect：商業規格審查通過、spec.md 技術規格部分完成、
      本檔完成、使用者選定方案；PM 隨即依商業規格展開 checklist.md draft；
      spec.md 與 checklist.md 經使用者一次確認後同時凍結）
- [ ] R3 實作（可平行，見子任務分解表；R3a 拆分 → R3b 平行實作 → R3c 彙整確認全部完成）
- [ ] R4 靜態把關（pre-review.ps1 通過 + reviewer 審查通過）
- [ ] R5 驗收（qa 逐條執行、當場判定 PASS/FAIL + 探索性測試）
- [ ] R6 收尾沉澱（回報使用者，含彙整上方「回合記錄」的流程統計——reviewer 幾輪、
      驗收條目打回幾次、有無動用 debugger；/learn 沉澱）

## 續作備註

<切批或中斷時：已完成內容、下一步輸入、地雷>
