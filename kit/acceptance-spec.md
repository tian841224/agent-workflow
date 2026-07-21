<!-- managed by claude-workflow v2 — 整檔覆蓋，勿直接編輯；客製請用專案層覆蓋 -->

# 驗收規約（acceptance-spec）

本檔定義重軌任務的驗收清單格式與證據規則。**格式為嚴格規約**：`verify-evidence.ps1`、`stop-check.ps1` 與 qa agent 都依此 parse，不得自創變體。

## 目錄結構

任務目錄建在全域 `.claude` 的專案對應目錄底下，不放專案 repo：

```
~/.claude/projects/<project-slug>/acceptance/<task-slug>/
├── checklist.md      # PM 凍結的驗收清單
├── plan.md           # architect 藍圖 + 階段進度（見 templates/plan.md）
└── evidence/
    ├── pre-review.txt
    ├── A1.txt        # 後端條目證據（指令輸出）
    └── A2.png        # 前端條目證據（截圖）
```

`<project-slug>` 為 Claude Code 對專案路徑的編碼（例：`C--Users-jacky-Documents-myproject`），與該專案 auto-memory 同層。

## checklist.md 格式

### 檔頭（必填）

```markdown
# <任務標題>
- project: <專案根目錄絕對路徑>
- frozen: <YYYY-MM-DD>（凍結日期；未凍結前寫 draft）
```

可選標記：檔頭加 `<!-- paused -->` 表示任務暫停，stop-check hook 會跳過此任務。

### 條目格式 — 後端型（預設）

```markdown
### A1 斷線重連後餘額不重複入帳
- cmd: `go test ./domain/wagers/... -run TestReconnectIdempotent -v`
- expect: `ok\s+`
- evidence: evidence/A1.txt
- status: [ ]
```

規則：
- 條目編號 `### A<n> <行為描述>`，n 從 1 遞增，不得跳號
- `cmd`：單行、以 `project:` 路徑為工作目錄可直接執行（go test / curl / docker exec ... mysql / docker exec ... redis-cli 等）
- `expect`：regex，對 evidence 檔內容比對（PowerShell `Select-String` 語法）
- `evidence`：相對於任務目錄的證據檔路徑
- `status`：`[ ]` 未驗、`[x]` 已驗通過；由主對話依 qa 的 PASS/FAIL 總表回填
- 需前置環境（如 server 需先啟動）的條目加一行 `- setup: <說明>`；verify-evidence 的 `-Rerun` 對含 setup 的條目只做靜態檢查並標註「需人工重跑」

### 條目格式 — 前端型（僅修改前端功能時使用）

```markdown
### A2 登入頁錯誤提示正確顯示
- type: ui
- steps: 開啟 <URL> → 輸入錯誤密碼 → 送出
- expect: 畫面顯示「帳號或密碼錯誤」提示
- evidence: evidence/A2.png
- status: [ ]
```

規則：
- `type: ui` 為前端型識別標記；`steps` 為 browser 操作描述、`expect` 為畫面預期（人工核對）
- 證據=截圖檔，由 qa 以 browser 工具執行擷取，PM 人工核對
- verify-evidence 對 ui 型只做檔案存在性與非空檢查，不做內容比對

## 證據檔規則

- 後端證據檔為指令輸出重導向，**首行**必須為：`# <ISO 8601 時間> $ <指令原文>`
- 證據檔不得為空
- **時效**：evidence 檔 mtime 必須晚於 `project:` 路徑最後一次 git commit 時間（防拿舊證據交差）；ui 型截圖同樣適用
- 證據不得含機密（token、密碼、連線字串明文）

## verify-evidence.ps1 行為

- 用法：`powershell -File verify-evidence.ps1 -Checklist <checklist.md 路徑> [-Rerun]`
- 預設（靜態模式）逐條檢查：evidence 檔存在、非空、首行含指令原文（後端型）、內容 match expect（後端型）、status 勾選與檢查結果一致、mtime 時效
- `-Rerun`：後端型逐條以 `project:` 為 cwd 重新執行 cmd、重寫 evidence、即時比對 expect；含 `setup:` 的條目與 ui 型僅靜態檢查
- 輸出 PASS/FAIL 總表；任一 FAIL 即 exit 1

## 凍結原則

- checklist 經使用者確認後凍結（`frozen:` 填日期），開發期間任何角色不得增刪修改條目
- 需求變更 → 回需求階段重出清單，舊檔改名加 `.superseded` 字尾保留
- 凍結後的修訂（經使用者核准）須在檔尾「修訂歷史」段落記錄一行：日期、改了什麼、核准依據
