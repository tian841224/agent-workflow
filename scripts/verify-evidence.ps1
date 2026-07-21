# managed by claude-workflow v2 — 驗收證據檢查腳本
# 用法: verify-evidence.ps1 -Checklist <checklist.md 路徑> [-Rerun]
# 依 kit/acceptance-spec.md 規約逐條檢查; 任一 FAIL 即 exit 1。
# 預設靜態模式: 檔案存在/非空/首行含指令/內容 match expect/status 一致/mtime 時效
# -Rerun: 後端型條目重新執行 cmd 並重寫 evidence (含 setup 或 ui 型仍走靜態檢查)

param(
    [Parameter(Mandatory = $true)][string]$Checklist,
    [switch]$Rerun
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Checklist)) { Write-Output "checklist 不存在: $Checklist"; exit 1 }
$taskDir = Split-Path -Parent (Resolve-Path $Checklist)
$content = Get-Content $Checklist -Raw -Encoding UTF8

# 檔頭 project 路徑
$projectPath = $null
if ($content -match '(?m)^\s*-\s*project:\s*(.+?)\s*$') { $projectPath = $Matches[1].Trim() }
if (-not $projectPath -or -not (Test-Path $projectPath)) {
    Write-Output "checklist 檔頭缺少有效的 project: 路徑 (實得: '$projectPath')"; exit 1
}

# 專案最後 commit 時間 (證據時效基準); 非 git repo 則跳過時效檢查
$lastCommitEpoch = $null
Push-Location $projectPath
try {
    $epochStr = cmd /c "git log -1 --format=%ct 2>nul"
    if ($LASTEXITCODE -eq 0 -and $epochStr) { $lastCommitEpoch = [long]("$epochStr".Trim()) }
} catch {} finally { Pop-Location }

# 解析條目: 以 "### A<n> " 切段
$itemBlocks = [regex]::Matches($content, '(?ms)^### (A\d+)\b(.*?)(?=^### A\d+\b|\z)')
if ($itemBlocks.Count -eq 0) { Write-Output "checklist 內找不到任何 ### A<n> 條目"; exit 1 }

function Get-Field($block, $name) {
    if ($block -match "(?m)^\s*-\s*$($name):\s*(.+?)\s*$") { return $Matches[1].Trim() }
    return $null
}

$results = @()
foreach ($m in $itemBlocks) {
    $id = $m.Groups[1].Value
    $block = $m.Groups[2].Value
    $isUi = (Get-Field $block 'type') -eq 'ui'
    $cmdRaw = Get-Field $block 'cmd'
    $expect = Get-Field $block 'expect'
    $evidence = Get-Field $block 'evidence'
    $setup = Get-Field $block 'setup'
    $statusChecked = $block -match '(?m)^\s*-\s*status:\s*\[x\]'

    $issues = @()
    $note = ''
    if (-not $evidence) { $issues += '缺 evidence 欄位' }
    $evPath = if ($evidence) { Join-Path $taskDir $evidence } else { $null }

    # 去掉 cmd/expect 的反引號包裹
    $cmd = if ($cmdRaw) { $cmdRaw.Trim('`') } else { $null }
    $expectPattern = if ($expect) { $expect.Trim('`') } else { $null }

    # -Rerun: 後端型且無 setup 才重跑
    if ($Rerun -and -not $isUi -and $cmd -and -not $setup -and $evPath) {
        $evDir = Split-Path -Parent $evPath
        if (-not (Test-Path $evDir)) { New-Item -ItemType Directory -Force $evDir | Out-Null }
        $ts = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
        Push-Location $projectPath
        try { $output = & cmd /c $cmd 2>&1 | Out-String } finally { Pop-Location }
        $body = "# $ts `$ $cmd`r`n$output"
        [System.IO.File]::WriteAllText($evPath, $body, (New-Object System.Text.UTF8Encoding($false)))
        $note = '已重跑'
    } elseif ($Rerun -and ($setup -or $isUi)) {
        $note = if ($isUi) { 'ui 型僅靜態檢查' } else { '含 setup,需人工重跑' }
    }

    # 靜態檢查
    if ($evPath) {
        if (-not (Test-Path $evPath)) {
            $issues += "證據檔不存在: $evidence"
        } else {
            $evItem = Get-Item $evPath
            if ($evItem.Length -eq 0) { $issues += '證據檔為空' }
            if ($lastCommitEpoch) {
                $mtimeEpoch = [long][double]::Parse((Get-Date $evItem.LastWriteTimeUtc -UFormat %s))
                if ($mtimeEpoch -lt $lastCommitEpoch) { $issues += '證據早於最後一次 commit (時效不符)' }
            }
            if (-not $isUi) {
                $evContent = Get-Content $evPath -Raw -Encoding UTF8
                if ($cmd -and $evContent) {
                    $firstLine = ($evContent -split "`r?`n")[0]
                    if ($firstLine -notlike "*$cmd*") { $issues += '證據檔首行不含指令原文' }
                }
                if ($expectPattern -and $evContent -and ($evContent -notmatch $expectPattern)) {
                    $issues += "內容不符 expect: $expectPattern"
                }
            }
        }
    }
    if (-not $isUi -and -not $cmd) { $issues += '缺 cmd 欄位' }
    if (-not $isUi -and -not $expectPattern) { $issues += '缺 expect 欄位' }

    $pass = ($issues.Count -eq 0)
    if ($pass -and -not $statusChecked) { $issues += 'status 未勾但檢查通過 (待回填 [x])'; $note = "$note 待勾選".Trim() }
    if (-not $pass -and $statusChecked) { $issues += 'status 已勾但檢查失敗 (勾選與證據不一致)' }

    $results += [pscustomobject]@{ Id = $id; Pass = $pass; Issues = $issues; Note = $note }
}

Write-Output '=== verify-evidence 結果 ==='
$failCount = 0
foreach ($r in $results) {
    if ($r.Pass -and $r.Issues.Count -eq 0) {
        Write-Output ("[PASS] {0} {1}" -f $r.Id, $r.Note)
    } elseif ($r.Pass) {
        Write-Output ("[PASS] {0} ({1}) {2}" -f $r.Id, ($r.Issues -join '; '), $r.Note)
    } else {
        $failCount++
        Write-Output ("[FAIL] {0}: {1} {2}" -f $r.Id, ($r.Issues -join '; '), $r.Note)
    }
}
Write-Output ("--- 共 {0} 條, FAIL {1} 條 ---" -f $results.Count, $failCount)
Write-Output '提醒: 腳本只能驗證檔案與比對內容,關鍵證據的真實性/相關性仍需主對話抽驗。'
if ($failCount -gt 0) { exit 1 }
exit 0
