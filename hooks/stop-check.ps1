# managed by claude-workflow v2 — Stop hook: 驗收缺件提醒
# session 結束時, 依 cwd 換算 project-slug, 掃該專案 acceptance 目錄:
# checklist.md 有未勾條目/缺證據檔、plan.md 有未勾階段 → decision=block 提醒補齊或標記 paused。
# stop_hook_active=true 一律放行 (防迴圈)。checklist 含 <!-- paused --> 跳過。解析失敗 → exit 0。

$ErrorActionPreference = 'Stop'
try {
    $raw = [Console]::In.ReadToEnd()
    $payload = $raw | ConvertFrom-Json
    if ($payload.stop_hook_active) { exit 0 }
    $cwd = $payload.cwd
    if (-not $cwd) { exit 0 }

    # cwd → project-slug (Claude Code 慣例: 冒號與斜線轉連字號)
    $slug = ($cwd -replace '[:\\/]', '-')
    $accDir = Join-Path $env:USERPROFILE ".claude\projects\$slug\acceptance"
    if (-not (Test-Path $accDir)) { exit 0 }

    $findings = @()
    foreach ($taskDir in (Get-ChildItem $accDir -Directory -ErrorAction SilentlyContinue)) {
        $checklist = Join-Path $taskDir.FullName 'checklist.md'
        if (-not (Test-Path $checklist)) { continue }
        $content = Get-Content $checklist -Raw -Encoding UTF8
        if ($content -match '<!--\s*paused\s*-->') { continue }

        $taskIssues = @()

        # 未勾條目
        $unchecked = [regex]::Matches($content, '(?ms)^### (A\d+)\b(.*?)(?=^### A\d+\b|\z)') |
            Where-Object { $_.Groups[2].Value -match '(?m)^\s*-\s*status:\s*\[ \]' } |
            ForEach-Object { $_.Groups[1].Value }
        if ($unchecked) { $taskIssues += "未驗收條目: $($unchecked -join ', ')" }

        # 證據檔缺失或為空
        $missing = @()
        foreach ($m in [regex]::Matches($content, '(?m)^\s*-\s*evidence:\s*(\S+)')) {
            $evPath = Join-Path $taskDir.FullName $m.Groups[1].Value
            if (-not (Test-Path $evPath) -or (Get-Item $evPath).Length -eq 0) { $missing += $m.Groups[1].Value }
        }
        if ($missing) { $taskIssues += "缺證據檔: $($missing -join ', ')" }

        # plan.md 未勾階段
        $plan = Join-Path $taskDir.FullName 'plan.md'
        if (Test-Path $plan) {
            $planContent = Get-Content $plan -Raw -Encoding UTF8
            $openStages = [regex]::Matches($planContent, '(?m)^\s*-\s*\[ \]\s*(R\d+)') | ForEach-Object { $_.Groups[1].Value }
            if ($openStages) { $taskIssues += "plan.md 未勾階段: $($openStages -join ', ')" }
        }

        if ($taskIssues.Count -gt 0) { $findings += "[$($taskDir.Name)] $($taskIssues -join '; ')" }
    }

    if ($findings.Count -gt 0) {
        $reason = "stop-check: 本專案有進行中的驗收任務缺件 — $($findings -join ' / ')。請補齊驗收與證據並勾選對應 status/階段;若任務刻意暫停,請向使用者說明並在該 checklist.md 檔頭加上 <!-- paused --> 標記。"
        $out = @{ decision = 'block'; reason = $reason }
        Write-Output ($out | ConvertTo-Json -Depth 3 -Compress)
    }
    exit 0
} catch {
    exit 0
}
