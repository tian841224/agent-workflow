# agent-workflow v4

跨 Claude Code、Codex、Antigravity 的輕量程式任務流程。只有實際修改「目標專案」用程式語言撰寫的 application source code 邏輯或 test code 邏輯時才使用 workflow、建立 `task.md` 並執行 Reviewer、Verifier；純註解修改、設定與文件修改、script 修改與操作等非程式邏輯修改任務直接由單一主對話處理，不載入 workflow 或角色。

Runtime 採使用者安裝的 Python 3.11+：hook 的 stdin/stdout 一律是 UTF-8 bytes、stdout 只輸出一行 JSON、child process 以 bounded timeout 執行。安裝後以 `~/.agent-workflow/runtime/agent_workflow.cmd <command>` 呼叫工具；安裝器會記錄實際 `sys.executable`，不依賴 Windows console code page。

## 架構

- `AGENTS.md`：常駐硬規則。
- `.agents\skills\`：共用 skill source；installer 會將所有 repo skill 同步到使用者的 `.agents\skills`。
  - `workflow/`：主流程、`risk-flags.md`、平行編排規則 `orchestration.md`，與專案文件規則 `project-docs.md`（分工、佈局、staleness 語意，見下方「專案文件」一節）。
  - `planning/`：架構設計、功能規劃、重構策略、技術方案比較等規劃工作；也是 `unclear_requirements` 釐清目標與限制的第一步。
  - `grill-me/`：壓力測試計畫與假設；使用者明確要求，或 `unclear_requirements` 仍有風險時用於第二步（逐一提問釐清決策樹）。
  - `push-back/`：在使用者選定或即將採用某個做法時，主動評估是否符合現有架構、是否為最小改動、會不會增加不必要複雜度，必要時提出具體替代方案。
  - `doc-coauthoring/`：與使用者共同撰寫技術文件、決策文件、proposal 或 spec；一般任務走 quick path，重大文件才走脈絡蒐集 → 逐節撰寫 → 讀者測試三階段。跟 `project-docs.md` 定義的目標 repo `docs/` 文件無關，這個 skill 產出的是給人讀的獨立文件（PRD、design doc、RFC 等）。
  - `localization-tw/`：正體中文（臺灣）在地化與翻譯技能，確保輸出符合臺灣華語母語者慣用方式，避免中國用語與簡體直譯。
- `.agents\agents\reviewer.md`、`.agents\agents\adversarial.md`、`.agents\agents\verifier.md`、`.agents\agents\retrospective.md`：唯讀角色 canonical source（`adversarial` 只在高風險 `risk_flags` 命中時，於 Reviewer PASS 後、Verifier 之前加開；`retrospective` 只在疑似 regression、同一問題反覆修正或使用者要求時加開）。`.agents\agents\worker.md`：可寫角色，coordinator／worker 編排的 worker 端 canonical source（v1 僅 Claude 有平台 adapter）。
- `agent_workflow/`：Python 核心套件，提供完整的 runtime 實作、守門規則、驗證、記憶管理與專案文件邏輯。
- `agent_workflow.py` / `agent_workflow.cmd`：統一 CLI 入口（例如 `agent_workflow <command> [options]`）。
- `scripts/`：相容 wrapper 入口（如 `scripts/knowledge.py`、`scripts/project-doc.py` 等）。
- 預設 adapter 只註冊 `hooks/git-guard.py`，保護 destructive Git 操作。`quality-gate.py` 與 `impact-guard.py` 保留給進階／編排流程手動使用，不會在一般 agent session 自動執行。三平台 hook payload 差異只由 adapter 處理，README 不重複維護 hook 內部解析細節。
- `schemas/`、`templates/task-minimal.md`、`templates/task.md`：Task 與遷移資料契約。Standard 使用 minimal template；Elevated／coordinator／worker 使用 extended template，後者含 coordinator／worker 的 optional 欄位（`subtask_role`、`parent_task_id`、`file_ownership`、`delivery_status`、`integration_status`）與 legacy gate 欄位。`schemas/retro.schema.json` 是回顧詞彙（`classification`、八類 `miss_category`、`escalate_threshold`）與 finding 紀錄結構的單一來源，`task-gate.py` 與 `retro.py` 都讀它。
- `install.py` / `install.cmd`：managed-file installer。
- `migrate-v3.py`：一次性 v3 資料正規化遷移。

Runtime 安裝在 `~/.agent-workflow/runtime/`，使用者資料放在 `~/.agent-workflow/knowledge/`、`projects/`、`imports/`。平台目錄只保留必要入口、skill、原生角色與 hook 設定，不建立 v3 路徑 alias。

## Task

只有實際修改「目標專案」source code logic 或 test code logic 才建立：

```text
~/.agent-workflow/projects/<project-id>/tasks/<task-id>/task.md
```

同一 worktree 最多一個 `in_progress` task。Task 必須填 `code_change: true | false`：只有修改「目標專案」source code logic 或 test code logic 為 `true`；script、設定、文件、註解、測試調查、除錯分析與 code review bypass workflow，不建立 task。Standard code task 使用 `templates/task-minimal.md`；Elevated／coordinator／worker 才使用 extended task。只有 `true` 強制依序執行 Reviewer、Verifier（命中六個高代價旗標時，中間再加一輪 Adversarial 複查）；凍結、驗收案例、browser 與風險檢查仍依 `risk_flags` 漸進增加。

`code_change: true` 時另填 `change_kind: fix | feature | refactor | chore`。它不在 schema 的 `required` 裡（既有 task 與 `orchestrate.py` 產生的 worker frontmatter 都沒有這個欄位），由 `task-gate.py --mode Close` 在結案時要求。

### Risk Flags

`risk_flags` 只能使用以下值，依實際風險加入，不為湊流程加 flag：

`behavior_change`、`ui`、`data_write`、`contract`、`schema`、`financial`、`authorization`、`cross_feature`、`migration`、`irreversible`、`unclear_requirements`

各值的定義、對應要求與 freeze-required 詳細規則，統一記錄在 [`.agents/skills/workflow/risk-flags.md`](.agents/skills/workflow/risk-flags.md)，修改流程時只需改這一份檔案；`risk_flags` 只控制凍結、驗收案例、browser 與風險檢查等額外要求是否漸進加入，不影響 Reviewer／Verifier 是否啟動；唯一例外是 Adversarial 複查，只由 `risk_flags` 觸發。

### 實作、Pre-review、角色與收尾

完整操作規則（Standard／Elevated workflow、Reviewer、Verifier 與條件式風險檢查）以 [`.agents/skills/workflow/SKILL.md`](.agents/skills/workflow/SKILL.md) 為唯一權威，本檔不重述——README 的定位是架構導覽，不是第二份操作手冊。角色 canonical source 見上方「架構」一節；legacy runtime gate 僅供 coordinator／worker 或明確啟用的 Elevated task 使用。

## 平行編排

每次 code task 開發前，主對話先做輕量拆分評估。若不適合，直接循序處理；若適合，先向使用者說明 worker 分工與依賴並詢問是否平行處理，只有使用者確認後才建立多個 worker。確認後各 worker 在 detached worktree 執行完整既有 workflow，成果以 `git apply` 移植回主工作目錄的未提交變更；主對話改當 **coordinator**，只負責拆分、worktree／delivery 管理與整合審查，不直接改 source。v1 僅 **Manual** 模式（`orchestrate.py` 不啟動 agent），Claude／Codex／Antigravity 皆為 sequential fallback。

```bat
agent_workflow split-plan --coordinator-task-path <task.md> --plan-path .\split-plan.json
agent_workflow orchestrate --action Init|Collect|Apply|Resolve|Reject|Cleanup|Status --plan-path .\split-plan.json
```

拆分條件、生命週期各動作、狀態機、ownership 與衝突合併、impact-guard 的具名例外、`.agent-workflow-worktree-init.py` 契約、已知限制，完整定義在 [`.agents/skills/workflow/orchestration.md`](.agents/skills/workflow/orchestration.md)——同理，本檔不重述細節。

## 記憶

程式任務可用少量關鍵字讀取 global 與目前 project 的相關記憶；只有發生可重用踩坑、使用者糾正、重要決策或既有認知失效時才寫入，不強制每個 task 沉澱。

```bat
agent_workflow knowledge --action Search --query "installer hooks" --limit 5
agent_workflow knowledge --action Upsert --scope Project --topic "installer-hooks" --content "<verified knowledge>"
agent_workflow knowledge --action Reindex --scope All
```

Search 是關鍵字子字串比對：query 用小寫英文單字、以空白分隔（topic 是英文 kebab-case，中文命中率極低），結果只回 entry 第一行前 180 字，命中後要讀 `path` 全文。寫入時第一行要寫成可獨立理解的摘要句。專案結構與模組流程不走 knowledge，改走下方「專案文件」一節的 `project-doc`。

### 跨平台原生記憶

各平台仍會寫自己的記憶（Codex `~/.codex/memories`、Claude 專案 `memory/`）。Search 會一併讀取並列出，標記 `scope: native`、`source: <平台>`、`status: needs_verification`，讓任一 agent 都看得到其他平台記下的事，避免跨平台記憶分歧。**Antigravity 不在此列**：其原生記憶存在 protobuf（`~/.gemini/antigravity/brain/<uuid>/`），不是 markdown，`knowledge` 讀不到；三平台只有 Codex 與 Claude 互見。

原生記憶**只讀不寫**：不複製進 curated store、不改動原檔，所以各平台的功能維持原狀。自動產生的 session 摘要（`rollout_summaries`）預設排除以免淹沒命中，需要時加 `--include-session-summaries`；只要 curated 結果時加 `--exclude-native`。原生記憶未經整理，一律當線索、使用前回查。

Project knowledge 可直接更新；Global knowledge 需要跨專案證據與使用者同意，並傳入 `--approved-by-user`。`needs_verification` entry 只能作為查證線索。Script 會拒絕疑似 credential 內容，同 scope 相同內容不重複建立，同 topic 更新 native entry 並保留關聯。

## 專案文件

`knowledge` 記踩坑與決策（topic 關鍵字檢索），不負責描述系統結構；`project-doc` 補這一段，記「這塊 code 是什麼、流程怎麼走」，用**路徑反查**取代關鍵字檢索。文件存在目標 repo 自身的 `docs/`（跟著 repo 與 branch 走版控），不是框架 state：

```text
docs/
├─ architecture.md        系統總覽（一份）
├─ dataflow.md             跨模組主要資料流（一份）
├─ modules/<slug>.md       模組文件（多份，need-driven）
└─ api/<slug>.md           API 規格（多份，need-driven；新增或修改對外端點時才建立）
```

Frontmatter 只兩個必填欄位：`doc_type: architecture | dataflow | module | api` 與 `covers: ["game/gameList/Seth_10017/"]`（repo-relative 路徑陣列，文法與 `file_ownership` 相同）。module 文件固定六區塊：`Responsibility`、`Entrypoints`、`Flow`、`Shared state`、`Invariants and gotchas`、`Unverified`；只記反向搜尋做不出來的東西（為什麼、隱藏入口），不記行號、簽名或呼叫端清單——那些 grep 一次就有且永遠最新。api 文件固定七區塊（`Endpoint`、`Auth`、`Request`、`Response`、`Errors`、`Invariants and gotchas`、`Unverified`），跟 module 文件相反，**刻意**記錄完整 request／response schema，因為 API 是對外契約，省略細節會讓呼叫端看不到變動。**不設行數上限**：篇幅過長時依 `covers` 拆成多份，而不是刪減內容。

```bat
agent_workflow project-doc --action Lookup --paths "game/gameList/Seth_10017/"   # 命中文件 + uncovered，附帶 architecture/dataflow
agent_workflow project-doc --action Stale                                         # 只列 stale／stale_pending 的文件
```

`stale`／`stale_pending` 純由 git 歷史推導（涵蓋路徑是否在文件之後又被 commit／有未提交改動），不是可手動填的欄位，不可能被改假；未進版控的新文件一律視為最新。

**Project docs 採條件式使用**：陌生模組、架構／契約／跨功能變更或高風險 flag 才執行 Lookup 並記錄 `read:`；局部 bug fix、chore 與不依賴架構脈絡的修改以現況 code、呼叫端與測試為準。`updated:` 只在 feature、refactor 或相關 risk flag 命中時要求，避免為了過 gate 產生沒有資訊量的文件。細節見 [`.agents/skills/workflow/project-docs.md`](.agents/skills/workflow/project-docs.md)。

## 遷移

```bat
python migrate-v3.py --action Inventory
python migrate-v3.py --action DryRun
python migrate-v3.py --action Stage
python migrate-v3.py --action Validate
python migrate-v3.py --action Activate
```

有 unresolved source 時，`Activate` 會要求傳入 validation report 的 manifest hash。原始檔保留 immutable snapshot 與 SHA-256；v4 activation 後不讀 v3 格式。

## 安裝

```bat
install.cmd --target-agent All
install.cmd --action Status
install.cmd --action Repair --target-agent All
install.cmd --action Verify
install.cmd --action Uninstall --target-agent All
```

`--action Verify` 唯讀，回報 user-installed Python 與 Python entrypoint 是否完整；不通過時 `exit 1`。`install.cmd` 只負責尋找使用者安裝的 Python，安裝、hook 合併與檔案寫入都在 Python 執行。

Global entrypoint 以 `C:\Users\<user>\.agents\AGENTS.md` 為 canonical source；Claude `CLAUDE.md`、Codex `AGENTS.md` 與 Antigravity `GEMINI.md` 由 installer 建立 hard link 指向同一檔案。共用 `reviewer`／`verifier` 集中在 `.agents\agents`，所有 repo skill 集中在 `.agents\skills`；Claude、Codex 與 Antigravity 的原生 skill discovery path 由 junction 指向同一份 canonical skill 目錄，不再各自維護副本。平台 Markdown／TOML 檔案是由 canonical source 產生的 adapter。三平台 unmanaged content 發生衝突時會先建立 timestamp backup 並停止，不會猜測合併。

發現尚未遷移的 v3 knowledge/history 時，installer 會阻止 activation。Uninstall 只移除 hash 未變的 managed runtime，不刪 knowledge、projects、tasks 或 imports。

## 開發檢查

測試腳本放在 `tests/`，以 Python 3.11+ 執行，涵蓋靜態契約、task 驗證、平行編排 lifecycle、hook、knowledge、pre-review、installer、migration 與專案文件：

```bat
python tests/run_all.py
```

`.pre-review-extra.py`（repo 根目錄）在 pre-review 階段執行 `tests/` 下全部測試；本 repo 沒有 `go.mod`／`package.json`，`pre-review.py` 的語言檢查一律 SKIP，這支才是本 repo 實際的 pre-review 驗證入口。
