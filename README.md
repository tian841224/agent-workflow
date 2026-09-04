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

### 為什麼會有這個專案

專案最初源自對大型 AI workflow framework 的實際使用經驗。過去曾嘗試 SuperClaude 等大型框架，也曾依照任務標籤建立多套 workflow。這些方案處理複雜任務時很完整，但面對小型或單純任務，容易產生過多角色、檢查與文件，增加 token 與時間成本。

因此，本專案逐步朝以下方向演進：

- 流程不再固定套用，而是依照任務的風險與實際影響範圍適度調整。
- 將共用規則集中管理，避免 Claude Code、Codex 與 Antigravity 各自維護不同版本。
- 將流程規劃、角色檢查、記憶管理與驗證能力整合成可重複使用的 runtime。
- 保留複雜任務所需的品質控管，同時讓簡單任務維持輕量。

### 發展歷程

| 階段 | 主要方向 | 解決的問題 |
| --- | --- | --- |
| v1 | 初版 Claude workflow 打包 | 建立可重複使用的開發規範與安裝方式 |
| v2 | 流程總控、角色分工、hooks 與後端化驗收 | 將規則從提示文字提升為可執行的護欄 |
| v3 | 任務分軌、Lite／Standard 流程、平行 sub-task 與跨平台 installer | 降低簡單任務的流程成本，並支援多平台與平行開發 |
| v4 | 依情境載入流程、canonical `.agents`、TDD、記憶與專案文件 | 讓流程更貼近實際影響範圍，降低重複規範與 context 成本 |
| v7 | Node.js runtime、主對話直接選定 capability／角色、條件式品質角色、跨平台記憶、唯讀 Reader 任務分流與主對話編排；`task.json` 統一 contract（`state_revision`／`plan_revision`／`intent_approval`）、risk_flags 驅動的 required capability、pure task-gate、CAS 檔案鎖與 git-guard allowlist | 將流程選擇與 runtime 執行分離，並讓高風險流程不再能靠少填 `workflow_request` 被略過，兼顧彈性、可驗證性與跨平台一致性 |
| v6 | 在 v5 架構基礎上，以「同 prompt、有無 skill／角色提示」的 A/B 比較作為去留依據，只保留驗證後仍有效的最小提示 | skill／角色清單只增不減，缺乏依據判斷提示內容是否真的提升輸出品質，導致 token 與執行時間持續墊高 |

## 二、功能介紹

### 框架特色

本框架採用條件式組合 workflow，所有流程、skills 與角色都會依據實際任務情境選擇性載入，而不是固定套用完整 pipeline。同時，框架採用漸進式載入方式，會根據每次任務的性質選擇適合的流程，並依當下情境決定需要讀取的文件深度，在維持輸出品質的前提下，盡可能減少 token 浪費與執行時間。透過這種設計，流程能保有最大的彈性與靈活度，既能讓簡單任務維持輕量，也能在複雜或高風險任務中提供足夠的規劃、角色分工與品質控管。

### 任務分流與條件式 Workflow

任務處理遵循精確的分流原則：

是否進入 workflow 由 `managed_change` 決定，不是「有沒有改到程式碼」的 `code_change`：`managed_change` 判準是這次修改是否可能改變系統實際行為、資料、契約、安全性、部署或執行結果，因此 CI/CD、Dockerfile、migration script 等非 application source code 的高風險修改一樣要走 workflow。

1. **Managed change**：`managed_change: true` 時建立 task、載入 `workflow` skill；isolated 且無明確風險的修改採最小驗證。
2. **純測試程式碼變更**：一律 `managed_change: true`，但走 lightweight 路徑——沒有刪除／弱化既有測試、沒有 skip 測試、沒有大量改動 snapshot 時 `selected` 為空清單，成本接近零；命中才加 `test_integrity` risk flag，強制對應 capability。
3. **非程式碼任務**：設定、文件、註解、script、除錯、review、規劃、問答與翻譯等 `managed_change: false` 任務一律 bypass，不建立 task、不啟動角色。
4. **唯讀任務**：單純讀取、檢查、解釋或程式碼審查任務，使用 `task_type: read_only`；`model_profile`（`cheap_read`／`deep_read`）由 runtime 依 `impact_scope`／`impact_effect`／`risk_flags` 推導，不由 agent 自由選擇。Codex／Claude 選用唯讀 reader agent，不啟動具寫入權限的 implementation worker。

