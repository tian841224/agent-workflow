# agent-workflow

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
| v5 | Python runtime、主對話直接選定 capability／角色、條件式品質角色、跨 agents 記憶與主對話編排 | 將流程選擇與 runtime 執行分離，兼顧彈性、可驗證性與跨平台一致性 |

## 二、功能介紹

### 框架特色

本框架採用條件式組合 workflow，所有流程、skills 與角色都會依據實際任務情境選擇性載入，而不是固定套用完整 pipeline。同時，框架採用漸進式載入方式，會根據每次任務的性質選擇適合的流程，並依當下情境決定需要讀取的文件深度，在維持輸出品質的前提下，盡可能減少 token 浪費與執行時間。透過這種設計，流程能保有最大的彈性與靈活度，既能讓簡單任務維持輕量，也能在複雜或高風險任務中提供足夠的規劃、角色分工與品質控管。

### 條件式 workflow

流程沒有固定 pipeline，由 Planner 依 task metadata 與 `workflow_facts` 先產生 capability 候選，主對話再依已知需求與程式脈絡確認、覆寫或補充，並把最終要跑的角色與檢查完整寫進 task 的 `workflow_request`；runtime 只驗證這份清單的執行結果是否齊全，不自行增減。可透過 `agent_workflow.py workflow-plan` 查看候選與理由。

簡單任務維持直接處理；涉及程式碼邏輯、跨模組影響、資料、契約或高風險行為的任務，才會增加相應的規劃與驗證流程。

Skill 也採條件式主動載入：`codebase_design` 用於介面與 seam 設計，`bug_diagnosis` 用於重現與根因驗證，`tdd` 用於 red → green → refactor 與測試 seam；架構規劃或需求不明時先載入 `planning`，使用者已選定的方案可能增加抽象或複雜度時先載入 `push-back`，高風險且不可逆的未決取捨才載入 `grill-me`。這些 skill 不會自動套用到所有任務，主對話會依場景把需要的 capability 寫入 `workflow_request`。

### Review 與角色化品質檢查

Review（檢查影響範圍、架構一致性、程式碼品質、相容性與失敗情境，並從 real entrypoint 確認完成條件）由主對話依 workflow skill 第 6 節直接執行，不再啟動獨立角色；需要對抗式複查或額外驗證時，把要推翻的假設或要測試的情境直接寫進 Review 指令。

專案僅保留 Worker 為可寫入的原生開發角色，用於平行開發時處理隔離 worktree 中的子任務。

### 平行開發

當一個任務可以拆成兩個以上互不重疊、可獨立驗收的子功能時，專案可以透過 coordinator／worker 建立隔離的 worktree，讓不同子功能平行處理，再由主流程整合與驗證。

### 記憶與自動學習

Runtime 可以讀取 shared knowledge 與安全的原生文字記憶，在新的 session 或 prompt 載入相關脈絡。

自動學習只保存可重複使用的決策、修正與經驗，不保存整段對話；各平台原生記憶維持只讀。

同一類結論反覆出現時，runtime 會把它標為可提煉的模式；agent 依 `distill` skill 寫成 skill 草稿暫存在 `skill-drafts/`，只有使用者明確核准才會 Promote 成生效的 skill。

Review 有打回時，該輪要記錄一次歸因：當初缺的是文件、任務描述、明文規範，還是有規範但沒讀到。同一種原因累積達門檻後，`distill` skill 依原因分派對應補救——缺文件就補文件、缺規範就寫 skill、任務描述不足就改 task 模板，補救一律需使用者核准。

### 跨平台記憶讀取

專案支援 Claude Code、Codex 與 Antigravity 之間的記憶脈絡讀取。各平台啟動新的 session 或收到新的 prompt 時，runtime 會依目前專案與任務內容，從共用 knowledge 與各平台可讀取的原生記憶中篩選相關資訊，提供給 AI 參考。

這項功能只負責讀取與整理記憶，不會任意改寫其他平台的原生記憶，讓不同 AI 工具在同一個專案中能共享必要脈絡，同時保留各平台原有的記憶機制。

### Skills

`.agents/skills/` 是跨平台共用的 skill canonical source。安裝程式會依 managed manifest 將適用的 skill 同步到指定平台的 adapter；AI agent 會根據任務性質與 workflow_request 載入適用的 skill。

