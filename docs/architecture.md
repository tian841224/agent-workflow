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

Node.js 20 以上版本是唯一 runtime family（對應 `package.json` 的 `engines.node: ">=20"`）。`src/` 是 TypeScript source，`dist/` 有兩個可部署 ESM bundle：`agent-workflow.mjs` 是完整 CLI，`agent-workflow-hook.mjs` 只含 hook 所需的 `hooks.ts`、`locale-hooks.ts` 與 `core.ts`。完整 CLI 在確認 command 與 options 後才動態載入該 subsystem；esbuild 仍輸出單一 CLI bundle，延後的是 module initialization，不需要部署額外 chunks。locale hook 與手動 git-guard 執行後者，`memory-context` 等其餘指令執行前者，避免 locale hook 載入不相關的 CLI subsystem。已安裝的 hooks 只執行記錄在 managed state 的 Node 絕對路徑與這兩個 bundle，不依賴 repo、`node_modules` 或 npx cache。

安裝另外把 `agent-workflow.mjs` 原封不動複製到 npm global prefix 成為無副檔名的 `agent-workflow`（Windows 另加 `.cmd` 包裝），讓 CLI 在任何專案都可執行。這份副本必須與 runtime bundle 位元組相同，安裝紀錄與 Verify 以 SHA-256 核對。

## 架構設計方向

在不降低輸出品質、正確性、必要安全邊界與可驗證性的前提下，選擇 token 與執行時間最少的完整路徑。流程、角色、skill 與驗證必須由任務的實際風險與影響決定；沒有改變決策或增加證據的步驟不執行。

Task-level Reviewer 的啟動時機由 [workflow review procedure](../.agents/skills/workflow/review.md) 統一管理；其他 workflow 文件只描述切片回饋與指向該規則。

採用漸進式設計與揭露。所有場景共用的短規則留在入口；只適用於特定場景的流程、reference 與 skill，使用明確 trigger 指向並在需要時讀取。不得為少數場景把不相關內容放進每次 session 的常駐 context。

## 責任邊界

### 原生角色與責任範圍

`Reader` 只蒐集與呈現可查證的事實。`Worker` 接受主 agent 直接指派的目標、檔案責任範圍、workspace 與驗收條件；隔離方式由主 agent 決定。Worker 保留其他人的修改，回報實際驗證結果、缺口與 blocker。分類、task lifecycle、整合與最終證據由主 agent 持有。

平行開發使用平台原生 subagent，判斷入口與責任分配依 [workflow](../.agents/skills/workflow/SKILL.md)，worker 契約依 [worker](../.agents/agents/worker.md)。一般指派不要求 ExecutionPacket、獨立 worktree、worker-exec 或固定結果檔格式。

`execution-packet` CLI 供明確選用 packet 契約的呼叫端使用。它帶有 task intent、classification、compiled capability／step、procedure pointers、required evidence 與 plan identity；task.md／task.json 是 authority。task-init、task-write 與 ExecutionPacket 共用 procedure resolver，依探索 profile、coordinator role 與 doc_gap 加入指引。`procedure` 是工作指引；`evidence` 是完成步驟的可驗證紀錄，兩者不可互換。

### task.md 與 task.json 的分工

`task.md` 保存 human-readable intent 與任務規格；managed 開發任務的規格撰寫與章節取捨依 [implementation-spec](../.agents/skills/implementation-spec/SKILL.md)。Runtime 保護的 intent 是 Goal、Scope、Completion criteria（`code_change: true` 時包含 Given／When／Then 與 Verify 指令構成的 Acceptance cases），以及 freeze-required 任務的 Non-goals and compatibility。驗收案例在開發前寫進 intent，所以「什麼算完成」在動手前就已固定，並受 `intent_hash` 保護。`task.json` 是 classification、lifecycle、transition、waiver、project_docs、machine evidence 與 gate evaluation 的 machine authority，並保存版本化 lifecycle、transition、waiver 與 evidence，並以 `state_revision`／`plan_revision` 追蹤狀態與計畫版本、以 `intent_approval` 記錄高風險任務 intent 的核准（預設由 agent 自行 attest）。`agent-workflow task-report` 從兩者產生一次性的 Markdown 檢視，不形成第三個 authority。

### task.json 的寫入路徑

