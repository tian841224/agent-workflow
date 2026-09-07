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

每一份 machine contract 只有一個 owner。`schemas/task.schema.json` 是目前唯一的 task-state contract，evidence、transition、waiver 與 `workflow_facts` 的結構都在其中定義，runtime 不另外持有隱性 schema；退役的 v2 contract 保存在 `schemas/legacy/task-v2.schema.json`，僅供 migration 參考。`schemas/cli-output.schema.json` 擁有各指令 stdout 的形狀，`src/cli.ts` 的 option registry 擁有各指令接受的參數。`contract-lint` 以這四者（task schema、workflow policy、CLI 指令與 option registry、cli-output schema）為真相來源，檢查 templates、`.agents/`、`adapters/` 與 docs 引用的 command、option、欄位名、capability 與 step id 是否都仍存在。`policy-matrix` 則把 policy 的選取結果對 classification 組合展開成 digest，讓「少跑一個該跑的 gate」這種不會 crash 的 regression 變成可比對的差異。`src/lifecycle/` 擁有 lifecycle 與 task-state runtime；其中 `transitions.ts` 擁有 lifecycle transition，`task-gate.ts` 擁有 contract evaluation，`evidence.ts` 擁有 evidence freshness，其他 module 分別處理 task store、schema、intent、ownership 與 worktree lease；`.agents/` 擁有給 agent 讀取的 procedure；`src/hooks.ts` 定義 `CanonicalHookEvent` 與 `HookDecision`；`adapters/` 只保留平台 payload／輸出格式的轉接與 hook template。Adapter 不重新解釋 workflow 語意，也不複製 schema 規則。

Node.js 20 以上版本是唯一 runtime family（對應 `package.json` 的 `engines.node: ">=20"`）。`src/` 是 TypeScript source，`dist/agent-workflow.mjs` 是唯一可部署 ESM bundle；已安裝的 hooks 只執行記錄在 managed state 的 Node 絕對路徑與該 bundle，絕不依賴 Python、repo、`node_modules` 或 npx cache。

## 架構設計方向

在不降低輸出品質、正確性、必要安全邊界與可驗證性的前提下，選擇 token 與執行時間最少的完整路徑。流程、角色、skill 與驗證必須由任務的實際風險與影響決定；沒有改變決策或增加證據的步驟不執行。

採用漸進式設計與揭露。所有場景共用的短規則留在入口；只適用於特定場景的流程、reference 與 skill，使用明確 trigger 指向並在需要時讀取。不得為少數場景把不相關內容放進每次 session 的常駐 context。

## 責任邊界

