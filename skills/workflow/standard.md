# 標準軌（M1–M4）

適用：單一功能的新增或行為變更，需求已明確，波及侷限本功能（判準見 SKILL.md）。刻意精簡：不比照重軌拆「PM 寫意圖、architect 補手段」——需求已明確不需要 PM 釐清，由 architect 一人寫完 mini-spec，單人設計驗收條目的盲點交由 qa 的探索性測試補償。PM 只在觸發前端畫面驗證 gate 時出場。

```
M1 mini-spec：architect 用 templates/mini-spec.md 一次寫完一頁規格——目標、非目標、
   TDD seam、3–6 條 A<n> 驗收條目（Given-When-Then + cmd/expect，前端條目
   type: ui + steps/expect）→ 使用者一次確認即凍結（frozen: 填日期）
M2 實作：TDD seam 取自凍結 mini-spec，red → green 一次一個切片 → 作者自檢（不 commit）
M3 把關：pre-review 通過（跳過語言檢查時 reviewer 先人工補跑 build/test）
   → reviewer 審查 diff（對照 mini-spec.md，≤2 輪）
M4 驗收：qa 逐條執行、當場比對 expect 判定 PASS/FAIL；含前端條目時追加 PM 畫面驗證；
   qa 加一輪探索性測試（前端做畫面探索、純後端做 edge-case 探索）——發現的問題分
   「規格缺漏」（回報、不算條目失敗）與「實作缺陷」（視同對應條目 FAIL，打回修正）；
   收尾執行 know-how 沉澱三問（見 SKILL.md）
```

任務目錄：`~/.claude/projects/<project-slug>/acceptance/<task-slug>/mini-spec.md`（單檔，不建 spec.md/checklist.md/plan.md；Codex 以約定的固定 slug 對應路徑）。凍結後的增刪循 SKILL.md 回合上限與 heavy.md 凍結原則（mini-spec 適用同一套：需求變更回 M1 重出、寫錯走輕量修訂）。
