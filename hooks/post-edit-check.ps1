# managed by claude-workflow v2 — PostToolUse hook: .go 檔編輯後快檢
# matcher: Edit|Write|MultiEdit
# 對被編輯的 .go 檔跑 gofmt -l 與該 package 的 go vet; 失敗回 decision=block 要求立即修正。
# 非 .go 檔 / 找不到 go.mod / vet 超時 → 放行。任何解析失敗 → exit 0。

$ErrorActionPreference = 'Stop'
try {
    $raw = [Console]::In.ReadToEnd()
    $payload = $raw | ConvertFrom-Json
    $filePath = $payload.tool_input.file_path
    if (-not $filePath -or $filePath -notlike '*.go') { exit 0 }
    if (-not (Test-Path $filePath)) { exit 0 }

    # 由檔案往上找 go.mod, 找不到就放行
    $dir = Split-Path -Parent (Resolve-Path $filePath)
    $modRoot = $null
    $probe = $dir
    while ($probe) {
        if (Test-Path (Join-Path $probe 'go.mod')) { $modRoot = $probe; break }
        $parent = Split-Path -Parent $probe
        if ($parent -eq $probe) { break }
        $probe = $parent
    }
    if (-not $modRoot) { exit 0 }

    $problems = @()

    $fmtOut = & gofmt -l $filePath 2>&1
    if ($LASTEXITCODE -eq 0 -and $fmtOut) {
        $problems += "gofmt 未格式化: $filePath (請執行 gofmt -w)"
    }

    # go vet 該檔所在 package (timeout 15s, 超時放行)
    $job = Start-Job -ScriptBlock {
        param($root, $pkgDir)
        Set-Location $root
        $out = & go vet $pkgDir 2>&1
        [pscustomobject]@{ Code = $LASTEXITCODE; Out = ($out | Out-String) }
    } -ArgumentList $modRoot, $dir
    if (Wait-Job $job -Timeout 15) {
        $res = Receive-Job $job
        if ($res.Code -ne 0) {
            $vetMsg = ($res.Out -split "`r?`n" | Select-Object -First 8) -join '; '
            $problems += "go vet 失敗: $vetMsg"
        }
    }
    Remove-Job $job -Force -ErrorAction SilentlyContinue

    if ($problems.Count -gt 0) {
        $out = @{ decision = 'block'; reason = "post-edit-check: $($problems -join ' | ')" }
        Write-Output ($out | ConvertTo-Json -Depth 3 -Compress)
    }
    exit 0
} catch {
    exit 0
}
