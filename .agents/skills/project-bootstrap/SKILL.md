---
name: project-bootstrap
description: "專案沒有入口規則或開發規範文件，或現有規範與實際架構不符時使用；先分析架構與慣例，有阻擋性決策才詢問，否則直接建立與驗證文件。"
---

# Project Bootstrap

## 1. 探索與審查（先唯讀）

- 先讀目標 repo 的入口規則、README、目錄、建置設定、現有 docs、Formatter／Linter／CI；以有代表性的入口、模組及測試判斷既有慣例。已讀過且未改變的資料不重讀。
- 有現有架構時，依 [architecture-review](../architecture-review/SKILL.md) 區分靜態事實、假設與實際驗證；不要因為偏好某種架構就要求改寫。需要比較模組邊界時才讀 [codebase-design](../codebase-design/SKILL.md)。
- 空白專案只根據已確認的語言、框架、需求與部署條件提出可支援的規範；無證據的細節列為未確認，不虛構既有實作。
- 檢查是否已有相同用途的規則；保留合理的原有慣例，避免新增第二份 authority。

## 2. 決策閘門

將發現分類為：
- **blocking**：互相衝突的核心契約、無法判定的正式架構，或缺少會直接決定規範內容的必要選擇。提出檔案／symbol 證據、影響、最小建議與替代方案，等待使用者決定受影響部分。
- **improvement**：有證據的非阻擋性改善；記錄建議，直接沿用現有合理慣例建立文件。
- **informational**：可選偏好；不阻擋初始化。

不把尚未全面檢查、單純缺少文件、或與個人偏好不同視為 blocking。沒有 blocking 時直接進入文件建立，不要求額外核准。

## 3. 建立或補齊契約

- 使用 [project-docs](../project-docs/SKILL.md) 的單一文件來源及 [doc-types](../project-docs/references/doc-types.md) 的既有 docs 佈局、frontmatter、covers 與索引；優先建立或補齊 `docs/architecture.md`、`docs/structure.md`。
- 依已確認事實按需補充模組、流程、API、decision 文件；不要批次建立空白範本。Decision 文件僅在符合 doc-types 的三項條件時建立。
- **編碼一致性必須落成可讀的規範**：從實際程式萃取專案特有的命名、錯誤處理、logging、分層依賴、測試命名與 mock 慣例。簡短的放入 `docs/structure.md` 的 `## Placement rules`，架構依賴放入 `docs/architecture.md`；驗證指令放入精簡的 `AGENTS.md`。不得重述 gofmt／ESLint 等工具已強制的通用規則。
- **文件數量預算**：初次初始化以 `AGENTS.md`、`docs/architecture.md`、`docs/structure.md` 為預設上限；有明確且無法在這三份中清楚表達的獨立主題，才依既有 doc_type 判準增加文件。不要因每個 module／handler／API 都存在就批次建立文件；公開 API 仍依 project-docs 的新增或修改端點規則處理。
- `coding-standards.md`、`testing-standards.md`、`patterns/` 不是目前 project-docs 支援的 doc_type；**不得直接新增未被 Lookup／Check 支援的檔案**。只有當專案規範確實超出現有文件責任，且已同步擴充 doc_type、Schema、Lookup、Check 與測試後，才能拆出這些文件。範例實作優先引用既有程式路徑，不複製大段程式碼。
- 每一條規範需能回答「何時適用、要求什麼、如何檢查」；不確定或只出現一次的偶然寫法不得升級為強制規則。
- 專案根目錄已有 `AGENTS.md` 時只增補必要的精簡 pointer；沒有時建立精簡入口，指向適用的專案文件及可執行檢查，不複製全域 agent-workflow 規則。
- 命名、錯誤處理、分層與測試慣例應引用實際程式或明確核准的決策；無足夠證據的項目標記 `Unverified`。
- 現有文件仍正確時不改寫；已存在但互相衝突的文件先依決策閘門處理。
- 不修改業務程式碼；不為建立文件而新增抽象層、範例 CRUD 或無依據的 Pattern。
- 只在使用者要求且現有專案確有對應工具時，補上適當 Formatter、Linter 或 CI；任何可能改變 verification integrity 的設定修改都遵守全域 `AGENTS.md` 的 managed_change 入口與規格確認流程。

## 4. 驗證與交付

- 驗證文件連結、doc_type／covers、重複權威來源與文件所述架構是否與已查證程式相符；可用時執行 `agent-workflow project-doc --action Check --doc <path>`。
- 規範文件需能由既有 `project-doc Lookup`／`task-init --paths` 依路徑找到；不得另外建立 context discovery、task state、memory 或 review 機制。
- 重跑時先比對現有文件，只新增缺口或修正失準內容；保留使用者修改。已確認的長期決策依 [learn](../learn/SKILL.md) 的分流保存，不另造記憶庫。
- 回報掃描範圍、blocking／improvement、建立或更新的檔案、實際執行的驗證與未驗證部分；沒有變更時明確回報 no-op。
