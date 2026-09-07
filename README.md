# agent-workflow

## 安裝

Clone 後執行：

```text
npm install
npm run build
npm run setup
```

`dist/agent-workflow.mjs` 是 `npm run build` 產生的 ESM bundle，不會進版控，`npm run setup` 依賴這個檔案存在才能執行安裝。`npm run setup` 會啟動互動式安裝：required skills 一律安裝，optional skills 由使用者選取。
公開 npm package 則使用：

```text
npx --yes @tian/agent-workflow@latest
```

`npx --yes .` 不可作為 clone 入口，因為 npm 不會從 current-project local directory package spec 選取其自身 bin。

跨 Claude Code、Codex 與 Antigravity 的 AI 開發工作流框架。

## 一、專案介紹

這個專案的核心目標，是在維持 AI 思考最大彈性的前提下，適度設計必要的流程與規範，並在「簡單任務快速完成」與「複雜任務維持嚴謹品質控管」之間取得平衡。

### 設計取向

大型 workflow framework 處理複雜任務時很完整，但面對小型或單純任務，容易產生過多角色、檢查與文件，增加 token 與時間成本。本專案的取向是：

- 流程依照任務的風險與實際影響範圍組合，不固定套用。
- 共用規則集中管理，Claude Code、Codex 與 Antigravity 讀同一份 canonical source。
- 流程規劃、角色檢查、記憶管理與驗證能力整合成可重複使用的 runtime。
- 保留複雜任務所需的品質控管，同時讓簡單任務維持輕量。

## 二、功能介紹

### 框架特色

本框架採用條件式組合 workflow，所有流程、skills 與角色都會依據實際任務情境選擇性載入，而不是固定套用完整 pipeline。同時，框架採用漸進式載入方式，會根據每次任務的性質選擇適合的流程，並依當下情境決定需要讀取的文件深度，在維持輸出品質的前提下，盡可能減少 token 浪費與執行時間。透過這種設計，流程能保有最大的彈性與靈活度，既能讓簡單任務維持輕量，也能在複雜或高風險任務中提供足夠的規劃、角色分工與品質控管。

### 任務分流與條件式 Workflow

任務處理遵循精確的分流原則：

是否進入 workflow 由 `managed_change` 決定，不是「有沒有改到程式碼」的 `code_change`：`managed_change` 判準是這次修改是否可能改變系統實際行為、資料、契約、安全性、部署或執行結果，因此 CI/CD、Dockerfile、migration script 等非 application source code 的高風險修改一樣要走 workflow。

1. **Managed change**：`managed_change: true` 時建立 task 並載入 `workflow` skill；capability 由 policy 與主對話依實際 impact／risk 選擇。
2. **Test-only change**：新增測試、強化 assertion 或安全 test refactor 可 `managed_change: false` 直接 bypass；刪除／skip 測試、弱化 assertion 或大量重寫 snapshot／fixture baseline 時改為 `managed_change: true`，並加入 `test_integrity` risk flag。
3. **Non-application-source change**：純文件、註解、read-only 分析通常 bypass；CI/CD、Dockerfile、nginx、migration、deploy script、Terraform 等設定或 script 依是否會影響部署、執行、資料或交付結果判斷。
4. **唯讀任務**：一般的唯讀問答、分析與 review 屬於 unmanaged，不建立 task，host 直接選用唯讀 reader agent，不啟動具寫入權限的 implementation worker。只有本來就存在 task record 的唯讀或 orchestration 情境才使用 `task_type: read_only`，此時 `model_profile`（`cheap_read`／`deep_read`）由 runtime 依 `impact_scope`／`impact_effect`／`risk_flags` 推導，不由 agent 自由選擇。

