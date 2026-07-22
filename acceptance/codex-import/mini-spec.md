# Mini-spec: 匯入 Claude workflow 至 Codex

status: draft

## 目標

讓現有 claude-workflow repo 能以同一支 PowerShell 安裝器，把可攜版流程規則與支援資產安裝到 Codex 使用者目錄，同時保留原本 Claude Code 安裝能力。

## 非目標

- 不將 Claude Code hooks 或 `settings.json` 直接註冊到 Codex。
- 不修改既有流程內容、角色定義或專案 `AGENTS.md` 語意。
- 不執行 commit、push 或其他 git 寫入操作。

## TDD seam

- 以 `-DryRun` 驗證目的地、檔案集合與不寫入行為。
- 以測試用暫存 Target 驗證 Codex 安裝後的檔案與冪等重跑。

## 驗收條目

### A1 — Codex 安裝內容

Given 一個空的 Codex target，When 執行安裝器的 Codex 模式，Then `AGENTS.md`、`agents/`、`skills/`、`rules/`、`claude-workflow/` 皆存在且內容來自 repo。

cmd: `./install.ps1 -CodexTarget <temp> -ClaudeTarget <temp-claude>`
expect: 指定檔案全部存在；Claude 與 Codex 目錄互不污染。

### A2 — Claude 相容性

Given 一個空的 Claude target，When 執行既有安裝流程，Then 原本的 Claude kit、agents、skills、rules、hooks、CLAUDE.md 與 settings 合併行為仍可用。

cmd: `./install.ps1 -ClaudeTarget <temp-claude> -CodexTarget <temp-codex>`
expect: Claude 目錄產出與目前安裝契約一致，hooks 只出現在 Claude target。

### A3 — DryRun 邊界

Given 兩個不存在或空的 target，When 使用 `-DryRun`，Then 只輸出預覽並不建立或修改任何檔案。

cmd: `./install.ps1 -DryRun -ClaudeTarget <temp-claude> -CodexTarget <temp-codex>`
expect: 輸出包含 Codex 預覽；兩個 target 不被建立。

### A4 — 冪等重跑

Given 已完成一次 Codex 安裝，When 使用相同 target 再執行一次，Then 不產生重複內容或錯誤，並更新 managed 檔案。

cmd: 連續執行兩次 `./install.ps1 -ClaudeTarget <temp-claude> -CodexTarget <temp-codex>`
expect: 兩次皆成功；檔案數量與 `AGENTS.md` 內容穩定。

frozen: 2026-07-22
