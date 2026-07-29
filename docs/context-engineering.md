# Context Engineering 指引 — 

來源：Claude 官方〈The new rules of context engineering for Claude 5 generation models〉
（https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models）。
核心轉向：**信任模型的判斷力，不過度約束**——官方將 Claude Code 系統提示刪去 80% 而效能無損。

本檔是修改 repo 內任何常駐檔／skill／agent 文件時的合規檢查表。由使用者人工指定對照時使用，不自動載入。

## 八條規則與本 repo 落地方式

### 1. 消除冗餘（Eliminate Redundancy）
同一指令不得在系統提示、skill、CLAUDE.md 之間重複；矛盾指令會逼模型多餘斟酌，必須清除。

**落地**：任何指令只有一個權威位置——判軌摘要與硬護欄在 `AGENTS.md`、判軌細則與回合上限在 `skills/workflow/SKILL.md`、各軌流程在 `light/standard/heavy.md`、角色細節在 `agents/*.md`、格式規約在 `workflow/acceptance-spec.md`。其他檔案只放指標，不複述內容。新增內容前先 grep 是否已存在於權威檔。
**例外（刻意冗餘）**：git 紀律等硬護欄允許在 agent 檔各留一行——`AGENTS.md` 明文「不因精簡而放寬」，安全性冗餘是設計，不是違規。

### 2. 以判斷取代規則（Replace Rules with Judgment）
不寫窮舉式禁令，改寫判斷原則，讓模型依情境自行裁量。

**落地**：判軌不以檔案數/行數硬性判定，看「單一功能」與「blast radius」；架構分析「明顯不相關的面向一句話帶過，不為湊清單而分析」。新增條文時先問：這能不能寫成一句原則而不是一串規則？

### 3. 常駐層輕量化（System Prompt Focus）
常駐提示只定義「做什麼」，不塞「怎麼做」的完整教學。

**落地**：`AGENTS.md`（＝各平台 CLAUDE.md/AGENTS.md/GEMINI.md 入口）維持 ~40 行：判軌摘要＋硬護欄＋記憶機制＋風格，僅此而已。想加內容到常駐層時，預設答案是「放到 skill 或 agent 檔」。

### 4. CLAUDE.md 策略
簡短、只寫 repo 讀不出來的 gotcha 與非顯而易見慣例，用連結做漸進披露。

**落地**：專案專屬慣例與高風險路徑定義寫在各專案自己的 CLAUDE.md／記憶層，本 kit 的共用檔不含專案內容。

### 5. Skills 作為漸進式披露（Progressive Disclosure）
skill 是輕量指南不是操作手冊；長 skill 拆多檔按需載入。

**落地**：`skills/workflow/` 採「入口（SKILL.md）→ 軌別分檔（light/standard/heavy）→ 平台分檔（platforms.md 路由 → platform-*.md）」三層；明文「判定軌別後只讀對應軌別檔」「只讀你所在平台那份」。角色專屬細節（reviewer 六大面向、qa 探索性測試、R2a 六維度）放在對應 agent 檔——spawn 時才載入，這是漸進披露的正確落點，不是冗餘。

### 6. 工具設計優於範例（Tool Design Over Examples）
避免 prescriptive examples 束縛模型探索；用清楚的介面讓模型自行推斷。

**落地**：agent frontmatter description 不放 `<example>` 對話範例（description 會常駐載入主對話，範例既吃 token 又過度約束）；description 縮為 2–3 句出場條件，分工邊界寫成 body 條文。v3 起六個 agent 檔已全數移除 examples。

### 7. 延遲載入（Defer-Load）
不常用的能力延遲載入，減少常駐 context 負擔。

**落地**：`WORKFLOW.md` 只是章節對照表；`platforms.md` 是路由頁；skill 已在 context 中時不重複讀取（agents/architect.md「Context 與 skill 載入」）。

### 8. Rich Format 優先（Reference Rich Formats）
規格用可執行、可機械判定的格式，優於散文描述。

**落地**：驗收以 `cmd`/`expect` regex 機械判定（`workflow/acceptance-spec.md` 嚴格規約，`stop-check.ps1` 依此 parse）；確定性檢查下沉到 hook 與 pre-review 腳本，「凡是能用腳本或 hook 保證的，不寫成條文」。

## 修改 repo 時的自檢清單

- [ ] 新增的內容是否已存在於某個權威檔？（先 grep，有就放指標不複述）
- [ ] 有沒有和既有檔案講法矛盾？（矛盾是最高優先修復項）
- [ ] 這段是規則清單還是判斷原則？能收斂成原則就收斂
- [ ] 放的位置對嗎？常駐層（AGENTS.md）↔ 按需層（skills/agents）——預設放按需層
- [ ] agent description 是否維持 2–3 句、無 examples？
- [ ] 能用 hook/腳本機械保證的，是否還在用條文約束？
- [ ] 刪減時：硬護欄（git 紀律、凍結制、升軌）不因精簡而放寬；跨檔交叉參照（如 heavy.md → architect.md 六維度）是否仍對得上？
- [ ] 修改完成後執行 `/doctor` 指令檢查，依其建議修正內容；有需要裁決（取捨、可能影響既有行為）的項目回報使用者決定，不自行取捨
