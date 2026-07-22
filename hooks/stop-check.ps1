# managed by claude-workflow v2 — Stop hook: 驗收缺件提醒
# session 結束時, 依 cwd 換算 project-slug, 掃該專案 acceptance 目錄:
# 重軌任務（有 checklist.md）：spec.md 缺失或未凍結（仍是 draft）、checklist.md 有未勾條目、
#   plan.md 有未勾階段 → decision=block 提醒補齊或標記 paused。
# 標準軌任務（只有 mini-spec.md，無 checklist.md）：mini-spec.md 未凍結（仍是 draft）、
#   有未勾條目 → decision=block 提醒補齊或標記 paused。mini-spec 任務不檢查 spec.md/plan.md
#   （M 軌本來就沒有這兩份文件）。
# stop_hook_active=true 一律放行 (防迴圈)。含 <!-- paused --> 的任務跳過。解析失敗 → exit 0。

$ErrorActionPreference = 'Stop'
try {
    $raw = [Console]::In.ReadToEnd()
    $payload = $raw | ConvertFrom-Json
    if ($payload.stop_hook_active) { exit 0 }
    $cwd = $payload.cwd
    if (-not $cwd) { exit 0 }

    # cwd → project-slug (Claude Code 慣例: 冒號與斜線轉連字號)
    $slug = ($cwd -replace '[:\\/]', '-')
$workflowHome = if ($env:AI_WORKFLOW_HOME) { $env:AI_WORKFLOW_HOME } else { Join-Path $env:USERPROFILE '.claude' }
$accDir = Join-Path $workflowHome "projects\$slug\acceptance"
    if (-not (Test-Path $accDir)) { exit 0 }

    function Get-UncheckedItems($content) {
        return [regex]::Matches($content, '(?ms)^### (A\d+)\b(.*?)(?=^### A\d+\b|\z)') |
            Where-Object { $_.Groups[2].Value -match '(?m)^\s*-\s*status:\s*\[ \]' } |
            ForEach-Object { $_.Groups[1].Value }
    }

    $findings = @()
    foreach ($taskDir in (Get-ChildItem $accDir -Directory -ErrorAction SilentlyContinue)) {
        $checklist = Join-Path $taskDir.FullName 'checklist.md'
        $miniSpec = Join-Path $taskDir.FullName 'mini-spec.md'
        $taskIssues = @()

        if (Test-Path $checklist) {
            # 重軌任務
            $content = Get-Content $checklist -Raw -Encoding UTF8
            if ($content -match '<!--\s*paused\s*-->') { continue }

            # spec.md 缺失或未凍結（SDD：checklist 是 spec.md 的延伸，缺規格書或規格書還沒凍結
            # 就代表 R4/R5 對照的依據不完整）
            $spec = Join-Path $taskDir.FullName 'spec.md'
            if (-not (Test-Path $spec)) {
                $taskIssues += 'spec.md 缺失'
            } else {
                $specContent = Get-Content $spec -Raw -Encoding UTF8
                if ($specContent -match '(?m)^\s*-\s*frozen:\s*draft\s*$') { $taskIssues += 'spec.md 未凍結（仍是 draft）' }
            }

            $unchecked = Get-UncheckedItems $content
            if ($unchecked) { $taskIssues += "未驗收條目: $($unchecked -join ', ')" }

            # plan.md 未勾階段
            $plan = Join-Path $taskDir.FullName 'plan.md'
            if (Test-Path $plan) {
                $planContent = Get-Content $plan -Raw -Encoding UTF8
                $openStages = [regex]::Matches($planContent, '(?m)^\s*-\s*\[ \]\s*(R\d+)') | ForEach-Object { $_.Groups[1].Value }
                if ($openStages) { $taskIssues += "plan.md 未勾階段: $($openStages -join ', ')" }
            }
        } elseif (Test-Path $miniSpec) {
            # 標準軌任務（單檔，無 spec.md/checklist.md/plan.md 可檢查）
            $content = Get-Content $miniSpec -Raw -Encoding UTF8
            if ($content -match '<!--\s*paused\s*-->') { continue }

            if ($content -match '(?m)^\s*-\s*frozen:\s*draft\s*$') { $taskIssues += 'mini-spec.md 未凍結（仍是 draft）' }

            $unchecked = Get-UncheckedItems $content
            if ($unchecked) { $taskIssues += "未驗收條目: $($unchecked -join ', ')" }
        } else {
            continue
        }

        if ($taskIssues.Count -gt 0) { $findings += "[$($taskDir.Name)] $($taskIssues -join '; ')" }
    }

    if ($findings.Count -gt 0) {
        $reason = "stop-check: 本專案有進行中的驗收任務缺件 — $($findings -join ' / ')。請補齊驗收並勾選對應 status/階段;若任務刻意暫停,請向使用者說明並在該任務的 checklist.md 或 mini-spec.md 檔頭加上 <!-- paused --> 標記。"
        $out = @{ decision = 'block'; reason = $reason }
        Write-Output ($out | ConvertTo-Json -Depth 3 -Compress)
    }
    exit 0
} catch {
    exit 0
}
