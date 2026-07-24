# AI Workflow installer: one canonical shared directory, platform-specific adapters.
[CmdletBinding()]
param(
    [Alias('Agent','Platform')][ValidateSet('Claude','Codex','Antigravity','Both','All')][string]$TargetAgent = 'Both',
    [Alias('Target')][string]$ClaudeTarget = (Join-Path $env:USERPROFILE '.claude'),
    [string]$CodexTarget = (Join-Path $env:USERPROFILE '.codex'),
    [string]$AntigravityTarget = (Join-Path $env:USERPROFILE '.gemini'),
    [string]$CanonicalTarget = (Join-Path $env:USERPROFILE '.agents'),
    [ValidateSet('Install','Status','Repair','Uninstall')][string]$Action = 'Install',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$commonDirectories = @('workflow','agents','skills','rules','scripts','templates','hooks')
$canonicalCore = $CanonicalTarget
$manifestSource = Join-Path $repoRoot 'adapters\shared\install-manifest.json'
$summary = [System.Collections.Generic.List[string]]::new()

function Log([string]$Message) { Write-Output $Message }
function Ensure-Directory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        if ($DryRun) { Log "[dry-run] mkdir $Path" } else { New-Item -ItemType Directory -Force -Path $Path | Out-Null }
    }
}
function Copy-Tree([string]$Source, [string]$Destination) {
    Ensure-Directory $Destination
    if ($DryRun) { Log "[dry-run] sync $Source -> $Destination"; return }
    Get-ChildItem -LiteralPath $Source -Force | Copy-Item -Destination $Destination -Recurse -Force
}
function Backup-Path([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $backup = "$Path.bak.$stamp"
    if ($DryRun) { Log "[dry-run] backup $Path -> $backup" } else { Move-Item -LiteralPath $Path -Destination $backup -Force }
    $summary.Add("備份 $backup")
}
function Test-LinkTo([string]$Path, [string]$Target) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $item = Get-Item -LiteralPath $Path -Force
    return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and ($item.Target -contains $Target -or $item.Target -eq $Target))
}
function Link-Or-CopyDirectory([string]$Target, [string]$Source) {
    if (Test-LinkTo $Target $Source) { return 'link' }
    if (Test-Path -LiteralPath $Target) { Backup-Path $Target }
    $parent = Split-Path -Parent $Target; Ensure-Directory $parent
    if ($DryRun) { Log "[dry-run] junction $Target -> $Source"; return 'junction' }
    try {
        New-Item -ItemType Junction -Path $Target -Target $Source -ErrorAction Stop | Out-Null
        return 'junction'
    } catch {
        Log "警告: 無法建立 junction ($($_.Exception.Message)); fallback 為同步複製。"
        Copy-Tree $Source $Target
        return 'copy'
    }
}
function Link-Or-CopyFile([string]$Target, [string]$Source) {
    if (Test-Path -LiteralPath $Target) {
        $item = Get-Item -LiteralPath $Target -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and ($item.Target -contains $Source -or $item.Target -eq $Source)) { return 'link' }
        if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and (Get-FileHash -LiteralPath $Target).Hash -eq (Get-FileHash -LiteralPath $Source).Hash) { return 'copy' }
        Backup-Path $Target
    }
    Ensure-Directory (Split-Path -Parent $Target)
    if ($DryRun) { Log "[dry-run] symlink $Target -> $Source"; return 'symlink' }
    try { New-Item -ItemType SymbolicLink -Path $Target -Target $Source -ErrorAction Stop | Out-Null; return 'symlink' }
    catch { Copy-Item -LiteralPath $Source -Destination $Target -Force; return 'copy' }
}
function Link-SharedDirectoryEntries([string]$Target, [string]$Source) {
    Ensure-Directory $Target
    foreach ($entry in (Get-ChildItem -LiteralPath $Source -Force)) {
        $destination = Join-Path $Target $entry.Name
        if ($entry.PSIsContainer) { $mode = Link-Or-CopyDirectory $destination $entry.FullName }
        else { $mode = Link-Or-CopyFile $destination $entry.FullName }
        $mode
    }
}
function Write-ManagedFile([string]$Source, [string]$Destination) {
    if ((Test-Path -LiteralPath $Destination) -and -not (Select-String -LiteralPath $Destination -Pattern 'claude-workflow' -Quiet)) { Backup-Path $Destination }
    if ($DryRun) { Log "[dry-run] copy $Source -> $Destination"; return }
    Ensure-Directory (Split-Path -Parent $Destination)
    Copy-Item -LiteralPath $Source -Destination $Destination -Force
}
function Install-Canonical {
    Ensure-Directory $CanonicalTarget
    foreach ($directory in $commonDirectories) { Copy-Tree (Join-Path $repoRoot $directory) (Join-Path $canonicalCore $directory) }
    Link-Or-CopyFile (Join-Path $canonicalCore 'AGENTS.md') (Join-Path $repoRoot 'AGENTS.md') | Out-Null
    $metadata = [ordered]@{ schemaVersion = 1; installedAt = (Get-Date).ToString('o'); source = $repoRoot; mode = 'junction-with-copy-fallback' }
    if ($DryRun) { Log "[dry-run] write $CanonicalTarget\manifest.json" } else { $metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $CanonicalTarget 'manifest.json') -Encoding utf8 }
    $summary.Add("canonical shared directory -> $canonicalCore")
}
function Update-Claude {
    Ensure-Directory $ClaudeTarget
    foreach ($dir in @('agents','skills')) { $sourceDir = if (Test-Path -LiteralPath (Join-Path $canonicalCore $dir)) { Join-Path $canonicalCore $dir } else { Join-Path $repoRoot $dir }; $modes = @(Link-SharedDirectoryEntries (Join-Path $ClaudeTarget $dir) $sourceDir); $summary.Add("Claude $dir entries -> $($modes -join ',')") }
    $claudeRulesDir = Join-Path $ClaudeTarget 'rules'; Ensure-Directory $claudeRulesDir
    $claudeRuleSource = if (Test-Path -LiteralPath (Join-Path $canonicalCore 'rules')) { Join-Path $canonicalCore 'rules' } else { Join-Path $repoRoot 'rules' }
    foreach ($rule in (Get-ChildItem -LiteralPath $claudeRuleSource -File)) { $mode = Link-Or-CopyFile (Join-Path $claudeRulesDir $rule.Name) $rule.FullName; $summary.Add("Claude rules/$($rule.Name) -> $mode") }
    $workflowLink = Link-Or-CopyDirectory (Join-Path $ClaudeTarget 'claude-workflow') $canonicalCore
    $summary.Add("Claude claude-workflow -> $workflowLink (deprecated compatibility path)")
    $claudeMd = Join-Path $ClaudeTarget 'CLAUDE.md'; $mode = Link-Or-CopyFile $claudeMd (Join-Path $canonicalCore 'AGENTS.md'); $summary.Add("Claude CLAUDE.md -> $mode")
    $hooksDir = Join-Path $ClaudeTarget 'hooks\ai-workflow'; $mode = Link-Or-CopyDirectory $hooksDir (Join-Path $canonicalCore 'hooks'); $summary.Add("Claude hooks -> $mode")
    $settings = Join-Path $ClaudeTarget 'settings.json'; $fragmentRaw = Get-Content (Join-Path $repoRoot 'adapters\claude\settings.hooks.json') -Raw -Encoding UTF8
    $fragmentRaw = $fragmentRaw -replace '\{\{HOOKS_DIR\}\}', (($hooksDir -replace '\\','\\'))
    $fragment = $fragmentRaw | ConvertFrom-Json
    $data = if (Test-Path -LiteralPath $settings) { Get-Content $settings -Raw -Encoding UTF8 | ConvertFrom-Json } else { [pscustomobject]@{} }
    if (-not $data.PSObject.Properties['hooks']) { $data | Add-Member NoteProperty hooks ([pscustomobject]@{}) }
    foreach ($event in $fragment.hooks.PSObject.Properties) {
        $existingEntries = @($data.hooks.$($event.Name) | Where-Object { $_ -and (($_.hooks | ForEach-Object { $_.command }) -notmatch 'hooks[\\/]ai-workflow') })
        $data.hooks | Add-Member NoteProperty $event.Name @() -Force
        $data.hooks.$($event.Name) = @($existingEntries) + @($event.Value)
    }
    if ($DryRun) { Log "[dry-run] merge $settings" } else { if (Test-Path $settings) { Copy-Item $settings "$settings.bak.$stamp" -Force }; $data | ConvertTo-Json -Depth 20 | Set-Content $settings -Encoding utf8 }
}
function Update-Codex {
    Ensure-Directory $CodexTarget
    foreach ($dir in @('agents','skills')) { $sourceDir = if (Test-Path -LiteralPath (Join-Path $canonicalCore $dir)) { Join-Path $canonicalCore $dir } else { Join-Path $repoRoot $dir }; $modes = @(Link-SharedDirectoryEntries (Join-Path $CodexTarget $dir) $sourceDir); $summary.Add("Codex $dir entries -> $($modes -join ',')") }
    $codexRulesDir = Join-Path $CodexTarget 'rules'; Ensure-Directory $codexRulesDir
    $ruleSourceDir = if (Test-Path -LiteralPath (Join-Path $canonicalCore 'rules')) { Join-Path $canonicalCore 'rules' } else { Join-Path $repoRoot 'rules' }
    foreach ($rule in (Get-ChildItem -LiteralPath $ruleSourceDir -File)) { $mode = Link-Or-CopyFile (Join-Path $codexRulesDir $rule.Name) $rule.FullName; $summary.Add("Codex rules/$($rule.Name) -> $mode") }
    $workflowLink = Link-Or-CopyDirectory (Join-Path $CodexTarget 'claude-workflow') $canonicalCore; $summary.Add("Codex claude-workflow -> $workflowLink (deprecated compatibility path)")
    $codexMd = Join-Path $CodexTarget 'AGENTS.md'; $mode = Link-Or-CopyFile $codexMd (Join-Path $canonicalCore 'AGENTS.md'); $summary.Add("Codex AGENTS.md -> $mode")
    $codexRules = Join-Path $CodexTarget 'rules\default.rules'
    Write-ManagedFile (Join-Path $repoRoot 'adapters\codex\execpolicy.rules') $codexRules
    $hooksDir = Join-Path $CodexTarget 'hooks\ai-workflow'; $mode = Link-Or-CopyDirectory $hooksDir (Join-Path $canonicalCore 'hooks'); $summary.Add("Codex hooks -> $mode")
    $hooks = Get-Content (Join-Path $repoRoot 'adapters\codex\hooks.json') -Raw -Encoding UTF8 | ForEach-Object { $_ -replace '\{\{HOOKS_DIR\}\}', (($hooksDir -replace '\\','\\')) }
    if ($DryRun) { Log "[dry-run] write $(Join-Path $CodexTarget 'hooks.json')" } else { $hooks | Set-Content (Join-Path $CodexTarget 'hooks.json') -Encoding utf8 }
}
function Update-Antigravity {
    Ensure-Directory $AntigravityTarget
    $geminiMd = Join-Path $AntigravityTarget 'GEMINI.md'
    $mode = Link-Or-CopyFile $geminiMd (Join-Path $canonicalCore 'AGENTS.md')
    $summary.Add("Antigravity GEMINI.md -> $mode")
    $summary.Add("Antigravity rules/skills -> canonical .agents")
}
function Test-FileSynced([string]$Target, [string]$Source) {
    if (-not (Test-Path -LiteralPath $Target) -or -not (Test-Path -LiteralPath $Source)) { return $false }
    if (Test-LinkTo $Target $Source) { return $true }
    return (Get-FileHash -LiteralPath $Target).Hash -eq (Get-FileHash -LiteralPath $Source).Hash
}
function Show-Status {
    [pscustomobject]@{ CanonicalCore=$canonicalCore; CanonicalExists=(Test-Path $canonicalCore); ClaudeExists=(Test-Path $ClaudeTarget); CodexExists=(Test-Path $CodexTarget); ClaudeWorkflow=(Test-LinkTo (Join-Path $ClaudeTarget 'claude-workflow') $canonicalCore); CodexWorkflow=(Test-LinkTo (Join-Path $CodexTarget 'claude-workflow') $canonicalCore); AntigravityExists=(Test-Path $AntigravityTarget); AntigravityLinked=(Test-FileSynced (Join-Path $AntigravityTarget 'GEMINI.md') (Join-Path $canonicalCore 'AGENTS.md')) } | Format-List
}
function Remove-Installed {
    foreach ($path in @((Join-Path $ClaudeTarget 'claude-workflow'),(Join-Path $CodexTarget 'claude-workflow'))) { if (Test-Path $path) { Backup-Path $path } }
    if (Test-Path $CanonicalTarget) { Backup-Path $CanonicalTarget }
    Log '已將受控 canonical 與相容連結移至備份；使用者設定檔未刪除。'
}

if ($Action -eq 'Status') { Show-Status; exit 0 }
if ($Action -eq 'Uninstall') { Remove-Installed; exit 0 }
Install-Canonical
if ($TargetAgent -in @('Claude','Both')) { Update-Claude }
if ($TargetAgent -in @('Codex','Both')) { Update-Codex }
if ($TargetAgent -in @('Antigravity','All')) { Update-Antigravity }
Log ''; Log '=== 安裝摘要 ==='; $summary | ForEach-Object { Log "- $_" }
Log "驗證: .\install.ps1 -Action Status -CanonicalTarget `"$CanonicalTarget`""
