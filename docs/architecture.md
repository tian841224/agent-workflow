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

每一份 machine contract 只有一個 owner。`schemas/task.schema.json` 是目前唯一的 task-state contract，evidence、transition、waiver 與 `workflow_facts` 的結構都在其中定義，runtime 不另外持有隱性 schema；退役的 v2 contract 保存在 `schemas/legacy/task-v2.schema.json`，僅供 migration 參考。`schemas/cli-output.schema.json` 擁有各指令 stdout 的形狀，`src/cli.ts` 的 option registry 擁有各指令接受的參數。`contract-lint` 以這四者（task schema、workflow policy、CLI 指令與 option registry、cli-output schema）為真相來源，檢查 templates、`.agents/`、`adapters/` 與 docs 引用的 command、option、欄位名、capability 與 step id 是否都仍存在。`policy-matrix` 則把 policy 的選取結果對 classification 組合展開成 digest，讓「少跑一個該跑的 gate」這種不會 crash 的 regression 變成可比對的差異。`src/lifecycle/` 擁有 lifecycle 與 task-state runtime；其中 `transitions.ts` 擁有 lifecycle transition，`task-gate.ts` 擁有 contract evaluation，`evidence.ts` 擁有 evidence freshness，其他 module 分別處理 task store、schema、intent、ownership 與 worktree lease；`src/misc.ts` 的 `preflight` 只做一次環境前置檢查，不寫入 task state。`.agents/` 擁有給 agent 讀取的 procedure；`src/hooks.ts` 定義 `CanonicalHookEvent` 與 `HookDecision`；`adapters/` 只保留平台 payload／輸出格式的轉接與 hook template。Adapter 不重新解釋 workflow 語意，也不複製 schema 規則。

Node.js 20 以上版本是唯一 runtime family（對應 `package.json` 的 `engines.node: ">=20"`）。`src/` 是 TypeScript source，`dist/` 有兩個可部署 ESM bundle：`agent-workflow.mjs` 是完整 CLI，`agent-workflow-hook.mjs` 只含 guard 判斷所需的 `hooks.ts` 與 `core.ts`。完整 CLI 在確認 command 與 options 後才動態載入該 subsystem；esbuild 仍輸出單一 CLI bundle，延後的是 module initialization，不需要部署額外 chunks。Guard hook 執行後者，`memory-context` 等其餘指令執行前者——guard 跑在每一次 tool call 上，讓它載入整個 CLI 會使每次呼叫都付出 installer、lifecycle、knowledge 與 policy 的解析成本。已安裝的 hooks 只執行記錄在 managed state 的 Node 絕對路徑與這兩個 bundle，不依賴 repo、`node_modules` 或 npx cache。

安裝另外把 `agent-workflow.mjs` 原封不動複製到 npm global prefix 成為無副檔名的 `agent-workflow`（Windows 另加 `.cmd` 包裝），讓 CLI 在任何專案都可執行。這份副本必須與 runtime bundle 位元組相同：guard 以 PATH 副檔名順序解析裸 `agent-workflow` 並對解析到的檔案計算 SHA-256，比對 managed state 記錄的 runtime 雜湊，npm 自行產生的 shim 會使該比對失敗。

## 架構設計方向

在不降低輸出品質、正確性、必要安全邊界與可驗證性的前提下，選擇 token 與執行時間最少的完整路徑。流程、角色、skill 與驗證必須由任務的實際風險與影響決定；沒有改變決策或增加證據的步驟不執行。

採用漸進式設計與揭露。所有場景共用的短規則留在入口；只適用於特定場景的流程、reference 與 skill，使用明確 trigger 指向並在需要時讀取。不得為少數場景把不相關內容放進每次 session 的常駐 context。

## 責任邊界

### 角色與 ExecutionPacket

