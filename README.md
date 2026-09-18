# agent-workflow

**讓 AI 依任務風險選擇流程，並以實際驗證證據完成交付。**

agent-workflow 是共用於 **Claude Code、Codex、Antigravity** 的 AI 開發工作流框架。它把任務分流、skills、角色分工、驗證、記憶與平台 hooks 整合成同一套規則與 Node.js runtime，讓小修改維持直接，複雜修改則具備足夠的規劃與品質檢查。

你可以繼續用自然語言向 AI 提出需求；agent 依情境載入指引，runtime 負責管理任務狀態與檢查已宣告的完成條件。

## 目錄

- [核心概念](#核心概念)
- [主要功能](#主要功能)
- [快速安裝](#快速安裝)
- [Skills 一覽](#skills-一覽)
- [專案架構與主要元件](#專案架構與主要元件)
- [資料夾結構](#資料夾結構)
- [專案演進](#專案演進)

## 核心概念

1. **依影響與風險組合流程**
2. **只在需要時載入細節**
3. **用可驗證的紀錄判定完成**
4. **共用規則，平台各自轉接**



## 主要功能

| 功能 | 實際用途 |
| --- | --- |
| 任務分流與計畫編譯 | 依影響範圍、風險與信心選取能力、步驟和文件指引 |
| 任務生命週期 | 管理建立、暫停、阻塞、恢復與結案，保留狀態變更紀錄 |
| 驗證與 freshness 檢查 | 記錄命令、工作目錄、exit code、輸出摘要與交付指紋，拒絕過期或失敗的 evidence |
| 條件式 Review | 一般任務由主對話自我檢查；policy 要求或加選時，由獨立唯讀 Reviewer 審查 |
| 隔離工作分工 | 由主對話分派 ExecutionPacket 給 Worker，在指定 worktree 與範圍實作，再統一整合 |
| 專案文件查詢 | 依受影響路徑尋找文件，追蹤讀取內容是否仍有效 |
| 跨平台記憶 | 查詢共用 knowledge，唯讀搜尋平台原生記憶，依任務相關性提供線索 |
| 學習與提煉 | 保存使用者要求或確認的可重用結論，將反覆出現的模式整理為待審 skill 草稿 |

### 一個 managed task 如何完成

```text
使用者提出需求
  |
  +-- 不影響行為或驗證完整性 --> 直接處理
  |
  +-- managed change
        |
        v
      目標與分類 --> task-init 回傳計畫與 readiness
        |
        +-- focused  --> 直接走 `implementation -> focused feedback`
        |
        +-- expanded --> 依序完成切片，每片先取得局部回饋
        |
        v
      交付內容穩定 --> 最終驗證與 evidence
        |
        v
      Review（依計畫需要啟動獨立 Reviewer）
        |
        v
      close-task 檢查完成條件並結案
```

### 多 sub-agent 平行開發

主對話是 coordinator。只有兩個以上工作包值得平行、且彼此沒有順序相依、ownership 不重疊、不共寫 persistent state 時，才由 runtime 建立 dirty-worktree snapshot、detached worktree 與各 worker 的 ExecutionPacket，交給平台原生 worker 執行；收件、整合與套用以 artifact digest、衝突檢查與 parent fingerprint 保護交付。套用後回到同一條 parent 結案流程。操作契約見 [parallel orchestration](.agents/skills/workflow/orchestration.md)。



### 記憶如何累積

```text
使用者要求或確認的結論 --> learn --> 共用 knowledge
                                         |
                         反覆出現的模式 --> distill
                                         |
                                         v
                                   待審 skill 草稿
                                         |
                                   使用者明確核准
                                         |
                                         v
                                      Promote
```



## 快速安裝

### 需求

- Node.js **20 以上**與 npm。
- Git，用於取得原始碼與開發任務的版本控制檢查。
- 已安裝要使用的 Claude Code、Codex 或 Antigravity。

### 安裝步驟

1. 安裝相依套件並建置：

   ```powershell
   npm install
   npm run build
   ```

2. 執行安裝，依提示選擇 skills：

   ```powershell
   npm run setup
   ```

   若只使用 Codex，改執行：

   ```powershell
   npm run setup -- --target-agent Codex
   ```

## Skills 一覽

Skill 是依情境讀取的工作指引。**必裝代表安裝時一定納入，不代表每次任務都讀取全文。** 安裝分類以 [managed manifest](adapters/managed-manifest.json) 為準。

### 核心 skills（必裝）

| Skill | 何時使用 |
| --- | --- |
| [workflow](.agents/skills/workflow/SKILL.md) | 分流 managed change，依 compiled plan 執行與結案 |
| [planning](.agents/skills/planning/SKILL.md) | 釐清架構方向、重要取捨或真正模糊的需求 |
| [grill-me](.agents/skills/grill-me/SKILL.md) | 使用者要求深入提問，或需釐清高風險假設 |
| [codebase-design](.agents/skills/codebase-design/SKILL.md) | 設計模組介面、責任邊界、seam 與 adapter |
| [tdd](.agents/skills/tdd/SKILL.md) | 計畫選取 TDD 時，執行 red → green → refactor |
| [learn](.agents/skills/learn/SKILL.md) | 保存使用者要求或確認的可重用結論 |
| [clean-comments](.agents/skills/clean-comments/SKILL.md) | 撰寫多行、公開合約或需要解釋判斷依據的註解 |
| [localization-tw](.agents/skills/localization-tw/SKILL.md) | 所有中文回覆的臺灣繁體中文規則；翻譯與術語按需查閱 references |
| [writing-for-agents](.agents/skills/writing-for-agents/SKILL.md) | 編寫 `.agents/` 角色或 skill 指引，維持清楚的入口與分層揭露 |

### 依需求選用

| Skill | 何時使用 |
| --- | --- |
| [architecture-review](.agents/skills/architecture-review/SKILL.md) | 審查跨層耦合、責任失衡、契約漂移與遷移風險 |
| [diagnosing-bugs](.agents/skills/diagnosing-bugs/SKILL.md) | 診斷原因不明、間歇性或效能問題 |
| [project-docs](.agents/skills/project-docs/SKILL.md) | 計畫要求查詢或更新模組、共用行為、契約與資料相關文件 |
| [operational-verification](.agents/skills/operational-verification/SKILL.md) | 安裝、部署、migration 與外部整合的實際環境驗證 |
| [distill](.agents/skills/distill/SKILL.md) | 從反覆出現的結論或 review 原因提煉改善；草稿核准後才生效 |
| [task-retrospective](.agents/skills/task-retrospective/SKILL.md) | 使用者明確要求分析單次任務的流程、hooks、skills、時間與重試 |
| [adhd-comms](.agents/skills/adhd-comms/SKILL.md) | 讓回覆重點先行、易掃讀，同時保留必要證據 |
| [humanizer](.agents/skills/humanizer/SKILL.md) | 依要求重寫文字，或修正明確的 AI 腔調 |
| [hallmark](.agents/skills/hallmark/SKILL.md) | 明確要求更有辨識度的 UI 設計、設計稽核或重設計 |

另有 repository 內的 [doc-coauthoring](.agents/skills/doc-coauthoring/SKILL.md)，用於規格、提案與較大型文件；它列在 manifest 的 unmanaged_skills 清單，不屬於 installer 的 managed skill catalog。

## 專案架構與主要元件

```text
Claude Code             Codex              Antigravity
     |                    |                     |
     +--------------------+---------------------+
                          |
                  平台 adapters / hooks
                          |
               共用 Node.js runtime / CLI
                          |
          +---------------+----------------+
          |               |                |
     分類與計畫      任務 / 驗證 / 結案    knowledge / memory
          |               |                |
          +---------------+----------------+
                          |
                 schemas / templates

.agents/skills + .agents/agents --> 提供 agent 執行指引
```


## 資料夾結構

```text
~/
|-- .agents/                  安裝後的共用指引與 skills
|-- .claude/                  Claude Code adapter 設定
|-- .codex/                   Codex adapter 設定
|-- .gemini/                  Antigravity adapter 設定
`-- .agent-workflow/          共用 runtime 與可寫資料
    |-- managed-runtime.json 安裝版本、雜湊與 managed files 紀錄
    |-- runtime/             已安裝 bundle、adapters、schemas、templates
    |-- knowledge/           可重用結論
    |-- skill-drafts/        待核准的 skill 草稿
    |-- skills/              已核准的 skills
    |-- review-causes/       Review 歸因紀錄
    |-- projects/
    |   `-- <project-id>/tasks/<task-id>/
    |       |-- task.md      人可讀的目標與完成條件
    |       `-- task.json    Runtime 管理的任務狀態與 evidence
    `-- imports/             外部資料匯入區
```

## 專案演進

**固定角色與多軌流程 → 情境式 skills → 組合式計畫 → runtime 契約與證據 → 保留必要品質、降低重複成本。**

| 版本 | 重大改變 | 重點 | 相較上版本的差異／優化 |
| --- | --- | --- | --- |
| v1 | 建立開發流程與護欄 | 導入角色分工、hooks、規格凍結與 TDD，禁止 agent 自行 commit。 | 從單純依賴 agent 自律，提升為有明確角色、規格與操作邊界的流程；降低未經檢查直接交付的風險。 |
| v2 | 支援跨平台共用 | 從 Claude Code 擴展至 Codex、Antigravity，以 `.agents/` 統一維護共用規則與 skills。 | 從單一平台設定改為 canonical source 加 adapter；規則只需維護一份，減少三平台內容分歧。 |
| v3 | 從固定流程改為按需組合 | 由多軌流程轉向情境式 skills 與組合式計畫，依任務風險選取必要能力與品質步驟。 | 從每個任務套用同一條完整 pipeline，改為小任務少走不必要步驟，複雜任務仍保留必要控管。 |
| v4 | 將流程判定移入 runtime | 由 runtime 管理任務狀態、計畫與完成條件。 | 統一跨平台入口並降低環境差異。 |
| v5 | 明確化任務與驗證契約 | 統一分流入口| 從以文字描述「已完成」改為 task schema 與 runtime receipt；可追蹤誰在何時以哪個工作樹與命令完成驗證，並拒絕 stale evidence。 |
| v5 → v6 | 精簡角色與技能 | Skills 分為必裝與選用，減少固定角色交接，僅在需要時啟動獨立審查。 | 從固定 Reviewer／Verifier／Retrospective 角色改為依計畫啟動責任；降低交接與 token 成本，同時保留高風險任務的獨立審查。 |
| v6 | 累積跨平台記憶 | 加入共用記憶與提煉機制，將可重用結論整理為待審 skill 草稿。 | 從每次任務重新摸索，改為可查詢且有範圍的 knowledge；草稿須經使用者核准才會生效，避免未驗證經驗污染流程。 |
| v7 | 統一驗證並降低重複成本 | 整合 hooks、preflight、最終驗證與結案路徑，保留切片局部回饋，減少重複確認與不必要的文件載入。 | 從多個角色各自重跑檢查，改為共用 impact map、delivery fingerprint 與單一結案 gate；在維持 verification integrity 的前提下縮短 roundtrip。 |
