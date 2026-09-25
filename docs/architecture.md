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

每一份 machine contract 只有一個 owner。`schemas/task.schema.json` 是目前唯一的 task-state contract，evidence、transition、waiver 與 `workflow_facts` 的結構都在其中定義，runtime 不另外持有隱性 schema；退役 schema 版本不另存副本，`src/installer.ts` 的 migration 邏輯直接內含各版本轉換規則，需要查退役版本原貌時查 git history。`schemas/cli-output.schema.json` 擁有各指令 stdout 的形狀，`src/cli.ts` 的 option registry 擁有各指令接受的參數。`contract-lint` 以這四者（task schema、workflow policy、CLI 指令與 option registry、cli-output schema）為真相來源，檢查 templates、`.agents/`、`adapters/` 與 docs 引用的 command、option、欄位名、capability 與 step id 是否都仍存在。`policy-matrix` 則把 policy 的選取結果對 classification 組合展開成 digest，讓「少跑一個該跑的 gate」這種不會 crash 的 regression 變成可比對的差異。`src/lifecycle/` 擁有 lifecycle 與 task-state runtime；其中 `transitions.ts` 擁有 lifecycle transition，`task-gate.ts` 擁有 contract evaluation，`evidence.ts` 擁有 evidence freshness，其他 module 分別處理 task store、schema、intent、ownership 與 worktree lease；`src/lifecycle/readiness.ts` 只做環境、intent 與驗收案例的前置檢查，結果隨 `task-init` 的 `readiness` 回傳，不寫入 task state；`src/lifecycle/next.ts` 把 gate 的缺口轉成各指令輸出的 `next`；`src/task-context.ts` 為 `task-init --paths` 組出相關的專案文件、記憶與已結案 task。`.agents/` 擁有給 agent 讀取的 procedure；`src/hooks.ts` 定義 `CanonicalHookEvent` 與 `HookDecision`；`adapters/` 只保留平台 payload／輸出格式的轉接與 hook template。Adapter 不重新解釋 workflow 語意，也不複製 schema 規則。

Node.js 20 以上版本是唯一 runtime family（對應 `package.json` 的 `engines.node: ">=20"`）。`src/` 是 TypeScript source，`dist/` 有兩個可部署 ESM bundle：`agent-workflow.mjs` 是完整 CLI，`agent-workflow-hook.mjs` 只含 hook 所需的 `hooks.ts`、`locale-hooks.ts` 與 `core.ts`。完整 CLI 在確認 command 與 options 後才動態載入該 subsystem；esbuild 仍輸出單一 CLI bundle，延後的是 module initialization，不需要部署額外 chunks。git-guard 與 locale hooks 執行後者，`memory-context` 等其餘指令執行前者——guard 跑在每一次 tool call 上，讓它載入整個 CLI 會使每次呼叫都付出 installer、lifecycle、knowledge 與 policy 的解析成本。已安裝的 hooks 只執行記錄在 managed state 的 Node 絕對路徑與這兩個 bundle，不依賴 repo、`node_modules` 或 npx cache。

安裝另外把 `agent-workflow.mjs` 原封不動複製到 npm global prefix 成為無副檔名的 `agent-workflow`（Windows 另加 `.cmd` 包裝），讓 CLI 在任何專案都可執行。這份副本必須與 runtime bundle 位元組相同：guard 以 PATH 副檔名順序解析裸 `agent-workflow` 並對解析到的檔案計算 SHA-256，比對 managed state 記錄的 runtime 雜湊，npm 自行產生的 shim 會使該比對失敗。

## 架構設計方向

在不降低輸出品質、正確性、必要安全邊界與可驗證性的前提下，選擇 token 與執行時間最少的完整路徑。流程、角色、skill 與驗證必須由任務的實際風險與影響決定；沒有改變決策或增加證據的步驟不執行。

Task-level Reviewer 的啟動時機由 [workflow review procedure](../.agents/skills/workflow/review.md) 統一管理；其他 workflow 文件只描述切片回饋與指向該規則。

採用漸進式設計與揭露。所有場景共用的短規則留在入口；只適用於特定場景的流程、reference 與 skill，使用明確 trigger 指向並在需要時讀取。不得為少數場景把不相關內容放進每次 session 的常駐 context。

## 責任邊界

### 角色與 ExecutionPacket