`Reader` 只蒐集與呈現可查證的事實，不改變專案狀態。`Worker` 只在明確授權的隔離範圍實作，且只執行 coordinator 提供的 ExecutionPacket；task 分類、capability 選取與 task lifecycle 都由 coordinator 持有。`agent-workflow execution-packet` 是 implementation Worker 的唯一 execution contract，內容包含 task intent、classification、compiled capability／step、execution constraints、procedure pointers、required evidence 與 plan identity；task.md／task.json 仍是 coordinator 與 runtime 的 authority。Packet 直接帶 selected step titles；一般 evidence capability 指向精簡的 `workflow/evidence.md`，只有需要完整操作規則時才指向專屬 skill，避免 Worker 為了還原已完成的決策重新讀取整份 policy。task-init、task-write 與 ExecutionPacket 共用同一個 procedure resolver；expanded／role 文件依 compiled exploration profile 與角色加入，project-doc 則只在 module/shared behavior、contract、data/schema、expanded exploration 或相關高影響邊界成立時加入。`procedure` 是 agent 要遵循的步驟；`evidence` 是任務對已完成步驟留下的可驗證紀錄，兩者不可互換。

### task.md 與 task.json 的分工

`task.md` 只保存 human-readable intent：Goal、Scope、Completion criteria，以及 freeze-required 任務的 Non-goals and compatibility／Acceptance cases。`task.json` 是 classification、lifecycle、transition、waiver、project_docs、machine evidence 與 gate evaluation 的 machine authority，並保存版本化 lifecycle、transition、waiver 與 evidence，並以 `state_revision`／`plan_revision` 追蹤狀態與計畫版本、以 `intent_approval` 記錄高風險任務已取得的使用者確認。`agent-workflow task-report` 從兩者產生一次性的 Markdown 檢視，不形成第三個 authority。

### task.json 的寫入路徑

`task.json` 只能經由 runtime CLI 寫入，且依欄位分工到不同 command，各自經同一檔案鎖並在落地前對照 `task.schema.json` 驗證：建立與初始分類用 `task-init`，後續分類用 `task-write`（allowlist，非允許欄位一律拒絕）；文件完成紀錄只用 `task-write` 更新 `project_docs.updated`，且會保留既有 read／digest 證據；讀完 project doc 後用 `project-doc --action Remember --task-path` 寫入 `project_docs.read` 與 `project_docs.digests`，這兩個欄位不能由 task-write 自行填入，Lookup 只有 digest 和 read 路徑都相符才回報 `reusable`；`task-write` 另外拒絕兩種降級（`managed_change` true→false、移除既有 `risk_flags`），唯一入口是 `reclassify`，它要求 `--confirmed-by-user` 與 `--reason` 並把該決定記進 `workflow_decision`；`impact_confidence` 不屬於受保護的降級，調低它只會讓 gate 要求更多而非更少，屬於 agent 自己的分析狀態，可直接用 `task-write` 更新，不需要使用者確認，也不必走 `reclassify`；`intent_approval` 用 `approve-intent`；evidence 用 `evidence-record`（step，`trust_level: attested`——agent 自述）／`evidence-run`（step，`trust_level: runtime`——runtime 實際執行該指令並記下 exit code、耗時、輸出 digest 與 delivery fingerprint），兩者都接受重複或逗號分隔的 `--requirement-id`，一次執行可在同一鎖內建立多筆同批 evidence；`review-record`（role）可接受 transient `--expected-workspace-sha256` 來綁定 reviewer 開始時的工作樹，但 persisted reviewed scope／digest 仍由 runtime 現算；policy 上宣告 `runtime_execution` 的 step 只接受 runtime evidence，`evidence_kind: execution` 且 exit code 非 0 一律不算通過；lifecycle 轉換用 `TaskLifecycle` 指令。persisted hash／timestamp／diff 範圍一律由 runtime 現算，不接受呼叫端傳入。agent 對直接命名 `task.json` 的檔案寫入由 `src/hooks.ts` fail-closed 攔截。

### Lifecycle 與終端狀態

Lifecycle transition 只能經由 `TaskLifecycle` 執行，其他層不得直接改寫其語意或狀態；`task-gate` 只讀取並回報 gate 結果，不寫入 task 狀態。`closed`／`superseded` 是終端狀態，所有 task state 寫入一律拒絕；`evidence-record`／`evidence-run`／`review-record`／`approve-intent`／`waive` 另外只接受 `in_progress`，`paused`／`blocked` 需先 `resume`。