流程沒有固定 pipeline，由主對話依 task metadata、`workflow_facts` 與實際程式脈絡判斷需要的 capability，並把要跑的角色與檢查寫進 task 的 `workflow_request`；需求本身還不清楚時先載入 `planning` skill 釐清。runtime 另外會依 `impact_scope`／`impact_effect`／`impact_confidence`／`risk_flags` 透過 policy 的 `require_when` 計算出 `required` capability——這是主對話不能靠少填 `workflow_request` 略過的下限。`managed_change: true` 本身不強制任何 capability：單檔、局部行為、高信心且無 risk flag 的修改 `required` 為空，要跑哪些測試、要不要 review 或 diagnosis 全由主對話決定；不確定（`impact_confidence` 為 `medium`／`low`）、影響面擴大或命中高風險 flag 時才由 runtime 強制，`workflow_request` 只能在這個下限之上疊加，唯一移除方式是明確執行 `waive --confirmed-by-user`，且該 waiver 只在對應的 `plan_hash` 沒有改變時有效。可透過 `agent-workflow workflow-plan` 查看 required／suggested／requested／effective 與理由。

`workflow_request` 的 capability 名稱以 `schemas/workflow-policy.json` 為唯一來源。未知名稱、重複項目或無效的 `workflow_facts` 會讓 `workflow-plan` 以非零狀態結束，不會靜默產生空 plan。

### Review 與角色化品質檢查

- **Review**：檢查影響範圍、架構一致性、程式碼品質、相容性與失敗情境，並從 real entrypoint 確認完成條件。預設由主對話完成基本自我檢查；當 `reviewer` capability 被 `required`（高 blast radius 或高風險分類）或被 `workflow_request` 加選時，另外啟動一個獨立唯讀 Reviewer，由主對話整合 finding。Runtime contract 只認得 `role.reviewer` 一種身份，不存在第二位 reviewer——需要對抗式複查時，把要推翻的假設寫進同一位 reviewer 的指令，修正後重跑同一個 capability。
- **Worker**：僅用於 host-native／manual isolated parallel development 的 implementation role；Worker 只執行 coordinator 提供的 ExecutionPacket，不自行重新選 capability 或 workflow。
- **Reader**：專案唯讀檢查角色，僅用於讀取、分析與審查，不可修改檔案或 repository 狀態。

### 平行開發

目前 automatic orchestration runtime 仍是 Experimental phase tracker，尚未提供正式的 worker dispatch、worktree creation、patch collect／apply 或 multi-worker completion protocol。

正式 workflow 預設使用 sequential execution；如果 host 平台本身支援 isolated sub-agent／worktree，可由主對話手動拆分互不重疊的子任務、建立或綁定各自 worktree，並以 ExecutionPacket dispatch Worker。所有 worker 結果由主對話統一整合後，再執行 final validation、Review 與 task gate。

Experimental `agent-workflow orchestrate` 只追蹤 phase，不是已完成的 automatic parallel engine。

### 記憶與自動學習

- **可重用結論保存**：使用者要求記憶、糾正 agent、拍板決策或確認錯誤修正時，立即透過 active `learn` skill 記錄可重用結論。
- **模式提煉**：同一類結論反覆出現時，runtime 會把它標為可提煉的模式；agent 依 `distill` skill 寫成 skill 草稿暫存在 `skill-drafts/`。草稿只有在使用者於對話中明確同意時才執行 Promote 成生效的 skill。
- **Review 歸因與補救**：Review 有打回並修正後，開下一輪前記錄一次歸因（缺文件、任務描述不足、缺規範或有規範未讀）。累積達門檻的補救措施（補文件、改 task 模板、寫 skill）一律需使用者明確同意。

### 每週記憶檢視

每次 `close-task` 成功結束任務時，runtime 會檢查是否已超過七天；到期才在輸出中詢問使用者是否執行記憶檢視，同一週不會重複詢問。使用者同意後執行 `npm run memory-review`，完成後標記 `memory-review --action Reviewed`。結果只提供證據與建議目的地，不會自動建立、Promote 或 Reject；由使用者決定後續處理。詳細流程見 [`docs/weekly-memory-review.md`](docs/weekly-memory-review.md)。

### 跨平台記憶讀取

專案支援 Claude Code、Codex 與 Antigravity 之間的記憶脈絡讀取。由 managed hook 自動從共用 knowledge 與各平台可讀取的原生文字記憶中篩選相關資訊，提供給 AI 參考：Claude／Codex 在 session 啟動的 `SessionStart`，Antigravity 在 `PreInvocation`，且只在該 conversation 的第一次 model invocation 注入。

