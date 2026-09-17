# 工作流程效率審查（2026-09-17）

以 HEAD `0d2d948d6986c51be606e04064585c88c5df0c74` 與本次工作樹為依據。結論：優先修正流程文件互相矛盾造成的重跑；現有 runtime 已具備批次 evidence、按風險選取與 freshness 檢查，不需要新增命令、快取層或 orchestration。這次沒有變更 runtime、schema、policy 或安裝副本。

## 已完成的優化與目前證據

| 範圍 | 目前實作 | 證據與驗證 |
| --- | --- | --- |
| 分流 | managed_change 是唯一 gate；required 依分類產生，requested 只能疊加；focused/expanded 由同一 plan 推導 | `src/workflow-policy.ts:compileWorkflowPlan`；policy-scenarios 測試通過 |
| 漸進讀取 | task-init/task-write 與 ExecutionPacket 共用 resolver；局部高信心任務不載入 project-doc；procedure 去重 | `src/execution/execution-packet.ts:resolveProcedures`；execution-packet 測試通過 |
| 文件重用 | Lookup 只回傳命中文件與 overview candidates；已讀 path 與目前 digest 同時吻合才 reusable | `src/project-doc.ts:digestStatus`；project-doc 測試通過 |
| 記錄 | 多個 requirement id 可由同一 evidence-run/record 建立，單次鎖與 state revision；task-report 不成為第三個 authority | `src/lifecycle/evidence.ts:appendStepEvidence`；lifecycle batch 測試通過 |
| gate | 每次 evaluation 共用一份 delivery snapshot；closeTask 直接呼叫 evaluateTaskGate | `src/lifecycle/task-gate.ts:ensureLiveDelivery`、`src/lifecycle/transitions.ts:closeTask` |
| 角色 | sequential 為預設；Worker 接收 ExecutionPacket；Reviewer 用 shared map 與 delta-first；相同 PASS 不重跑 | workflow 的 orchestration.md、review.md；本次獨立 Reviewer PASS，未將合成 review 視為模型品質證據 |
| 啟動 | CLI 依命令動態載入 subsystem；guard 使用獨立 bundle | `src/cli.ts`、`src/hook-entry.ts`；lazy-cli 測試通過；本次 build 成功 |
| 測試範圍 | focused/affected 要求明列路徑；full 固定全套；scope 不另改變 policy | `scripts/run-tests.mjs`；本次以 affected 執行 6 個測試檔、76 tests 全數通過 |

## 已修正的矛盾與最小變更

1. **medium：最終驗證順序互相矛盾。** 原 README 第 56 行與 evidence procedure 要求 regression → Reviewer → DV1，第 60 行又要求 Review 穩定後跑最終回歸。相同命令可能因此跑兩次。現在 evidence procedure 明訂：穩定內容後，以 evidence-run 一次記錄該命令實際涵蓋的 requirement（可包含 DV1），再執行選取的唯讀 Reviewer；內容變動才重新驗證。不同語意、不同範圍的命令仍分開執行。
2. **medium：正常結案重複 gate。** 原 runtime 文件 flow 列 task-gate → close-task，但 closeTask 本身執行 gate。移除固定的前置 task-gate，保留診斷 blocker 用途。相應 flow contract 測試已更新，沒有刪除 runtime gate。
3. **low：Review 歸因被摘要升格為必要步驟。** README 要求每次打回都先記歸因，review.md 已允許併入失敗回報且不必阻塞交付。README 改指向 owner procedure。
4. **low：分類文件重複維護驗證順序。** capability-selection.md 改成 pointer；模組文件澄清 plan 隨 task-init 回傳，preflight 執行一次，不暗示每次 task-write 都重跑。

本次刻意保留 required evidence、完整 delivery fingerprint、plan/intent freshness、review 工作樹綁定、失敗命令不算 PASS，以及保護既有異動的邊界。沒有新增逐路徑信任宣告或第二份 ledger。

## 尚未解決的缺口

| 程度 | 目前證據與影響 | 最小後續方向與驗證條件 |
| --- | --- | --- |
| medium | `evidence.ts:deliverySnapshot` 綁定完整交付，任何文件或其他交付路徑變更都使 runtime receipt 失效。這會增加返工，但目前是明確安全邊界 | 先穩定文件與 source，再發最終 receipt；同一 distinct command 重跑一次即可。只有具備可靠 dependency coverage 且能證明未漏測時，才考慮 path-scoped reuse；本次不實作 |
| medium | runtime 沒有完整模型 token、工具等待、角色推論或人工返工 telemetry；`evidence.at` 不是執行時間。現有測試明確保留移除 timing 欄位後的 contract | 對真實相同任務做隔離、成對 session replay，從 host usage/事件時間戳離線取值；不要把 timing 欄位加回 task schema。此次無完整 session A/B，因此不能宣稱總 token／總任務時間改善已獲證實 |
| medium | freshness 自動涵蓋 delivery、plan、intent；外部環境是否改變仍依 agent 判斷，沒有自動環境指紋 | 重用時核對相關環境與驗證範圍；若涉及部署／資料庫，依 operational-verification 取得當前證據。不要將工作樹相同解讀為外部系統仍相同 |
| low | `src/project-doc.ts:docs` 每次 Lookup 遍歷並讀取所有 Markdown，digest reuse 節省模型讀取但未省去此 I/O | 先量測大型文件樹是否為實際瓶頸。沒有量測前維持現有簡單掃描，不新增 persistent index |
| low | architecture、README、skills 仍有部分規則摘要重疊；elevated/orchestration 保留角色 gate 名稱，但不是自動執行實作 | 變更相關段落時回指 owner；不要一次拆分所有文件。未命中任務 trigger 就不讀專屬 procedure |