### Plan、intent 與 waiver 的雜湊綁定

`workflow-policy.ts` 編譯出的 plan 區分 `required`（runtime 強制、無法透過省略 `workflow_request` 移除）、`suggested` 與 `requested` 三種 capability，並從同一份分類推導 `exploration_profile: focused | expanded`；高信心、局部行為且無高風險邊界維持 focused，低信心、較大影響面、契約／資料／schema／不可逆或其他高風險情境才使用 expanded，agent 不再另判 Standard／Elevated。其 `plan_hash` 只覆蓋 policy 與分類欄位；task.md 的 Goal／Scope／Completion criteria 另由 `intent_hash` 覆蓋，兩者各自獨立計算。每個 `managed_change: true` plan 都包含最低 `delivery_validation.DV1` runtime receipt；高風險 capability 仍各自要求自己的 evidence。Waiver 必須包含明確使用者確認及 transition history，且同時綁定當下的 `plan_hash` 與 `plan_revision`（`plan_hash` 是分類的純函式，分類改走一圈再改回來會還原同一個 hash；沒有 `plan_revision` 的舊 waiver 一律視為過期）。`evidence-record`／`review-record`／waiver 落地時會同時記錄當下的 `plan_hash` 與 `intent_hash`；runtime execution evidence 目前綁定完整 delivery fingerprint，任何交付內容變更都會使 receipt 失效並要求重新驗證，尚未提供 path-scoped execution reuse，避免未經驗證的相依性宣告讓正確性下降。

`validation_profile` 是相容性保留的選填 task metadata，不改變 compiled plan；不需要為了執行測試額外寫入它。實際驗證仍由 `scripts/run-tests.mjs` 的 command 與 `evidence-run` receipt 決定：`focused` 與 `affected` 由呼叫端明列測試路徑，`regression` 可指定 subsystem 或執行完整 regression set，`full` 固定執行整個 `tests-node`。runner 會拒絕 profile 與路徑組合不合法的呼叫，避免 focused task 意外退化成 full 或 full task 靜默漏測；command 的範圍仍須符合 completion criteria 與必要 evidence。

`workflow_mode` 只保留給舊 task 的相容性資料；新流程不主動填入它，capability selection 也不再依它分支，但舊值仍留在 schema 與 plan identity 中直到下一次 breaking schema migration。

`OrchestrationEngine` 是 experimental phase-tracker 子系統，目前只管理 `planned -> split -> executing -> integrating -> integrated -> cleaned` 與 failure phase transition。它不是正式的 worker protocol，也尚未實作 worker dispatch、worker-level state、worktree creation、snapshot、patch collect／integrate／apply 或 multi-worker completion aggregation。它的 state 與 task state 走同一把檔案鎖。所有 mutating orchestration action 都需要 `AGENT_WORKFLOW_ORCHESTRATION_EXPERIMENTAL=1`；正常 workflow 預設 sequential execution，host-native isolated parallelism 則由主對話手動建立／綁定 worktree、提供 ExecutionPacket、收集 Worker 結果並統一整合與驗證。

## Classification 與 confirmation 的 trust boundary

兩件事本框架明確不保證，設計上以 attestation 而非 proof 處理：

- **初始分類由 AI 負責。** Runtime 無法分辨「這次真的沒有 authorization 風險」與「AI 漏判了 authorization 風險」，除非另建 static analysis 或分類驗證器。Runtime 的職責是保證**已宣告**的高風險不能被靜默繞過：`required` 不能靠少填 `workflow_request` 移除，移除 risk flag 或把 `managed_change` 改回 `false` 都必須走 `reclassify`。
- **使用者確認是 attestation。** `approve-intent --as-user` 與 `reclassify --confirmed-by-user` 都由 agent 提交，runtime 沒有 platform event bridge 可以密碼學地證明使用者真的按過確認。記錄的是「誰在什麼時間宣稱使用者確認了什麼」，不是使用者行為本身的證明。

