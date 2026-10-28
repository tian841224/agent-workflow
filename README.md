# agent-workflow

**開發前先定義目標與驗收標準，依風險組合流程，以實際執行的驗收完成交付。**

agent-workflow 是 **Claude Code、Codex、Antigravity** 共用的 AI 開發工作流框架。任務分流、skills、驗收、Review、記憶與平台 hooks 整合成同一套規則與一個 Node.js runtime。小修改維持直接，複雜修改則有足夠的規劃與品質檢查。

你照常用自然語言提出需求：agent 依情境載入需要的指引，runtime 管理任務狀態、檢查完成條件，並在每一步告訴 agent 下一步該做什麼。

## 目錄

- [核心概念](#核心概念)
- [主要功能](#主要功能)
- [快速安裝](#快速安裝)
- [Skills 一覽](#skills-一覽)
- [專案架構與主要元件](#專案架構與主要元件)
- [資料夾結構](#資料夾結構)
- [專案演進](#專案演進)

## 核心概念

1. **開發前先確認目標與驗收標準**
   - 每個程式修改都在 task.md 寫下 Goal 與 Given／When／Then 驗收案例，每條附一行驗證指令。
   - 需求不明確時，先用問答釐清到明確為止。
   - 驗收案例全部由 runtime 實際執行通過，任務才算完成。
2. **依影響與風險組合流程**
   - 影響範圍、信心與風險決定要多做哪些驗證，以及 Reviewer 的審查強度。
   - 小修改不會被迫走完整的高風險流程。
3. **只在需要時載入細節**
   - 入口規則保持精簡，特定情境的做法由 pointer 按需讀取。
   - 每個指令的輸出都附上 `next`，agent 照著走就好，不必背協定。
4. **用可驗證的紀錄判定完成**
   - 結案由 gate 判斷：驗收與驗證都要是 runtime 實際執行的紀錄，而且對應目前的交付內容。
   - Review 的結論要綁定它實際看過的 diff。
5. **共用規則，平台各自轉接**
   - skills、hooks、agent 定義只維護一份。
   - installer 依 Claude Code、Codex、Antigravity 各自的格式與位置安裝。

## 主要功能

| 功能 | 實際用途 |
| --- | --- |
| 任務分流 | 會改變程式行為的修改走 managed workflow；純文件、問答與唯讀分析直接處理 |
| 開發前的規格與驗收 | Managed 開發任務先進入 Plan mode，依 implementation-spec 產出只寫做什麼、動哪裡、怎麼驗的 task.md 規格，使用者確認後才展開實作設計並開發；展開深度隨影響調整，單一檔案且沒有風險 flag 的修改可直接在對話確認 |
| 開發前的脈絡 | `task-init --paths` 一次回傳相關的專案文件、記憶，以及改過同一批路徑的已結案 task；缺文件時，只補這次碰到的模組 |
| 計畫編譯 | 依影響範圍、風險與信心選取能力；必須實際執行的步驟列為 `proofs` 進入 gate，其餘分析步驟成為 `checklist` |
| 驗收與 freshness | runtime 實際執行每條驗收案例的指令，記錄 exit code、輸出摘要與交付指紋；交付一改變，舊紀錄就失效 |
| 下一步指引 | 每個指令的輸出都附上 `next`，列出 gate 目前的缺口與補上缺口的完整指令 |
| 獨立 Review | 程式修改一律由獨立的唯讀 Reviewer 審查（局部的純機械性修改除外），強度依風險調整；第二輪起只審上一輪之後有變動的路徑 |
| 根因追查 | bug 修好或 review 確認問題後，判斷是缺測試、缺文件、缺規範還是 workflow 缺陷，並補上對應的防線 |
| 記憶與學習 | 使用者的決策、更正與可重用結論依 tags 與路徑分類保存；專案決策寫進專案文件，個人偏好寫進共用記憶 |
| 單一 agent loop | 主對話自己完成讀取、規劃、實作與驗證；只有互不相依的平行工作、會擠滿主對話的大量讀取與獨立 Review 才派平台原生 subagent，回報由主 agent 核對後採用 |
| 平台 hooks | 輸出前注入 localization-tw skill 的規則，以及依任務自動篩選注入的記憶；session 結束時關閉 agent 啟動的背景程序並清除期間新增的暫存檔；Git 操作依入口規則取得使用者授權 |

### 一個 managed task 如何完成

```text
使用者提出需求
  |
  +-- 不影響行為或驗證完整性 --> 直接處理
  |
  +-- managed change
        |
        v
      目標與方向（不明確時先問答，由使用者確認）
        |
        v
      +-- 開發任務 --> Plan mode --> implementation-spec 產出規格
      |                               （做什麼、動哪裡、怎麼驗）
      |                                 |
      |                               使用者確認 --> 保存 task.md
      |
      +-- 其餘任務 --> task.md 寫明目標、範圍與完成條件
        |
        v
      task-init --paths --> 計畫、readiness、相關文件／記憶／歷程、next
        |
        跨模組或涉及契約、資料的開發任務 --> 把規格展開到可直接實作
        |
        主 agent 自己實作；只有互不相依的工作才平行派給原生 subagent
        |
        +-- focused  --> 無可獨立工作包時，直接走 `implementation -> focused feedback`
        |
        +-- expanded --> 依序完成切片，每片先取得局部回饋
        |               （獨立工作可交給原生 subagent，相依工作維持循序）
        v
      交付內容穩定 --> 逐條執行驗收案例（evidence-run），失敗就修正重跑
        |
        v
      獨立 Reviewer --> 有問題：修正 --> 重跑驗收 --> 只審變動範圍
        |               確認的問題做 root-cause，補上測試／文件／規範
        v
      close-task 檢查完成條件並結案；過程中的決策與更正交給 learn
```

task.md 的驗收案例寫法：

```markdown
### Acceptance cases

- **AC1** 有效帳密登入成功
  - Given 使用者輸入有效的電子郵件與密碼
  - When 點擊登入按鈕
  - Then 系統回傳有效的 JWT 並導向首頁
  - Verify: `npx playwright test e2e/login.spec.ts -g AC1`
```

### 原生 subagent 平行開發

何時派 subagent 只看 [AGENTS.md](AGENTS.md) 的「Subagent」段落；其餘工作由主對話自己完成，避免交接遺失細節。需要平行時，Agent 依任務及平台能力決定工作切分、worker 數量與隔離方式，直接指派目標、責任範圍與驗收條件，不需先執行固定的 orchestration 流程，平行開發的責任分配見 [workflow](.agents/skills/workflow/SKILL.md)。

Worker 只修改指派範圍，保留其他人的修改，回報實際驗證結果與 blocker。主 agent 整合後執行 task 的全部驗收案例與 proofs，再依 plan 完成 Reviewer 與結案；worker 的局部驗證不能取代整體證據。沒有可用原生 subagent 的平台採循序執行。

Protocol 3 runtime CLI 與 state 是選用介面；原生平行開發不以它們為前置條件。

### 記憶如何累積

```text
使用者的決策、更正、可重用結論
        |
        v
      learn（分類：kind + tags + paths）
        |
        +-- 專案決策、商業規則 --> 專案 docs/（decision 文件或對應的模組文件）
        |
        +-- 個人偏好、agent 行為更正、專案 pitfall --> ~/.agent-workflow 共用記憶
                                                        |
下一次修改相關路徑：task-init --paths <----------------+
                    帶出相關文件、記憶與已結案 task 的歷程

反覆出現的更正 --> distill --> 待審 skill／規則草稿 --> 使用者核准後才生效
```

## 快速安裝

### 需求

- Node.js **20 以上**與 npm。
- Git，用於取得原始碼與開發任務的版本控制檢查。
- 已安裝要使用的 Claude Code、Codex 或 Antigravity。

### 安裝步驟

1. 安裝相依套件並建置：

   ```powershell
   npm install
   npm run build
   ```

2. 執行安裝，依提示選擇 skills：

   ```powershell
   npm run setup
   ```

   若只使用 Codex，改執行：

   ```powershell
   npm run setup -- --target-agent Codex
   ```

安裝會依平台寫入下列內容：

| 平台 | 入口規則 | skills | hooks | 原生 agent |
| --- | --- | --- | --- | --- |
| Claude Code | `~/.claude/CLAUDE.md`（引入 `~/.agents/AGENTS.md` 與 `~/.claude/agent-workflow/delegation.md`） | `~/.claude/skills` | `settings.json`（含 orchestration CLI 使用的 `additionalDirectories`） | `~/.claude/agents/agent-workflow-worker.md` |
| Codex | `~/.codex/AGENTS.md`（指標指向 `~/.agents/AGENTS.md`，另含 Codex coordinator 指示） | `~/.codex/skills` | `hooks.json` | `~/.codex/agents/agent-workflow-{worker,reader}.toml` |
| Antigravity | `~/.gemini/GEMINI.md`（引用 `~/.agents/AGENTS.md` 與 `~/.gemini/agent-workflow/delegation.md`） | `~/.gemini/config/skills` | `config/hooks.json` | 無原生 worker 定義；agent 依可用工具決定 |

各平台的派工規則只決定派哪個 agent 與模型。Claude Code 的派工規則只安裝在 Claude 目錄：只讀不寫的派工一律用 Haiku（內建的 Explore）、平行實作交給 Sonnet 的 worker、複審交給 Opus。規則來源是 `adapters/claude/delegation.md`，原生角色設定是 `adapters/claude/managed-config.json`，Codex 與 Antigravity 的安裝內容不包含它。Antigravity 的派工規則來源是 `adapters/antigravity/delegation.md`，同樣只安裝在 Antigravity 目錄。

技能實體統一放在 `~/.agents/skills`，平台 skills 目錄內逐技能建立 Junction／symlink；同一技能的修改會由所有適用平台共用。`implementation-spec` 由 Claude Code、Codex 與 Antigravity 共用。Repair 會備份普通副本後改為連結；非 catalog 技能內容衝突時保留原狀並回報。Uninstall 僅移除 managed 連結，保留共用技能實體與備份，並移除三個平台設定檔中由 agent-workflow 寫入的 hook；`.system` 與 plugin cache 仍由原生平台管理。遷移、回復與驗證契約見 [managed skill installation](docs/modules/managed-skill-installation.md)。

Codex 的角色設定與委派程序由 [Codex adapter](adapters/codex/managed-config.json) 及其[coordinator 指示](adapters/codex/coordinator.md) 擁有，只安裝至 Codex 目錄。共用 runtime 排除所有平台 adapter 子目錄；原生 consumer 的載入與實際分派需另行驗證。

重跑 `npm run setup` 即可更新，`agent-workflow verify` 檢查安裝是否完整。升級前，先把進行中的 managed task 結案或 supersede：plan 的計算方式改變時，進行中 task 的驗證紀錄會失效。

選用的原生整合由各自的上游 repo 安裝，不收進本 repo 的 skills。
- 可用的選項：`--ponytail`、`--design-and-refine`、`--hallmark`，或用 `--integration <名稱>` 安裝 `adapters/upstream-manifest.json` 內的任一條目。
- 上游位置與各平台的安裝指令只記在該 manifest。
- 需要本機目錄的指令會臨時 clone 到系統暫存目錄，跑完（含失敗時）就刪除，不在本機保留。
- 重跑同一指令即更新，加 `--dry-run` 只列出步驟。
- 新增框架的方法見 [upstream integrations](docs/modules/upstream-integrations.md)。

## Skills 一覽

Skill 是依情境讀取的工作指引。**必裝代表安裝時一定納入，不代表每次任務都讀取全文。** 安裝分類以 [managed manifest](adapters/managed-manifest.json) 為準。

### 核心 skills（必裝）

| Skill | 何時使用 |
| --- | --- |
| [workflow](.agents/skills/workflow/SKILL.md) | 分流 managed change，從定義驗收標準一路到結案 |
| [planning](.agents/skills/planning/SKILL.md) | 釐清架構方向、重要取捨或真正模糊的需求 |
| [implementation-spec](.agents/skills/implementation-spec/SKILL.md) | Managed 開發任務在 Plan mode 產出待使用者確認的 task.md 規格，核准後再展開到可直接實作；Claude Code、Codex 與 Antigravity 必裝 |
| [grill-me](.agents/skills/grill-me/SKILL.md) | 使用者要求深入提問，或需要釐清高風險假設 |
| [project-docs](.agents/skills/project-docs/SKILL.md) | 開發前補上這次碰到的模組文件、改動後更新失準的文件、記錄專案決策 |
| [codebase-design](.agents/skills/codebase-design/SKILL.md) | 設計模組介面、責任邊界、seam 與 adapter |
| [tdd](.agents/skills/tdd/SKILL.md) | 計畫選取 TDD 時，執行 red → green → refactor |
| [root-cause](.agents/skills/root-cause/SKILL.md) | bug 修好或 review 確認問題後，追查起因並補上防止再發生的測試、機制、文件或規則 |
| [learn](.agents/skills/learn/SKILL.md) | 分類保存使用者的決策、更正與可重用結論 |
| [clean-comments](.agents/skills/clean-comments/SKILL.md) | 撰寫多行、公開合約或需要解釋判斷依據的註解 |
| [localization-tw](.agents/skills/localization-tw/SKILL.md) | 翻譯、長篇在地化與臺灣用語疑義；一般中文回覆由 `AGENTS.md` 常駐規則與每次提交訊息時注入的 skill 規則處理 |
| [writing-for-agents](.agents/skills/writing-for-agents/SKILL.md) | 編寫 `.agents/` 角色或 skill 指引，維持清楚的入口與分層揭露 |

### 依需求選用

| Skill | 何時使用 |
| --- | --- |
| [architecture-review](.agents/skills/architecture-review/SKILL.md) | 審查跨層耦合、責任失衡、契約漂移與遷移風險 |
| [diagnosing-bugs](.agents/skills/diagnosing-bugs/SKILL.md) | 診斷原因不明、間歇性或效能問題 |
| [operational-verification](.agents/skills/operational-verification/SKILL.md) | 安裝、部署、migration 與外部整合的實際環境驗證 |
| [distill](.agents/skills/distill/SKILL.md) | 從反覆出現的結論或 review 原因提煉改善；草稿核准後才生效 |
| [task-retrospective](.agents/skills/task-retrospective/SKILL.md) | 使用者明確要求分析單次任務的流程、hooks、skills、時間與重試 |
| [git-commit](.agents/skills/git-commit/SKILL.md) | 撰寫 commit 訊息、規劃 commit 拆分與發起 PR／MR |

### 原生 agent

| Agent | 用途 |
| --- | --- |
| [worker](.agents/agents/worker.md) | 接受主 agent 直接指派的目標與檔案範圍，完成驗收並回報修改、結果與 blocker |
| [reader](.agents/agents/reader.md) | 唯讀的程式查詢與彙整，只安裝到 Codex；Claude 改用內建的 Explore |

## 專案架構與主要元件

```text
Claude Code             Codex              Antigravity
     |                    |                     |
     +--------------------+---------------------+
                          |
          平台 adapters：hooks、原生 agent 定義
                          |
               共用 Node.js runtime / CLI
                          |
     +-----------+--------+---------+-------------+
     |           |                  |             |
 計畫編譯   任務 / 驗收 / gate   平行開發      文件 / 記憶 / 歷程
 (policy)   (next 指引)         (原生 subagent) (task-init context)
     |           |                  |             |
     +-----------+--------+---------+-------------+
                          |
                 schemas / templates

.agents/skills + .agents/agents --> agent 的執行指引與原生 agent 定義
```

設計原則與各 contract 的 owner 見 [architecture](docs/architecture.md)。

## 資料夾結構

```text
~/
|-- .agents/                  安裝後的共用指引、skills 與 templates
|-- .claude/                  Claude Code：CLAUDE.md、skills、agents、settings.json、agent-workflow/delegation.md
|-- .codex/                   Codex：AGENTS.md、skills、agents、hooks.json
|-- .gemini/                  Antigravity：GEMINI.md、config/skills、config/hooks.json、agent-workflow/delegation.md
`-- .agent-workflow/          共用 runtime 與可寫資料
    |-- managed-runtime.json 安裝版本、雜湊與 managed files 紀錄
    |-- runtime/             已安裝的 bundle、adapters、schemas
    |-- knowledge/global/    跨專案的共用記憶
    |-- sessions/            進行中 session 的起點紀錄（供結束時的暫存檔清理判斷範圍）
    |-- logs/                session-cleanup.jsonl：每次清理關閉的程序與刪除的路徑
    |-- projects/<project-id>/
    |   |-- knowledge/       該專案的記憶（含 tags 與 paths）
    |   `-- tasks/<task-id>/
    |       |-- task.md      人可讀的目標、範圍與驗收案例
    |       `-- task.json    runtime 管理的任務狀態與驗證紀錄
    |-- orchestration/v3/    orchestration CLI 資料：snapshot、worker worktrees、artifacts
    |-- worktree-leases/     每個 worktree 同時只能有一個 code task
    |-- skill-drafts/        待核准的 skill 草稿
    |-- skills/              已核准的 skills
    `-- review-causes/       Review 歸因紀錄
```

## 專案演進

**固定角色與多軌流程 → 情境式 skills → 組合式計畫 → runtime 契約與證據 → 以驗收案例為完成依據。**

| 版本 | 重大改變 | 重點 | 相較上版本的差異與改善 |
| --- | --- | --- | --- |
| v1 | 建立開發流程與護欄 | 導入角色分工、hooks、規格凍結與 TDD，禁止 agent 自行 commit。 | 從單純依賴 agent 自律，提升為有明確角色、規格與操作邊界的流程；降低未經檢查直接交付的風險。 |
| v2 | 支援跨平台共用 | 從 Claude Code 擴展至 Codex、Antigravity，以 `.agents/` 統一維護共用規則與 skills。 | 從單一平台設定改為 canonical source 加 adapter；規則只需維護一份，減少三平台內容分歧。 |
| v3 | 從固定流程改為按需組合 | 由多軌流程轉向情境式 skills 與組合式計畫，依任務風險選取必要能力與品質步驟。 | 從每個任務套用同一條完整 pipeline，改為小任務少走不必要步驟，複雜任務仍保留必要控管。 |
| v4 | 將流程判定移入 runtime | 由 runtime 管理任務狀態、計畫與完成條件。 | 統一跨平台入口並降低環境差異。 |
| v5 | 明確化任務與驗證契約 | 統一分流入口，並以 task schema 與 runtime receipt 記錄驗證。 | 從以文字描述「已完成」改為可追蹤誰在何時以哪個工作樹與命令完成驗證，並拒絕 stale evidence。 |
| v5 → v6 | 精簡角色與技能 | Skills 分為必裝與選用，減少固定角色交接，僅在需要時啟動獨立審查。 | 從固定 Reviewer／Verifier／Retrospective 角色改為依計畫啟動責任；降低交接與 token 成本，同時保留高風險任務的獨立審查。 |
| v6 | 累積跨平台記憶 | 加入共用記憶與提煉機制，將可重用結論整理為待審 skill 草稿。 | 從每次任務重新摸索，改為可查詢且有範圍的 knowledge；草稿須經使用者核准才會生效，避免未驗證經驗污染流程。 |
| v7 | 統一驗證並降低重複成本 | 整合 hooks、前置檢查、最終驗證與結案路徑，保留切片局部回饋，減少重複確認與不必要的文件載入。 | 從多個角色各自重跑檢查，改為共用 impact map、delivery fingerprint 與單一結案 gate；在維持 verification integrity 的前提下縮短往返。 |
| v7.1 | 以驗收案例為完成依據 | 開發前寫 Given／When／Then 驗收案例，由 runtime 逐條執行；分析步驟改為 checklist；指令輸出附 `next`；程式修改一律獨立 Review，第二輪起只審變動範圍；`task-init --paths` 帶出相關文件、記憶與歷程；記憶加上 tags 與 paths。 | 從 agent 逐條自述的 evidence 改為可執行的驗收；policy 修改不再讓進行中 task 的驗證失效；移除任務狀態檔的 guard 與三個重複的記錄／診斷指令，減少往返與誤擋。 |
| v7.2 | 平行開發交給平台原生 subagent | 實作前由 agent 判斷工作能否獨立完成，適合時直接指派目標、責任範圍與驗收條件，主 agent 整合後執行全部驗收；Git 操作改由入口規則要求使用者授權，不再安裝 Git guard hook。 | 平行開發不再需要固定的 orchestration 流程、packet 或獨立 worktree；Protocol 3 CLI 只保留相容性。 |
| v7.3 | Claude 主對話改為派工與驗證 | Claude 依工作類型把讀取、規劃、實作、複審派給指定模型的 subagent；`CLAUDE.md` 改為引入共用入口與 Claude 專屬派工規則。 | 主對話的 context 不再承載讀檔與實作過程；各平台自己的規則（Claude 派工規則、Codex coordinator 指示、Antigravity 派工規則）只安裝在該平台目錄，不影響其他平台。各平台入口檔 managed 區塊以外的內容各自保留，不會複製到其他平台。 |
| v7.4 | 主對話改回單一 agent loop | 三平台的主對話自己完成讀取、規劃、實作與驗證，只有互不相依的平行工作、會擠滿主對話的大量讀取與獨立 Review 才派 subagent；判斷規則集中在 `AGENTS.md` 的「Subagent」段落，平台規則只決定 agent 與模型。移除 Codex 的強制委派 gate 與 planner 角色，task schema 升為 v7 並清除執行平台與 Codex 委派紀錄兩個欄位。 | 規劃與執行由同一個 agent 負責，能依中途結果修正；省下交接造成的細節遺失與等待時間。Codex task 不再因為沒有委派紀錄而無法結案。 |
