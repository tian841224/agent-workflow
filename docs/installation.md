# 安裝與維護

[回到首頁](../README.md)

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

三個平台的派工規則與流程相同，都在 [AGENTS.md](../AGENTS.md) 的「Subagent」段落；各平台的派工規則是同一張表，列出只讀不寫的派工、平行實作與複審各用哪個 agent 與模型。Claude Code 的派工規則只安裝在 Claude 目錄：只讀不寫的派工一律用 Haiku（內建的 Explore）、平行實作交給 Sonnet 的 worker、複審交給 Opus。Codex 讀取用 Luna 的 reader，實作與複審用 Sol 的 worker；Antigravity 的 reader 與 worker 都繼承主對話的 Flash High。規則來源是 `adapters/claude/delegation.md`，原生角色設定是 `adapters/claude/managed-config.json`，Codex 與 Antigravity 的安裝內容不包含它。Antigravity 的派工規則來源是 `adapters/antigravity/delegation.md`，同樣只安裝在 Antigravity 目錄。

技能實體統一放在 `~/.agents/skills`，平台 skills 目錄內逐技能建立 Junction／symlink；同一技能的修改會由所有適用平台共用。`implementation-spec` 由 Claude Code、Codex 與 Antigravity 共用。Repair 會備份普通副本後改為連結；非 catalog 技能內容衝突時保留原狀並回報。Uninstall 僅移除 managed 連結，保留共用技能實體與備份，並移除三個平台設定檔中由 agent-workflow 寫入的 hook；`.system` 與 plugin cache 仍由原生平台管理。遷移、回復與驗證契約見 [managed skill installation](modules/managed-skill-installation.md)。

Codex 的角色設定與委派程序由 [Codex adapter](../adapters/codex/managed-config.json) 及其[coordinator 指示](../adapters/codex/coordinator.md) 擁有，只安裝至 Codex 目錄。共用 runtime 排除所有平台 adapter 子目錄；原生 consumer 的載入與實際分派需另行驗證。

重跑 `npm run setup` 即可更新，`agent-workflow verify` 檢查安裝是否完整。升級前，先把進行中的 managed task 結案或 supersede：plan 的計算方式改變時，進行中 task 的驗證紀錄會失效。

選用的原生整合由各自的上游 repo 安裝，不收進本 repo 的 skills。
- 可用的選項：`--ponytail`、`--design-and-refine`、`--hallmark`，或用 `--integration <名稱>` 安裝 `adapters/upstream-manifest.json` 內的任一條目。
- 上游位置與各平台的安裝指令只記在該 manifest。
- 需要本機目錄的指令會臨時 clone 到系統暫存目錄，跑完（含失敗時）就刪除，不在本機保留。
- 重跑同一指令即更新，加 `--dry-run` 只列出步驟。
- 新增框架的方法見 [upstream integrations](modules/upstream-integrations.md)。

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