歷史 V5 的 dispatcher/worktree/patch 敘述不能視為目前功能；目前 `src/experimental/orchestration.ts` 及 architecture.md 明確只支援 phase tracker。先前記憶中的 `pre-review --repo-root` 也不是當前介面，CLI registry 現在使用 `--path`。舊記憶僅作搜尋線索，不當執行規則。

## 成對實測

這是**結案流程的合成重播**，不是完整產品任務或 LLM A/B。相同目前 bundle、相同 repository/worktree，三種情境各做前後 3 次，交替執行順序。共同 task-init 不計入；測量涵蓋子程序啟動、命令、fingerprint、evidence 記錄、review-record 與結案。驗證命令是同一個 Node arithmetic assertion，review-record 是明確標記的合成 PASS。沒有模擬真實閱讀、模型判斷或 Reviewer 推論。

before 是文件可導致的重複順序：直接驗證 →（review）→ 同命令 evidence-run 記 DV1 → task-gate → close-task。after 使用既有 receipt 機制：evidence-run →（review）→ close-task。這不代表每個舊任務一定重跑；若原先已使用最短合法路徑，就不會有這些收益。

| 情境 | CLI／命令呼叫 前→後 | 驗證執行 前→後 | 中位時間 前→後 | 時間差 | stdout+stderr 字元 前→後 |
| --- | --- | --- | --- | --- | --- |
| 局部任務 | 4 → 2 | 2 → 1 | 2,548 → 1,868 ms | -26.7% | 1,064 → 485 |
| 含唯讀 Review | 5 → 3 | 2 → 1 | 3,395 → 2,764 ms | -18.6% | 1,839 → 1,231 |
| 需求變更返工一次 | 8 → 6 | 3 → 2 | 4,482 → 4,846 ms | **+8.1%** | 3,396 → 3,070 |

18 個流程都成功結案；6 個返工流程的 gate 均未通過，但此重播只檢查非零 exit code，未單獨確認拒絕原因。before 在該階段也缺少 DV1，故不能將此項視為 intent freshness 的獨立證明；freshness 正確性另由既有 evidence 測試驗證。模型 input/output/cache token、整個任務耗時與人工返工成本均未取得；字元數不是 token，不能換算後當實測。樣本僅 n=3，沒有統計顯著性結論；同機其他程序可能影響 wall time。

返工情境雖少兩次呼叫，卻較慢：after 提早建立的 receipt 在 intent 改變後失效，再次 evidence-run 多付完整 fingerprint 成本；before 第一次只直接跑便宜 assertion。可觀察到此機制差異，尚未隔離量出各子步驟時間，因此不能把全部時間差歸因於 fingerprint。對極便宜、仍會反覆修改的驗證，應先用局部 feedback，待交付穩定才建立最終 receipt；不應為了「少步驟」提早反覆寫 evidence。

原始 18 筆資料：`.tmp-a/efficiency-audit/run-1789579864690/measurements.json`；一次性重播程式：`.tmp-a/efficiency-audit/measure.mjs`。兩者留在 Git 忽略的本機工作資料，不新增 framework 命令或長期維護子系統。

## 本次操作成本與驗證界線

- 既有未追蹤的 docs/decisions 與 docs/history 文件完整保留；未 commit、push 或同步安裝副本。
- 本次也發生可避免的返工：task id 未依 schema 命名，pre-review 使用舊參數，首次量測與文件修改並行導致 receipt 正確拒絕；這些均未算入成對數字，不能隱藏成「總任務」改善。後續應直接使用 schema／CLI registry 的當前介面，量測期間固定工作樹。
- 沙箱 Node 存取使用者目錄發生 EPERM，經核准使用本機執行；.agents 的 apply_patch 存取受限，改經核准寫入指定文件。這些環境/tool 成本也不在重播數字內。
- 76 個相關回歸測試已通過，contract-lint findings 為空，流程修改獨立 Reviewer PASS。最終 runtime receipt 的文件合約及 evidence 邊界檢查通過。報告 delta review 曾指出「非零 gate 不等於證明 intent 過期」的證據主張問題，已收斂措辭並重新驗證；此返工不計入重播數字。
- 未執行全套測試、遠端 CI、安裝 runtime 驗證或真實多模型端到端 A/B；本次沒有 runtime/source 行為修改。

採納本次最小修正的理由是消除可重現的重複流程與規則矛盾；目前證據支持穩定交付的局部成本下降，**不支持所有任務總耗時都下降，也不足以證明最大化總 token 節省**。
