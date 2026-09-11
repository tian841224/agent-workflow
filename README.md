# agent-workflow

## 安裝

Clone 後執行：

```text
npm install
npm run build
npm run setup
```

`npm run build` 產生兩個不進版控的 ESM bundle，`npm run setup` 依賴兩者都存在才能執行安裝：`dist/agent-workflow.mjs` 是完整 CLI，`dist/agent-workflow-hook.mjs` 只含 guard 判斷所需的程式碼，供每次 tool call 都會執行的 hook 使用。`npm run setup` 會啟動互動式安裝：required skills 一律安裝，optional skills 由使用者選取。

安裝同時把 CLI 放上 PATH：`agent-workflow.mjs` 會原封不動複製到 npm global prefix 成為無副檔名的 `agent-workflow`（Windows 另加 `.cmd`），因此 `agent-workflow <command>` 在任何專案都能執行，不需要 repo checkout。這份副本必須與 runtime bundle 位元組相同，hook 的身分驗證才會通過，所以不要改用 `npm install -g` 產生的 shim 取代它。
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

1. **Managed change**：`managed_change: true` 時建立 task，runtime 一次編譯 plan 與 procedure pointers；capability 由 policy 與任務脈絡決定。
2. **Test-only change**：新增測試、強化 assertion 或安全 test refactor 可 `managed_change: false` 直接 bypass；刪除／skip 測試、弱化 assertion 或大量重寫 snapshot／fixture baseline 時改為 `managed_change: true`，並加入 `test_integrity` risk flag。
3. **Non-application-source change**：純文件、註解、read-only 分析通常 bypass；CI/CD、Dockerfile、nginx、migration、deploy script、Terraform 等設定或 script 依是否會影響部署、執行、資料或交付結果判斷。
4. **唯讀任務**：一般的唯讀問答、分析與 review 屬於 unmanaged，不建立 task，host 直接選用唯讀 reader agent，不啟動具寫入權限的 implementation worker。只有本來就存在 task record 的唯讀或 orchestration 情境才使用 `task_type: read_only`；探索深度仍由 compiled plan 的 `exploration_profile` 決定，不假設各 AI 平台都能遵守自訂模型分級。

流程沒有固定的完整 pipeline。runtime 依 task metadata、`workflow_facts` 與 policy 編譯 `required`、`requested`、`selected`、步驟順序與 procedure pointers；`workflow_request` 只能增加檢查，不能移除 required。所有 managed task 都需要 `delivery_validation.DV1` runtime receipt；高風險 capability 仍各自保留。高信心、單檔、局部行為且無高風險 flag 的修改維持 focused exploration；低信心、影響面擴大、契約／資料／schema／不可逆或其他高風險情境才使用 expanded exploration。selected evidence 與 Reviewer 共用一份 impact map，同一個驗證命令可用多個 `--requirement-id` 一次記錄。需求未明時先用 `planning` 釐清；Freeze-required flags 仍依 task schema 的確認規則處理。

Project docs 也採條件式載入：單純 `code_change: true` 不會自動加入 project-doc procedure；只有 module+、shared behavior、contract、data/schema、expanded exploration 或其他相關高影響邊界才做 Lookup／讀取／Remember。高信心的 file-local `local_behavior` 修改直接依程式與測試處理。

建立 managed task 後先執行一次 `agent-workflow preflight --task-path <path> --repo-root <repo>`，集中檢查 Node、Git worktree、task intent、lease、依賴與平台 shell。實作期間只跑必要的局部回饋；待程式碼、測試、文件與 Review 穩定後，再執行一次最終回歸並批次記錄 runtime evidence。最後一次交付變更會使舊 receipt 失效，必須重新執行；內容、命令、環境與驗證範圍都沒有改變時則重用仍有效的 evidence，不為了流程節點重跑相同檢查。

`workflow_request` 的 capability 名稱以 `schemas/workflow-policy.json` 為唯一來源。未知名稱、重複項目或無效的 `workflow_facts` 會讓 `workflow-plan` 以非零狀態結束，不會靜默產生空 plan。

本機驗證用 `node scripts/run-tests.mjs --profile <focused|affected|regression|full>`：`focused` 與 `affected` 要明列測試路徑，`regression` 可指定 subsystem 或省略路徑跑完整 regression set，`full` 固定跑全部 `tests-node/**/*.test.mjs` 且拒絕混入路徑。CI 仍使用 full profile；runtime evidence 應記錄實際使用的 profile 與路徑。

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

