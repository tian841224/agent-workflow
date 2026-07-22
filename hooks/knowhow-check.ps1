# managed by claude-workflow v2 — Stop hook: know-how 沉澱缺件提醒
# session 結束時, 掃 transcript 判斷本次 session 是否對專案(cwd 底下、排除 .claude\)有 >=3 筆
# Edit/Write/MultiEdit 實質修改; 若有, 檢查是否已滿足下列任一條件才放行:
#   (a) assistant 回覆文字含「已沉澱」或「無可沉澱」宣告(見 WORKFLOW.md §9 沉澱三問)
#   (b) 專案記憶層 ~/.claude/projects/<slug>/memory/ 下有檔案的更新時間晚於本次 session 起點
# 皆未滿足 → decision=block 提醒依 §9 執行。
# stop_hook_active=true 一律放行(防迴圈)。任何解析失敗 → exit 0(不得影響 Claude Code)。

$ErrorActionPreference = 'Stop'
try {
    $raw = [Console]::In.ReadToEnd()
    $payload = $raw | ConvertFrom-Json
    if ($payload.stop_hook_active) { exit 0 }

    $cwd = $payload.cwd
    $transcriptPath = $payload.transcript_path
    if (-not $cwd -or -not $transcriptPath -or -not (Test-Path $transcriptPath)) { exit 0 }

    $cwdNorm = $cwd.TrimEnd('\', '/').ToLowerInvariant()
    $editCount = 0
    $declared = $false
    $sessionStart = $null

    foreach ($line in [System.IO.File]::ReadLines($transcriptPath)) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $entry = $null
        try { $entry = $line | ConvertFrom-Json } catch { continue }

        if (-not $sessionStart -and $entry.timestamp) {
            try { $sessionStart = [DateTime]::Parse($entry.timestamp, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind) } catch { }
        }

        if ($entry.type -ne 'assistant' -or -not $entry.message -or -not $entry.message.content) { continue }
        foreach ($block in @($entry.message.content)) {
            if ($block.type -eq 'tool_use' -and @('Edit', 'Write', 'MultiEdit') -contains $block.name) {
                $fp = $block.input.file_path
                if ($fp) {
                    $fpNorm = $fp.ToLowerInvariant()
                    if ($fpNorm.StartsWith($cwdNorm) -and $fpNorm -notmatch '\\\.claude\\') {
                        $editCount++
                    }
                }
            } elseif ($block.type -eq 'text' -and $block.text) {
                if ($block.text -match '已沉澱' -or $block.text -match '無可沉澱') { $declared = $true }
            }
        }
    }

    if ($editCount -lt 3) { exit 0 }
    if ($declared) { exit 0 }

    if (-not $sessionStart) {
        $sessionStart = (Get-Item $transcriptPath).CreationTime
    }

    $slug = ($cwd -replace '[:\\/]', '-')
    $memDir = Join-Path $env:USERPROFILE ".claude\projects\$slug\memory"
    if (Test-Path $memDir) {
        $latest = Get-ChildItem $memDir -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($latest -and $latest.LastWriteTime -ge $sessionStart) { exit 0 }
    }

    $reason = 'knowhow-check: 本次 session 對專案有實質修改，但專案記憶層未更新、也未宣告沉澱結論。請依 WORKFLOW §9 執行：有值得記的 → 用 /learn 寫入專案記憶並回報「已沉澱:<摘要>」；確實沒有 → 在回覆中明寫「無可沉澱:<一句理由>」。'
    $out = @{ decision = 'block'; reason = $reason }
    Write-Output ($out | ConvertTo-Json -Depth 3 -Compress)
    exit 0
} catch {
    exit 0
}
