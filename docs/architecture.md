---
doc_type: architecture
covers:
  - AGENTS.md
  - .agents/
  - src/
  - dist/
  - adapters/
  - schemas/
---

# Agent workflow architecture

本文件是 agents、skills、hooks、runtime 與 workflow contract 的穩定架構原則唯一 owner。實作細節、欄位定義與操作步驟仍以其個別 schema、skill 或 runtime module 為 authority。

## Contract owner

每一份 machine contract 只有一個 owner。`schemas/task.schema.json` 是目前唯一的 task-state contract，evidence、transition、waiver 與 `workflow_facts` 的結構都在其中定義，runtime 不另外持有隱性 schema；退役的 v2 contract 保存在 `schemas/legacy/task-v2.schema.json`，僅供 migration 參考。`schemas/cli-output.schema.json` 擁有各指令 stdout 的形狀，`src/cli.ts` 的 option registry 擁有各指令接受的參數。`contract-lint` 以這四者（task schema、workflow policy、CLI 指令與 option registry、cli-output schema）為真相來源，檢查 templates、`.agents/`、`adapters/` 與 docs 引用的 command、option、欄位名、capability 與 step id 是否都仍存在。`policy-matrix` 則把 policy 的選取結果對 classification 組合展開成 digest，讓「少跑一個該跑的 gate」這種不會 crash 的 regression 變成可比對的差異。`src/lifecycle.ts` 擁有 lifecycle transition 與 contract evaluation；`.agents/` 擁有給 agent 讀取的 procedure；`src/hooks.ts` 定義 `CanonicalHookEvent` 與 `HookDecision`；`adapters/` 只保留平台 payload／輸出格式的轉接與 hook template。Adapter 不重新解釋 workflow 語意，也不複製 schema 規則。

Node 20 是唯一 runtime。`src/` 是 TypeScript source，`dist/agent-workflow.mjs` 是唯一可部署 ESM bundle；已安裝的 hooks 只執行記錄在 managed state 的 Node 絕對路徑與該 bundle，絕不依賴 Python、repo、`node_modules` 或 npx cache。

## 架構設計方向

在不降低輸出品質、正確性、必要安全邊界與可驗證性的前提下，選擇 token 與執行時間最少的完整路徑。流程、角色、skill 與驗證必須由任務的實際風險與影響決定；沒有改變決策或增加證據的步驟不執行。

採用漸進式設計與揭露。所有場景共用的短規則留在入口；只適用於特定場景的流程、reference 與 skill，使用明確 trigger 指向並在需要時讀取。不得為少數場景把不相關內容放進每次 session 的常駐 context。

## 責任邊界

`Reader` 只蒐集與呈現可查證的事實，不改變專案狀態。`Worker` 只在明確授權的隔離範圍實作。`procedure` 是 agent 要遵循的步驟；`evidence` 是任務對已完成步驟留下的可驗證紀錄，兩者不可互換。Lifecycle transition 只能經由 `TaskLifecycle` 執行，其他層不得直接改寫其語意或狀態；`task-gate` 只讀取並回報 gate 結果，不寫入 task 狀態。`task.md` 只保存人的意圖與驗收條件；`task.json` 保存版本化 lifecycle、transition、waiver 與 evidence，並以 `state_revision`／`plan_revision` 追蹤狀態與計畫版本、以 `intent_approval` 取代舊版「frozen」lifecycle 狀態。`task.json` 只能經由 runtime CLI 寫入，且依欄位分工到不同 command，各自經同一檔案鎖並在落地前對照 `task.schema.json` 驗證：建立用 `task-init`；分類欄位用 `task-write`（allowlist，非分類欄位一律拒絕）；`intent_approval` 用 `approve-intent`；evidence 用 `evidence-record`（step）／`review-record`（role）；lifecycle 轉換用 `TaskLifecycle` 指令。hash／timestamp／diff 範圍一律由 runtime 現算，不接受呼叫端傳入。agent 對 `task.json` 的直接檔案寫入由 `src/hooks.ts` fail-closed 攔截。Waiver 必須包含明確使用者確認及 transition history，且綁定當下 `plan_hash`。`workflow-policy.ts` 編譯出的 plan 區分 `required`（runtime 強制、無法透過省略 `workflow_request` 移除）、`suggested` 與 `requested` 三種 capability，其 `plan_hash` 只覆蓋 policy 與分類欄位；task.md 的 Goal／Scope／Completion criteria 另由 `intent_hash` 覆蓋，兩者互不影響。

