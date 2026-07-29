<!-- managed by agent-workflow v3 — 整檔覆蓋，勿直接編輯 -->

# WORKFLOW.md — v3 起已拆分（本檔僅保留章節對照）

依 Claude 5 世代 context engineering 原則，流程總控自 v3 起改為「常駐核心＋漸進式披露」：常駐層（AGENTS.md，即各平台 CLAUDE.md/AGENTS.md/GEMINI.md 入口）只留判軌摘要與硬護欄，細節下放 `skills/workflow/` 按需載入。舊條文的權威位置對照如下——文件中出現「WORKFLOW.md §n」引用時依此表查找：

| 舊章節 | 新位置 |
|---|---|
| 前言（角色總覽、模型固定表） | AGENTS.md 前言；模型表寫死於各 `agents/*.md` frontmatter `model:` |
| §0 適用範圍 gate | AGENTS.md「適用範圍」 |
| §0.1 角色專屬交接 prompt | `skills/workflow/handoff.md` |
| §1 流程分級（判軌判準、附加 gate、升降軌） | AGENTS.md「判軌」摘要；細則在 `skills/workflow/SKILL.md` |
| §2 輕軌 L1–L4 | `skills/workflow/light.md` |
| §3 標準軌 M1–M4 | `skills/workflow/standard.md` |
| §4 重軌 R1–R6（含 R3 平行護欄） | `skills/workflow/heavy.md` |
| §5 回合上限 | `skills/workflow/SKILL.md`「回合上限」 |
| §6 凍結原則 | `skills/workflow/heavy.md`「凍結原則」（mini-spec 適用同一套） |
| §7 版本控制紀律 | AGENTS.md「硬護欄」第 1 條 |
| §8 中斷續作 | `skills/workflow/SKILL.md`「中斷續作」 |
| §9 know-how 沉澱（沉澱三問、專案記憶層結構） | AGENTS.md「記憶與沉澱」＋ `skills/workflow/SKILL.md`「收尾」；記憶層結構見 `rules/learning.md` |
| §10 專案層擴充 | AGENTS.md「風格」段（專案內容寫在專案層） |
| §11 Hooks 對應行為 | `skills/workflow/SKILL.md`「平台差異」 |

acceptance 文件格式規約不變：見同目錄 `acceptance-spec.md` 與 `templates/`。
