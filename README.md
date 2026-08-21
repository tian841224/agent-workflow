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
| v4 | 依情境載入流程、canonical `.agents`、TDD、impact-guard、記憶與專案文件 | 讓流程更貼近實際影響範圍，降低重複規範與 context 成本 |
| v5 | Python runtime、組合式 Planner、條件式品質角色、跨 agents 記憶與主對話編排 | 將流程選擇與 runtime 執行分離，兼顧彈性、可驗證性與跨平台一致性 |

## 二、功能介紹

### 條件式 workflow

專案會先判斷任務的性質與影響範圍，再決定是否需要建立 task、執行額外檢查或啟用品質角色。

簡單任務維持直接處理；涉及程式碼邏輯、跨模組影響、資料、契約或高風險行為的任務，才會增加相應的規劃與驗證流程。

### 角色化品質檢查

專案提供獨立的 Reviewer、Adversarial 與 Verifier 角色，依任務需求選擇性啟用：

- Reviewer：檢查影響範圍、架構一致性、程式碼品質、相容性與失敗情境。
- Adversarial：從反向角度檢查實作假設，以及資料、契約、遷移與不可逆操作風險。
- Verifier：執行適合的測試或驗證，確認實作是否符合完成條件。

這些角色不是固定套用在每個任務上，而是根據任務的風險、影響範圍與完成條件適度啟用。

### 平行開發

當一個任務可以拆成兩個以上互不重疊、可獨立驗收的子功能時，專案可以透過 coordinator／worker 建立隔離的 worktree，讓不同子功能平行處理，再由主流程整合與驗證。

### 記憶與自動學習

Runtime 可以讀取 shared knowledge 與安全的原生文字記憶，在新的 session 或 prompt 載入相關脈絡。

自動學習只保存可重複使用的決策、修正與經驗，不保存整段對話；各平台原生記憶維持只讀。

### 跨平台記憶讀取

專案支援 Claude Code、Codex 與 Antigravity 之間的記憶脈絡讀取。各平台啟動新的 session 或收到新的 prompt 時，runtime 會依目前專案與任務內容，從共用 knowledge 與各平台可讀取的原生記憶中篩選相關資訊，提供給 AI 參考。

這項功能只負責讀取與整理記憶，不會任意改寫其他平台的原生記憶，讓不同 AI 工具在同一個專案中能共享必要脈絡，同時保留各平台原有的記憶機制。

### 設計原則與邊界

- 小任務保持小流程；複雜任務才增加必要的角色與驗證。
- `unknown` 代表尚未證明，不代表沒有影響。
- 角色預設為唯讀；只有 Worker 是允許寫入的開發角色。
- 不自行 commit、push、rebase、merge 或執行破壞性 Git 操作。
- 保留使用者既有修改，只處理需求直接涵蓋的範圍。
- Verifier 若需要 Docker／SQL，只使用一次性且可清理的驗證資源。
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
                 agent_workflow.py / agent_workflow.cmd
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
| `.agents/agents/` | Reviewer、Adversarial、Verifier、Retrospective 與 Worker 等角色 |
| `agent_workflow/` | planner、installer、guard、task、knowledge 與驗證邏輯 |
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