## Hook trust boundary

Platform adapter 只正規化工具名稱、command 與直接路徑，轉成 `CanonicalHookEvent`；`git-guard` 是唯一 PreToolUse 入口，先做 task safety，再做 Git safety。不含 `task.json` 或 Git 的呼叫直接放行，不做全指令 mutation 分類、檔案讀取或雜湊。

Task safety 只保護直接命名 `task.json` 的工具或 shell segment。明確 read tool 與唯讀 shell command 可讀取；寫入需由 managed state 雜湊核對過的 runtime CLI，且 subcommand 必須是 sanctioned task writer。其他直接操作一律拒絕。只檢查命中 task.json 的片段，無關的 `cd`、build 等片段不影響 task read；`2>&1`／`1>&2`／`>&2` 是 descriptor rebinding，不是 command separator。`evidence-run` 可執行任意 caller command，因此不能取得 task writer 的全面豁免。

Git safety 只在 command 提到 Git 時解析。破壞性操作（hard reset、clean、branch delete、path checkout、restore、force push）及 hidden execution（wrapper、直譯器、remote/container、substitution、改變 Git 執行方式的 option）拒絕；其餘直接 Git 呼叫交由平台 native permission，包括 `cd repo && git checkout -b branch`。平台是否提示 approval 由平台 permission 設定決定，guard 放行本身不代表已獲使用者核准。diff machinery 的 output／external execution 與跨 project git-dir／work-tree 邊界仍保留。

`.agents/` 文件品質由 AGENTS pointer、`writing-for-agents`、review 與 contract lint 維持，不再保存或驗證 session read proof，也沒有 PostToolUse／SessionEnd guard。Claude／Codex 只在 SessionStart 載入 memory；Antigravity 保留 PreInvocation，後續 invocation 在 CLI dispatcher 載入 knowledge 模組前即回傳空結果。

這是對直接資源與高風險 pattern 的窄範圍檢查，不是完整 shell sandbox；變數間接算出的路徑、任意 script、alias 或同機程序的行為仍由平台權限管理。它不試圖防止擁有本機檔案權限者停用 hook。task runtime 的 schema、鎖、evidence freshness 與 reviewer gate 維持原有 authority。

## 文件路由

文件只摘要並指向 authority，不複製 workflow 規則或 contract。`project-doc Lookup` 將 path 命中的文件放在 `docs`，將 architecture／structure／dataflow／glossary 放在附有 `content_sha256` 的 `overview_candidates`；傳入 `--task-path` 時會以 `project_docs.read` + `project_docs.digests` 判斷 `reusable`／`stale`，未讀的 overview candidate 不會自動成為 read evidence。修改 agents、skills、hooks 或 workflow contract 前，先讀本文件，再依目標路徑讀取其 owner 文件與 schema。

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

`install` 先建立不可覆寫的時間戳備份，再遷移既有 state。遷移可重跑；完成 Verify 前，既有的 managed command 與 runtime 保持原狀。既有 task frontmatter 轉為 `task.json`；`task.md` 就地去除 frontmatter、保留人的意圖內容而不刪除，原始完整檔案另收入備份，無法機械驗證的 evidence 標記為 `legacy-unverified`。managed state 記錄 package version、runtime hash、Node 路徑、platform targets 與 selected skills。Repair 從目前 repo checkout 取 source；只有已安裝 runtime 自我 repair 時才使用記錄 source。

## Memory 的有界選取

自動 `memory-context --auto` 沒有能代表目前任務的有效 query 時，在列舉或讀取 knowledge entries 前直接回空；同 project 或最近更新不構成 relevance。只有有明確 query 的情況才做 verified memory 的 relevance 篩選與 source freshness 檢查，再套用 6 筆／800 字元上限。任務需要歷史脈絡但 hook 沒有可靠 query 時，由 agent 以 `knowledge --action Search --query '<keywords>'` 明確搜尋。沒有新增 persistent index；Project Docs whole-tree digest 與 legacy cleanup 保留為量測後再評估的項目。
