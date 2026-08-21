---
name: learn
description: 自動擷取使用者要求保存的記憶、使用者糾正、已拍板決策與已修正的可重用錯誤。
---

# learn

這是 agent 的自動學習入口，不需要使用者輸入 `/learn`。

## 必須觸發

- 使用者說「記住」「學習」「保存」或明確要求下次沿用：立即記錄。
- 使用者糾正 agent 的理解、行為、流程或答案：立即記錄該糾正。
- 對話中拍板方案、否決替代方案或改變實作方向：立即記錄決策。
- 發生錯誤且已確認原因與修正方式：記錄可重用的錯誤與避坑方式；尚未確認時標記 `needs_verification`。

## 記錄規則

1. 只摘錄可重用的結論，不保存整段對話、秘密、token、密碼、連線字串或個資。
2. 依事件選擇 `kind`：`explicit`、`correction`、`decision`、`error`、`preference` 或 `pitfall`。
3. 專案相關內容使用 `scope Project`；跨專案偏好或通用教訓才使用 `scope Global`，且需要使用者明確同意。
4. 透過 runtime 執行：

```text
agent_workflow learn --action Capture --cwd <cwd> --scope Project --kind <kind> --topic <topic> --content <durable conclusion> --source-event <event>
```

5. 寫入後在回覆中簡短告知「已記錄：<摘要>」。如果內容沒有長期價值，明確標示不記錄的理由。

新 task 的 session hook 會自動載入目前 project 與 shared global memory；新的 user prompt 會再依內容篩選相關記憶。所有記憶都只是參考，使用前仍須核對目前 repo。
