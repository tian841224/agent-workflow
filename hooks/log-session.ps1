# SessionEnd hook:將 session 資訊追加到每日工作日誌(任何錯誤一律靜默,不得影響 Claude Code)
try {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }
    $data = $raw | ConvertFrom-Json

    $projName = ''
    if ($data.cwd) { $projName = Split-Path $data.cwd -Leaf }

    # 從 transcript(JSONL)抓第一則使用者訊息前 100 字當摘要;失敗不阻斷
    $summary = ''
    try {
        if ($data.transcript_path -and (Test-Path $data.transcript_path)) {
            foreach ($line in [System.IO.File]::ReadLines($data.transcript_path)) {
                if ([string]::IsNullOrWhiteSpace($line)) { continue }
                $entry = $null
                try { $entry = $line | ConvertFrom-Json } catch { continue }
                if ($entry.type -ne 'user' -or -not $entry.message) { continue }
                $text = ''
                if ($entry.message.content -is [string]) {
                    $text = $entry.message.content
                } else {
                    foreach ($block in $entry.message.content) {
                        if ($block.type -eq 'text') { $text = $block.text; break }
                    }
                }
                $text = ($text -replace '\s+', ' ').Trim()
                # 跳過系統注入內容(以 < 開頭的 system-reminder / command 包裝)
                if (-not $text -or $text.StartsWith('<')) { continue }
                if ($text.Length -gt 100) { $text = $text.Substring(0, 100) + '…' }
                $summary = $text
                break
            }
        }
    } catch { }

    $logDir = Join-Path $env:USERPROFILE '.claude\logs'
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $logFile = Join-Path $logDir ((Get-Date -Format 'yyyy-MM-dd') + '.md')

    $time = Get-Date -Format 'HH:mm'
    $reason = if ($data.reason) { $data.reason } else { 'unknown' }
    $entryLine = "- $time [$projName]"
    if ($summary) { $entryLine += " $summary" }
    $entryLine += " (reason: $reason)"

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    if (-not (Test-Path $logFile)) {
        $header = "# 工作日誌 " + (Get-Date -Format 'yyyy-MM-dd') + "`r`n`r`n"
        [System.IO.File]::WriteAllText($logFile, $header, $utf8NoBom)
    }
    [System.IO.File]::AppendAllText($logFile, $entryLine + "`r`n", $utf8NoBom)
} catch { }
exit 0