`task.json` 只能經由 runtime CLI 寫入。這是 agent 的約定，hook 不攔截直接編輯；gate 信任檔案內容，所以這條約定由指令卡、review 與 CLI 的 schema 驗證維持。寫入依欄位分工到不同 command，各自經同一檔案鎖並在寫入前對照 `task.schema.json` 驗證：建立與初始分類用 `task-init`，後續分類用 `task-write`（allowlist，非允許欄位一律拒絕）；文件完成紀錄只用 `task-write` 更新 `project_docs.updated`，且會保留既有 read／digest 證據；讀完 project doc 後用 `project-doc --action Remember --task-path` 寫入 `project_docs.read` 與 `project_docs.digests`，這兩個欄位不能由 task-write 自行填入，Lookup 只有 digest 和 read 路徑都相符才回報 `reusable`；`task-write` 另外拒絕兩種降級（`managed_change` true→false、移除既有 `risk_flags`），唯一入口是 `reclassify`，它要求 `--confirmed-by-user` 與 `--reason` 並把該決定記進 `workflow_decision`；`impact_confidence` 不屬於受保護的降級，調低它只會讓 gate 要求更多而非更少，屬於 agent 自己的分析狀態，可直接用 `task-write` 更新，不需要使用者確認，也不必走 `reclassify`；`intent_approval` 用 `approve-intent`，或在 `task-init` 以 `--confirmed-by` 隨 task 建立一併寫入；evidence 只有 `evidence-run` 一種寫入者（`trust_level: runtime`——runtime 實際執行該指令並記下 command、cwd、exit code、輸出 digest 與 delivery fingerprint），接受重複或逗號分隔的 `--requirement-id`（`acceptance.<ID>` 或 plan 的 `proofs`），一次執行可在同一鎖內建立多筆同批 evidence；agent 自述的分析不是 evidence，而是 plan 的 `checklist`，由實作與 Reviewer 涵蓋；`review-record`（role）可接受 transient `--expected-workspace-sha256` 來綁定 reviewer 開始時的工作樹，但 persisted reviewed scope／digest 仍由 runtime 現算；policy 上宣告 `runtime_execution` 的 step 只接受 runtime evidence，`evidence_kind: execution` 且 exit code 非 0 一律不算通過；lifecycle 轉換用 `TaskLifecycle` 指令。persisted hash／record timestamp／diff 範圍一律由 runtime 現算，不接受呼叫端傳入。hook 不攔截 `task.json`：shell 字串比對只能依名稱擋下指令，證明不了指令實際寫了什麼，還會誤擋唯讀操作；寫入規則由 workflow skill 的指令卡告知 agent，狀態正確性由 schema、檔案鎖與 gate 的重新計算保證。

### Lifecycle 與終端狀態

Lifecycle transition 只能經由 `TaskLifecycle` 執行，其他層不得直接改寫其語意或狀態；`task-gate` 只讀取並回報 gate 結果，不寫入 task 狀態。`closed`／`superseded` 是終端狀態，所有 task state 寫入一律拒絕；`evidence-run`／`review-record`／`approve-intent`／`waive` 另外只接受 `in_progress`，`paused`／`blocked` 需先 `resume`。

### Plan、intent 與 waiver 的雜湊綁定

