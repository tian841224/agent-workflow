---
doc_type: module
covers:
  - adapters/managed-manifest.json
  - src/installer.ts
  - tests-node/installer.test.mjs
  - tests-node/skills.test.mjs
  - README.md
  - .agents/skills/implementation-spec/
---

# Managed skill installation

## Responsibility

安裝器依 managed manifest 選取 repo 內的技能，實體只放在 `~/.agents/skills/<name>`；各平台技能目錄以逐技能 Junction（Windows）或 symlink（其他系統）指向該實體。上游框架另見 [upstream integrations](upstream-integrations.md)。

## Entrypoints

`install` 與 `repair` 共用 `src/installer.ts` 的安裝流程。`required: true` 的技能自動加入選取清單，不受 `--skills` 省略影響。

## Flow

- `skills.<name>.platforms` 是可選的非空平台清單，值為 `Claude`、`Codex`、`Antigravity`；省略時適用所有平台。無效清單使安裝失敗，避免錯誤設定被當成全平台安裝。
- 選取的技能保存於 canonical `~/.agents/skills`；建立平台連結時套用清單，不連結整個 skills 根目錄。
- implementation-spec 必裝，平台範圍由 [managed manifest](../../adapters/managed-manifest.json) 指定。
- 寫入前檢查所有選取平台：技能根目錄與共用技能必須是普通目錄；拒絕指向其他目標的既有連結、巢狀連結與不同內容的非 catalog 技能。
- 選取平台內既有的有效技能（根目錄有 `SKILL.md` 且名稱合法）也轉為共用實體連結。已安裝的 catalog 技能以 repo 更新 canonical；這不會額外將未選取的 optional 技能加入其他平台。非 catalog 技能合併缺少的檔案，不覆寫既有檔案；同一路徑內容不同時失敗並保留原狀。`.system` 與 plugin cache 不在這個流程內。
- 普通平台目錄先改名保存到 state 的 `migrations/skills-<timestamp>-<pid>/<platform>/<name>`，再建立連結；連結建立失敗會還原原目錄，不退回副本。跨磁碟改名不支援時保留原目錄並失敗。
- repo 是 catalog 技能的更新來源；canonical 內容不同時先完整備份到同一批次的 `canonical/<name>`。既有額外檔案保留。回復時先停止安裝器操作，移除平台連結再將備份目錄搬回原路徑；需回復共用版本時使用 canonical 備份。

## Shared state

managed-runtime.json 的 selected_skills 記錄 repo 選取結果，不代表每個平台皆有安裝；files 保存實體檔案雜湊與 `platform-skill-link` 紀錄（path、target、target 路徑雜湊）。單平台 Repair 保留其他平台的紀錄；Verify 同時檢查連結身分與共用檔案內容。既有 file 紀錄仍可讀，完成全平台 Repair 才會轉完所有平台。

## Invariants and gotchas

- Repair 僅移除不再適用且仍指向預期 canonical 的 managed 連結；不透過 Junction 刪除檔案。舊普通副本只清除雜湊未變的 managed 檔案，保留使用者修改及未納管檔案。
- Uninstall 保留 canonical 技能實體與 migrations 備份，僅移除仍屬預期目標的 managed 平台連結。錯誤目標、使用者替換的目錄或未知連結保留。
- dry-run 會執行前置檢查，不更新 runtime、canonical、備份、連結或 managed state。
- 路徑邊界以實際根目錄身分檢查，Windows 忽略大小寫。變更平台 target 時清理舊 target 仍屬 managed 的連結與檔案，保留其他平台紀錄；使用者修改仍保留。
- installer 是循序更新，沒有新增跨程序鎖；安裝期間請勿同時執行其他技能安裝器。每個目錄遷移可重跑，備份保留，整批安裝不是檔案系統交易。

## Verification

`node scripts/run-tests.mjs --profile affected tests-node/installer.test.mjs tests-node/skills.test.mjs tests-node/migration.test.mjs tests-node/contract.test.mjs` 驗證隔離安裝、遷移、連結與相關契約，不代表使用者實際環境已 Repair。

## Unverified

原生平台是否在目前 session 重新載入技能，需由該平台確認；本機連結與 runtime 檢查不證明原生平台已載入。plugin cache 的版本與生命週期維持由原生平台管理。
