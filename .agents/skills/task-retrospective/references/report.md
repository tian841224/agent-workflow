# Retrospective report

只在 task 結束或使用者要求輸出分析時讀本檔。

## Full report

```markdown
# Task Retrospective

**task**: <id / goal>
**outcome**: <completed | blocked | failed | abandoned | superseded>
**workflow_version**: <commit/hash/version | unknown>
**platform**: <platform>
**tracking**: <track | analyze-only>
**telemetry_quality**: <complete | partial | limited>
**total_duration**: <value + measured/derived/estimated/unavailable>

## Execution Summary

<實際完成內容、主要決策與最終驗證；不要重寫完整 task report。>

## Time Distribution

<只有有足夠證據時才分 phase。沒有可靠 phase 時間就只保留 total duration。使用者等待時間獨立列出。>

## Hooks

- `<hook>` — invocations=<n> blocked=<n> retries=<n> duration=<value/status>; reasons=<summary>

沒有可靠 hook telemetry 時寫 `unavailable`，不要由印象補數字。

## Skills

- `<skill>` — load=<n> injection=<n> trigger=<reason>; repeated_loads=<n>

`skill_reference` 另外說明，不併入 load count。

## Errors & Retries

<依 root cause 聚合：phase / owner / attempts / recovery / extra cost。沒有則寫 none。>

## Necessary Cost

<列出看似昂貴但由風險、正確性或必要驗證合理要求的成本。>

## Avoidable Friction

<只列有 evidence 的可避免成本。>

## Workflow Findings

### P0
<findings or none>

### P1
<findings or none>

### P2
<findings or none>

每項 finding 使用：

- owner:
- problem:
- evidence:
- occurrences:
- avoidable_cost:
- root_cause:
- recommended_change:
- risk_of_change:
- confidence:

## Recommended Improvements

<依收益／風險排序；先修 root cause。若目前版本已修正某歷史問題，要明確標記 resolved/stale，而不是再次提出。>
```

`telemetry_quality`：

- `complete`：主要 hook/skill/event/count/duration 有直接 telemetry 或 runtime receipt。
- `partial`：核心流程可還原，但部分次數或 duration 缺失；緊接著列 `missing`。
- `limited`：主要依 transcript 或事後推導，只能做定性分析。

## Compact report

只有同時符合以下條件才使用：沒有 error、沒有 retry、沒有 hook block、沒有重複 skill load、沒有 workflow finding。

```text
outcome: completed
telemetry_quality: <complete | partial | limited>
duration: <value/status>
hooks: <name=count | unavailable>
skills: <name=count | unavailable>
errors: 0
retries: 0
workflow_findings: none
```