`OrchestrationEngine` 是 experimental 子系統，目前只以 transition table 管理 split、execute、integrate、cleanup 的階段狀態，尚未實作 worktree snapshot 與 patch collect／apply；未完成 integrate 前不可 cleanup、失敗 path 不可跳過 cleanup、已套用 patch 不可重複套用。它的 state 與 task state 走同一把檔案鎖，因為 coordinator 與各 worker process 會同時寫入。由 runtime 建立 worktree 的 `Init` 需要 `AGENT_WORKFLOW_ORCHESTRATION_EXPERIMENTAL=1`；主流程預設走 sequential 或 host-native dispatch。

## Hook trust boundary

Platform adapter 必須先正規化為 `CanonicalHookEvent`，runtime 僅回傳 `HookDecision`；未知或無法定位 target 的 mutation 絕不交由平台猜測，而是拒絕。

Shell command 的判斷分兩層：先做 shell 解析取得真正會執行的 segment（剝除由資料型指令接收的 heredoc body 與引號內容、只在引號外切分隔符、把 `$( )` 與 backtick 內容視為獨立 segment、展開 `-c` 型直譯器與 prefix／remote wrapper 的 payload），再對 segment 判斷 allowlist。判斷是否為「資料」的依據是接收指令而非文字外觀：`cat`／`echo`／`grep` 的引號內容是資料，`bash`／`python` 的引號內容是程式碼。這一層是 `isShellMutation`（用於一般 mutation 偵測，保護 `task.json`／`.agents`）的規則。

`git-guard` 對 git 指令另用更嚴格、不遞迴解析的規則：任何 wrapper／直譯器／remote／container carrier 或 command substitution 只要與提到 git 的 segment 同時出現，一律直接拒絕，不嘗試解析包裝內實際是哪個 git 指令——即使包裝內其實是唯讀安全的呼叫（例如 `ssh host git status`）也一樣。只有沒有任何間接層的裸 `git <subcommand>` 才會對照 allowlist（`status`／`diff`／`log`／`show`／`rev-parse`／`ls-files`／`rev-list`／受限的 `branch`／`remote`／`config`）。這是刻意的取捨：git 指令交給 runtime 自己判斷「包裝內其實安不安全」的成本，換成「看不懂就一律拒絕」的固定規則。

Managed hook 對未知 mutation、缺少 session id、無法正規化的路徑、損毀或逾期 state、讀取失敗與 hook exception 一律 fail closed。`.agents/**` 寫入必須有同一 session、同一 `.agents` root 的 `writing-for-agents/SKILL.md` 成功讀取事件；proof 同時綁定該檔案當前 SHA-256，skill 變動後舊 proof 立即失效。SessionEnd 會清除 proof，TTL 只作遺留 state 的額外清理。

這個機制只驗證可觀察到的讀取事件，不宣稱驗證模型理解內容；也不試圖防止擁有本機檔案系統權限者停用 hook 或直接改檔。無法提供成功讀取事件或 session id 的 adapter，維持 `.agents/**` 寫入 deny，不降級為提醒。

## 文件路由

文件只摘要並指向 authority，不複製 workflow 規則或 contract。修改 agents、skills、hooks 或 workflow contract 前，先讀本文件，再依目標路徑讀取其 owner 文件與 schema。

## 安裝與遷移

`install` 先建立不可覆寫的時間戳備份，再遷移舊 Python state。遷移可重跑；完成 Verify 前，不移除舊 managed command 或 runtime。舊 task frontmatter 轉為 `task.json`；`task.md` 就地去除 frontmatter、保留人的意圖內容而不刪除，原始完整檔案另收入備份，無法機械驗證的 evidence 標記為 `legacy-unverified`。managed state 記錄 package version、runtime hash、Node 路徑、platform targets 與 selected skills。Repair 從目前 repo checkout 取 source；只有已安裝 runtime 自我 repair 時才使用記錄 source。
