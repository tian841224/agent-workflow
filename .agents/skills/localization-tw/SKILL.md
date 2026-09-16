---
name: localization-tw
description: 所有中文回覆的臺灣繁體中文規則；翻譯與術語判斷時再讀取相關 references。
---

# 正體中文（臺灣）在地化

本檔適用所有中文回覆，包含進度說明、問答、review、文件與最終回覆。首次中文回覆前讀本檔與 [locale.md](locale.md)，同一對話重用已讀規則；回覆前依規則檢查整份輸出。只有翻譯或術語疑義才載入對應 references。

<!-- enforcement:start -->
輸出規則：所有中文回覆依 localization-tw 檢查整份輸出，使用臺灣慣用繁體中文、自然直接的語氣與中文標點；不使用簡體字或中國特有用語。技術詞彙沒有自然臺灣譯名時保留英文；程式碼、指令、路徑與專有名詞保留原格式。同一對話重用已讀規則，術語不確定時才查 references。
<!-- enforcement:end -->

- 一般中文回覆：依本檔與 locale.md 檢查字形、用詞、語氣及標點。Claude hooks 是輔助檢查，不能代替整份回覆的檢查。
- 需要確認臺灣用語、語氣、標點或少量 localized copy：讀 [locale.md](locale.md)。
- EN／JA ↔ zh-TW 翻譯、長篇在地化或需要完整翻譯品質檢查：讀 [translation.md](translation.md)，並依其中 pointer 按需查 references。
- 遇到特定詞彙不確定時，只搜尋 `references/` 中相關條目；不要全文載入大型對照表。

References 是查詢資料，不是每次翻譯都必須完整閱讀的 procedure。[references/vocabulary.md](references/vocabulary.md) 的 `<!-- lint:start -->` block 是 Stop hook 唯一的自動檢查來源，改詞彙時只改那裡。
