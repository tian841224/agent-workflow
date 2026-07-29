# mattpocock/skills 借鏡評估報告

> 來源：<https://github.com/mattpocock/skills>（Matt Pocock 的 AI agent skills 集合）
> 日期：2026-07-24
> 性質：純評估報告，未修改任何框架檔案。落地與否由使用者逐項核准後另行處理。
> 範圍裁定：使用者選定評估 **grilling 審問迴圈**、**deep module 設計詞彙**、**writing-great-skills 準則** 三項；CONTEXT.md 領域詞彙表本次不引入（見 §5）。

---

## 1. 上游專案總覽

mattpocock/skills 是一套「小型、可組合、易於改造」的 agent skill 集合，圍繞四個 AI 編碼代理的失敗模式設計：

| 失敗模式 | 上游解法 |
|---|---|
| 溝通不對齊（agent 沒理解需求） | `grill-me` / `grill-with-docs`（審問式需求訪談） |
| 缺乏共同語言（表達冗長、命名發散） | `CONTEXT.md` 領域詞彙表 + `domain-modeling` |
| 缺乏反饋迴路（程式碼跑不起來） | `tdd` / `diagnosing-bugs` |
| 架構熵增（越寫越亂） | `to-spec` / `codebase-design` / `improve-codebase-architecture` |

結構上分兩類：**user-invoked**（使用者輸入指令觸發的協調型 skill，可呼叫 model-invoked skill）與 **model-invoked**（agent 自主判斷觸發的可重用紀律）。這個分類本身也是可借鏡的方法論之一（見 §4）。

## 2. 重疊對照——為何多數 skill 不重複引入

本 kit 既有機制已涵蓋上游大部分 skill 的職責，重複引入只會造成雙重維護與條文衝突：

| 上游 skill | 本 kit 既有對應 | 結論 |
|---|---|---|
| `tdd` | `skills/tdd`（red→green 迴圈 + Iron Law） | 已有，且已接進 architect 條文 |
| `diagnosing-bugs` | `skills/systematic-debugging`（四階段 + Iron Law） | 已有，且已接進 architect/debugger |
| `to-spec` / `to-tickets` | 重軌 R1–R2 spec.md/checklist.md 凍結流程、標準軌 M1 mini-spec | 已有，且更嚴格（凍結制） |
| `code-review` | reviewer 六大面向 + pre-review 機械閘 | 已有，且面向更完整 |
| `wayfinder` | R3a 子任務分解（四判準） | 已有 |
| `handoff` | WORKFLOW.md §0.1 角色專屬交接 prompt、§8 中斷續作 | 已有；且本 kit 刻意不維護獨立狀態檔，handoff 文件與此哲學相牴 |
| `improve-codebase-architecture` | refactoring-expert 顧問角色（唯讀診斷 + 分步計畫） | 已有 |
| `triage` | 判軌機制（§1）承擔了問題分流職責 | 概念已涵蓋 |
| `research` | deep-research 等既有工具 | 不缺 |
| `prototype` | 無直接對應，但 karpathy-guidelines 的「簡單優先」+ 判軌已抑制過度設計 | 價值有限，暫不引入 |

真正的新增價值集中在下面三項。

---

## 3. 三項選定理念評估

### 3.1 grilling 審問迴圈

**上游做法**：一個可被其他 skill 重用的「審問紀律」——

1. **一次只問一題**，等回答後才問下一題（避免使用者面對一整版問題清單挑著答、漏答）。
2. **每題附建議答案**（recommended answer），讓使用者可以只回「就照你建議的」，降低回答成本。
3. **查得到的事實自己查，不問使用者**——用工具查證程式碼、文件、現況，只把「真正需要人裁決的」拿去問。
4. **決策所有權在使用者**：每個決定逐一呈給使用者確認，沿決策樹依依賴順序走。
5. **停止條件**：雙方對核心決策與其影響達成共識（shared understanding）才停，不是問滿幾題就停。

**本 kit 現況與缺口**：

