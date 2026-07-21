# SessionStart hook:距上次自我回顧滿 7 天時,輸出到期提醒(stdout 會注入對話 context)
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $f = Join-Path $env:USERPROFILE '.claude\memory\last-review.txt'
    $due = $true
    if (Test-Path $f) {
        $txt = (Get-Content $f -Raw).Trim()
        $last = [DateTime]::MinValue
        $ok = [DateTime]::TryParseExact($txt, 'yyyy-MM-dd', [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::None, [ref]$last)
        if ($ok -and ((Get-Date).Date - $last.Date).Days -lt 7) { $due = $false }
    }
    if ($due) {
        Write-Output '【週回顧到期】距上次自我回顧已超過 7 天。請在回覆開頭提醒使用者:可執行 /evolve 進行經驗沉澱(把本週日誌與記憶精煉成新規則/技能)。'
    }
} catch { }
exit 0