`workflow-policy.ts` 編譯出的 plan 區分 `required`（runtime 強制、無法透過省略 `workflow_request` 移除）、`suggested` 與 `requested` 三種 capability，並從同一份分類推導 `exploration_profile: focused | expanded`；高信心、局部行為且無高風險邊界維持 focused，低信心、較大影響面、契約／資料／schema／不可逆或其他高風險情境才使用 expanded。selected capability 的 step 分成兩類：`runtime_execution` step 是 `proofs`，進入 gate 的 `required_evidence`；其餘分析 step 是 `checklist`，只引導實作與 Reviewer，不進 gate。`workflow_facts` 判斷不了的 step 一律保留：分析 step 進 checklist，runtime step 仍是 gate 的 proof；兩者都附 `undecided_by`，宣告對應 fact 後才能確定是否適用，`next` 會先提示宣告。`plan_hash` 只覆蓋 selected capability、`required_evidence` 與 exploration profile，不含 policy 檔雜湊與原始分類：policy 修改或重新分類只要沒改變 gate 要求的項目，既有 evidence 就仍有效。task.md 的 Goal／Scope／Completion criteria 另由 `intent_hash` 覆蓋，兩者各自獨立計算。每個 `code_change: true` 的 managed task 都要有驗收案例，且每一條都要有 runtime receipt；`code_change: false` 的 managed task（例如 hook、policy、部署設定）刻意不強制驗收案例，只有分類選到的 proofs 與 Reviewer 會進 gate，若沒有選到任何項目，建立後即可結案，需要驗證時由 task.md 自行寫入 Acceptance cases；驗收 receipt 只綁定 `intent_hash` 與 delivery fingerprint，不綁定 plan，所以重新分類不會讓驗收失效。`code_change: true` 的 task 一律選入 Reviewer；`task_type: mechanical` 只免除這條，影響面、effect 或 risk flag 觸發的 Reviewer 條件仍然有效；高風險 capability 仍各自要求自己的 proofs。每個 task 指令的輸出都附上 `next`，由 gate 的缺口推出補上缺口的完整指令，agent 照著走即可，不必從文件重建協定。Waiver 必須包含明確使用者確認及 transition history，且同時綁定當下的 `plan_hash` 與 `plan_revision`（`plan_hash` 是分類的純函式，分類改走一圈再改回來會還原同一個 hash；沒有 `plan_revision` 的舊 waiver 一律視為過期）。`evidence-run`／`review-record`／waiver 寫入時會同時記錄當下的 `plan_hash` 與 `intent_hash`；`review-record` 另外記錄每個 reviewed path 的內容 digest，讓 `pre-review --task-path` 把下一輪的範圍縮到上一輪之後有變動的路徑；runtime execution evidence 目前綁定完整 delivery fingerprint，任何交付內容變更都會使 receipt 失效並要求重新驗證，尚未提供 path-scoped execution reuse，避免未經驗證的相依性宣告讓正確性下降。