- [pm.md:46](agents/pm.md) R1 步驟 3 已有「釐清紀錄」機制：模糊點記入清單置頂、由主對話轉問使用者、答案回來更新 S\<n\>、開放問題清空才定案，並禁止「照既有行為 1:1」自填答案。**停止條件與決策所有權兩點已等價存在。**
- 缺口一：**沒有「附建議答案」的要求**。目前 PM 把問題丟回主對話轉問時，只列問題不列建議選項，使用者的回答成本較高。
- 缺口二：**沒有「查得到的自己查」的明文要求**。pm.md 步驟 1 要求先讀現況再寫規格，但「釐清紀錄」段沒有明文要求提問前先過一道「這題能不能用 Read/Grep 自己查到答案」的過濾，實務上可能把可查證的事實也丟去問使用者。
- 缺口三（部分適用）：「一次一題」在多 agent 架構下要調整——PM 是 subagent 不能直接對使用者提問（pm.md 步驟 3 明文），問題是批次經主對話轉問的；逐題往返會把 PM↔主對話↔使用者的成本放大好幾倍。**建議不照搬「一次一題」，改為「一次一批、批內逐題附建議答案、依決策樹排依賴順序」**。Codex 單進程版（AGENTS.md）沒有 subagent 限制，可更接近原味的逐題確認，但同樣不必強制。

**融入建議**（若核准，落點與草擬文字）：

1. `agents/pm.md` R1 步驟 3「釐清紀錄」段，補入一句：
   > 提問前先過濾：能用 Read/Grep 從程式碼、文件或現況查證的事實自己查，不問使用者；只把需要人裁決的需求取捨列入釐清紀錄。每個待確認問題**附上你的建議答案與理由**，讓使用者可以只回覆「同意建議」或指出不同意之處；問題依決策依賴順序排列（前面的答案會影響後面的問題時，標明依賴）。
2. `workflow/WORKFLOW.md` R1 段落同步一句話摘要（Codex 版 AGENTS.md 由同一來源產生，會一併生效）。
3. 標準軌 M1 也適用縮減版：architect 寫 mini-spec 遇模糊點時同樣「先查證、後提問、附建議答案」。落點：`agents/architect.md` 標準路徑 M1 段補半句即可。
4. **不新增獨立 skill**——這是提問紀律不是多步驟程序，內化為條文成本最低、觸發最可靠。

**效益/成本**：改動約 3–5 行條文；直接降低 R1 往返輪數與使用者回答成本。風險低，與既有凍結制完全相容。

### 3.2 deep module 設計詞彙（Ousterhout）

**上游做法**（`codebase-design`）：提供一套判斷模組設計好壞的操作型詞彙——

- 核心句：「**小介面背後藏大量行為，放在乾淨的 seam 上，透過介面即可測試**」。
- **Depth Test**：能不能減少方法數、簡化參數、把複雜度藏進實作？介面每縮一分，呼叫端學習成本降一分。
- **Deletion Test**：這個模組消失後，複雜度是「跟著消失」（pass-through 模組，白養的）還是「擴散到 N 個呼叫端」（有存在價值）？
- **Seam 紀律**：「**一個 adapter 是假想的 seam，兩個 adapter 才是真的 seam**」——只有一個實作就先別抽介面，等第二個實作出現才抽。
- **可測性三原則**：接受依賴而非自建依賴、回傳結果而非產生副作用、最小化表面積（方法越少要測的越少）。

**本 kit 現況與缺口**：

- [architect.md:98](agents/architect.md)「領域關注原則」已有「當下簡單 vs 長期可維護」trade-off 與漣漪效應的要求；[reviewer.md:60-64](agents/reviewer.md) 面向 1「架構一致性」已審模組邊界、跨模組依賴、重造輪子。
- 缺口：**方向對但缺操作型判準**。「優先鬆耦合與清晰邊界」這類條文是原則宣示，agent 執行時沒有具體的測試可跑；Depth/Deletion Test 與 Seam 紀律恰好補上「怎麼判斷邊界清不清晰」的可操作版本。
- Seam 紀律與本 kit 的 **TDD seam** 概念（mini-spec/spec.md 技術規格的測試策略段）天然銜接：TDD seam 講「在哪裡測」，deep module 講「介面該多小、seam 該不該存在」——前者是驗證面、後者是設計面，同一個詞不同視角，放在一起反而互相強化。**karpathy-guidelines 的「簡單優先」也與 Seam 紀律同向**（一個 adapter 別抽介面 = 不加未被要求的彈性），無衝突。

