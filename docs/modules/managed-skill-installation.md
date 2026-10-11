---
doc_type: module
covers:
  - adapters/managed-manifest.json
  - adapters/codex/
  - src/installer.ts
  - tests-node/installer.test.mjs
  - tests-node/skills.test.mjs
  - tests-node/claude-delegation.test.mjs
  - tests-node/entrypoint-content.test.mjs
  - tests-node/platform-isolation.test.mjs
  - adapters/claude/delegation.md
  - README.md
  - .agents/skills/implementation-spec/
---

# Managed skill installation

## Responsibility

安裝器依 managed manifest 選取 repo 內的技能，實體只放在 `~/.agents/skills/<name>`；各平台技能目錄以逐技能 Junction（Windows）或 symlink（其他系統）指向該實體。上游框架另見 [upstream integrations](upstream-integrations.md)。

## Entrypoints

`install` 與 `repair` 共用 `src/installer.ts` 的安裝流程。入口檔由 repo 的 `AGENTS.md` 產生：帶 `<!-- repo-only -->` 的行與指向未安裝 skill 的 `<!-- skill:<name> -->` 行不寫入，`.agents/` 連結改寫成 `~/.agents/`，在任何專案都解析得到。`required: true` 的技能自動加入選取清單，不受 `--skills` 省略影響。

產生的內容寫入 `~/.agents/AGENTS.md`、Codex 的 `AGENTS.md` 與 Antigravity 的 `GEMINI.md`。Claude 的 `CLAUDE.md` 支援引入語法，managed 區塊只有兩行：`@~/.agents/AGENTS.md` 引入共用入口，`@agent-workflow/delegation.md` 引入 Claude 專屬派工規則。

平台專屬的指示放在 `adapters/<platform>/`。`adapters/claude/delegation.md` 只在選取 Claude 時安裝到 `<Claude 根目錄>/agent-workflow/delegation.md`；Claude 原生角色的設定維持共用 manifest。Codex 的設定 authority 是 [Codex adapter 設定](../../adapters/codex/managed-config.json)，只在選取 Codex 時讀取。

Codex 的入口另在同一個受管區塊內追加專用設定所指定的 coordinator 來源。[Codex coordinator 指示](../../adapters/codex/coordinator.md) 是委派、平行條件及當次原生模型選擇的 authority；共用 `~/.agents/AGENTS.md` 與 Antigravity 入口維持共用內容；Claude 維持共用入口與專屬規則的引入方式。各入口各自保留區塊外的使用者文字。

