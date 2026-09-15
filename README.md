跨 Claude Code、Codex 與 Antigravity 的 AI 開發工作流框架。

## 一、專案介紹

這個專案的核心目標，是在維持 AI 思考最大彈性的前提下，適度設計必要的流程與規範，並在「簡單任務快速完成」與「複雜任務維持嚴謹品質控管」之間取得平衡。

### 設計取向

大型 workflow framework 處理複雜任務時很完整，但面對小型或單純任務，容易產生過多角色、檢查與文件，增加 token 與時間成本。本專案的取向是：

- 流程依照任務的風險與實際影響範圍組合，不固定套用。
- 共用規則集中管理，Claude Code、Codex 與 Antigravity 讀同一份 canonical source。
- 流程規劃、角色檢查、記憶管理與驗證能力整合成可重複使用的 runtime。
- 保留複雜任務所需的品質控管，同時讓簡單任務維持輕量。

### clean-comments

`clean-comments` 是必裝 skill。一般開發期間只需遵守 `AGENTS.md` 的短註解規則；Claude 不再於每次 `Edit|Write` 前呼叫 LLM hook。任務準備結束時，Claude 的 `Stop` agent gate 會重新讀取 `clean-comments/SKILL.md`，檢查本次 staged、unstaged 與新增未追蹤程式碼檔案的 diff，只驗證本次新增或修改的註解。若發現違規，會阻止任務結束並回傳檔案位置、規則、原因與建議改寫，讓主 Claude 修正後再次進入 Stop gate。

這個設計把高頻、容易誤擋的 per-edit 檢查改成任務級最終驗證，降低 token 與延遲，同時保留交付前的合規保證。新增／重寫多行註解、public/doc comments、高風險判斷依據或 review 發現 comment pollution 時，仍可在開發途中主動讀取完整 skill。

## 二、功能介紹

### 框架特色

本框架採用條件式組合 workflow，所有流程、skills 與角色都會依據實際任務情境選擇性載入，而不是固定套用完整 pipeline。同時，框架採用漸進式載入方式，會根據每次任務的性質選擇適合的流程，並依當下情境決定需要讀取的文件深度，在維持輸出品質的前提下，盡可能減少 token 浪費與執行時間。透過這種設計，流程能保有最大的彈性與靈活度，既能讓簡單任務維持輕量，也能在複雜或高風險任務中提供足夠的規劃、角色分工與品質控管。

### 任務分流與條件式 Workflow

任務處理遵循精確的分流原則：

是否進入 workflow 由 `managed_change` 決定，不是「有沒有改到程式碼」的 `code_change`：`managed_change` 判準是這次修改是否可能改變系統實際行為、資料、契約、安全性、部署或執行結果，因此 CI/CD、Dockerfile、migration script 等非 application source code 的高風險修改一樣要走 workflow。

1. **Managed change**：`managed_change: true` 時建立 task，runtime 一次編譯 plan 與 procedure pointers；capability 由 policy 與任務脈絡決定。
2. **Test-only change**：新增測試、強化 assertion 或安全 test refactor 可 `managed_change: false` 直接 bypass；刪除／skip 測試、弱化 assertion 或大量重寫 snapshot／fixture baseline 時改為 `managed_change: true`，並加入 `test_integrity` risk flag。
3. **Non-application-source change**：純文件、註解、read-only 分析通常 bypass；CI/CD、Dockerfile、nginx、migration、deploy script、Terraform 等設定或 script 依是否會影響部署、執行、資料或交付結果判斷。
4. **唯讀任務**：一般的唯讀問答、分析與 review 屬於 unmanaged，不建立 task，host 直接選用唯讀 reader agent，不啟動具寫入權限的 implementation worker。只有本來就存在 task record 的唯讀或 orchestration 情境才使用 `task_type: read_only`；探索深度仍由 compiled plan 的 `exploration_profile` 決定，不假設各 AI 平台都能遵守自訂模型分級。