流程沒有固定 pipeline，由 Planner 依 task metadata 與 `workflow_facts` 先產生 capability 候選，主對話再依已知需求與程式脈絡確認、覆寫或補充，並把要跑的角色與檢查寫進 task 的 `workflow_request`。runtime 另外會依 `risk_flags` 透過 policy 的 `require_when` 計算出 `required` capability——這是主對話不能靠少填 `workflow_request` 略過的下限，`workflow_request` 只能在這個下限之上疊加，唯一移除方式是明確執行 `waive --confirmed-by-user`，且該 waiver 只在對應的 `plan_hash` 沒有改變時有效。可透過 `agent-workflow workflow-plan` 查看 required／suggested／requested／effective 與理由。

`workflow_request` 的 capability 名稱以 `schemas/workflow-policy.json` 為唯一來源。未知名稱、重複項目或無效的 `workflow_facts` 會讓 `workflow-plan` 以非零狀態結束，不會靜默產生空 plan。

### Review 與角色化品質檢查

- **Review**：檢查影響範圍、架構一致性、程式碼品質、相容性與失敗情境，並從 real entrypoint 確認完成條件。Review 由主對話依 `workflow` skill 第 6 節直接執行，不再啟動獨立角色；需要對抗式複查或額外驗證時，把要推翻的假設或要測試的情境直接寫進 Review 指令。
- **Worker**：專案唯一允許寫入的原生開發角色，僅用於平行開發時處理隔離 worktree 中的子任務。
- **Reader**：專案唯讀檢查角色，僅用於讀取、分析與審查，不可修改檔案或 repository 狀態。

### 平行開發

當一個任務可以拆成兩個以上互不重疊、可獨立驗收的子功能時，專案可以透過 coordinator／worker 建立隔離的 worktree，讓不同子功能平行處理，再由主流程整合與驗證。

### 記憶與自動學習

- **可重用結論保存**：使用者要求記憶、糾正 agent、拍板決策或確認錯誤修正時，立即透過 active `learn` skill 記錄可重用結論。
- **模式提煉**：同一類結論反覆出現時，runtime 會把它標為可提煉的模式；agent 依 `distill` skill 寫成 skill 草稿暫存在 `skill-drafts/`。草稿只有在使用者於對話中明確同意時才執行 Promote 成生效的 skill。
- **Review 歸因與補救**：Review 有打回並修正後，開下一輪前記錄一次歸因（缺文件、任務描述不足、缺規範或有規範未讀）。累積達門檻的補救措施（補文件、改 task 模板、寫 skill）一律需使用者明確同意。

### 每週記憶檢視

每次 `close-task` 成功結束任務時，runtime 會檢查是否已超過七天；到期才在輸出中詢問使用者是否執行記憶檢視，同一週不會重複詢問。使用者同意後執行 `npm run memory-review`，完成後標記 `memory-review --action Reviewed`。結果只提供證據與建議目的地，不會自動建立、Promote 或 Reject；由使用者決定後續處理。詳細流程見 [`docs/weekly-memory-review.md`](docs/weekly-memory-review.md)。

### 跨平台記憶讀取

專案支援 Claude Code、Codex 與 Antigravity 之間的記憶脈絡讀取。各平台啟動新的 session 或收到新的 prompt 時，由 managed `SessionStart` hook 自動從共用 knowledge 與各平台可讀取的原生文字記憶中篩選相關資訊，提供給 AI 參考。

這項功能只負責讀取與整理記憶，原生來源只讀且不會任意改寫其他平台的原生記憶，讓不同 AI 工具在同一個專案中能共享必要脈絡。

### Skills

`.agents/skills/` 是跨平台共用的 skill canonical source。安裝程式會依 managed manifest 將適用的 skill 同步到指定平台的 adapter；AI agent 會根據任務性質與 workflow_request 載入適用的 skill。

| Skill | 類型 | 用途與適用時機 |
| --- | --- | --- |
| [`workflow`](.agents/skills/workflow/SKILL.md) | 必裝 | 修改 application source code logic 時，由主對話依實際觀察到的 impact 與 risk 決定是否建立 task、寫入 `workflow_request` 啟用哪些 capability；isolated 且無明確風險的修改可採最小驗證。純 test code 與 non-code 任務直接 bypass。 |
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
   Task / Planner        Roles / Guards          Knowledge / Memory
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
   └─ imports/                舊版本或外部資料的匯入區
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