實際驗證由目標專案的原生測試 command 與 `evidence-run` receipt 決定；scope 定義見 [evidence.md](../.agents/skills/workflow/evidence.md#validation-command)。`scripts/run-tests.mjs` 只執行本 repo 的 `tests-node`。migration 會清除舊 task 中殘留的 validation profile、workflow mode、model profile 欄位。

`src/orchestration/protocol.ts`、`schemas/orchestration.schema.json` 與 orchestration CLI 是工作包（packet）契約的選用介面；不作為正常平行開發的必要控制層。只有明確選用該介面時，才使用其 worktree、packet、receipt、artifact、Retry 與整合 state machine。原生指派直接使用平台工具，整合後回到 [Finalization](../.agents/skills/workflow/evidence.md#finalization)：主 agent 執行整體驗收與 proofs，再做 task-level Reviewer 與 close-task。

Installer 從 `.agents/agents/*.md` 產生 Claude 與 Codex 的原生 agent 定義。orchestration writable root 與 Claude additionalDirectories 只供 orchestration CLI 使用，並非原生 worker 的隔離要求。沒有可用原生 subagent 的平台採循序實作。

## Classification 與 confirmation 的 trust boundary

兩件事本框架明確不保證，設計上以 attestation 而非 proof 處理：

- **初始分類由 AI 負責。** Runtime 無法分辨「這次真的沒有 authorization 風險」與「AI 漏判了 authorization 風險」，除非另建 static analysis 或分類驗證器。Runtime 的職責是保證**已宣告**的高風險不能被靜默繞過：`required` 不能靠少填 `workflow_request` 移除，移除 risk flag 或把 `managed_change` 改回 `false` 都必須走 `reclassify`。
- **使用者確認是 attestation。** `task-init`／`approve-intent` 的 `--as-user` 與 `reclassify --confirmed-by-user` 都由 agent 提交，runtime 沒有 platform event bridge 可以密碼學地證明使用者真的按過確認。記錄的是「誰在什麼時間宣稱使用者確認了什麼」，不是使用者行為本身的證明。`approve-intent` 預設由 agent 自行執行、不加 `--as-user`（`source: cli-attestation`）；這不取代 managed 開發任務依 [workflow](../.agents/skills/workflow/SKILL.md) 在 Plan mode 交付規格並取得使用者確認的 procedure。`intent_hash` 仍負責偵測核准後 Goal／Scope／Completion criteria 被改動。

## Hook trust boundary

自動 hook 只提供 locale 與 memory context；平台模板不註冊 `PreToolUse` Git guard。Git 操作授權由 [AGENTS.md](../AGENTS.md) 的行為規則管理，只有使用者明確授權才可執行受限操作，agent attestation 或平台放行不能代替使用者授權。

手動 `git-guard` CLI：adapter 把 payload 正規化為 `CanonicalHookEvent`，checker 拒絕破壞性與隱藏執行 pattern。它沒有安裝為自動 hook，也不接收或證明使用者授權。選用的 Codex execpolicy rules 對受限 Git 操作要求 prompt；installer 不自動安裝該 rules 檔。

`.agents/` 文件品質由 AGENTS pointer、`writing-for-agents`、review 與 contract lint 維持，不保存或驗證 session read proof，也沒有 PostToolUse／SessionEnd guard。三平台共用同一組 context hook 功能：輸出前注入的 localization-tw skill 規則，以及依任務自動篩選的 memory hook。localization-tw skill 的核心規則（`locale.md` 的 Core rules）與用詞清單由 `locale-context` 注入，來源是安裝時由 vocabulary.md 產生的 policy：Claude／Codex 的每次 `UserPromptSubmit` 都注入用詞清單，核心規則同一個 session 只在第一次注入（以 `os.tmpdir()` 的 session 標記判斷，payload 沒有 session id 時每次都注入）；Antigravity 在首次 `PreInvocation` 注入兩者。注入內容緊接在要寫的回覆之前，讓 agent 在輸出前先讀過 skill 再寫，而不是另外多一次工具往返去載入整個 skill；回覆送出後不再檢查或要求修正，因為那時回覆已經顯示給使用者，事後更正只會重複內容。用詞清單每一輪都進 context，所以只收錄不需要例外就能判斷的中國用語（收錄條件在 vocabulary.md）。Claude／Codex 在 `UserPromptSubmit` 觸發；Antigravity 沒有等價的 prompt-submit lifecycle，在首次 `PreInvocation` 提供 skill 規則與主題導航。

平台權限由平台管理；agent 行為規則不是 shell sandbox，也不提供密碼學的使用者授權證明。task runtime 的 schema、鎖、evidence freshness 與 reviewer gate 的 authority 不受 hook 影響。安裝與舊 managed hook 清理契約見 [platform hooks](modules/platform-hooks.md)。

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

Repo 內技能的必裝與平台範圍契約見 [managed skill installation](modules/managed-skill-installation.md)。

其他框架（ponytail、hallmark、design-and-refine 等）不複製進本 repo，只在 `adapters/upstream-manifest.json` 記錄上游位置與各平台的安裝指令，由安裝器在安裝時執行；需要本機目錄的指令使用臨時 clone，跑完即刪。方法與新增步驟見 [upstream-integrations.md](modules/upstream-integrations.md)。

`install` 先建立不可覆寫的時間戳備份，再遷移既有 state。遷移可重跑；完成 Verify 前，既有的 managed command 與 runtime 保持原狀。既有 task frontmatter 轉為 `task.json`；`task.md` 就地去除 frontmatter、保留人的意圖內容而不刪除，原始完整檔案另收入備份，無法機械驗證的 evidence 標記為 `legacy-unverified`。managed state 記錄 package version、runtime hash、Node 路徑、platform targets 與 selected skills。Repair 從目前 repo checkout 取 source；只有已安裝 runtime 自我 repair 時才使用記錄 source。

## Memory 的有界選取

`~/.agent-workflow` 是跨平台共用的可寫 curated store；安裝時把同一個絕對 state root 寫入三平台 hooks。自動路徑（Claude／Codex 的 `UserPromptSubmit`、Antigravity 首次 `PreInvocation` 的主題導航）只掃 curated verified 記憶，有 6 筆／800 字元上限與專案隔離；prompt 只作資料，不放進 shell。同一 session 已注入的紀錄以 `os.tmpdir()` 的暫存標記跳過，不重複注入。只有 explicit query 才額外唯讀掃描平台原生記憶，候選標成 `needs_verification`，只能作線索。何時明確查詢、query 語意與寫入規則以 [memory.md](../.agents/skills/workflow/memory.md) 為準；詞彙匹配不宣稱語意搜尋，也沒有 persistent index。

## 模組文件索引

- [Platform hooks](modules/platform-hooks.md)：context hook templates、managed hook 清理與平台授權邊界。
