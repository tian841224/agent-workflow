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
| 開發前的目標與驗收 | task.md 寫好目標與 Given／When／Then 驗收案例；需求不明確時依 planning／grill-me 問答釐清 |
| 開發前的脈絡 | `task-init --paths` 一次回傳相關的專案文件、記憶，以及改過同一批路徑的已結案 task；缺文件時，只補這次碰到的模組 |
| 計畫編譯 | 依影響範圍、風險與信心選取能力；必須實際執行的步驟列為 `proofs` 進入 gate，其餘分析步驟成為 `checklist` |
| 驗收與 freshness | runtime 實際執行每條驗收案例的指令，記錄 exit code、輸出摘要與交付指紋；交付一改變，舊紀錄就失效 |
| 下一步指引 | 每個指令的輸出都附上 `next`，列出 gate 目前的缺口與補上缺口的完整指令 |
| 獨立 Review | 程式修改一律由獨立的唯讀 Reviewer 審查（局部的純機械性修改除外），強度依風險調整；第二輪起只審上一輪之後有變動的路徑 |
| 根因追查 | bug 修好或 review 確認問題後，判斷是缺測試、缺文件、缺規範還是 workflow 缺陷，並補上對應的防線 |
| 記憶與學習 | 使用者的決策、更正與可重用結論依 tags 與路徑分類保存；專案決策寫進專案文件，個人偏好寫進共用記憶 |
| 平行開發（experimental） | 值得平行時，依驗收案例切成數個工作包，交給平台原生 worker 在各自的 worktree 同時開發，再統一整合 |
| 平台 hooks | Git 破壞性操作防護、輸出前注入 localization-tw skill 的規則，以及依任務自動篩選注入的記憶 |

### 一個 managed task 如何完成

```text
使用者提出需求
  |
  +-- 不影響行為或驗證完整性 --> 直接處理
  |
  +-- managed change
        |
        v
      目標與 Given/When/Then 驗收案例（不明確時先問答，由使用者確認）
        |
        v
      task-init --paths --> 計畫、readiness、相關文件／記憶／歷程、parallel_hint、next
        |
        +-- focused  --> 直接走 `implementation -> focused feedback`
        |
        +-- expanded --> 依序完成切片，每片先取得局部回饋
        |               （parallel_hint 成立且切分值得時，改由多個 worker 平行開發）
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

### 多 sub-agent 平行開發（experimental）

主對話是 coordinator，預設循序完成各個 slice。平行會增加總 token，因此只在明顯節省時間時才啟動。判斷分兩段，兩段都通過才平行：

1. `task-init` 回傳的 `parallel_hint` 成立：程式修改、影響面到 module 以上或 exploration 為 expanded、至少 3 條驗收案例，而且沒有 `migration`、`irreversible`、`schema`、`unclear_requirements` 這類需要依序處理的風險。
2. coordinator 依驗收案例切出工作包：每包有自己的案例，以及互不重疊的檔案範圍；共用的契約檔由 coordinator 先寫好。接著由 `orchestrate Assess` 檢查切分是否安全、每包的工作量是否值得平行。

通過後，runtime 會完成下列事情：
- 建立 dirty-worktree snapshot、各 worker 的 worktree，以及 packet（含該 worker 負責的驗收案例）。
- 把 parent 的依賴目錄連結到各 worktree。
- 交給安裝好的平台原生 worker（Claude、Codex）同時執行，每個 worker 都在自己的 worktree 驗收。

收件、整合與套用，以 artifact digest、衝突檢查與 parent fingerprint 保護交付。套用後 parent 重跑全部驗收案例，再交給單一 Reviewer。Antigravity 沒有原生 subagent，一律循序。操作契約見 [parallel orchestration](.agents/skills/workflow/orchestration.md)。

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
| Claude Code | `~/.claude/CLAUDE.md` | `~/.claude/skills` | `settings.json`（並把平行開發的 worktree 目錄加入 `additionalDirectories`） | `~/.claude/agents/agent-workflow-{worker,reader}.md` |
| Codex | `~/.codex/AGENTS.md` | `~/.codex/skills` | `hooks.json` | `~/.codex/agents/agent-workflow-{worker,reader}.toml` |
| Antigravity | `~/.gemini/GEMINI.md` | `~/.gemini/config/skills` | `config/hooks.json` | 無，平行開發一律循序 |

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
| [adhd-comms](.agents/skills/adhd-comms/SKILL.md) | 使用者要求回覆重點先行、易掃讀，同時保留必要證據 |
| [humanizer](.agents/skills/humanizer/SKILL.md) | 依要求重寫文字，或修正明確的 AI 腔調 |

另有 repository 內的 [doc-coauthoring](.agents/skills/doc-coauthoring/SKILL.md)，用於規格、提案與較大型文件。它列在 manifest 的 unmanaged_skills 清單，不屬於 installer 管理的 skill catalog。

### 原生 agent

| Agent | 用途 |
| --- | --- |
| [worker](.agents/agents/worker.md) | 平行開發時，在自己的 worktree 完成分配到的驗收案例，並回報結果檔 |
| [reader](.agents/agents/reader.md) | 唯讀的程式查詢與彙整，使用最低成本的模型 |

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
 (policy)   (next 指引)         (protocol 3)  (task-init context)
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
|-- .claude/                  Claude Code：CLAUDE.md、skills、agents、settings.json
|-- .codex/                   Codex：AGENTS.md、skills、agents、hooks.json
|-- .gemini/                  Antigravity：GEMINI.md、config/skills、config/hooks.json
`-- .agent-workflow/          共用 runtime 與可寫資料
    |-- managed-runtime.json 安裝版本、雜湊與 managed files 紀錄
    |-- runtime/             已安裝的 bundle、adapters、schemas
    |-- knowledge/global/    跨專案的共用記憶
    |-- projects/<project-id>/
    |   |-- knowledge/       該專案的記憶（含 tags 與 paths）
    |   `-- tasks/<task-id>/
    |       |-- task.md      人可讀的目標、範圍與驗收案例
    |       `-- task.json    runtime 管理的任務狀態與驗證紀錄
    |-- orchestration/v3/    平行開發批次：snapshot、worker worktrees、artifacts
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
| v7.2 | 平行開發可實際運作 | `parallel_hint` 與 `Assess` 可以計算何時值得平行；依驗收案例切分工作包；installer 安裝三平台的原生 worker／reader；worker 在 worktree 內自行驗收，Collect 退回未完成的 worker。 | 從「只有 protocol、從未觸發」改為有觸發條件、有安裝好的 worker、失敗可以 Retry 的平行流程；門檻刻意偏嚴，預設仍是循序。 |