**融入建議**（若核准，落點與草擬文字）：

1. `agents/architect.md`「領域關注原則」段（或 R2b 步驟 2 方案設計處）補入：
   > 模組邊界設計用三個操作型判準檢查：**Depth Test**（能否減少方法數/簡化參數、把複雜度藏進實作，讓介面承載更多行為）；**Deletion Test**（模組拿掉後複雜度是消散還是擴散到呼叫端——純轉手的 pass-through 模組不該存在）；**Seam 紀律**（只有一個實作就不抽介面，第二個實作出現才抽——一個 adapter 是假想 seam，兩個才是真 seam）。設計 TDD seam 時同時檢查該 seam 是否通過這三關。
2. `agents/reviewer.md` 面向 1「架構一致性」補一條 bullet：
   > 新增的抽象是否通過 Deletion Test（不是純轉手的 pass-through 層）？只有單一實作卻抽了介面（假想 seam）？介面能否更小（Depth Test）？
3. `workflow/WORKFLOW.md` architect 領域關注清單「系統/架構層」同步一句摘要。
4. **不新增獨立 skill**——這是設計判準詞彙不是流程，嵌進 architect 設計時機與 reviewer 審查時機，比獨立 skill 的觸發更可靠。

**效益/成本**：改動約 6–8 行條文；把兩個角色的架構判斷從「原則宣示」升級為「可操作測試」。注意分寸：Seam 紀律是預設值不是禁令——專案既有慣例（例如全面 interface 化的 DI 框架）優先，reviewer 引用時應依 reviewer.md「尊重專案既有決策」的既有分寸條款，不拿這套詞彙強行要求重寫。

### 3.3 writing-great-skills 準則

**上游做法**：寫 skill 的方法論——

- **可預測性是根本目標**：skill 的價值在讓 agent 每次走相同流程，不是每次產出相同結果。
- **description 撰寫**：核心概念前置；每個觸發分支只寫一次（不用同義詞重複）；已在正文出現的內容從 description 刪除；「最能完成工作的最少字數」。
- **資訊層級**：技能內步驟（有序操作、每步有明確完成標準）→ 技能內參考（定義/規則/事實）→ 外部參考（指標連到專用檔）。
- **user-invoked vs model-invoked 分類**：model-invoked 的 description 常駐上下文、有 token 成本，適合 agent 必須自主觸發的紀律；user-invoked 零上下文負載但要使用者記得它存在，數量多時用路由 skill 索引。
- **常見失敗模式**：倉促完成（步驟沒真的做完就收工）、同義重複、沉澱物（過時內容堆積）、無效表述（改變不了預設行為的文字）、**否定表述**（用「禁止 X」而非「陳述目標行為 Y」）。
- **分割時機**：有獨立觸發詞時分出 model-invoked；後續步驟會誘使 agent 倉促完成當前步驟時，把後續步驟藏到下一階段。

**本 kit 現況體檢**（依上述準則檢視現有 4 個 skill 與整體，僅列出、未修改）：

| 檢查項 | 現況 | 依準則的觀察 |
|---|---|---|
| `skills/tdd` description | `Use when implementing any feature or bugfix, before writing implementation code` | 符合：觸發前置、極簡。正文的 Iron Law／分割階段做法也符合準則 |
| `skills/systematic-debugging` description | `Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes` | 符合，同上 |
| `skills/learn` description | 三個觸發分支一次寫清 | 大致符合；「(不等待指示)」「(自我學習框架:擷取階段)」等括號補述在正文已有，依「已在正文出現的內容從 description 刪除」可再精簡 |
| `skills/evolve` description | 列舉五種提案類型 + 兩種觸發 | 提案類型清單（新規則、新技能、記憶整併…）屬正文內容，依準則應從 description 移除，只留觸發條件——它是偏 user-invoked 的 skill，description 的自主觸發價值低 |
| 分類意識 | kit 內未明文區分 user/model-invoked | `learn`（被糾正時自動）、`tdd`、`systematic-debugging` 是 model-invoked；`evolve` 實質是 user-invoked（條文明言「不掛週期提醒、使用者想整理時執行」）。明文標注可指導未來 description 的詳略取捨 |
| 否定表述 | WORKFLOW.md 與 agents 條文有相當比例「不得/不要/禁止」 | 本 kit 的禁令多屬硬護欄（git 紀律、凍結制），是刻意設計、不建議翻寫；但**新寫**條文時「陳述目標行為優先於禁止」可作為文風指引 |
| 沉澱物 | evolve skill 的修剪機制（§4.3）已對應 | 已有機制，無缺口 |