`Reader` 只蒐集與呈現可查證的事實，不改變專案狀態。`Worker` 只在明確授權的隔離範圍實作，且只執行 coordinator 提供的 ExecutionPacket；task 分類、capability 選取與 task lifecycle 都由 coordinator 持有。`agent-workflow execution-packet` 是 implementation Worker 的唯一 execution contract，內容包含 task intent、classification、compiled capability／step、execution constraints、procedure pointers、required evidence 與 plan identity；task.md／task.json 仍是 coordinator 與 runtime 的 authority。`procedure` 是 agent 要遵循的步驟；`evidence` 是任務對已完成步驟留下的可驗證紀錄，兩者不可互換。Lifecycle transition 只能經由 `TaskLifecycle` 執行，其他層不得直接改寫其語意或狀態；`task-gate` 只讀取並回報 gate 結果，不寫入 task 狀態。`task.md` 保存 human-readable intent、completion criteria 與 workflow 所需的人類可讀 evidence section；`task.json` 是 classification、lifecycle、transition、waiver、machine evidence 與 gate evaluation 的 machine authority，並保存版本化 lifecycle、transition、waiver 與 evidence，並以 `state_revision`／`plan_revision` 追蹤狀態與計畫版本、以 `intent_approval` 取代舊版「frozen」lifecycle 狀態。`task.json` 只能經由 runtime CLI 寫入，且依欄位分工到不同 command，各自經同一檔案鎖並在落地前對照 `task.schema.json` 驗證：建立用 `task-init`；分類欄位用 `task-write`（allowlist，非分類欄位一律拒絕）；`task-write` 另外拒絕兩種降級（`managed_change` true→false、移除既有 `risk_flags`），唯一入口是 `reclassify`，它要求 `--confirmed-by-user` 與 `--reason` 並把該決定記進 `workflow_decision`；`impact_confidence` 不屬於受保護的降級，調低它只會讓 gate 要求更多而非更少，屬於 agent 自己的分析狀態，可直接用 `task-write` 更新，不需要使用者確認，也不必走 `reclassify`；`intent_approval` 用 `approve-intent`；evidence 用 `evidence-record`（step，`trust_level: attested`——agent 自述）／`evidence-run`（step，`trust_level: runtime`——runtime 實際執行該指令並記下 exit code、耗時與輸出 digest）／`review-record`（role）；policy 上宣告 `runtime_execution` 的 step 只接受 runtime evidence，`evidence_kind: execution` 且 exit code 非 0 一律不算通過；lifecycle 轉換用 `TaskLifecycle` 指令。hash／timestamp／diff 範圍一律由 runtime 現算，不接受呼叫端傳入。agent 對 `task.json` 的直接檔案寫入由 `src/hooks.ts` fail-closed 攔截。Waiver 必須包含明確使用者確認及 transition history，且同時綁定當下的 `plan_hash` 與 `plan_revision`（`plan_hash` 是分類的純函式，分類改走一圈再改回來會還原同一個 hash；沒有 `plan_revision` 的舊 waiver 一律視為過期）。`closed`／`superseded` 是終端狀態，所有 task state 寫入一律拒絕；`evidence-record`／`evidence-run`／`review-record`／`approve-intent`／`waive` 另外只接受 `in_progress`，`paused`／`blocked` 需先 `resume`。`workflow-policy.ts` 編譯出的 plan 區分 `required`（runtime 強制、無法透過省略 `workflow_request` 移除）、`suggested` 與 `requested` 三種 capability，其 `plan_hash` 只覆蓋 policy 與分類欄位；task.md 的 Goal／Scope／Completion criteria 另由 `intent_hash` 覆蓋，兩者各自獨立計算。`evidence-record`／`review-record`／waiver 落地時會同時記錄當下的 `plan_hash` 與 `intent_hash`；`task-gate` 檢查兩者是否都與現況相符，任一項改變都會使該筆 evidence／waiver 失效並要求重新驗證，避免計畫沒變但需求（Goal／Scope／Completion criteria）已改的情況下驗收仍被視為有效。

`OrchestrationEngine` 是 experimental phase-tracker 子系統，目前只管理 `planned -> split -> executing -> integrating -> integrated -> cleaned` 與 failure phase transition。它不是正式的 worker protocol，也尚未實作 worker dispatch、worker-level state、worktree creation、snapshot、patch collect／integrate／apply 或 multi-worker completion aggregation。它的 state 與 task state 走同一把檔案鎖。所有 mutating orchestration action 都需要 `AGENT_WORKFLOW_ORCHESTRATION_EXPERIMENTAL=1`；正常 workflow 預設 sequential execution，host-native isolated parallelism 則由主對話手動建立／綁定 worktree、提供 ExecutionPacket、收集 Worker 結果並統一整合與驗證。

## Classification 與 confirmation 的 trust boundary

兩件事本框架明確不保證，設計上以 attestation 而非 proof 處理：

- **初始分類由 AI 負責。** Runtime 無法分辨「這次真的沒有 authorization 風險」與「AI 漏判了 authorization 風險」，除非另建 static analysis 或分類驗證器。Runtime 的職責是保證**已宣告**的高風險不能被靜默繞過：`required` 不能靠少填 `workflow_request` 移除，移除 risk flag 或把 `managed_change` 改回 `false` 都必須走 `reclassify`。
- **使用者確認是 attestation。** `approve-intent --as-user` 與 `reclassify --confirmed-by-user` 都由 agent 提交，runtime 沒有 platform event bridge 可以密碼學地證明使用者真的按過確認。記錄的是「誰在什麼時間宣稱使用者確認了什麼」，不是使用者行為本身的證明。