| Skill | 用途與適用時機 |
| --- | --- |
| [`workflow`](.agents/skills/workflow/SKILL.md) | 修改 application source code logic 時，由主對話依實際觀察到的 impact 與 risk 決定是否建立 task、寫入 `workflow_request` 啟用哪些 capability；isolated 且無明確風險的修改可採最小驗證。純 test code 修改仍執行相關測試，但 bypass workflow；文件、設定、script、除錯分析與規劃等 non-code task 也直接 bypass。 |
| [`tdd`](.agents/skills/tdd/SKILL.md) | 定義 red → green → refactor、seam、行為導向測試、測試反模式與 mock 邊界；選取 `tdd` capability 時由 workflow 主動載入並在 task 記錄 TDD evidence。 |
| [`planning`](.agents/skills/planning/SKILL.md) | 進行架構設計、功能規劃、重構策略、技術方案比較或需求不明時，先釐清目標、限制與完成條件。 |
| [`grill-me`](.agents/skills/grill-me/SKILL.md) | 需求籠統、決策未明，或使用者要求壓力測試計畫與假設時，逐一檢查高風險未決分支。 |
| [`push-back`](.agents/skills/push-back/SKILL.md) | 使用者選定實作或設計方向後，若涉及新增 abstraction、interface、adapter、wrapper 或 cross-layer seam，先檢查是否符合現有架構、是否為最小改動，以及是否引入不必要的複雜度。 |
| [`project-docs`](.agents/skills/project-docs/SKILL.md) | 修改 application source code 前載入；先查出涵蓋本次路徑的 `docs/` 文件並讀過再動手，改完後依查詢結果建立缺少的文件或更新已失準的內容。定義 architecture／structure／dataflow／flow／module／api／decision／glossary 的佈局與必要區塊。 |
| [`doc-coauthoring`](.agents/skills/doc-coauthoring/SKILL.md) | 撰寫 README、規格、提案或決策文件時，依序進行脈絡整理、結構化編寫與讀者檢查。 |
| [`clean-comments`](.agents/skills/clean-comments/SKILL.md) | 修改 application source code logic 前載入；若涉及註解，聚焦於目的、合約與非顯而易見的原因，避免贅述實作細節。test code 與其他 non-code task 不適用。 |
| [`codebase-design`](.agents/skills/codebase-design/SKILL.md) | 設計或改善模組介面、尋找加深機會、決定 seam 位置時，提供 deep module／seam／adapter 等共用詞彙；選取 `codebase_design` capability 時主動載入。 |
| [`architecture-review`](.agents/skills/architecture-review/SKILL.md) | 審查既有程式架構、跨層耦合、模組責任、契約漂移與遷移風險；以 static fact、hypothesis、runtime proof 區分證據，並提出最小可行的漸進式改善方案。 |
| [`diagnosing-bugs`](.agents/skills/diagnosing-bugs/SKILL.md) | 除錯疑難雜症或效能異常時，依六階段紀律先重現、再假設、再修正；選取 `bug_diagnosis` capability 時主動載入並記錄診斷證據。 |
| [`writing-for-agents`](.agents/skills/writing-for-agents/SKILL.md) | 撰寫或修改 `.agents/` 底下的角色檔與 skill 文件時，統一 pointer 寫法、分層揭露與去重判準。 |
| [`localization-tw`](.agents/skills/localization-tw/SKILL.md) | 產生或翻譯正體中文（臺灣）內容時，統一術語、語氣與標點，避免中國用語與簡體直譯。 |
| [`learn`](.agents/skills/learn/SKILL.md) | 使用者要求記憶、提出糾正、拍板決策，或確認錯誤修正方式時，保存可重複使用的結論。 |
| [`distill`](.agents/skills/distill/SKILL.md) | 記憶中同一類結論反覆出現時，提煉成待審的 skill 草稿；Promote 需要使用者明確核准。 |

### 設計原則與邊界

- 小任務保持小流程；複雜任務才增加必要的角色與驗證。
- `unknown` 代表尚未證明，不代表沒有影響。
- 角色預設為唯讀；只有 Worker 是允許寫入的開發角色。
- 不自行 commit、push、rebase、merge 或執行破壞性 Git 操作。
- 保留使用者既有修改，只處理需求直接涵蓋的範圍。
- README 是專案導覽，不取代 workflow skill、risk flags 與 orchestration 文件中的完整操作規則。

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
        agent_workflow.py（經 agent_workflow.cmd／agent-workflow 呼叫）
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
├─ .claude/                   Claude Code 的 agent、skills 與 hooks
├─ .codex/                    Codex 的 agent、skills、rules 與 hooks
├─ .gemini/                   Antigravity 的 agent、skills 與 hooks
└─ .agent-workflow/           agent-workflow runtime 與使用者資料
   ├─ runtime/                已安裝的 Python runtime 與 CLI
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

不同 AI 工具的原生設定則由 installer 依平台建立，並透過 adapter 連結到 `.agents` 的 canonical source。未指定的平台不會建立或修改對應的 agent 資料夾。安裝需求為 Windows 與 Python 3.11 以上。

### 主要元件分工

| 元件 | 責任 |
| --- | --- |
| `.agents/skills/` | 共用 skills、workflow policy、風險與平行編排規則 |
| `.agents/agents/` | Worker 角色（平行開發子任務）；Review 與回歸歸因改由主對話直接執行 |
| `agent_workflow/` | workflow 選取評估、installer、guard、task、knowledge 與驗證邏輯 |
| `adapters/` | 各 AI 平台的設定與 hooks |
| `schemas/` | task、workflow、knowledge、project 與 retro 的資料契約 |
| `templates/` | Standard、Elevated 與其他 task 範本 |
| `runtime/` | Python runtime contract 與執行限制 |
| `tests/` | runtime、installer、hook、task、knowledge 與 migration 驗證 |

## 四、安裝方法

### 安裝需求

- Windows
- Python 3.11 以上
- 可使用 `py.exe` 或 `python.exe`

### 安裝

在 repository 根目錄執行：

```bat
install.cmd --target-agent All
```

`--target-agent` 可依需求指定安裝平台：

- `Claude`
- `Codex`
- `Antigravity`
- `All`

安裝程式會將共用的 skills、角色、workflow 規則與 hooks 設定到對應平台，並在使用者家目錄建立 `.agent-workflow` runtime 與資料夾。

### 檢查安裝狀態

```bat
install.cmd --action Verify
```

如果需要重新同步或修復已安裝的檔案：

```bat
install.cmd --action Repair --target-agent All
```

### 移除安裝

```bat
install.cmd --action Uninstall --target-agent All
```

移除安裝時，只會移除仍由本專案管理且未被使用者修改的 managed files，不會刪除既有的 knowledge、projects、tasks 或 imports 資料。
