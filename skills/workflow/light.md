# 輕軌（L1–L4）

適用：單一功能內的 bug fix 或小幅改動，波及侷限自身（判準見 SKILL.md）。PM、QA 不出場（除非觸發畫面驗證 gate——此時僅 qa 做畫面核對）；不建 acceptance 目錄。

```
L1 判定：軌別已於任務開始判定並宣告（不 spawn agent）
L2 實作：architect 開工前先列 3–5 條「改完後用什麼指令驗證什麼行為」的微驗收清單
   （至少一條異常/邊界情境；純回報層級、不落檔）→ 實作＋作者自檢（不 commit）。
   輕軌沒有落地檔案，這份清單是唯一驗收依據——交棒 L3/L4 時把清單全文帶入 prompt
L3 把關：pre-review 通過（若輸出「跳過語言檢查」，reviewer 先人工補跑 build/test）
   → reviewer 審查（≤2 輪）；要求修正時，修正後把微驗收清單全部條目重跑一次，
   不是只跑被點名的幾條
L4 證據：architect 依微驗收清單逐條執行、全綠即證據（測試輸出與清單結果留存於回報）
   ＋ know-how 沉澱三問（見 SKILL.md）
```

修 bug 時遵守 architect 的 Iron Law：沒查明根因前不動手修（詳見 agents/architect.md 與 systematic-debugging skill）。
