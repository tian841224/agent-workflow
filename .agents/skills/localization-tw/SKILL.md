---
name: localization-tw
description: "進行翻譯、長篇在地化或臺灣用語有疑義時使用；一般中文回覆則依 hook 注入的核心規則與用詞清單撰寫。"
---

# 正體中文（臺灣）在地化

一般中文回覆的常駐規則在 `AGENTS.md`。hook 在每次提交訊息時注入 [references/vocabulary.md](references/vocabulary.md) 的用詞清單，[locale.md](locale.md) 的 Core rules 同一個 session 只注入一次，這就是本 skill 對一般中文回覆的全部要求；輸出中文前先讀完注入的內容再寫。

- 需要確認臺灣用語、語氣、標點或少量 localized copy：讀 [locale.md](locale.md)。
- EN／JA ↔ zh-TW 翻譯、長篇在地化或需要完整翻譯品質檢查：讀 [translation.md](translation.md)，並依其中 pointer 按需查 references。
- 遇到特定詞彙不確定時，只搜尋 `references/` 中相關條目；不要全文載入大型對照表。

[references/vocabulary.md](references/vocabulary.md) 的 `<!-- lint:start -->` block 是每次提交訊息時注入的唯一來源，改詞彙時只改那裡，並遵守該節開頭的收錄條件，安裝後（`npm run setup`）才會生效。
