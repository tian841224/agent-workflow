# 使用指南

[回到首頁](../README.md)

### 一個 managed task 如何完成

```text
使用者提出需求
  |
  +-- 不影響行為或驗證完整性 --> 直接處理
  |
  +-- managed change
        |
        v
      目標與方向（不明確時先問答，由使用者確認）
        |
        v
      +-- 開發任務 --> Plan mode --> implementation-spec 產出規格
      |                               （做什麼、動哪裡、怎麼驗）
      |                                 |
      |                               使用者確認 --> 保存 task.md
      |
      +-- 其餘任務 --> task.md 寫明目標、範圍與完成條件
        |
        v
      task-init --paths --> 計畫、readiness、相關文件／記憶／歷程、next
        |
        跨模組或涉及契約、資料的開發任務 --> 把規格展開到可直接實作
        |
        主 agent 自己實作，互不相依的讀取與指令在同一回合平行送出；
        符合 Subagent 段落的工作才派原生 subagent
        |
        +-- focused  --> 無可獨立工作包時，直接走 `implementation -> focused feedback`
        |
        +-- expanded --> 依序完成切片，每片先取得局部回饋
        |               （獨立工作可交給原生 subagent，相依工作維持循序）
        v
      交付內容穩定 --> 逐條執行驗收案例（evidence-run），失敗就修正重跑
        |
        v
      獨立 Reviewer --> 有問題：修正 --> 重跑驗收 --> 只審變動範圍
        |               確認的問題做 root-cause，補上測試／文件／規範
        v
      close-task 檢查完成條件並結案；過程中的決策與更正交給 learn
```

task.md 的驗收案例寫法：

```markdown
### Acceptance cases

- **AC1** 有效帳密登入成功
  - Given 使用者輸入有效的電子郵件與密碼
  - When 點擊登入按鈕
  - Then 系統回傳有效的 JWT 並導向首頁
  - Verify: `npx playwright test e2e/login.spec.ts -g AC1`
```

### 派原生 subagent 平行實作

何時派 subagent 只看 [AGENTS.md](../AGENTS.md) 的「Subagent」段落；其餘工作由主對話自己完成，避免交接遺失細節。需要派 worker 平行實作時，Agent 依任務及平台能力決定工作切分、worker 數量與隔離方式，直接指派目標、責任範圍與驗收條件，不需先執行固定的 orchestration 流程，平行開發的責任分配見 [workflow](../.agents/skills/workflow/SKILL.md)。

Worker 只修改指派範圍，保留其他人的修改，回報實際驗證結果與 blocker。主 agent 整合後執行 task 的全部驗收案例與 proofs，再依 plan 完成 Reviewer 與結案；worker 的局部驗證不能取代整體證據。沒有可用原生 subagent 的平台採循序執行。

Protocol 3 runtime CLI 與 state 是選用介面；指派原生 subagent 不以它們為前置條件。

### 記憶如何累積

```text
使用者的決策、更正、可重用結論
        |
        v
      learn（分類：kind + tags + paths）
        |
        +-- 專案決策、商業規則 --> 專案 docs/（decision 文件或對應的模組文件）
        |
        +-- 個人偏好、agent 行為更正、專案 pitfall --> ~/.agent-workflow 共用記憶
                                                        |
下一次修改相關路徑：task-init --paths <----------------+
                    帶出相關文件、記憶與已結案 task 的歷程

反覆出現的更正 --> distill --> 待審 skill／規則草稿 --> 使用者核准後才生效
```

### 原生 agent

| Agent | 用途 |
| --- | --- |
| [worker](../.agents/agents/worker.md) | 接受主 agent 直接指派的目標與檔案範圍，完成驗收並回報修改、結果與 blocker |
| [reader](../.agents/agents/reader.md) | 唯讀的程式查詢與彙整，只安裝到 Codex；Claude 改用內建的 Explore |