流程沒有固定的完整 pipeline。runtime 依 task metadata、`workflow_facts` 與 policy 編譯 `required`、`requested`、`selected`、步驟順序與 procedure pointers；`workflow_request` 只能增加檢查，不能移除 required。所有 managed task 都需要 `delivery_validation.DV1` runtime receipt；高風險 capability 仍各自保留。高信心、單檔、局部行為且無高風險 flag 的修改維持 focused exploration，直接走 `implementation -> focused feedback`；低信心、影響面擴大、契約／資料／schema／不可逆、跨模組或含多個獨立行為的情境才使用 expanded exploration，依序拆成具備 goal、scope、acceptance、local verification command、dependencies 的 slices，每個 slice 先取得局部回饋，依賴 slice 才能開始。所有 slices 穩定後才做 affected／regression、Reviewer 與 DV1；不對每個 slice 增加人工核准或第二位 Reviewer。Slices 是 coordinator 的工作流程，不新增 `task.json`／ExecutionPacket authority 或新的 slice state，也不啟用 automatic orchestration。selected evidence 與 Reviewer 共用一份 impact map，同一個驗證命令可用多個 `--requirement-id` 一次記錄。需求未明時先用 `planning` 釐清；Freeze-required flags 仍依 task schema 的確認規則處理。

Project docs 也採條件式載入：單純 `code_change: true` 不會自動加入 project-doc procedure；只有 module+、shared behavior、contract、data/schema、expanded exploration 或其他相關高影響邊界才做 Lookup／讀取／Remember。高信心的 file-local `local_behavior` 修改直接依程式與測試處理。

建立 managed task 後先執行一次 `agent-workflow preflight --task-path <path> --repo-root <repo>`，集中檢查 Node、Git worktree、task intent、lease、依賴與平台 shell。實作期間依 focused 或 expanded 路徑提供局部回饋；待程式碼、測試、文件與 Review 穩定後，再執行一次最終回歸並批次記錄 runtime evidence。最後一次交付變更會使舊 receipt 失效，必須重新執行；內容、命令、環境與驗證範圍都沒有改變時則重用仍有效的 evidence，不為了流程節點重跑相同檢查。

`workflow_request` 的 capability 名稱以 `schemas/workflow-policy.json` 為唯一來源。未知名稱、重複項目或無效的 `workflow_facts` 會讓 `workflow-plan` 以非零狀態結束，不會靜默產生空 plan。

本機驗證用 `node scripts/run-tests.mjs --profile <focused|affected|regression|full>`：`focused` 與 `affected` 要明列測試路徑，`regression` 可指定 subsystem 或省略路徑跑完整 regression set，`full` 固定跑全部 `tests-node/**/*.test.mjs` 且拒絕混入路徑。CI 仍使用 full profile；runtime evidence 應記錄實際使用的 profile 與路徑。

### Review 與角色化品質檢查

- **Review**：檢查影響範圍、架構一致性、程式碼品質、相容性與失敗情境，並從 real entrypoint 確認完成條件。預設由主對話完成基本自我檢查；當 `reviewer` capability 被 `required`（高 blast radius 或高風險分類）或被 `workflow_request` 加選時，另外啟動一個獨立唯讀 Reviewer，由主對話整合 finding。Runtime contract 只認得 `role.reviewer` 一種身份，不存在第二位 reviewer——需要對抗式複查時，把要推翻的假設寫進同一位 reviewer 的指令，修正後重跑同一個 capability。
- **Worker**：僅用於 host-native／manual isolated parallel development 的 implementation role；Worker 只執行 coordinator 提供的 ExecutionPacket，不自行重新選 capability 或 workflow。
- **Reader**：專案唯讀檢查角色，僅用於讀取、分析與審查，不可修改檔案或 repository 狀態。

### 平行開發

目前 automatic orchestration runtime 仍是 Experimental phase tracker，尚未提供正式的 worker dispatch、worktree creation、patch collect／apply 或 multi-worker completion protocol。