## Hook trust boundary

Platform adapter 必須先正規化為 `CanonicalHookEvent`，runtime 僅回傳 `HookDecision`；未知或無法定位 target 的 mutation 絕不交由平台猜測，而是拒絕。

Shell command 的判斷分兩層：先做 shell 解析取得真正會執行的 segment（剝除由資料型指令接收的 heredoc body 與引號內容、只在引號外切分隔符、把 `$( )` 與 backtick 內容視為獨立 segment、展開 `-c` 型直譯器與 prefix／remote wrapper 的 payload），再對 segment 判斷 allowlist。判斷是否為「資料」的依據是接收指令而非文字外觀：`cat`／`echo`／`grep` 的引號內容是資料，`bash`／`python` 的引號內容是程式碼。這一層是 `isShellMutation`（用於一般 mutation 偵測，保護 `task.json`／`.agents`）的規則。

`git-guard` 對 git 指令另用更嚴格、不遞迴解析的規則：任何 wrapper／直譯器／remote／container carrier 或 command substitution 只要與提到 git 的 segment 同時出現，一律直接拒絕，不嘗試解析包裝內實際是哪個 git 指令——即使包裝內其實是唯讀安全的呼叫（例如 `ssh host git status`）也一樣。只有沒有任何間接層的裸 `git <subcommand>` 才會對照 allowlist（`status`／`diff`／`log`／`show`／`rev-parse`／`ls-files`／`rev-list`／受限的 `branch`／`remote`／`config`）。這是刻意的取捨：git 指令交給 runtime 自己判斷「包裝內其實安不安全」的成本，換成「看不懂就一律拒絕」的固定規則。

Managed hook 對未知 mutation、缺少 session id、無法正規化的路徑、損毀或逾期 state、讀取失敗與 hook exception 一律 fail closed。`.agents/**` 寫入必須有同一 session、同一 `.agents` root 的 `writing-for-agents/SKILL.md` 成功讀取事件；proof 同時綁定該檔案當前 SHA-256，skill 變動後舊 proof 立即失效。SessionEnd 會清除 proof，TTL 只作遺留 state 的額外清理。

這個機制只驗證可觀察到的讀取事件，不宣稱驗證模型理解內容；也不試圖防止擁有本機檔案系統權限者停用 hook 或直接改檔。無法提供成功讀取事件或 session id 的 adapter，維持 `.agents/**` 寫入 deny，不降級為提醒。

## 文件路由

文件只摘要並指向 authority，不複製 workflow 規則或 contract。修改 agents、skills、hooks 或 workflow contract 前，先讀本文件，再依目標路徑讀取其 owner 文件與 schema。

## Framework 變更政策

本 framework 已進入穩定期，任何對 agents、skills、hooks、runtime 或 workflow contract 的修改都要由證據驅動，不由推測驅動。修改的 task 或 PR 在理由中寫出下列四項，寫在既有 task.md 即可，不另建 schema 或審查角色：

```text
trigger:        regression | gate-cost | platform-contract | contract-test
evidence:       實際的 task、regression、benchmark、platform contract 或 failing test
minimal_change: 為什麼這是能解決該證據問題的最小修改
non_goals:      本次明確不順便處理的項目
```

四項都寫不出來時，代表還沒有值得改動 framework 的證據。

## 安裝與遷移

`install` 先建立不可覆寫的時間戳備份，再遷移舊 Python state。遷移可重跑；完成 Verify 前，不移除舊 managed command 或 runtime。舊 task frontmatter 轉為 `task.json`；`task.md` 就地去除 frontmatter、保留人的意圖內容而不刪除，原始完整檔案另收入備份，無法機械驗證的 evidence 標記為 `legacy-unverified`。managed state 記錄 package version、runtime hash、Node 路徑、platform targets 與 selected skills。Repair 從目前 repo checkout 取 source；只有已安裝 runtime 自我 repair 時才使用記錄 source。