`Reader` 只蒐集與呈現可查證的事實，不改變專案狀態。`Worker` 只在明確授權的隔離範圍實作，且只執行 coordinator 提供的 ExecutionPacket；task 分類、capability 選取與 task lifecycle 都由 coordinator 持有。`agent-workflow execution-packet` 是 implementation Worker 的唯一 execution contract，內容包含 task intent、classification、compiled capability／step、execution constraints、procedure pointers、required evidence 與 plan identity；task.md／task.json 仍是 coordinator 與 runtime 的 authority。Packet 直接帶 selected step titles；一般 evidence capability 指向精簡的 `workflow/evidence.md`，只有需要完整操作規則時才指向專屬 skill，避免 Worker 為了還原已完成的決策重新讀取整份 policy。task-init、task-write 與 ExecutionPacket 共用同一個 procedure resolver；expanded／role 文件依 compiled exploration profile 與角色加入，project-docs 則只在 task-init 的 `--paths` context 回報 `doc_gap` 時加入；task-write 與 ExecutionPacket 沒有這份 context，不加入。expanded 任務的 ordered slices 是 coordinator 的工作流程與局部回饋順序，不是新的 `task.json` 欄位、ExecutionPacket authority 或 slice-state 欄位；符合 protocol 3 資格的獨立 ownership scope 可由 coordinator 明確建立 parallel batch。`procedure` 是 agent 要遵循的步驟；`evidence` 是任務對已完成步驟留下的可驗證紀錄，兩者不可互換。

### task.md 與 task.json 的分工

`task.md` 只保存 human-readable intent：Goal、Scope、Completion criteria（`code_change: true` 時包含 Given／When／Then 與 Verify 指令構成的 Acceptance cases），以及 freeze-required 任務的 Non-goals and compatibility。驗收案例在開發前寫進 intent，所以「什麼算完成」在動手前就已固定，並受 `intent_hash` 保護。`task.json` 是 classification、lifecycle、transition、waiver、project_docs、machine evidence 與 gate evaluation 的 machine authority，並保存版本化 lifecycle、transition、waiver 與 evidence，並以 `state_revision`／`plan_revision` 追蹤狀態與計畫版本、以 `intent_approval` 記錄高風險任務 intent 的核准（預設由 agent 自行 attest）。`agent-workflow task-report` 從兩者產生一次性的 Markdown 檢視，不形成第三個 authority。

### task.json 的寫入路徑

`task.json` 只能經由 runtime CLI 寫入。這是 agent 的約定，hook 不再攔截直接編輯；gate 信任檔案內容，所以這條約定由指令卡、review 與 CLI 的 schema 驗證維持。寫入依欄位分工到不同 command，各自經同一檔案鎖並在寫入前對照 `task.schema.json` 驗證：建立與初始分類用 `task-init`，後續分類用 `task-write`（allowlist，非允許欄位一律拒絕）；文件完成紀錄只用 `task-write` 更新 `project_docs.updated`，且會保留既有 read／digest 證據；讀完 project doc 後用 `project-doc --action Remember --task-path` 寫入 `project_docs.read` 與 `project_docs.digests`，這兩個欄位不能由 task-write 自行填入，Lookup 只有 digest 和 read 路徑都相符才回報 `reusable`；`task-write` 另外拒絕兩種降級（`managed_change` true→false、移除既有 `risk_flags`），唯一入口是 `reclassify`，它要求 `--confirmed-by-user` 與 `--reason` 並把該決定記進 `workflow_decision`；`impact_confidence` 不屬於受保護的降級，調低它只會讓 gate 要求更多而非更少，屬於 agent 自己的分析狀態，可直接用 `task-write` 更新，不需要使用者確認，也不必走 `reclassify`；`intent_approval` 用 `approve-intent`；evidence 只有 `evidence-run` 一種寫入者（`trust_level: runtime`——runtime 實際執行該指令並記下 command、cwd、exit code、輸出 digest 與 delivery fingerprint），接受重複或逗號分隔的 `--requirement-id`（`acceptance.<ID>` 或 plan 的 `proofs`），一次執行可在同一鎖內建立多筆同批 evidence；agent 自述的分析不是 evidence，而是 plan 的 `checklist`，由實作與 Reviewer 涵蓋；`review-record`（role）可接受 transient `--expected-workspace-sha256` 來綁定 reviewer 開始時的工作樹，但 persisted reviewed scope／digest 仍由 runtime 現算；policy 上宣告 `runtime_execution` 的 step 只接受 runtime evidence，`evidence_kind: execution` 且 exit code 非 0 一律不算通過；lifecycle 轉換用 `TaskLifecycle` 指令。persisted hash／record timestamp／diff 範圍一律由 runtime 現算，不接受呼叫端傳入。hook 不再攔截 `task.json`：shell 字串比對只能依名稱擋下指令，證明不了指令實際寫了什麼，還會誤擋唯讀操作；寫入規則由 workflow skill 的指令卡告知 agent，狀態正確性由 schema、檔案鎖與 gate 的重新計算保證。

