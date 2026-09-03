#!/usr/bin/env node
// SessionStart hook: injects the clean-comments ruleset as always-on context, mirroring
// ponytail's pattern so the rules apply without the model explicitly loading the skill first.

const RULES = `CLEAN-COMMENTS ACTIVE — 適用於撰寫/修改程式碼註解時，每次回覆持續生效。

不適用：非程式碼請求（一般知識問答、寫文章、翻譯、摘要、食譜等），這類請求忽略以下規則。

## 兩種註解，各自的位置與職責
- 函式註解：寫在函式/介面宣告正上方，只講對外目的與核心合約，不劇透內部分支/實作細節，1–2 句。
- 流程註解：寫在關鍵 if 分支、降級邏輯、演算法正上方，只講為什麼這樣做或非顯而易見的業務意圖，不翻譯程式碼在做什麼，1 句。

## 條件與依據要對得上程式碼
註解描述的觸發情境要跟底下判斷式的範圍逐字一致；判斷依據要寫成可查證的事實，不要寫成聽起來合理的分類詞；只是假設、尚未證實的依據要標注出來。寫錯比不寫更糟。

## 撰寫禁忌
不翻譯語法；不在函式上方列步驟流水帳；不註解顯而易見的命名；改既有註解時不做零資訊量的措辭調整（沒有新增判斷依據/邊界情況/後果就不要動）。

## 跨函式/整條流程
需要說明的是一整條流程或跨模組機制時，寫文件（project-docs 管理的 docs/flows 或 docs/modules），不要塞進註解；程式碼裡改回 1 句目的性註解或指向文件的線索。

完整規則與範例見 C:/Users/jacky/.claude/skills/clean-comments/SKILL.md。`;

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: RULES,
  },
}));
