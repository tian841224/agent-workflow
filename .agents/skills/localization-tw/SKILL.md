---
name: localization-tw
description: Taiwan Traditional Chinese locale policy — always enforced by the host (baseline rule in AGENTS.md, plus a UserPromptSubmit reminder and a deterministic Stop-time lexical check on Claude) for every zh-TW output. Load this skill only for EN/JA↔zh-TW translation, terminology lookup, localized UI copy, or deeper localization guidance.
---

# 正體中文（臺灣）在地化

本檔只做路由，不把完整翻譯規則與大型詞彙表一起載入。Policy 永遠適用；skill 本身只在需要查詢時才載入。

<!-- enforcement:start -->
輸出規則：所有中文回覆使用臺灣慣用繁體中文；不使用簡體字或中國特有用語；技術詞彙沒有自然臺灣譯名時保留英文。
<!-- enforcement:end -->

- 一般正體中文回覆：核心規則已由 host 強制（`AGENTS.md` baseline + Claude 的 UserPromptSubmit／Stop hook），不需要讀本 skill。
- 需要確認臺灣用語、語氣、標點或少量 localized copy：讀 [locale.md](locale.md)。
- EN／JA ↔ zh-TW 翻譯、長篇在地化或需要完整翻譯品質檢查：讀 [translation.md](translation.md)，並依其中 pointer 按需查 references。
- 遇到特定詞彙不確定時，只搜尋 `references/` 中相關條目；不要全文載入大型對照表。

References 是查詢資料，不是每次翻譯都必須完整閱讀的 procedure。[references/vocabulary.md](references/vocabulary.md) 的 `<!-- lint:start -->` block 是 Stop hook 唯一的自動檢查來源，改詞彙時只改那裡。