### Lifecycle 與終端狀態

Lifecycle transition 只能經由 `TaskLifecycle` 執行，其他層不得直接改寫其語意或狀態；`task-gate` 只讀取並回報 gate 結果，不寫入 task 狀態。`closed`／`superseded` 是終端狀態，所有 task state 寫入一律拒絕；`evidence-run`／`review-record`／`approve-intent`／`waive` 另外只接受 `in_progress`，`paused`／`blocked` 需先 `resume`。

### Plan、intent 與 waiver 的雜湊綁定

`workflow-policy.ts` 編譯出的 plan 區分 `required`（runtime 強制、無法透過省略 `workflow_request` 移除）、`suggested` 與 `requested` 三種 capability，並從同一份分類推導 `exploration_profile: focused | expanded`；高信心、局部行為且無高風險邊界維持 focused，低信心、較大影響面、契約／資料／schema／不可逆或其他高風險情境才使用 expanded，agent 不再另判 Standard／Elevated。selected capability 的 step 分成兩類：`runtime_execution` step 是 `proofs`，進入 gate 的 `required_evidence`；其餘分析 step 是 `checklist`，只引導實作與 Reviewer，不進 gate。`workflow_facts` 判斷不了的 step 一律保留：分析 step 進 checklist，runtime step 仍是 gate 的 proof；兩者都附 `undecided_by`，宣告對應 fact 後才能確定是否適用，`next` 會先提示宣告。`plan_hash` 只覆蓋 selected capability、`required_evidence` 與 exploration profile，不含 policy 檔雜湊與原始分類：policy 修改或重新分類只要沒改變 gate 要求的項目，既有 evidence 就仍有效。task.md 的 Goal／Scope／Completion criteria 另由 `intent_hash` 覆蓋，兩者各自獨立計算。每個 `code_change: true` 的 managed task 都要有驗收案例，且每一條都要有 runtime receipt；`code_change: false` 的 managed task（例如 hook、policy、部署設定）刻意不強制驗收案例，只有分類選到的 proofs 與 Reviewer 會進 gate，若沒有選到任何項目，建立後即可結案，需要驗證時由 task.md 自行寫入 Acceptance cases；驗收 receipt 只綁定 `intent_hash` 與 delivery fingerprint，不綁定 plan，所以重新分類不會讓驗收失效。`code_change: true` 的 task 一律選入 Reviewer；`task_type: mechanical` 只免除這條，影響面、effect 或 risk flag 觸發的 Reviewer 條件仍然有效；高風險 capability 仍各自要求自己的 proofs。每個 task 指令的輸出都附上 `next`，由 gate 的缺口推出補上缺口的完整指令，agent 照著走即可，不必從文件重建協定。Waiver 必須包含明確使用者確認及 transition history，且同時綁定當下的 `plan_hash` 與 `plan_revision`（`plan_hash` 是分類的純函式，分類改走一圈再改回來會還原同一個 hash；沒有 `plan_revision` 的舊 waiver 一律視為過期）。`evidence-run`／`review-record`／waiver 寫入時會同時記錄當下的 `plan_hash` 與 `intent_hash`；`review-record` 另外記錄每個 reviewed path 的內容 digest，讓 `pre-review --task-path` 把下一輪的範圍縮到上一輪之後有變動的路徑；runtime execution evidence 目前綁定完整 delivery fingerprint，任何交付內容變更都會使 receipt 失效並要求重新驗證，尚未提供 path-scoped execution reuse，避免未經驗證的相依性宣告讓正確性下降。

