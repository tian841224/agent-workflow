# lite 軌（LT1–LT4，重軌等級任務的單對話精簡模式）

適用：**僅使用者主動指定**（如「走 lite」）才啟用，不自動判入；判軌命中重軌判準時預設仍走多角色重軌。刻意精簡：規格、方案、實作由主對話一人直接完成，不 spawn PM／architect；單檔 mini-spec 取代 spec／checklist／plan 三檔；單人寫規格的盲點由三道機制補償——三項必答自審（附證據）、獨立唯讀 reviewer／qa 平行把關、qa 探索性測試。「審查者與驗收者不是實作者」的原則不變。

```
LT1 規格與凍結（單一確認點）：先讀專案既有文件與現況行為當 baseline（含記憶層
    overview.md；影響面調查需要時可平行 fan-out 唯讀 agent 查呼叫點與契約現況）
    → 用 templates/mini-spec.md 寫單檔：目標／非目標、關鍵技術決策（契約、型別、
    錯誤碼——有才寫）、TDD seam、A<n> 驗收條目（G-W-T＋test-type＋cmd/expect，
    前端條目 type: ui＋steps/expect；涵蓋邊界值／等價類／異常路徑各至少一條，
    不只 happy path，不適用需註明理由；條數依規模不受標準軌 3–6 條限制，約 15 條
    以上建議拆任務或改走完整重軌）→ 三項必答自審（見下）→ 開放問題（不得用
    「照既有行為 1:1」自答）＋方案 trade-off（解法明顯唯一時說明理由後單方案徑行）
    ＋自審結論一次送使用者：釐清、選方案、凍結一次完成（frozen: 填日期）
LT2 實作：依凍結 seam red→green 一次一個切片，對照條目自檢（不 commit）；寫入
    一律主對話單人、不拆平行；唯讀支援工作（查呼叫點、跑分析）可隨時平行
LT3 把關與驗收（唯讀平行）：pre-review 通過（跳過語言檢查時先人工補跑 build/test）
    → 單一訊息平行 spawn reviewer（審 diff 對照 mini-spec.md，≤2 輪）＋ qa（逐條
    cmd/expect 判定 PASS/FAIL＋探索性測試，規則同標準軌 M4）；交接 prompt 依
    handoff.md 裁剪，不夾帶實作者自評 → 兩邊結果合併：blocker＋FAIL 彙總一批
    打回主對話修正 → 修正 diff 過 pre-review＋reviewer 輕量複審，qa 只重驗 FAIL
    與波及條目 → 同一條目累計 3 次仍失敗轉 debugger
LT4 收尾：回報使用者（改了什麼、驗收結果、複驗方式、流程統計——審查輪數、打回
    次數、有無動用 debugger）＋ know-how 沉澱三問（見 SKILL.md）
```

## 三項必答自審（LT1 凍結前必過——單人寫規格的防走過場條款）

這是砍掉「architect 審 PM 規格」往返後的對價：每項必附實際讀檔／grep 證據，沒有證據不得標通過，結論隨送審導讀一併給使用者查驗。

1. **影響面**：列出受影響模組與呼叫點清單（grep 證據）；確認既有契約／schema 的變動範圍與向後相容性。
2. **技術風險**：資料一致性、交易邊界、並發、冪等、效能熱點、資安——有風險寫進導讀交使用者裁決，不得自行吸收。
3. **可測性**：每條 A\<n\> 都能落到可執行的 cmd/expect 或 ui steps；環境前置條件已確認具備。

## 文件與邊界

任務目錄同標準軌單檔：`~/.claude/projects/<project-slug>/acceptance/<task-slug>/mini-spec.md`（stop-check hook 自動把關凍結與未勾條目）。凍結後增刪與輕量修訂循 heavy.md 凍結原則；回合上限見 SKILL.md，計數口頭列在回報中。升軌訊號：規格反覆翻案、影響面比自審認定的大、規模大到需要平行寫入 → 停手建議轉完整重軌，補齊該軌前置步驟再繼續。Codex／Antigravity 單進程無法平行，LT3 退化為序列（先 reviewer 後 qa），切換身分照常宣告。