專案保留 Claude Code、Codex 與 Antigravity 的 `memory-context` hook，但自動 hook 一律使用嚴格 relevance gate。沒有能代表目前任務的有效 query 時直接回空，且在列舉／讀取 knowledge entries 前就停止；不得用同 project、最近更新或降低 threshold 來補結果。有 query 時，只有所有有效關鍵字都命中的 verified memory 才能注入，沒有相關結果就是 0 筆。

任務真的需要歷史脈絡時，由 agent 以目前任務的 2–5 個關鍵字執行 `agent-workflow knowledge --action Search --query '<keywords>'`；原生來源與 curated knowledge 都只作參考，使用前仍需依目前程式、文件或設定驗證。

### Skills

`.agents/skills/` 是跨平台共用的 skill canonical source。安裝程式會依 managed manifest 將適用的 skill 同步到指定平台的 adapter；AI agent 會根據任務性質與 workflow_request 載入適用的 skill。

| Skill | 類型 | 用途與適用時機 |
| --- | --- | --- |
| [`workflow`](.agents/skills/workflow/SKILL.md) | 必裝 | 由 `managed_change` 決定是否建立 task，再依實際 impact／risk 決定 `workflow_request` 與 required capability；安全 test-only、文件與 read-only 任務可 bypass，高風險設定／script 與 test-integrity 修改仍進 workflow。 |
| [`codebase-design`](.agents/skills/codebase-design/SKILL.md) | 必裝 | 設計或改善模組介面、尋找加深機會、決定 seam 位置時，提供 deep module／interface／depth／seam／adapter 等設計標準；選取 `codebase_design` capability 時主動載入。 |
| [`planning`](.agents/skills/planning/SKILL.md) | 必裝 | 只有方向、技術取捨或真正模糊需求會影響後續實作時使用；可逆低風險決定優先依 repo convention 自行處理。 |
| [`push-back`](.agents/skills/push-back/SKILL.md) | 必裝 | 核心規則已常駐於 `AGENTS.md`；skill 保留相容入口，僅在需要明確檢查方案是否錯誤、危險或不必要複雜時使用。 |
| [`learn`](.agents/skills/learn/SKILL.md) | 必裝 | 使用者要求記憶、提出糾正、拍板決策，或確認錯誤修正方式時，保存可重複使用的結論。 |
| [`grill-me`](.agents/skills/grill-me/SKILL.md) | 必裝 | 使用者要求壓力測試或計畫已有高風險未決假設時，逐題進行深度提問直到決策樹清晰。 |
| [`tdd`](.agents/skills/tdd/SKILL.md) | 必裝 | 定義 red → green → refactor、seam、行為導向測試、測試反模式與 mock 邊界；選取 `tdd` capability 時由 workflow 主動載入並記錄 TDD evidence。 |
| [`clean-comments`](.agents/skills/clean-comments/SKILL.md) | 必裝 | 核心「只解釋非顯而易見的意圖／限制／原因、不逐句翻譯程式碼」規則已常駐於 `AGENTS.md`；只有多行註解、public/doc comments、高風險判斷依據或 comment pollution 才載入完整 skill。 |
| [`architecture-review`](.agents/skills/architecture-review/SKILL.md) | 選擇性 | 審查既有程式架構、跨層耦合、模組責任、契約漂移與遷移風險；以 static fact、hypothesis、runtime proof 區分證據並提出漸進改善方案。 |
| [`diagnosing-bugs`](.agents/skills/diagnosing-bugs/SKILL.md) | 選擇性 | 原因不明、間歇性或效能型問題才載入；依可靠 signal、可證偽診斷與 confirmed fix 收斂，不強迫固定 phase 或 hypothesis 數量。 |
| [`project-docs`](.agents/skills/project-docs/SKILL.md) | 選擇性 | execution packet 判定 module/shared behavior、contract、data/schema、expanded exploration 或其他高影響脈絡需要時才載入；file-local 高信心修改不自動讀文件。 |
| [`distill`](.agents/skills/distill/SKILL.md) | 選擇性 | 記憶中同一類結論反覆出現或 review 歸因達門檻時，提煉成待審的 skill 草稿或分派補救措施；Promote 需要使用者明確核准。 |
| [`operational-verification`](.agents/skills/operational-verification/SKILL.md) | 選擇性 | 進行安裝、同步、部署、migration、provisioning 或外部整合驗證時，區分靜態設定、本機 mock、本機 runtime 與遠端環境證據層級。 |
| [`localization-tw`](.agents/skills/localization-tw/SKILL.md) | 選擇性 | EN／JA ↔ zh-TW 翻譯、中文 UI copy 或術語敏感的正式在地化才載入；一般中文回覆只遵守 `AGENTS.md` 的短 locale 規則。skill 內再分 `locale.md`、`translation.md` 與按需 `references/`。 |
| [`archify`](.agents/skills/archify/SKILL.md) | 選擇性 | 將架構、workflow、sequence、data-flow 與 lifecycle 需求轉成可驗證、可互動的 standalone HTML 圖表；final `deliver` 是 authoritative acceptance，未變更的 validation evidence 直接重用。來源：[tt-a1i/archify](https://github.com/tt-a1i/archify)。 |
| [`design-and-refine`](.agents/skills/design-and-refine/SKILL.md) | 選擇性 | 只有需要比較多個實質不同的 UI 方向時才進 Design Lab；問題數與 variant 數依實際設計空間決定，不固定問卷或固定五種方案。來源：[0xdesign/design-plugin](https://github.com/0xdesign/design-plugin)。 |
| [`doc-coauthoring`](.agents/skills/doc-coauthoring/SKILL.md) | 共用 | 大型規格、提案或決策文件才按需要使用 context／refinement／reader testing；資訊足夠時直接起草，不先要求使用者選流程。 |
| [`writing-for-agents`](.agents/skills/writing-for-agents/SKILL.md) | 共用 | 撰寫或修改 `.agents/` 底下的角色檔與 skill 文件時，統一 pointer 寫法、分層揭露與去重判準。 |
| [`humanizer`](.agents/skills/humanizer/SKILL.md) | 選擇性 | 消除 AI 腔調與公式化套話，讓文字讀起來自然真實，保留事實與作者聲音。 |
| [`adhd-comms`](.agents/skills/adhd-comms/SKILL.md) | 選擇性 | 採取 Action-first 與高掃讀性溝通，結論先行、分點陳述、低認知負擔。 |
| [`hallmark`](.agents/skills/hallmark/SKILL.md) | 選擇性 | 明確需要 anti-AI-slop 設計、audit、redesign 或 study 時使用；依 scope 與實際 acceptance criteria 決定探索與驗證，不跑固定 8 states／theme／variant recipe。來源：[nutlope/hallmark](https://github.com/nutlope/hallmark)。 |

### 設計原則與硬護欄

- **不自行變更 Git 狀態**：不自行 commit、push、rebase、merge 或執行破壞性 Git 操作。
- **尊重使用者修改**：不覆寫、刪除或重設使用者未要求處理的修改與資料。
- **技術判斷不盲從**：使用者指定的做法若明顯錯誤、矛盾、危險或造成不必要複雜度，先指出影響與替代方案；合理取捨則尊重選擇。
- **註解只保留高資訊內容**：只說明非顯而易見的意圖、限制、合約或原因，不逐句翻譯程式碼或重述命名。
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
   agent-workflow.mjs（CLI）  agent-workflow-hook.mjs（guard hook）
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

agents、skills、hooks 與 runtime 的架構原則見 [docs/architecture.md](docs/architecture.md)；procedure bytes 之外的真實端到端成本（wall-clock、token、tool round trip、返工）量測方式見 [docs/replay-benchmark.md](docs/replay-benchmark.md)。

### 主要元件分工

| 元件 | 責任 |
| --- | --- |
| `.agents/skills/` | 共用 skills、workflow policy、風險與平行編排規則 |
| `.agents/agents/` | 角色定義（Worker 處理隔離子任務；Reader 處理唯讀分析） |
| `src/lifecycle/` | task.json 的 transition、gate、evidence、intent approval 與 worktree lease |
| `src/classification/` | 從 task.json 讀出 workflow policy 條件評估用的分類 context |
| `src/execution/` | 把 intent、classification 與 compiled workflow plan 打包成單一 execution packet 給實作 agent |
| `src/` 其餘 | workflow policy 編譯、installer、guard、skill manifest、knowledge、learn、distill 與驗證邏輯 |
| `adapters/` | 各 AI 平台的設定、manifest 與 hooks |
| `schemas/` | task、workflow、knowledge、project、retro、review-cause 等資料契約 |
| `skills-lock.json` | 從外部來源 vendor 進來的 optional skill 的來源與雜湊紀錄 |
| `templates/` | task intent 與其他工作流程範本 |
| `runtime/` | Node runtime contract 與執行限制 |
| `docs/` | 本 repo 自己的 project docs：architecture 原則、module 文件、發布驗證與歷史記錄 |
| `tests-node/` | runtime、installer、hook、task、knowledge、orchestrate、adapter parity、migration 與 procedure budget 完整驗證 |

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