Codex 指示透過既有 task runtime 登錄拆分評估與原生狀態快照；此 gate 的紀錄與信任邊界見 [Workflow runtime](workflow-runtime.md#codex-coordinator-gate)。安裝產物與 Verify 不會自行證明一次任務真的平行執行。

## Flow

- `skills.<name>.platforms` 是可選的非空平台清單，值為 `Claude`、`Codex`、`Antigravity`；省略時適用所有平台。無效清單使安裝失敗，避免錯誤設定被當成全平台安裝。
- 選取的技能保存於 canonical `~/.agents/skills`；建立平台連結時套用清單，不連結整個 skills 根目錄。
- implementation-spec 必裝且未設定 `platforms`，因此適用 Claude Code、Codex 與 Antigravity 全平台。
- `retired_skills` 列出的技能不進入 catalog 或既有技能匯入流程；目前退役 `adhd-comms`、`humanizer` 與 `doc-coauthoring`，明確指定其名稱時依未知技能處理。
- Repair／Install 只處理選取平台：舊連結須符合前次納管路徑、目標及雜湊，且 canonical 完整內容未改動才移除；舊普通副本須所有檔案與目錄皆符合紀錄，才搬到 migrations 備份。canonical 實體保留供回復。使用者修改、額外內容、錯誤目標或未知來源保留，不重新匯入，輸出的 `retired_skills` 以 `preserved` 回報；dry-run 只回報 `planned`，未選取平台維持原狀。
- 寫入前檢查所有選取平台：技能根目錄與共用技能必須是普通目錄；拒絕指向其他目標的既有連結、巢狀連結與不同內容的非 catalog 技能。
- 選取平台內既有的有效技能（根目錄有 `SKILL.md` 且名稱合法）也轉為共用實體連結。已安裝的 catalog 技能以 repo 更新 canonical；這不會額外將未選取的 optional 技能加入其他平台。非 catalog 技能合併缺少的檔案，不覆寫既有檔案；同一路徑內容不同時失敗並保留原狀。`.system` 與 plugin cache 不在這個流程內。
- 普通平台目錄先改名保存到 state 的 `migrations/skills-<timestamp>-<pid>/<platform>/<name>`，再建立連結；連結建立失敗會還原原目錄，不退回副本。跨磁碟改名不支援時保留原目錄並失敗。
- repo 是 catalog 技能的更新來源；canonical 內容不同時先完整備份到同一批次的 `canonical/<name>`。既有額外檔案保留。來源已刪除的檔案在更新該技能時處理：雜湊與紀錄相同就從 canonical 移除，並移除因此變空的子目錄；使用者改過的保留為額外檔案；已不存在的不做檔案操作。三種情況的紀錄都從 managed state 移除；雜湊相同卻刪除失敗的檔案保留紀錄，下次安裝再試。回復時先停止安裝器操作，移除平台連結再將備份目錄搬回原路徑；需回復共用版本時使用 canonical 備份。

### Native agents

共用 manifest 的 `agents` 供 Claude 產生角色；Codex 使用專用設定內的 `agents`。角色內容預設取 `.agents/agents/<name>.md`，`source` 指定其他 body，`agents.<name>.instructions_source` 追加補充；Codex 的自訂來源與 coordinator 必須是 `adapters/codex/` 內的普通檔案。可選的 `platforms` 是非空原生平台清單，Codex 設定僅接受 Codex；缺少來源、越界路徑、無效平台或無法嵌入 TOML 的內容在任何安裝寫入之前失敗。未選取的平台設定不讀取，因此缺少或損壞 Codex 設定不影響 Claude 安裝。

共用角色 body 仍供各平台使用；Codex 的角色來源與補充由專用 adapter 擁有。Claude 的角色 body、tools、model、effort 維持共用 manifest 設定；Antigravity 不生成原生角色。

Codex 原生角色檔只產生於 `~/.codex/agents/`，由平台自動發現；模型與 effort 規則見專用 adapter authority。npm package 保留 `adapters/codex/` 原始來源，共用 runtime 不保存該子樹或專屬設定；Install／Repair 從 repo 或 `managed-runtime.json` 記錄的 package／repo 來源讀取，來源缺失時明確失敗。Verify 檢查已產生的受管檔案與雜湊。

## Shared state

managed-runtime.json 的 selected_skills 記錄 repo 選取結果，不代表每個平台皆有安裝；files 保存實體檔案雜湊與 `platform-skill-link` 紀錄（path、target、target 路徑雜湊）。單平台 Repair 保留其他平台的紀錄；Verify 同時檢查連結身分與共用檔案內容。既有 file 紀錄仍可讀，完成全平台 Repair 才會轉完所有平台。

原生角色以 `platform-agent` 保存整份產物雜湊；Codex 入口以 `platform-entrypoint` 只保存受管區塊雜湊，Verify 檢查專用指示而容許使用者修改區塊外的文字。單平台 Repair 保留其他平台紀錄；來源或平台限制使角色不再適用時，只清除選取平台上雜湊未變的 managed 角色檔。

## Invariants and gotchas

- Repair 僅移除不再適用且仍指向預期 canonical 的 managed 連結；不透過 Junction 刪除檔案。舊普通副本只清除雜湊未變的 managed 檔案，保留使用者修改及未納管檔案。
- 來源已刪除檔案的清理只套用在本次有重新寫入的 canonical 技能（選取的技能與選取平台上已存在的 catalog 技能）；本次未重新寫入的技能（退役技能，以及未選取且不在選取平台上的技能）其 canonical 實體與紀錄維持原狀，供回復與其他平台的退役判斷使用。
- Uninstall 保留 canonical 技能實體與 migrations 備份，僅移除仍屬預期目標的 managed 平台連結。錯誤目標、使用者替換的目錄或未知連結保留。
- Claude 的共用規則來自引入，`~/.agents/AGENTS.md` 不存在時 Claude 讀不到共用規則。Uninstall 保留各平台入口檔，也保留 `CLAUDE.md` 引入的 `delegation.md`；Verify 以雜湊檢查這份檔案。
- Claude 專屬內容不放進 `AGENTS.md`、`.agents/` 或 `.agents/rules/`：前兩者會安裝到所有平台，後者是 Antigravity 的 workspace 規則目錄。`tests-node/claude-delegation.test.mjs` 檢查其他平台的安裝內容不含派工規則。`adapters/<platform>/` 底下的平台指示 Markdown 不複製進各平台共用的 runtime 目錄，各自只存在自己的平台根目錄（Claude 的派工規則在 Claude 根目錄，Codex 的 coordinator 與 agent 指示在 Codex 根目錄）；`tests-node/platform-isolation.test.mjs` 檢查這點。Codex adapter 的所有檔案（含設定與 hook template）亦不複製至 shared runtime；hooks 仍從安裝來源產生於 Codex 根目錄。
- 每個入口檔在 managed 區塊以外保有自己的內容，Install 與 Repair 只替換區塊本身。內容不會在入口檔之間複製，也不會寫進 `~/.agents/AGENTS.md`，所以寫在某個平台入口檔的專屬規則只留在該平台。`~/.agents/AGENTS.md` 區塊以外的內容只會經由引入到達 Claude。之後才安裝的平台，入口檔一開始只有 managed 區塊。`delegation.md` 每次安裝都以來源覆寫，直接修改已安裝的檔案不會保留。`tests-node/entrypoint-content.test.mjs` 檢查這些行為。
- Codex 入口的 Uninstall 僅移除與紀錄雜湊一致的受管區塊，保留使用者文字與入口檔；被使用者修改的區塊整段保留。其他平台入口沿用既有生命週期。
- 變更 Codex target 時，Repair 只移除舊入口中雜湊未變的受管區塊；區塊外文字保留，被修改的舊區塊保留為使用者內容並解除納管。移除失敗時安裝失敗，不更新 target 與 managed state，供下次 Repair 重試。
- dry-run 會執行前置檢查，不更新 runtime、canonical、備份、連結或 managed state。
- 路徑邊界以實際根目錄身分檢查，Windows 忽略大小寫。變更平台 target 時清理舊 target 仍屬 managed 的連結與檔案，保留其他平台紀錄；使用者修改仍保留。
- installer 是循序更新，沒有新增跨程序鎖；安裝期間請勿同時執行其他技能安裝器。每個目錄遷移可重跑，備份保留，整批安裝不是檔案系統交易。

## Verification

`node scripts/run-tests.mjs --profile affected tests-node/installer.test.mjs tests-node/skills.test.mjs tests-node/migration.test.mjs tests-node/contract.test.mjs` 驗證隔離安裝、遷移、連結與相關契約，不代表使用者實際環境已 Repair。

## Unverified

隔離安裝測試只檢查 `CLAUDE.md` 的引入行與檔案位置，不證明 Claude Code 實際載入了被引入的檔案；需在實機開新 session 確認。派工時對內建 agent 指定的 `model` 與 `effort` 是否生效，以及 subagent 讀到派工規則後是否照規則不再轉派，同樣只能在實機觀察。原生平台是否在目前 session 重新載入技能，需由該平台確認；本機連結與 runtime 檢查不證明原生平台已載入。plugin cache 的版本與生命週期維持由原生平台管理。

這是來源位置與一般安裝／載入範圍的隔離，不是作業系統讀取權限；其他 agent 若明確讀取 repo，仍可讀到 `adapters/codex/`。

隔離安裝測試與 Verify 只能證明產物、來源與受管紀錄一致。角色自動發現、實際 spawn 接受選出的模型／effort、委派及獨立審查行為，需在目標 Codex consumer 另行驗證。