**融入建議**（若核准）：

1. 新增 `skills/README.md`（或 `docs/skill-authoring.md`）作為本 kit 的 skill 維護指引，內容：可預測性目標、description 四規則、資訊層級三層、user/model-invoked 分類與 token 成本考量、五種失敗模式、分割時機。約 30–40 行。這份指引同時服務 `evolve` 的「新技能」提案類型（evolve 生成 SKILL.md 時有章可循）——這是最自然的接點。
2. 順帶微調 `learn`/`evolve` 兩個 skill 的 description（如上表觀察），各刪 10–20 字。
3. 在指引中為現有 4 個 skill 標注 invocation 類型，作為範例。
4. **不引入路由 skill**（上游的 `ask-matt`）——本 kit 只有 4 個 skill，數量遠未到需要索引的程度。

**效益/成本**：新增一份約 40 行的指引文件 + 兩個 description 微調。主要受益者是未來的 skill 產出品質（含 evolve 自動生成的），非立即行為改變。三項中優先級最低，但成本也最低。

---

## 4. 額外觀察：user/model-invoked 分類（附帶收穫，不需獨立決策）

上游這個二分法值得寫進 §3.3 的指引文件即可，不需要更大的架構改動：本 kit 的「skill vs 條文內化」取捨其實已隱含同一邏輯——**條文內化 ≈ 常駐上下文的 model-invoked（最高可靠度、最高 token 成本）**；獨立 skill ≈ 按需載入。過去借鏡 SuperClaude 時採內化路線（commit 1296e81）與此一致，本報告 §3.1、§3.2 建議內化、§3.3 建議獨立文件，也是依同一判準做的取捨。

## 5. 暫不引入：CONTEXT.md 領域詞彙表

上游最核心的獨創概念——repo 根目錄放一份純詞彙表（嚴禁實作細節），統一領域術語、降低溝通與 token 成本、指導命名。本次依使用者裁定不引入。若日後重啟評估，需先釐清與既有記憶層的邊界：`overview.md` 記「專案長什麼樣、為什麼」（敘事），CONTEXT.md 記「這個詞在本專案指什麼」（詞彙表），兩者職責可分但有灰區；且 CONTEXT.md 屬 repo 內進版控檔案，與 `AGENTS.memory/` 的關係也要定義。此段僅留檔備查。

## 6. 建議後續

三項皆屬條文/文件修改，依 WORKFLOW.md §0 gate 由單一 agent 直接處理，不需判軌：

| 項目 | 落地動作 | 建議優先序 |
|---|---|---|
| grilling 審問紀律 | 修 `agents/pm.md`、`agents/architect.md`、`workflow/WORKFLOW.md` 各數行 | 1（立即降低 R1 往返成本） |
| deep module 判準 | 修 `agents/architect.md`、`agents/reviewer.md`、`workflow/WORKFLOW.md` 各數行 | 2（升級架構判斷可操作性） |
| skill 撰寫指引 | 新增 `skills/README.md` + 微調 learn/evolve description | 3（服務未來產出） |

若核准落地，建議在 `DECISIONS.md`（或 repo 記憶層）記一筆「借鏡 mattpocock/skills：內化 grilling/deep-module/skill-authoring 三項，CONTEXT.md 暫不引入」的決策，理由與範圍以本報告為據。三處修改需注意 `AGENTS.md`（Codex 版）與 `workflow/WORKFLOW.md` 的同步慣例——依 repo 既有產生/同步方式處理，不要只改一邊。
