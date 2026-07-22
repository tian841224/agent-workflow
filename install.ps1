# claude-workflow v2 安裝腳本 (Windows)
# 分層安裝: kit 層整檔覆蓋 / 使用者層最小侵入 (CLAUDE.md marker 區塊 + settings.json JSON 合併) / 專案層不碰
# 冪等: 重跑 = 升級。
# 用法: .\install.ps1 [-Target <dir>] [-DryRun]

param(
    [string]$Target = (Join-Path $env:USERPROFILE '.claude'),
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$summary = @()

function Log($msg) { Write-Output $msg }
function Do-Copy($src, $dst) {
    if ($DryRun) { Log "[dry-run] copy $src -> $dst"; return }
    $dstDir = Split-Path -Parent $dst
    if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Force $dstDir | Out-Null }
    Copy-Item $src $dst -Force
}

if (-not (Test-Path $Target)) {
    if ($DryRun) { Log "[dry-run] 建立 $Target" } else { New-Item -ItemType Directory -Force $Target | Out-Null }
}

# ---------- 1. kit 層: 整檔覆蓋 ----------
Log '=== kit 層 (整檔覆蓋) ==='

# 1a. ~/.claude/claude-workflow/ (WORKFLOW.md / acceptance-spec.md / templates / scripts)
$kitDir = Join-Path $Target 'claude-workflow'
Do-Copy (Join-Path $repoRoot 'kit\WORKFLOW.md') (Join-Path $kitDir 'WORKFLOW.md')
Do-Copy (Join-Path $repoRoot 'kit\acceptance-spec.md') (Join-Path $kitDir 'acceptance-spec.md')
foreach ($f in (Get-ChildItem (Join-Path $repoRoot 'kit\templates') -File)) {
    Do-Copy $f.FullName (Join-Path $kitDir "templates\$($f.Name)")
}
foreach ($f in (Get-ChildItem (Join-Path $repoRoot 'scripts') -File)) {
    Do-Copy $f.FullName (Join-Path $kitDir "scripts\$($f.Name)")
}
$summary += "kit 檔 → $kitDir"

# 1b. agents (同名但無 managed 標記者先備份)
foreach ($f in (Get-ChildItem (Join-Path $repoRoot 'agents') -Filter *.md)) {
    $dst = Join-Path $Target "agents\$($f.Name)"
    if ((Test-Path $dst) -and -not (Select-String -Path $dst -Pattern 'managed by claude-workflow' -Quiet)) {
        $bak = "$dst.bak.$stamp"
        if (-not $DryRun) { Copy-Item $dst $bak -Force }
        Log "警告: $dst 為使用者自有檔案,已備份至 $bak 後覆蓋"
        $summary += "備份 $bak"
    }
    Do-Copy $f.FullName $dst
}
$agentCount = (Get-ChildItem (Join-Path $repoRoot 'agents') -Filter *.md).Count
$summary += "agents $agentCount 檔 → $(Join-Path $Target 'agents')"

# 1c. skills（整個 skill 目錄複製，不只 SKILL.md——systematic-debugging 還有 root-cause-tracing.md/
#     defense-in-depth.md/condition-based-waiting.md 等被引用的參考檔）
foreach ($skill in @('learn', 'evolve', 'tdd', 'systematic-debugging')) {
    $skillSrcDir = Join-Path $repoRoot "skills\$skill"
    foreach ($f in (Get-ChildItem $skillSrcDir -File)) {
        Do-Copy $f.FullName (Join-Path $Target "skills\$skill\$($f.Name)")
    }
}
# tdd 已改版為自包含單檔 SKILL.md；清掉舊機器上殘留的淘汰參考檔，避免失連引用
foreach ($stale in @('tests.md', 'mocking.md')) {
    $staleDst = Join-Path $Target "skills\tdd\$stale"
    if (Test-Path $staleDst) {
        if ($DryRun) { Log "[dry-run] 刪除已淘汰檔 $staleDst" }
        else { Remove-Item $staleDst -Force }
        $summary += "刪除已淘汰的 skills\tdd\$stale"
    }
}
$summary += "skills learn/evolve/tdd/systematic-debugging → $(Join-Path $Target 'skills')"

# 1d. hooks → ~/.claude/hooks/claude-workflow/
$hooksDstDir = Join-Path $Target 'hooks\claude-workflow'
$hookFiles = @(Get-ChildItem (Join-Path $repoRoot 'hooks') -Filter *.ps1)
foreach ($f in $hookFiles) {
    Do-Copy $f.FullName (Join-Path $hooksDstDir $f.Name)
}
$summary += "hooks $($hookFiles.Count) 支 → $hooksDstDir"

# 1e. rules（同名但無 managed 標記者先備份，同 1b agents 邏輯——使用者可能已有個人 learning.md）
foreach ($f in (Get-ChildItem (Join-Path $repoRoot 'rules') -Filter *.md)) {
    $dst = Join-Path $Target "rules\$($f.Name)"
    if ((Test-Path $dst) -and -not (Select-String -Path $dst -Pattern 'managed by claude-workflow' -Quiet)) {
        $bak = "$dst.bak.$stamp"
        if (-not $DryRun) { Copy-Item $dst $bak -Force }
        Log "警告: $dst 為使用者自有檔案,已備份至 $bak 後覆蓋"
        $summary += "備份 $bak"
    }
    Do-Copy $f.FullName $dst
}
$ruleCount = (Get-ChildItem (Join-Path $repoRoot 'rules') -Filter *.md).Count
$summary += "rules $ruleCount 檔 → $(Join-Path $Target 'rules')"

