---
doc_type: module
covers:
  - adapters/upstream-manifest.json
  - src/installer.ts
  - src/cli.ts
---

# Upstream integrations

## Responsibility

其他框架（ponytail、hallmark、design-and-refine 等）的原始碼不放進本 repo，也不複製進 `.agents/skills`。本 repo 只在 `adapters/upstream-manifest.json` 記錄上游位置，以及「依上游自己的安裝方式」逐平台要執行的指令。安裝器負責取得上游內容、執行那些指令、清理暫存，不解讀上游內容。

新增任何框架都走這個方法；只需要新增 manifest 條目，不需要改程式碼。

## Entrypoints

- `install --integration <name>[,<name>]`：安裝 manifest 內的指定條目，名稱可用逗號分隔。
- `--ponytail`、`--design-and-refine`、`--hallmark`：對應名稱的簡寫，與 `--integration` 等價。
- `--dry-run`：只列出將執行的步驟，不 clone、不執行、不寫入。
- 名稱不在 manifest 內時，在寫入任何檔案之前就失敗並列出已知名稱。

## Flow

```text
讀 manifest 條目
  |
  +-- 選取平台的步驟含 $checkout ？
  |     是：git clone --depth 1 --branch <ref> 到系統暫存目錄
  |
  v
逐平台、逐步驟執行上游指令（有 clone 時以 clone 為工作目錄）
  |  任一步失敗：該條目停止，install 以失敗結束
  v
刪除暫存 clone（成功或失敗都刪）
```

### 選哪一種模式

依上游 README 的安裝方式決定，不依偏好決定：

| 上游的安裝方式 | 步驟寫法 | 為什麼 |
| --- | --- | --- |
| 指令吃本機目錄，安裝時把內容複製出去（例如 `npx skills add <目錄>`） | 用 `$checkout` | 安裝器臨時 clone，指令跑完就刪，本機不留上游 repo |
| 以 repo 網址註冊，由工具自己保存副本（plugin marketplace、`agy plugin install <url>`） | 用 `$source`（必要時 `$ref`），不 clone | 對暫存 clone 註冊，clone 刪掉後註冊會指向不存在的路徑，也無法更新；要交給工具自己 clone |

同一個條目可以依平台混用。例如 design-and-refine 的 Claude 走 marketplace（`$source`），Codex 與 Antigravity 走 `npx skills add`（`$checkout`）。

## Manifest 條目

```json
"<name>": {
  "source": "https://github.com/<owner>/<repo>",
  "ref": "main",
  "executables": {"Claude": "npx", "Codex": "npx", "Antigravity": "npx"},
  "platforms": {
    "Claude": [["-y", "skills", "add", "$checkout", "--global", "--yes", "--agent", "claude-code"]],
    "Codex": [["..."]],
    "Antigravity": [["..."]]
  }
}
```

- `source`、`ref`：必填。`ref` 是分支或 tag。
- `platforms`：每個平台一個「步驟陣列」，每個步驟是一組不經 shell 的引數。省略的平台不安裝。
- `executables`：各平台的執行檔。預設 Claude 用 claude、Codex 用 codex、Antigravity 用 agy；上游用 npx 時要覆寫。
- 可用的置換：`$source`、`$ref`、`$checkout`（暫存 clone 的絕對路徑）。

## 新增一個框架

1. 讀上游 README 的安裝章節，逐平台列出官方指令。
2. 依上表決定每個平台用 `$checkout` 或 `$source`。
3. 在 manifest 新增條目。使用 `$checkout` 時，指令必須是全域安裝（例如 `--global`）並免互動（例如 `--yes`）：工作目錄在暫存 clone 內，專案層級的安裝會隨 clone 一起被刪。
4. 執行 `npm run setup -- --integration <name> --dry-run`，確認步驟與路徑。
5. 在 `tests-node/installer.test.mjs` 補一個 dry-run 測試，斷言關鍵指令；在 README 的選用整合一句補上名稱。
6. 需要固定版本時，把 `ref` 改成 tag。

不做的事：不把上游檔案複製進 `.agents/skills`，不加進 `managed-manifest.json`，不寫入 `skills-lock.json`。

## Shared state

不寫入任何本 repo 的狀態檔。暫存 clone 位於系統暫存目錄，以 mkdtemp 建立，結束時整個刪除；狀態目錄（`~/.agent-workflow`）不保留上游內容。上游安裝後的檔案由上游工具管理。

## Invariants and gotchas

- 暫存 clone 一定會刪除，包含 clone 之後的步驟失敗時。
- 安裝的是 `ref` 當下的內容；預設 `main` 會跟著上游變動。需要可重現時改用 tag。
- 重新執行同一個 `--integration` 即更新。
- 解除安裝不會移除整合；用上游自己的移除指令（例如 `npx skills remove <name> --global`）。
- 在 Windows 上，`npx` 是 `npx.cmd`，安裝器改用 shell 執行，路徑含空白時會加引號。
- 複製式安裝只帶走上游安裝指令複製的內容。skill 內指向資料夾外檔案的相對連結（例如 hallmark 的 docs）在安裝後沒有對應檔案。
- 這些指令會連網並以完整 agent 權限安裝第三方內容，只收錄信任的上游。

## Unverified

實際安裝只驗證過 hallmark 的 `npx skills add` 路徑。ponytail 與 design-and-refine 的 `claude`、`codex`、`agy` 指令在 dry-run 與測試中只驗證了規劃的指令，沒有在本機實際執行。
