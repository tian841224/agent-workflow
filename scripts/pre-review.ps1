# managed by claude-workflow v2 — pre-review 預檢腳本
# 在受審專案根目錄執行。exit 0 = 通過, exit 1 = 失敗(退回實作者,不計 reviewer 回合)。
# 檢查: gofmt (diff 檔案) → go vet ./... → go build ./... → go test ./...
# 專案可放 .pre-review-extra.ps1 於 repo root 追加自訂檢查。

$ErrorActionPreference = 'Continue'
$failures = @()

function Write-Section($name) { Write-Output "=== $name ===" }

if (-not (Test-Path 'go.mod')) {
    Write-Output "非 Go 專案 (無 go.mod),跳過 Go 檢查。"
} else {
    # gofmt: 只檢查本次 diff 涉及的 .go 檔;無 diff 則檢查全部
    Write-Section 'gofmt'
    $diffFiles = @()
    $inRepo = $true
    git rev-parse --is-inside-work-tree 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { $inRepo = $false }
    if ($inRepo) {
        $diffFiles = @(git diff --name-only HEAD 2>$null) + @(git diff --name-only --cached 2>$null) |
            Where-Object { $_ -like '*.go' -and (Test-Path $_) } | Select-Object -Unique
    }
    $fmtTargets = if ($diffFiles.Count -gt 0) { $diffFiles } else { @('.') }
    $unformatted = & gofmt -l @fmtTargets 2>&1
    if ($LASTEXITCODE -ne 0) {
        $failures += "gofmt 執行失敗: $unformatted"
    } elseif ($unformatted) {
        $failures += "gofmt 未格式化: $($unformatted -join ', ')"
        Write-Output $unformatted
    } else {
        Write-Output 'OK'
    }

    Write-Section 'go vet'
    $vetOut = & go vet ./... 2>&1
    if ($LASTEXITCODE -ne 0) { $failures += 'go vet 失敗'; Write-Output $vetOut } else { Write-Output 'OK' }

    Write-Section 'go build'
    $buildOut = & go build ./... 2>&1
    if ($LASTEXITCODE -ne 0) { $failures += 'go build 失敗'; Write-Output $buildOut } else { Write-Output 'OK' }

    Write-Section 'go test'
    $testOut = & go test ./... 2>&1
    if ($LASTEXITCODE -ne 0) { $failures += 'go test 失敗'; Write-Output $testOut } else { Write-Output ($testOut | Select-Object -Last 30) }

    # golangci-lint 為選配:裝了才跑
    if (Get-Command golangci-lint -ErrorAction SilentlyContinue) {
        Write-Section 'golangci-lint'
        $lintOut = & golangci-lint run ./... 2>&1
        if ($LASTEXITCODE -ne 0) { $failures += 'golangci-lint 失敗'; Write-Output $lintOut } else { Write-Output 'OK' }
    }
}

# 專案自訂追加檢查
if (Test-Path '.pre-review-extra.ps1') {
    Write-Section 'pre-review-extra'
    & powershell -NoProfile -ExecutionPolicy Bypass -File '.pre-review-extra.ps1'
    if ($LASTEXITCODE -ne 0) { $failures += '.pre-review-extra.ps1 失敗' }
    else { Write-Output 'OK' }
}

Write-Section 'RESULT'
if ($failures.Count -gt 0) {
    Write-Output "FAIL:"
    $failures | ForEach-Object { Write-Output "  - $_" }
    exit 1
}
Write-Output 'PASS'
exit 0