# ---------- 2. 使用者層: CLAUDE.md marker 區塊 ----------
Log '=== 使用者層: CLAUDE.md ==='
$claudeMd = Join-Path $Target 'CLAUDE.md'
$beginMarker = '<!-- claude-workflow:begin -->'
$endMarker = '<!-- claude-workflow:end -->'
$importBlock = "$beginMarker`n@claude-workflow/WORKFLOW.md`n$endMarker`n"
$existing = if (Test-Path $claudeMd) { [System.IO.File]::ReadAllText($claudeMd, [System.Text.Encoding]::UTF8) } else { '' }
if ($existing -match [regex]::Escape($beginMarker)) {
    Log 'CLAUDE.md 已含 claude-workflow 區塊,不重複加入'
} else {
    $newContent = if ($existing.Trim()) { $existing.TrimEnd() + "`n`n" + $importBlock } else { $importBlock }
    if ($DryRun) { Log "[dry-run] append marker 區塊到 $claudeMd" }
    else { [System.IO.File]::WriteAllText($claudeMd, $newContent, $utf8NoBom) }
    $summary += "CLAUDE.md 加入 import 區塊"
}

# ---------- 3. 使用者層: settings.json hooks 合併 ----------
Log '=== 使用者層: settings.json hooks ==='
$settingsPath = Join-Path $Target 'settings.json'
$fragmentPath = Join-Path $repoRoot 'hooks\settings.hooks.json'
$marker = 'hooks\claude-workflow'

$fragmentRaw = [System.IO.File]::ReadAllText($fragmentPath, [System.Text.Encoding]::UTF8)
$fragmentRaw = $fragmentRaw -replace '\{\{HOOKS_DIR\}\}', ($hooksDstDir -replace '\\', '\\')
$fragment = $fragmentRaw | ConvertFrom-Json

$settings = if (Test-Path $settingsPath) {
    [System.IO.File]::ReadAllText($settingsPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
} else { [pscustomobject]@{} }

if (-not $DryRun -and (Test-Path $settingsPath)) {
    Copy-Item $settingsPath "$settingsPath.bak.$stamp" -Force
    $summary += "settings.json 備份 → $settingsPath.bak.$stamp"
}

if (-not ($settings.PSObject.Properties.Name -contains 'hooks')) {
    $settings | Add-Member -MemberType NoteProperty -Name 'hooks' -Value ([pscustomobject]@{})
}

foreach ($eventProp in $fragment.hooks.PSObject.Properties) {
    $eventName = $eventProp.Name
    $newEntries = @($eventProp.Value)
    $existingEntries = @()
    if ($settings.hooks.PSObject.Properties.Name -contains $eventName) {
        # 移除既有的 claude-workflow entry (以 command 路徑為 marker → 冪等)
        foreach ($entry in @($settings.hooks.$eventName)) {
            $cmds = @($entry.hooks | ForEach-Object { $_.command })
            $isKit = $false
            foreach ($c in $cmds) { if ($c -like "*$marker*" -or $c -like '*hooks/claude-workflow*') { $isKit = $true } }
            # 同檔名的舊註冊 (裝在別的路徑) 印警告但不動
            foreach ($c in $cmds) {
                foreach ($n in @('git-guard.ps1','post-edit-check.ps1','stop-check.ps1','knowhow-check.ps1','weekly-review-check.ps1','log-session.ps1')) {
                    if ($c -like "*$n*" -and -not $isKit) { Log "警告: $eventName 已有非 kit 路徑的 $n 註冊,請手動擇一: $c" }
                }
            }
            if (-not $isKit) { $existingEntries += $entry }
        }
    } else {
        $settings.hooks | Add-Member -MemberType NoteProperty -Name $eventName -Value @()
    }
    $settings.hooks.$eventName = @($existingEntries) + @($newEntries)
    Log "hooks.$eventName : 保留既有 $($existingEntries.Count) 筆 + kit $($newEntries.Count) 筆"
}

if ($DryRun) {
    Log "[dry-run] 寫回 $settingsPath"
} else {
    $json = $settings | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($settingsPath, $json, $utf8NoBom)
    $summary += "settings.json hooks 已合併"
}

# ---------- 摘要 ----------
Log ''
Log '=== 安裝摘要 ==='
$summary | ForEach-Object { Log "- $_" }
Log ''
Log '驗證建議:'
Log ("  echo '{{""tool_name"":""Bash"",""tool_input"":{{""command"":""git push --force""}}}}' | powershell -NoProfile -File `"{0}`"  應輸出 deny" -f (Join-Path $hooksDstDir 'git-guard.ps1'))
Log '  (settings.json 的 ConvertTo-Json 會把中文轉為 \uXXXX 逸出,功能無損)'