這項功能只負責讀取與整理記憶，原生來源只讀且不會任意改寫其他平台的原生記憶，讓不同 AI 工具在同一個專案中能共享必要脈絡。

### Skills

`.agents/skills/` 是跨平台共用的 skill canonical source。安裝程式會依 managed manifest 將適用的 skill 同步到指定平台的 adapter；AI agent 會根據任務性質與 workflow_request 載入適用的 skill。

| Skill | 類型 | 用途與適用時機 |
| --- | --- | --- |
| [`workflow`](.agents/skills/workflow/SKILL.md) | 必裝 | 由 `managed_change` 決定是否建立 task，再依實際 impact／risk 決定 `workflow_request` 與 required capability；安全 test-only、文件與 read-only 任務可 bypass，高風險設定／script 與 test-integrity 修改仍進 workflow。 |
| [`codebase-design`](.agents/skills/codebase-design/SKILL.md) | 必裝 | 設計或改善模組介面、尋找加深機會、決定 seam 位置時，提供 deep module／interface／depth／seam／adapter 等設計標準；選取 `codebase_design` capability 時主動載入。 |
| [`planning`](.agents/skills/planning/SKILL.md) | 必裝 | 進行架構設計、功能規劃、重構策略、技術方案比較或遇到模糊需求（unclear_requirements）時，先釐清目標、限制與完成條件。 |
| [`push-back`](.agents/skills/push-back/SKILL.md) | 必裝 | 使用者選定實作或設計方向後，評估是否符合現有架構、是否為最小改動，以及是否引入不必要的複雜度；主動提出具體意見與替代方案。 |
| [`learn`](.agents/skills/learn/SKILL.md) | 必裝 | 使用者要求記憶、提出糾正、拍板決策，或確認錯誤修正方式時，保存可重複使用的結論。 |
| [`grill-me`](.agents/skills/grill-me/SKILL.md) | 必裝 | 使用者要求壓力測試或計畫已有高風險未決假設時，逐題進行深度提問直到決策樹清晰。 |
| [`tdd`](.agents/skills/tdd/SKILL.md) | 必裝 | 定義 red → green → refactor、seam、行為導向測試、測試反模式與 mock 邊界；選取 `tdd` capability 時由 workflow 主動載入並記錄 TDD evidence。 |
| [`clean-comments`](.agents/skills/clean-comments/SKILL.md) | 必裝 | 修改 application source code logic 前載入；精準撰寫高資訊密度註解，聚焦於目的、合約與非顯而易見的原因，避免贅述語法與實作細節。 |
| [`architecture-review`](.agents/skills/architecture-review/SKILL.md) | 選擇性 | 審查既有程式架構、跨層耦合、模組責任、契約漂移與遷移風險；以 static fact、hypothesis、runtime proof 區分證據並提出漸進改善方案。 |
| [`diagnosing-bugs`](.agents/skills/diagnosing-bugs/SKILL.md) | 選擇性 | 除錯疑難雜症或效能異常時，依六階段紀律先重現、再假設、再修正；選取 `bug_diagnosis` capability 時主動載入並記錄診斷證據。 |
| [`project-docs`](.agents/skills/project-docs/SKILL.md) | 選擇性 | 修改 application source code 前載入；先查出涵蓋本次路徑的 `docs/` 文件並讀過再動手，改完後依查詢結果建立缺少的文件或更新已失準的內容。 |
| [`distill`](.agents/skills/distill/SKILL.md) | 選擇性 | 記憶中同一類結論反覆出現或 review 歸因達門檻時，提煉成待審的 skill 草稿或分派補救措施；Promote 需要使用者明確核准。 |
| [`operational-verification`](.agents/skills/operational-verification/SKILL.md) | 選擇性 | 進行安裝、同步、部署、migration、provisioning 或外部整合驗證時，區分靜態設定、本機 mock、本機 runtime 與遠端環境證據層級。 |
| [`localization-tw`](.agents/skills/localization-tw/SKILL.md) | 選擇性 | 產生或翻譯正體中文（臺灣）內容時載入；輸出前檢查臺灣用語、語氣與全形標點，避免中國用語與簡體直譯。 |
| [`archify`](.agents/skills/archify/SKILL.md) | 選擇性 | 將架構、workflow、sequence、data-flow 與 lifecycle 需求轉成可驗證、可互動的 standalone HTML 圖表；來源：[tt-a1i/archify](https://github.com/tt-a1i/archify)。 |
| [`design-and-refine`](.agents/skills/design-and-refine/SKILL.md) | 選擇性 | 透過設計訪談、五種 UI 變體、互動回饋與實作計畫，協助探索與收斂元件或頁面的設計方向；來源：[0xdesign/design-plugin](https://github.com/0xdesign/design-plugin)。 |
| [`doc-coauthoring`](.agents/skills/doc-coauthoring/SKILL.md) | 共用 | 撰寫 README、規格、提案或決策文件時，依序進行脈絡整理、結構化編寫與讀者檢查。 |
| [`writing-for-agents`](.agents/skills/writing-for-agents/SKILL.md) | 共用 | 撰寫或修改 `.agents/` 底下的角色檔與 skill 文件時，統一 pointer 寫法、分層揭露與去重判準。 |
| [`humanizer`](.agents/skills/humanizer/SKILL.md) | 選擇性 | 消除 AI 腔調與公式化套話，讓文字讀起來自然真實，保留事實與作者聲音。 |
| [`adhd-comms`](.agents/skills/adhd-comms/SKILL.md) | 選擇性 | 採取 Action-first 與高掃讀性溝通，結論先行、分點陳述、低認知負擔。 |
| [`hallmark`](.agents/skills/hallmark/SKILL.md) | 選擇性 | 去除 AI 樣板感的頁面設計、稽核與重新設計，涵蓋新頁面、重設計與從網址或截圖萃取設計；來源：[nutlope/hallmark](https://github.com/nutlope/hallmark)。 |

### 設計原則與硬護欄

- **不自行變更 Git 狀態**：不自行 commit、push、rebase、merge 或執行破壞性 Git 操作。
- **尊重使用者修改**：不覆寫、刪除或重設使用者未要求處理的修改與資料。
- **最小變更與根因優先**：先讀現況與規則，只做需求直接需要的最小變更；驗證失敗先修根因，不降低完成條件。
- **分層證據原則**：安裝、部署或外部整合驗證，證據不得跨越靜態設定、本機 mock、本機 runtime 與遠端環境等層級。
- **安全邊界**：`unknown` 代表尚未證明，不代表沒有影響；Worker 為唯一寫入角色，其餘角色一律唯讀。

## 三、專案架構、安裝與資料夾結構

### 整體架構

```text
┌──────────────────────────────────────────────────────────────┐
│ Claude Code              Codex              Antigravity       │
│       │                    │                    │              │
│       └──────────── platform adapters / hooks ─┘              │
└──────────────────────────────┬───────────────────────────────┘
                               │
                    ~/.agent-workflow/runtime
                               │
        dist/agent-workflow.mjs（經 agent-workflow 指令呼叫）
                               │
        ┌───────────────────────┼────────────────────────┐
        │                       │                        │
   Task / Workflow       Roles / Guards          Knowledge / Memory
        │                       │                        │
        └─────────────── schemas / templates ───────────┘
                               │
              .agents canonical source in this repository
```

### Repository 結構

```text
~/
├─ .agents/                   共用 canonical source
│  ├─ agents/                 角色定義（worker.md, reader.md）
│  └─ skills/                 跨平台 skills（workflow, tdd, planning...）
├─ .claude/                   Claude Code 的 agent、skills 與 hooks
├─ .codex/                    Codex 的 agent、skills、rules 與 hooks
├─ .gemini/                   Antigravity 的 agent、skills 與 hooks
└─ .agent-workflow/           agent-workflow runtime 與使用者資料
   ├─ runtime/                已安裝的 Node runtime contract
   ├─ knowledge/              跨專案與專案共用的 knowledge
   ├─ skill-drafts/           待審的 skill 草稿與提煉狀態（不會被 agent 載入）
   ├─ review-causes/          review 打回的歸因紀錄與累積狀態
   ├─ skills/                 已核准的 skill，散佈到各平台
   ├─ projects/               專案識別資料與 task 狀態
   │  └─ <project-id>/
   │     └─ tasks/
   │        └─ <task-id>/
   │           └─ task.md
   └─ imports/                外部資料的匯入區
```

不同 AI 工具的原生設定由 installer 依平台建立，並透過 adapter 連結到 `.agents` 的 canonical source。未指定的平台不會建立或修改對應的 agent 資料夾。

agents、skills、hooks 與 runtime 的架構原則見 [docs/architecture.md](docs/architecture.md)。

### 主要元件分工

| 元件 | 責任 |
| --- | --- |
| `.agents/skills/` | 共用 skills、workflow policy、風險與平行編排規則 |
| `.agents/agents/` | 角色定義（Worker 處理隔離子任務；Reader 處理唯讀分析） |
| `src/lifecycle/` | task.json 的 transition、gate、evidence、intent approval 與 worktree lease |
| `src/classification/` | 從 task.json 讀出 workflow policy 條件評估用的分類 context、read-only 任務的 model profile 推導 |
| `src/execution/` | 把 intent、classification 與 compiled workflow plan 打包成單一 execution packet 給實作 agent |
| `src/` 其餘 | workflow policy 編譯、installer、guard、skill manifest、knowledge、learn、distill 與驗證邏輯 |
| `adapters/` | 各 AI 平台的設定、manifest 與 hooks |
| `schemas/` | task、workflow、knowledge、project、retro、review-cause 等資料契約 |
| `skills-lock.json` | 從外部來源 vendor 進來的 optional skill 的來源與雜湊紀錄 |
| `templates/` | Standard、Minimal 與其他 task 範本 |
| `runtime/` | Node runtime contract 與執行限制 |
| `tests-node/` | runtime、installer、hook、task、knowledge、orchestrate、adapter parity 與 migration 完整驗證 |

## 四、安裝方法

### 安裝需求

- Windows
- Node.js 20 以上

### 安裝

在 repository 根目錄執行：

```bat
install.cmd --target-agent All
```

未指定 `--skills` 時，互動式安裝會列出 skills 與簡短說明，輸入編號即可選擇；`workflow` 等必裝 skill 會自動納入，其餘 skills 可依需求挑選。也可以直接指定：

```bat
install.cmd --target-agent All --skills workflow,planning,tdd
install.cmd --target-agent All --skills all
```

`Repair` 未指定 `--skills` 時會沿用上次安裝的選擇。若要在腳本或 CI 中避免互動提示，請加上 `--non-interactive`；未指定 skills 時會安裝全部 skills。

`--target-agent` 可依需求指定安裝平台：

- `Claude`
- `Codex`
- `Antigravity`
- `All`

安裝程式會將共用的 skills、角色、workflow 規則與 hooks 設定到對應平台，並在使用者家目錄建立 `.agent-workflow` runtime 與資料夾。

新增 skill 時，先確認要列為必裝或選擇性，再在 `adapters/managed-manifest.json` 的 `skills` catalog 登錄名稱、說明與 `required` 設定。

三個版本欄位各自獨立演進：product version 是 CLI 顯示的版本；`adapters/managed-manifest.json` 的 `schema_version` 是 manifest 格式版本；`.agent-workflow/managed-runtime.json` 的 `schema_version` 是 installed state 格式版本。

### 檢查安裝狀態

```bat
install.cmd --action Verify
```

`Verify` 會檢查 managed-state 與 manifest、bundle SHA-256、repo source 與 runtime 同步、三平台 required／selected skills、managed entrypoint、hooks 與 Codex hook trust。輸出包含 `valid`、`node`、`runtime_root` 與 `errors`；任一缺失、hash drift、source 自指或 hook 未信任都會回傳非零狀態。

如果需要重新同步或修復已安裝的檔案：

```bat
install.cmd --action Repair --target-agent All
```

### 移除安裝

```bat
install.cmd --action Uninstall --target-agent All
```

移除安裝時，只會移除仍由本專案管理且未被使用者修改的 managed files，不會刪除既有的 knowledge、projects、tasks 或 imports 資料。