版本欄位分工如下：product version 是 CLI 顯示的 `v7`；`adapters/managed-manifest.json` 的 `schema_version` 是 manifest 格式版本；`.agent-workflow/managed-runtime.json` 的 `schema_version` 是 installed state 格式版本。三者獨立演進，不再以同一個數字代稱。

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

### v7 breaking changes

- `schemas/task.schema.json` 成為 `task.json` 的唯一 contract，並完整定義 evidence、transition、waiver 與 `workflow_facts` 的結構；退役的 v2 contract 移至 `schemas/legacy/task-v2.schema.json`，只供 migration 參照；`task.json` 新增 `state_revision`／`plan_revision`，lifecycle 不再有 `frozen` 狀態，改以 `intent_approval`（綁定 task.md 內容 hash）判斷高風險任務是否已取得使用者確認。
- `workflow-plan` 會依 `risk_flags` 計算 `required` capability，`workflow_request` 只能疊加、無法移除；要略過必須明確 `waive --confirmed-by-user`，且該 waiver 綁定當下的 `requirements_hash`，task 分類一變就失效。 <!-- contract-lint:allow -->
- `task-gate` 改為 pure read-only：不再把 `compiled` 寫回 `task.json`；role evidence 綁定它實際審查過的 diff（`reviewed_base` + `reviewed_paths` + `reviewed_diff_sha256`），只有審查範圍內的變更才判定 stale，範圍外的檔案改動不再觸發重審。審查範圍必須涵蓋這個 task 實際交付的變更（有 `file_ownership` 就以它為界，否則是全部變更路徑），避免把範圍指向沒動過的檔案來取得一個永不失效的 digest。task 目錄位於 state root 而非 repo，因此 `task-gate`／`close-task` 需要在受審 worktree 內執行或傳入 `--repo-root`。
- `git-guard` 由「denylist 擋已知危險指令」改成「allowlist 只放行已知唯讀指令」，未列在 allowlist 的 git 子指令一律需要使用者明確執行。
- Knowledge／learning 新寫入的預設狀態從 `verified` 改成 `needs_verification`，寫入前一律經 `schemas/knowledge.schema.json` 驗證；entry 依實際 project id 分桶（不再落在字面上的 `default` 目錄），SessionStart 仍只注入當前 project 與 global 的 `verified` 記憶，但改以相關性排序並設下限：同 project 加權，帶 `--query` 時完全不命中關鍵字的 entry 直接不注入。
- `workflow-plan` 的三值判斷拆成兩層：條件明確成立才進 `required`，資料不足只進 `classification_incomplete`（附上缺哪個欄位），不再因為 `impact_scope` 沒填就把所有 capability 強制加入。step 選取維持「unknown 保留」。
- 變更分類收斂成單一欄位：移除 `change_kind` 與 `complexity_hint`，policy 條件改讀 `task_type`，情境旗標一律寫進 `workflow_facts`。 <!-- contract-lint:allow -->
- 新增 `agent-workflow contract-lint`（已納入 `npm run ci`）：以 schema、workflow policy 與 CLI 指令表為真相來源，檢查 `templates/`、`.agents/`、`adapters/` 與 `docs/` 是否還引用退役名稱、不存在的指令或不存在的 schema。
- `.agents` 與 `task.json` 的寫入保護不再依賴 mutation regex：只要指令提到這些路徑，就必須整條命令都落在唯讀 allowlist 內，否則一律 deny（涵蓋 `python -c`、`node -e`、`bash -c`、`powershell -Command` 這類把寫入藏在直譯器參數裡的形式）。
- `file_ownership` 一旦宣告就是硬邊界：任何在它之外的變更路徑（含 rename 的來源側與刪除）直接判定 ownership violation，不會被 diff-scoped review 過濾掉；`reviewed_paths` 也必須涵蓋自 `reviewed_base` 以來的全部變更路徑。
- 重複 option 不再靜默覆蓋：multi-value option（`--id`、`--paths`、`--source-entry` 等）重複給值會累積，comma 形式與重複形式等價；single-value option 重複給值直接報 `duplicate option`。
- 新增 `schemas/cli-output.schema.json`：`workflow-plan`、`task-gate`、`project-doc`、`review-cause`、`skill-draft`、`worktree-fingerprint`、`verify`、`contract-lint`、`policy-matrix` 的 stdout 形狀首次有正式定義，測試會驗證實際輸出符合它。
- 新增 `agent-workflow policy-matrix`：對 task_type × impact_scope × impact_effect × impact_confidence × risk flag 組合 × fact 組合（宣告為真／宣告為假／未宣告）展開 5,760 列，輸出每個 task_type 的 capability／step 選取 digest。測試以 `tests-node/fixtures/policy-matrix.json` 為 golden file，policy 一改就會指名是哪個 task_type 的選取變了。
- `contract-lint` 新增四條規則：文件裡的 option 必須是該 command 接受的 option、backtick 內的 snake_case term 必須來自 schema／policy／CLI、step id 必須存在於 policy、`contract-lint:allow=<rule>` 只豁免指名的那一條規則。fenced code block 現在也會被掃描。
- `git-guard` 改成先做 shell 解析再判斷 command：heredoc body 與引號區段依「接收指令是否把它當資料」決定要不要剝掉（`cat`／`echo`／`grep` 這類是資料，`bash`／`python` 這類是程式碼，保留），分段只在引號外的分隔符切開，`$( )` 與 backtick 的內容一律當成獨立指令解析。引述在資料型指令引號或 heredoc 裡的 Git 指令不再誤判；`bash -c` 型直譯器、`ssh`／`docker` 這類 remote executor、`sudo`／`xargs` 這類 prefix wrapper 與 substitution 裡的真實 Git 寫入則一律攔下。同一套解析也用在 mutation 偵測，所以引號內的 `>` 不再被當成重導向。
- `install`／`repair` 會自動跑 v2→v3 migration：既有 `task.json` 的 evidence／waiver 一律標成 stale，需要重新驗證才能通過新版 `task-gate`。
- `workflow-plan` 遇到未知 capability 或損壞 facts 時改為非零結束。
- `Verify` 從入口存在檢查提升為完整 runtime integrity contract。
- 新增 `task.json.managed_change`：決定是否進入 workflow 的欄位，`code_change` 降級為純描述用途（是否修改 application source code）。既有 v3 task 遷移時 fail-safe 預設為 `managed_change: true`。
- `model_profile` enum 新增 `deep_read`，由 runtime 依 `impact_scope`／`impact_effect`／`risk_flags` 推導（`src/classification/model-profile.ts`），`task-init` 建立 `read_only` task 時自動套用，不再由 agent 自由指定。
- 新增 `test_integrity` capability 與同名 risk flag：純測試變更預設 `selected` 為空清單，只有實際刪除／弱化 assertion、skip 測試或大量改動 snapshot 時才加旗標、才強制這個 capability。
- 新增 `agent-workflow execution-packet`：把一個 task 的 intent（task.md Goal）、classification 與 compiled workflow plan 打包成單一物件，並把 `selected` 的每個 capability 對應到它的 procedure 文件（有獨立 skill 的指向該 skill，其餘指向 `schemas/workflow-policy.json` 作為 single source of truth）。
- 新增 `agent-workflow skill`（`--action List／Verify／Install／Update／Remove`）：`List` 合併 `adapters/managed-manifest.json` 的必裝／選擇性 catalog 與 `skills-lock.json` 的來源資訊；`Verify` 離線比對已 vendor 的 skill 目前雜湊是否仍等於上次鎖定的雜湊；`Install`／`Update` 從本機目錄 vendor 一份 skill 並寫回 `skills-lock.json`，不會替你連網抓取。
- `src/lifecycle.ts` 拆成 `src/lifecycle/` 底下 8 個檔案（transitions／task-store／task-schema／task-gate／evidence／intent／ownership／worktree-lease），對外行為不變。
- 新增 `tests-node/adapters/parity.test.mjs`：同一個操作以 Claude／Codex／Antigravity 三種平台原生 payload 形狀送進 `git-guard`／`skill-guard`，驗證正規化後的 allow／deny 決策一致。
- CI 新增 macOS 與 `package-smoke` job：把打包出的 tarball 安裝進一個乾淨的 scratch 專案，驗證 `npx agent-workflow` 系列指令在「裝進 node_modules 之後」而非只在「原始碼 checkout」下也能跑。
