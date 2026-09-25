# zh-TW Locale

用詞、語氣或標點有疑義時讀本檔；一般中文回覆的常駐規則在 `AGENTS.md`。

## Core rules

這一節與用詞清單由 hook 在每次提交訊息時注入；改規則只改這裡，安裝後生效。

- 使用臺灣慣用繁體中文，不使用簡體字或中國特有技術詞彙。
- 技術名詞以臺灣業界常用譯法為主；沒有自然譯名時保留英文。
- 中文敘述使用全形標點；程式碼、指令、路徑、identifier 保留原格式。
- 語氣自然、直接，避免翻譯腔與為了正式而堆疊冗詞。
- 保留產品名、API、協定、程式 identifier 與使用者原本指定的專有名詞。

## 高頻用詞

唯一來源在 [references/vocabulary.md](references/vocabulary.md) 的 `<!-- lint:start -->` block（每次提交訊息時注入的清單），不在此重複維護第二份對照表。

如果特定詞彙仍不確定，搜尋 `references/vocabulary.md` 或 `references/linguipedia-cross-strait.md` 的該詞；不要為一個詞載入整份大型 reference。