實際驗證由目標專案的原生測試 command 與 `evidence-run` receipt 決定；scope 定義見 [evidence.md](../.agents/skills/workflow/evidence.md#validation-command)。`scripts/run-tests.mjs` 只執行本 repo 的 `tests-node`。schema v6 已移除三個相容性欄位（validation profile、workflow mode、model profile），migration 會把舊 task 中殘留的值一併清除。

`src/orchestration/protocol.ts` 以 protocol 3 提供唯一的 deterministic multi-worker control plane；protocol 2 phase tracker 已退役，只保留 `--protocol 2 --action Read` 讀取遺留 state。資格條件、action 序列與 state machine 見 [orchestration.md](../.agents/skills/workflow/orchestration.md)，狀態 authority 是 `schemas/orchestration.schema.json`，與 task state 走同一把檔案鎖。parent 在 Apply 後回到同一條 finalization（見 [evidence.md](../.agents/skills/workflow/evidence.md#finalization)）。三平台 native dispatch 只負責啟動並回傳 stable `run_id`，不重新解釋 ExecutionPacket 或 workflow policy。

平行是否啟動分成兩段可計算的判斷。第一段是 `task-init` 的 `parallel_hint`，只看分類、exploration profile 與驗收案例數，決定值不值得考慮切分。第二段是 `orchestrate Assess`，對 coordinator 的切分計畫同時檢查 eligible 與 worthwhile。eligible 包括：ownership 不重疊、`shared_files` 不在任何 worker 範圍內、每條驗收案例恰好分配一次。worthwhile 包括：每個 worker 至少有一條驗收案例與足夠的預計檔案，而且 parent 沒有需要依序處理的風險。平行一定會增加總 token，因此門檻刻意偏嚴，預設仍是循序 slices。

worker 的單位是一組 parent 驗收案例，packet 的 `assignment` 帶這些案例的全文。worker 的 receipt 由 `worker-exec --acceptance` 寫在 worktree 內的保留目錄：Codex 的 sandbox 只能寫 workspace roots，所以回報只能留在 worktree 裡；Collect 讀取後會把這個目錄排除在交付之外。receipt 只用來提早退回未完成的 worker，parent 在 Apply 後仍要重跑全部案例。installer 從 `.agents/agents/*.md` 產生 Claude（`agents/*.md`）與 Codex（`agents/*.toml`，worker 的 sandbox 可寫範圍包含 state root 的 orchestration 目錄）的原生 agent 定義，並把同一個目錄加入 Claude 的 `additionalDirectories`；Antigravity 沒有原生 subagent，一律循序。

## Classification 與 confirmation 的 trust boundary

兩件事本框架明確不保證，設計上以 attestation 而非 proof 處理：

- **初始分類由 AI 負責。** Runtime 無法分辨「這次真的沒有 authorization 風險」與「AI 漏判了 authorization 風險」，除非另建 static analysis 或分類驗證器。Runtime 的職責是保證**已宣告**的高風險不能被靜默繞過：`required` 不能靠少填 `workflow_request` 移除，移除 risk flag 或把 `managed_change` 改回 `false` 都必須走 `reclassify`。
- **使用者確認是 attestation。** `approve-intent --as-user` 與 `reclassify --confirmed-by-user` 都由 agent 提交，runtime 沒有 platform event bridge 可以密碼學地證明使用者真的按過確認。記錄的是「誰在什麼時間宣稱使用者確認了什麼」，不是使用者行為本身的證明。`approve-intent` 預設由 agent 自行執行、不加 `--as-user`（`source: cli-attestation`），不停下來要求使用者確認 intent；`intent_hash` 仍負責偵測核准後 Goal／Scope／Completion criteria 被改動。

## Hook trust boundary

Platform adapter 只正規化工具名稱、command 與直接路徑，轉成 `CanonicalHookEvent`；`git-guard` 是唯一 PreToolUse 入口，只做 Git safety。不含 Git 的呼叫直接放行，不做全指令 mutation 分類、檔案讀取或雜湊。

Git safety 只在 command 提到 Git 時解析。破壞性操作（hard reset、clean、branch delete、path checkout、restore、force push）及 hidden execution（wrapper、直譯器、remote/container、substitution、改變 Git 執行方式的 option）拒絕；其餘直接 Git 呼叫交由平台 native permission，包括 `cd repo && git checkout -b branch`。平台是否提示 approval 由平台 permission 設定決定，guard 放行本身不代表已獲使用者核准。diff machinery 的 output／external execution 與跨 project git-dir／work-tree 邊界仍保留。

`.agents/` 文件品質由 AGENTS pointer、`writing-for-agents`、review 與 contract lint 維持，不再保存或驗證 session read proof，也沒有 PostToolUse／SessionEnd guard。三平台共用同一組 hook 功能矩陣：工具呼叫的 guard、輸出前注入的 localization-tw skill 規則，以及依任務自動篩選的 memory hook。Claude 的 guard matcher 只列 shell 與 `mcp__.*` 工具（Git 只能經由這兩類執行），Codex／Antigravity 的工具名稱未固定，維持 `*`。localization-tw skill 的核心規則（`locale.md` 的 Core rules）與用詞清單由 `locale-context` 在 Claude／Codex 的每次 `UserPromptSubmit` 與 Antigravity 首次 `PreInvocation` 注入，來源是安裝時由 vocabulary.md 產生的 policy。注入內容緊接在要寫的回覆之前，讓 agent 在輸出前先讀過 skill 再寫，而不是另外多一次工具往返去載入整個 skill；回覆送出後不再檢查或要求修正，因為那時回覆已經顯示給使用者，事後更正只會重複內容。它每一輪都進 context，所以清單只收錄不需要例外就能判斷的中國用語（收錄條件在 vocabulary.md）。Claude／Codex 在 `UserPromptSubmit`、`PreToolUse` 觸發；Antigravity 沒有等價的 prompt-submit lifecycle，才在首次 `PreInvocation` 提供 skill 規則與主題導航，其餘以 `PreToolUse` 做必要映射。

這是對直接資源與高風險 pattern 的窄範圍檢查，不是完整 shell sandbox；變數間接算出的路徑、任意 script、alias 或同機程序的行為仍由平台權限管理。它不試圖防止擁有本機檔案權限者停用 hook。task runtime 的 schema、鎖、evidence freshness 與 reviewer gate 維持原有 authority。

## 文件路由

文件只摘要並指向 authority，不複製 workflow 規則或 contract。`project-doc Lookup` 將 path 命中的文件放在 `docs`，將 architecture／structure／dataflow／glossary 放在附有 `content_sha256` 的 `overview_candidates`；傳入 `--task-path` 時會以 `project_docs.read` + `project_docs.digests` 判斷 `reusable`／`stale`，未讀的 overview candidate 不會自動成為 read evidence。修改 agents、skills、hooks 或 workflow contract 前，先讀本文件，再依目標路徑讀取其 owner 文件與 schema。

## Framework 變更政策

本 framework 已進入穩定期，任何對 agents、skills、hooks、runtime 或 workflow contract 的修改都要由證據驅動，不由推測驅動。修改的 task 或 PR 在理由中寫出下列四項，寫在既有 task.md 即可，不另建 schema 或審查角色：

```text
trigger:        regression | gate-cost | platform-contract | contract-test
evidence:       實際的 task、regression、platform contract 或 failing test
minimal_change: 為什麼這是能解決該證據問題的最小修改
non_goals:      本次明確不順便處理的項目
```

四項都寫不出來時，代表還沒有值得改動 framework 的證據。

新增或擴充 subsystem（例如新的 orchestration protocol、新 CLI command、新固定 hook）前，先確認它是在擴充 [Contract owner](#contract-owner) 已列出的既有 authority，還是在建立第二個 authority；後者預設不允許，除非該 subsystem本身就是該 responsibility 的唯一 owner。可選流程只能掛在既有 lifecycle 的插入點（例如 exploration、orchestration、review 都是 optional，完成後由 coordinator 執行內含 gate 的 close-task；失敗時才用 task-gate 診斷），不得自建平行的 init／gate／close。新 CLI command 需說明既有 command 為何無法擴充，避免同樣資料多一種輸出格式時仍新增一個 command，增加 agent 的判斷成本。新增預設每個 task 都執行的固定成本（fixed hook、固定 step）時，需同時指出它取代了哪個既有步驟。

## 安裝與遷移

其他框架（ponytail、hallmark、design-and-refine 等）不複製進本 repo，只在 `adapters/upstream-manifest.json` 記錄上游位置與各平台的安裝指令，由安裝器在安裝時執行；需要本機目錄的指令使用臨時 clone，跑完即刪。方法與新增步驟見 [upstream-integrations.md](modules/upstream-integrations.md)。

`install` 先建立不可覆寫的時間戳備份，再遷移既有 state。遷移可重跑；完成 Verify 前，既有的 managed command 與 runtime 保持原狀。既有 task frontmatter 轉為 `task.json`；`task.md` 就地去除 frontmatter、保留人的意圖內容而不刪除，原始完整檔案另收入備份，無法機械驗證的 evidence 標記為 `legacy-unverified`。managed state 記錄 package version、runtime hash、Node 路徑、platform targets 與 selected skills。Repair 從目前 repo checkout 取 source；只有已安裝 runtime 自我 repair 時才使用記錄 source。

## Memory 的有界選取

`~/.agent-workflow` 是跨平台共用的可寫 curated store；安裝時把同一個絕對 state root 寫入三平台 hooks。自動路徑（Claude／Codex 的 `UserPromptSubmit`、Antigravity 首次 `PreInvocation` 的主題導航）只掃 curated verified 記憶，有 6 筆／800 字元上限與專案隔離；prompt 只作資料，不放進 shell。同一 session 已注入的紀錄以 `os.tmpdir()` 的暫存標記跳過，不重複注入。只有 explicit query 才額外唯讀掃描平台原生記憶，候選標成 `needs_verification`，只能作線索。何時明確查詢、query 語意與寫入規則以 [memory.md](../.agents/skills/workflow/memory.md) 為準；詞彙匹配不宣稱語意搜尋，也沒有 persistent index。
