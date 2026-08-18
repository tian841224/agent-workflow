# agent-workflow v4 installer for Windows PowerShell 5.1 and PowerShell 7.
[CmdletBinding()]
param(
    # v4 is a three-platform framework; 'Both' (Claude+Codex only) was the v3-era default and is
    # kept solely for backward compatibility with existing invocations that pass it explicitly.
    [Alias('Agent','Platform')][ValidateSet('Claude','Codex','Antigravity','Both','All')][string]$TargetAgent = 'All',
    [Alias('Target')][string]$ClaudeTarget = (Join-Path $env:USERPROFILE '.claude'),
    [string]$CodexTarget = (Join-Path $env:USERPROFILE '.codex'),
    [string]$AntigravityTarget = (Join-Path $env:USERPROFILE '.gemini'),
    [string]$StateRoot = (Join-Path $env:USERPROFILE '.agent-workflow'),
    [string]$CanonicalRoot = (Join-Path $env:USERPROFILE '.agents'),
    [string]$LegacyRoot = (Join-Path $env:USERPROFILE '.agents'),
    [ValidateSet('Install','Status','Repair','Uninstall','Verify')][string]$Action = 'Install',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot
$repoSharedRoot = Join-Path $repoRoot '.agents'
$runtimeRoot = Join-Path $StateRoot 'runtime'
$stateFile = Join-Path $StateRoot 'managed-runtime.json'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$managed = [System.Collections.Generic.List[object]]::new()
$forceOverwrite = ($Action -eq 'Repair')

# What this run last wrote to each managed path, so a re-install can tell "canonical evolved"
# (destination still matches what we delivered) from "someone edited the destination after we
# delivered it" (e.g. a runtime-only hotfix layered on top by hand). Without this, Install-File's
# same-hash/marker-text check cannot see that difference and silently clobbers local edits on
# every re-install.
$previousInstalledHashes = @{}
if (Test-Path -LiteralPath $stateFile) {
    try {
        $previousState = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($item in @($previousState.files)) {
            if ($item.path -and $item.sha256) { $previousInstalledHashes[$item.path] = $item.sha256 }
        }
    } catch {
        Write-Warning "could not read previous install state ($stateFile): $($_.Exception.Message); falling back to same-hash/marker detection only"
    }
}

function Ensure-Directory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        if ($DryRun) { Write-Output "[dry-run] mkdir $Path" }
        else { New-Item -ItemType Directory -Force -Path $Path | Out-Null }
    }
}

function Write-Utf8Json([string]$Path, $Value) {
    Ensure-Directory (Split-Path -Parent $Path)
    $json = $Value | ConvertTo-Json -Depth 30
    if ($DryRun) { Write-Output "[dry-run] write $Path"; return }
    [IO.File]::WriteAllText($Path, $json, $utf8NoBom)
    Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json | Out-Null
}

function Get-Hash([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# Every re-install that finds local drift creates one more `<name>.bak.<timestamp>` next to the
# original - a file via Backup-UserFile, a directory via Install-ManagedJunction. Neither path
# ever pruned old ones: `.system` alone accumulated 24 full copies of six Codex system skills
# because its junction check kept missing on repeat installs. Kept last N, called once right
# after each new backup is created (skipped in -DryRun, which never creates one to rotate).
$backupRetentionCount = 5
function Invoke-BackupRotation([string]$OriginalPath) {
    $parent = Split-Path -Parent $OriginalPath
    $leaf = Split-Path -Leaf $OriginalPath
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { return }
    $stale = Get-ChildItem -LiteralPath $parent -Filter "$leaf.bak.*" -Force -ErrorAction SilentlyContinue |
        Sort-Object -Property Name -Descending | Select-Object -Skip $backupRetentionCount
    foreach ($item in $stale) {
        Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Backup-UserFile([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $backup = "$Path.bak.$stamp"
    if ($DryRun) { Write-Output "[dry-run] backup $Path -> $backup" }
    else { Copy-Item -LiteralPath $Path -Destination $backup -Force; Invoke-BackupRotation $Path }
}

function Install-File([string]$Source, [string]$Destination, [string]$Kind = 'file') {
    Ensure-Directory (Split-Path -Parent $Destination)
    if (Test-Path -LiteralPath $Destination) {
        $destHash = Get-Hash $Destination
        $sourceHash = Get-Hash $Source
        $same = $destHash -eq $sourceHash
        if (-not $same -and -not $forceOverwrite) {
            $recordedHash = $previousInstalledHashes[$Destination]
            # Only a match against what THIS installer delivered last time means "safe, nobody
            # touched it since" - a missing record (pre-tracking install, or a file layered in by
            # hand and never installed by us) falls back to the old marker-text heuristic below,
            # same as before this check existed.
            if ($recordedHash -and $destHash -ne $recordedHash) {
                Write-Output "[install] kept local changes: $Destination differs from what agent-workflow last installed there ($($recordedHash.Substring(0,12))) and a newer canonical version is available. Not overwriting; re-run with -Action Repair to force the canonical version instead."
                $managed.Add([ordered]@{ path = $Destination; sha256 = $destHash; kind = $Kind })
                return
            }
        }
        $owned = $same -or (Select-String -LiteralPath $Destination -Pattern 'agent-workflow v4' -Quiet -ErrorAction SilentlyContinue)
        if (-not $owned) { Backup-UserFile $Destination }
    }
    if ($DryRun) { Write-Output "[dry-run] copy $Source -> $Destination" }
    else { Copy-Item -LiteralPath $Source -Destination $Destination -Force }
    $hash = if ($DryRun) { Get-Hash $Source } else { Get-Hash $Destination }
    $managed.Add([ordered]@{ path = $Destination; sha256 = $hash; kind = $Kind })
}

function Install-CanonicalSharedSources {
    foreach ($relative in @('agents\reviewer.md','agents\adversarial.md','agents\verifier.md','agents\retrospective.md','agents\worker.md')) {
        Install-File (Join-Path $repoSharedRoot $relative) (Join-Path $CanonicalRoot $relative) 'canonical-shared-source'
    }
    $repoSkillsRoot = Join-Path $repoSharedRoot 'skills'
    if (Test-Path -LiteralPath $repoSkillsRoot -PathType Container) {
        foreach ($skillDirectory in Get-ChildItem -LiteralPath $repoSkillsRoot -Directory) {
            foreach ($file in Get-ChildItem -LiteralPath $skillDirectory.FullName -Recurse -File) {
                $relative = $file.FullName.Substring($skillDirectory.FullName.Length).TrimStart('\','/')
                $canonicalSkillRoot = Join-Path (Join-Path $CanonicalRoot 'skills') $skillDirectory.Name
                Install-File $file.FullName (Join-Path $canonicalSkillRoot $relative) 'canonical-shared-source'
            }
        }
    }
}

function Get-SharedSource([string]$RelativePath) {
    if ($RelativePath -like 'agents/*' -or $RelativePath -like 'skills/*') {
        return Join-Path $CanonicalRoot ($RelativePath.Replace('/','\'))
    }
    return Join-Path $repoRoot ($RelativePath.Replace('/','\'))
}

function Get-UnmanagedEntrypointContent([string]$Path) {
    $begin = '<!-- agent-workflow v4 managed:start -->'
    $end = '<!-- agent-workflow v4 managed:end -->'
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
    $existing = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    return [regex]::Replace($existing, "(?s)\r?\n?$([regex]::Escape($begin)).*?$([regex]::Escape($end))\r?\n?", '').Replace("`r`n", "`n").Replace("`r", "`n").Trim()
}

function Test-HardLinkTo([string]$Path, [string]$Target) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $targetNorm = [IO.Path]::GetFullPath($Target).TrimEnd('\','/').ToLowerInvariant()
    foreach ($link in @(& fsutil hardlink list $Path 2>$null)) {
        $linkText = ([string]$link).Trim()
        if (-not $linkText) { continue }
        try { $linkNorm = [IO.Path]::GetFullPath($linkText).TrimEnd('\','/').ToLowerInvariant() } catch { continue }
        if ($linkNorm -eq $targetNorm) { return $true }
    }
    return $false
}

function Install-ManagedHardLink([string]$Source, [string]$Destination, [string]$Kind) {
    Ensure-Directory (Split-Path -Parent $Destination)
    $isLink = Test-HardLinkTo $Destination $Source
    if ($DryRun) {
        Write-Output "[dry-run] link $Destination -> $Source"
    } else {
        if ((Test-Path -LiteralPath $Destination) -and -not $isLink) {
            Backup-UserFile $Destination
            Remove-Item -LiteralPath $Destination -Force
        }
        if (-not $isLink) { New-Item -ItemType HardLink -Path $Destination -Target $Source | Out-Null }
    }
    $hash = if ($DryRun) { Get-Hash $Source } else { Get-Hash $Destination }
    $managed.Add([ordered]@{ path = $Destination; sha256 = $hash; kind = $Kind })
}

function Test-JunctionTo([string]$Path, [string]$Target) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
    try {
        $item = Get-Item -LiteralPath $Path -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { return $false }
        $targetNorm = [IO.Path]::GetFullPath($Target).TrimEnd('\','/').ToLowerInvariant()
        foreach ($candidate in @($item.Target)) {
            if (-not $candidate) { continue }
            $candidateNorm = [IO.Path]::GetFullPath([string]$candidate).TrimEnd('\','/').ToLowerInvariant()
            if ($candidateNorm -eq $targetNorm) { return $true }
        }
    } catch { return $false }
    return $false
}

function Remove-ManagedJunction([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        Write-Warning "Kept replaced managed skill directory: $Path"
        return
    }
    # Windows PowerShell 5.1's Remove-Item throws on directory reparse points.
    # Directory.Delete removes only the link, never the junction target.
    [IO.Directory]::Delete($Path, $false)
}

function Install-ManagedJunction([string]$Source, [string]$Destination, [string]$Kind) {
    Ensure-Directory (Split-Path -Parent $Destination)
    $isJunction = Test-JunctionTo $Destination $Source
    if ($DryRun) {
        Write-Output "[dry-run] junction $Destination -> $Source"
    } else {
        if ((Test-Path -LiteralPath $Destination) -and -not $isJunction) {
            $backup = "$Destination.bak.$stamp"
            Move-Item -LiteralPath $Destination -Destination $backup -Force
            Invoke-BackupRotation $Destination
        }
        if (-not $isJunction) { New-Item -ItemType Junction -Path $Destination -Target $Source | Out-Null }
    }
    $managed.Add([ordered]@{ path = $Destination; sha256 = ''; kind = $Kind })
}

function Install-CanonicalEntrypoints([string]$Source, [string]$CanonicalPath, [string[]]$Destinations, [string[]]$ExistingPaths) {
    $begin = '<!-- agent-workflow v4 managed:start -->'
    $end = '<!-- agent-workflow v4 managed:end -->'
    $managedContent = Get-Content -LiteralPath $Source -Raw -Encoding UTF8
    $prefixes = New-Object System.Collections.Generic.List[string]
    foreach ($path in @($CanonicalPath) + @($ExistingPaths)) {
        $prefix = Get-UnmanagedEntrypointContent $path
        if ($prefix -and -not $prefixes.Contains($prefix)) { $prefixes.Add($prefix) }
    }
    if ($prefixes.Count -gt 1) {
        foreach ($path in @($CanonicalPath) + @($ExistingPaths)) {
            if (Test-Path -LiteralPath $path -PathType Leaf) { Backup-UserFile $path }
        }
        throw 'Conflicting unmanaged entrypoint content found; review timestamp backups before linking global AGENTS.md.'
    }
    $prefix = if ($prefixes.Count -eq 1) { $prefixes[0] } else { '' }
    $contentPrefix = if ($prefix) { $prefix + "`r`n`r`n" } else { '' }
    $content = $contentPrefix + $begin + "`r`n" + $managedContent.Trim() + "`r`n" + $end + "`r`n"

    Ensure-Directory (Split-Path -Parent $CanonicalPath)
    if ((Test-Path -LiteralPath $CanonicalPath) -and -not $DryRun) { Backup-UserFile $CanonicalPath }
    if ($DryRun) { Write-Output "[dry-run] merge canonical entrypoint $CanonicalPath" }
    else { [IO.File]::WriteAllText($CanonicalPath, $content, $utf8NoBom) }
    $canonicalHash = if ($DryRun) { Get-Hash $Source } else { Get-Hash $CanonicalPath }
    $managed.Add([ordered]@{ path = $CanonicalPath; sha256 = $canonicalHash; kind = 'canonical-entrypoint' })

    foreach ($destination in $Destinations) {
        Ensure-Directory (Split-Path -Parent $destination)
        $isLink = Test-HardLinkTo $destination $CanonicalPath
        if ($DryRun) {
            Write-Output "[dry-run] link $destination -> $CanonicalPath"
        } else {
            if ((Test-Path -LiteralPath $destination) -and -not $isLink) {
                Backup-UserFile $destination
                Remove-Item -LiteralPath $destination -Force
            }
            if (-not $isLink) { New-Item -ItemType HardLink -Path $destination -Target $CanonicalPath | Out-Null }
        }
        $managed.Add([ordered]@{ path = $destination; sha256 = $canonicalHash; kind = 'canonical-hardlink' })
    }
}

function Get-CanonicalAgent([string]$Name) {
    $path = Join-Path $CanonicalRoot "agents\$Name.md"
    $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8
    $description = if ($raw -match '(?m)^description:\s*(.+)$') { $Matches[1].Trim() } else { "$Name agent" }
    $body = [regex]::Replace($raw, '(?s)^---\s*.*?\s*---\s*', '').Trim()
    return [pscustomobject]@{ Name = $Name; Description = $description; Body = $body; Path = $path }
}

function Write-CodexAgent([string]$Name, [string]$Destination) {
    $agent = Get-CanonicalAgent $Name
    $description = $agent.Description.Replace('"','\"')
    $body = $agent.Body.Replace("'''", "' ' '")
    $content = @(
        '# agent-workflow v4 managed agent'
        ('name = "agent-workflow-{0}"' -f $Name)
        ('description = "{0}"' -f $description)
        'sandbox_mode = "read-only"'
        "developer_instructions = '''"
        $body
        "'''"
        ''
    ) -join "`n"
    $canonicalDestination = Join-Path $CanonicalRoot "agents\platforms\codex\agent-workflow-$Name.toml"
    Ensure-Directory (Split-Path -Parent $canonicalDestination)
    if ((Test-Path -LiteralPath $canonicalDestination) -and -not $DryRun) { Backup-UserFile $canonicalDestination }
    if ($DryRun) { Write-Output "[dry-run] generate $canonicalDestination" }
    else { [IO.File]::WriteAllText($canonicalDestination, $content, $utf8NoBom) }
    $hash = if ($DryRun) { '' } else { Get-Hash $canonicalDestination }
    $managed.Add([ordered]@{ path = $canonicalDestination; sha256 = $hash; kind = 'canonical-agent-adapter' })
    Install-ManagedHardLink $canonicalDestination $Destination 'canonical-agent-hardlink'
}

function Write-MarkdownAgent([string]$Name, [string]$Destination) {
    # Claude and Antigravity both consume plain markdown and apply the identical name: rewrite
    # below, so they share one generated adapter instead of each getting their own byte-identical
    # copy under agents\platforms\<platform>\.
    $source = Join-Path $CanonicalRoot "agents\$Name.md"
    $content = Get-Content -LiteralPath $source -Raw -Encoding UTF8
    $content = [regex]::Replace($content, '(?m)^name:\s*.+$', "name: agent-workflow-$Name", 1)
    $canonicalDestination = Join-Path $CanonicalRoot "agents\platforms\markdown\agent-workflow-$Name.md"
    Ensure-Directory (Split-Path -Parent $canonicalDestination)
    if ((Test-Path -LiteralPath $canonicalDestination) -and -not $DryRun) { Backup-UserFile $canonicalDestination }
    if ($DryRun) { Write-Output "[dry-run] generate $canonicalDestination" }
    else { [IO.File]::WriteAllText($canonicalDestination, $content, $utf8NoBom) }
    $hash = if ($DryRun) { '' } else { Get-Hash $canonicalDestination }
    $managed.Add([ordered]@{ path = $canonicalDestination; sha256 = $hash; kind = 'canonical-agent-adapter' })
    Install-ManagedHardLink $canonicalDestination $Destination 'canonical-agent-hardlink'
}

# v3 shipped its own hook scripts under "<platform-root>\hooks\ai-workflow\..." (e.g.
# ~/.claude/hooks/ai-workflow/post-edit-check.ps1). Backup-V3Runtime already moves that whole
# directory out of the way on activation, but nothing ever removed the settings.json/hooks.json
# entries that point at it - so every turn kept invoking commands whose target no longer exists.
# Matched as a path-segment string, same convention as the v4 $HooksDir check below: cheap,
# does not need to resolve any path (the v3 directory may already be gone), and cannot collide
# with a real user-authored hook that happens to live somewhere else.
$legacyHookMarker = '\hooks\ai-workflow\'

function Test-ManagedHookCommand([string]$Command, [string]$HooksDir) {
    if (-not $Command) { return $false }
    $needle = [IO.Path]::GetFullPath($HooksDir).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    if ($Command.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    return $Command.IndexOf($legacyHookMarker, [StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Remove-ManagedHookCommands($Entry, [string]$HooksDir) {
    if ($null -eq $Entry) { return $null }
    if ($Entry.PSObject.Properties['command']) {
        if (Test-ManagedHookCommand ([string]$Entry.command) $HooksDir) { return $null }
        return $Entry
    }
    if ($Entry.PSObject.Properties['hooks']) {
        $keptHooks = @($Entry.hooks | Where-Object { $null -ne $_ -and -not (Test-ManagedHookCommand ([string]$_.command) $HooksDir) })
        if ($keptHooks.Count -eq 0) { return $null }
        $Entry | Add-Member NoteProperty hooks $keptHooks -Force
    }
    return $Entry
}

function Merge-Hooks([string]$Source, [string]$Destination, [string]$HooksDir, [switch]$TopLevel) {
    $escapedHooksDir = $HooksDir.Replace('\', '\\').Replace('"', '\"')
    $fragmentRaw = (Get-Content -LiteralPath $Source -Raw -Encoding UTF8).Replace('{{HOOKS_DIR}}', $escapedHooksDir)
    $fragment = $fragmentRaw | ConvertFrom-Json
    $data = if (Test-Path -LiteralPath $Destination) { Get-Content -LiteralPath $Destination -Raw -Encoding UTF8 | ConvertFrom-Json } else { [pscustomobject]@{} }

    if ($TopLevel) {
        foreach ($old in @($data.PSObject.Properties.Name | Where-Object { $_ -like 'agent-workflow-*' })) { $data.PSObject.Properties.Remove($old) }
        foreach ($property in $fragment.PSObject.Properties) { $data | Add-Member NoteProperty $property.Name $property.Value -Force }
    } else {
        if (-not $data.PSObject.Properties['hooks']) { $data | Add-Member NoteProperty hooks ([pscustomobject]@{}) }
        # Sweep legacy/managed entries from EVERY event already in the destination file, not
        # just the events this fragment happens to define. v3 registered hooks under
        # PostToolUse and SessionEnd that v4 has no equivalent for; a loop scoped to
        # $fragment.hooks.PSObject.Properties never visits those event names at all, so their
        # v3 entries survived every repair untouched (confirmed on a real profile: v3's
        # post-edit-check.ps1 and log-session.ps1 were still present after a Repair that was
        # specifically supposed to remove them).
        # @() around an empty PSCustomObject's .Properties.Name does NOT yield an empty array in
        # PowerShell 5.1 - it yields a single-element array containing $null - so a fresh
        # install (no pre-existing hooks object) would otherwise iterate once with a null event
        # name and crash Add-Member below with "Cannot bind argument to parameter 'Name'".
        foreach ($existingEventName in @($data.hooks.PSObject.Properties.Name | Where-Object { $_ })) {
            $swept = @($data.hooks.$existingEventName | ForEach-Object { Remove-ManagedHookCommands $_ $HooksDir } | Where-Object { $null -ne $_ })
            $data.hooks | Add-Member NoteProperty $existingEventName $swept -Force
        }
        foreach ($event in $fragment.hooks.PSObject.Properties) {
            $kept = @($data.hooks.$($event.Name))
            $data.hooks | Add-Member NoteProperty $event.Name (@($kept) + @($event.Value)) -Force
        }
    }
    if ((Test-Path -LiteralPath $Destination) -and -not $DryRun) { Backup-UserFile $Destination }
    Write-Utf8Json $Destination $data
    $managed.Add([ordered]@{ path = $Destination; sha256 = ''; kind = 'merged-hooks' })
}

function Install-Runtime {
    $manifest = Get-Content -LiteralPath (Join-Path $repoRoot 'adapters\managed-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($relative in $manifest.runtime) {
        $destination = Join-Path $runtimeRoot $relative
        if ($relative -in @('agents/reviewer.md','agents/adversarial.md','agents/verifier.md','agents/retrospective.md','agents/worker.md','skills/workflow/SKILL.md','skills/workflow/risk-flags.md','skills/workflow/orchestration.md','skills/workflow/project-docs.md')) {
            Install-ManagedHardLink (Get-SharedSource $relative) $destination 'canonical-shared-hardlink'
        } else {
            Install-File (Get-SharedSource $relative) $destination 'runtime'
        }
    }
}

function Install-CanonicalSkillLinks([string]$DestinationSkillsRoot) {
    $canonicalSkillsRoot = Join-Path $CanonicalRoot 'skills'
    if (-not (Test-Path -LiteralPath $canonicalSkillsRoot -PathType Container)) { return }
    foreach ($skillDirectory in Get-ChildItem -LiteralPath $canonicalSkillsRoot -Directory) {
        Install-ManagedJunction $skillDirectory.FullName (Join-Path $DestinationSkillsRoot $skillDirectory.Name) 'canonical-skill-junction'
    }
}

function Install-Claude {
    # worker is Claude-only in v1: Codex and Antigravity fan-out is unverified, so no adapter is generated there.
    foreach ($name in @('reviewer','adversarial','verifier','retrospective','worker')) { Write-MarkdownAgent $name (Join-Path $ClaudeTarget "agents\agent-workflow-$name.md") }
    Install-CanonicalSkillLinks (Join-Path $ClaudeTarget 'skills')
    Merge-Hooks (Join-Path $repoRoot 'adapters\claude\settings.hooks.json') (Join-Path $ClaudeTarget 'settings.json') (Join-Path $runtimeRoot 'hooks')
}

function Install-Codex {
    foreach ($name in @('reviewer','adversarial','verifier','retrospective')) { Write-CodexAgent $name (Join-Path $CodexTarget "agents\agent-workflow-$name.toml") }
    Install-CanonicalSkillLinks (Join-Path $CodexTarget 'skills')
    Install-File (Join-Path $repoRoot 'adapters\codex\execpolicy.rules') (Join-Path $CodexTarget 'rules\agent-workflow.rules') 'rules'
    Merge-Hooks (Join-Path $repoRoot 'adapters\codex\hooks.json') (Join-Path $CodexTarget 'hooks.json') (Join-Path $runtimeRoot 'hooks')
}

# Get-CodexHookStateKeys / Get-UntrustedCodexHookKeys: shared with runtime-check.ps1 - see
# codex-hook-trust.ps1 for why this is dot-sourced rather than copied.
. (Join-Path $PSScriptRoot 'scripts\codex-hook-trust.ps1')

# install.ps1 can write hooks.json but cannot grant trust - that only happens inside an
# interactive Codex session - so a v4 hook can be correctly installed and still silently never
# execute. "managed" here means Test-ManagedHookCommand's definition (matches the current
# HooksDir; also matches legacy v3 markers, harmlessly - a leftover v3 entry would never have a
# trust key shaped like a v4 one anyway).
function Get-UntrustedCodexHooks([string]$HooksJsonPath, [string]$ConfigPath, [string]$HooksDir) {
    return Get-UntrustedCodexHookKeys $HooksJsonPath $ConfigPath { param($cmd) Test-ManagedHookCommand $cmd $HooksDir }
}

function Install-Antigravity {
    foreach ($name in @('reviewer','adversarial','verifier','retrospective')) { Write-MarkdownAgent $name (Join-Path $AntigravityTarget "config\agents\agent-workflow-$name\agent.md") }
    Install-CanonicalSkillLinks (Join-Path $AntigravityTarget 'config\skills')
    Install-File (Join-Path $repoRoot 'adapters\antigravity\workflows\agent-workflow.md') (Join-Path $AntigravityTarget 'config\global_workflows\agent-workflow.md') 'workflow'
    Merge-Hooks (Join-Path $repoRoot 'adapters\antigravity\hooks.json') (Join-Path $AntigravityTarget 'config\hooks.json') (Join-Path $runtimeRoot 'hooks') -TopLevel
}

function Test-LegacyKnowledge {
    if (Test-Path -LiteralPath (Join-Path $StateRoot 'activation.json')) { return $false }
    # v3-specific paths only. The previous version scanned .claude/projects (recursively, so it
    # swept up every project's own memory/*.md) and .codex/memories wholesale - both are where
    # Claude and Codex write their ORDINARY NATIVE memory, unrelated to this framework. Any
    # machine that had ever used platform memory, v3 or not, was refused installation by this
    # check; knowledge.ps1's own Get-NativeMemoryFile treats the same two paths as native-only.
    $legacyPaths = @(
        (Join-Path $ClaudeTarget 'agent-workflow'),
        (Join-Path $CodexTarget 'agent-workflow'),
        (Join-Path $LegacyRoot 'workflow')
    )
    foreach ($path in $legacyPaths) {
        if (Test-Path -LiteralPath $path) { return $true }
    }
    # A real v3 signal even inside the native memory roots: v3 tagged its own knowledge/history
    # notes with this marker (same string Backup-V3Runtime already checks for legacy reviewers
    # below), so a plain native memory file - which never contains it - is left alone.
    $markerCandidates = @(
        (Join-Path $ClaudeTarget 'memory'),
        (Join-Path $ClaudeTarget 'projects'),
        (Join-Path $CodexTarget 'memories')
    )
    foreach ($candidate in $markerCandidates) {
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        $hit = Get-ChildItem -LiteralPath $candidate -Recurse -File -Include '*.md','*.txt' -ErrorAction SilentlyContinue |
            Select-String -Pattern 'managed by agent-workflow v3|agent-workflow v3' -Quiet -ErrorAction SilentlyContinue
        if ($hit) { return $true }
    }
    return $false
}

function Backup-V3Runtime {
    $backupRoot = Join-Path $StateRoot "imports\v3-runtime-backup-$stamp"
    $legacyRoot = $LegacyRoot
    $paths = @(
        (Join-Path $ClaudeTarget 'agent-workflow'),
        (Join-Path $CodexTarget 'agent-workflow'),
        (Join-Path $ClaudeTarget 'agents\architect.md'),
        (Join-Path $ClaudeTarget 'agents\pm.md'),
        (Join-Path $ClaudeTarget 'agents\qa.md'),
        (Join-Path $ClaudeTarget 'agents\debugger.md'),
        (Join-Path $ClaudeTarget 'agents\security-engineer.md'),
        (Join-Path $ClaudeTarget 'agents\refactoring-expert.md'),
        (Join-Path $CodexTarget 'agents\architect.toml'),
        (Join-Path $CodexTarget 'agents\pm.toml'),
        (Join-Path $CodexTarget 'agents\qa.toml'),
        (Join-Path $CodexTarget 'agents\debugger.toml'),
        (Join-Path $AntigravityTarget 'config\agents\architect'),
        (Join-Path $AntigravityTarget 'config\agents\pm'),
        (Join-Path $AntigravityTarget 'config\agents\qa'),
        (Join-Path $AntigravityTarget 'config\agents\debugger'),
        (Join-Path $AntigravityTarget 'config\agents\security-engineer'),
        (Join-Path $AntigravityTarget 'config\agents\refactoring-expert'),
        (Join-Path $ClaudeTarget 'hooks\ai-workflow'),
        (Join-Path $CodexTarget 'hooks\ai-workflow'),
        (Join-Path $legacyRoot 'workflow'),
        (Join-Path $legacyRoot 'agents\architect.md'),
        (Join-Path $legacyRoot 'agents\pm.md'),
        (Join-Path $legacyRoot 'agents\qa.md'),
        (Join-Path $legacyRoot 'agents\debugger.md')
    )
    foreach ($skill in @('tdd','systematic-debugging','design-principles','karpathy-guidelines','learn')) {
        $paths += (Join-Path $ClaudeTarget "skills\$skill")
        $paths += (Join-Path $CodexTarget "skills\$skill")
        $paths += (Join-Path $AntigravityTarget "config\skills\$skill")
        $paths += (Join-Path $legacyRoot "skills\$skill")
    }
    $paths += (Join-Path $legacyRoot 'rules\learning.md')
    $legacyReviewers = @(
        (Join-Path $ClaudeTarget 'agents\reviewer.md'),
        (Join-Path $CodexTarget 'agents\reviewer.toml'),
        (Join-Path $AntigravityTarget 'config\agents\reviewer'),
        (Join-Path $legacyRoot 'agents\reviewer.md')
    )
    foreach ($candidate in $legacyReviewers) {
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        $probe = if (Test-Path -LiteralPath $candidate -PathType Container) { Get-ChildItem -LiteralPath $candidate -File | Select-Object -First 1 } else { Get-Item -LiteralPath $candidate }
        if ($probe -and (Select-String -LiteralPath $probe.FullName -Pattern 'managed by agent-workflow v3|agent-workflow v3' -Quiet)) { $paths += $candidate }
    }
    foreach ($path in $paths) {
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $key = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($path)).TrimEnd('=').Replace('/','_').Replace('+','-')
        $destination = Join-Path $backupRoot ($key + '-' + [IO.Path]::GetFileName($path))
        Ensure-Directory $backupRoot
        if ($DryRun) { Write-Output "[dry-run] move legacy $path -> $destination" }
        else { Move-Item -LiteralPath $path -Destination $destination -Force }
    }
}

function Remove-ManagedHooks([string]$Path, [switch]$TopLevel) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $data = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($TopLevel) {
        foreach ($name in @($data.PSObject.Properties.Name | Where-Object { $_ -like 'agent-workflow-*' })) { $data.PSObject.Properties.Remove($name) }
    } elseif ($data.PSObject.Properties['hooks']) {
        foreach ($event in @($data.hooks.PSObject.Properties)) {
            $hooksDir = Join-Path $runtimeRoot 'hooks'
            $kept = @($event.Value | ForEach-Object { Remove-ManagedHookCommands $_ $hooksDir } | Where-Object { $null -ne $_ })
            $data.hooks | Add-Member NoteProperty $event.Name $kept -Force
        }
    }
    Write-Utf8Json $Path $data
}

function Show-Status {
    $activation = Join-Path $StateRoot 'activation.json'
    [pscustomobject]@{
        version = 4
        state_root = $StateRoot
        canonical_entrypoint = (Test-Path -LiteralPath (Join-Path $CanonicalRoot 'AGENTS.md') -PathType Leaf)
        canonical_reviewer = (Test-Path -LiteralPath (Join-Path $CanonicalRoot 'agents\reviewer.md') -PathType Leaf)
        canonical_verifier = (Test-Path -LiteralPath (Join-Path $CanonicalRoot 'agents\verifier.md') -PathType Leaf)
        canonical_workflow_skill = (Test-Path -LiteralPath (Join-Path $CanonicalRoot 'skills\workflow\SKILL.md') -PathType Leaf)
        claude_entrypoint_linked = (Test-HardLinkTo (Join-Path $ClaudeTarget 'CLAUDE.md') (Join-Path $CanonicalRoot 'AGENTS.md'))
        codex_entrypoint_linked = (Test-HardLinkTo (Join-Path $CodexTarget 'AGENTS.md') (Join-Path $CanonicalRoot 'AGENTS.md'))
        antigravity_entrypoint_linked = (Test-HardLinkTo (Join-Path $AntigravityTarget 'GEMINI.md') (Join-Path $CanonicalRoot 'AGENTS.md'))
        claude_workflow_skill_linked = (Test-JunctionTo (Join-Path $ClaudeTarget 'skills\workflow') (Join-Path $CanonicalRoot 'skills\workflow'))
        codex_workflow_skill_linked = (Test-JunctionTo (Join-Path $CodexTarget 'skills\workflow') (Join-Path $CanonicalRoot 'skills\workflow'))
        antigravity_workflow_skill_linked = (Test-JunctionTo (Join-Path $AntigravityTarget 'config\skills\workflow') (Join-Path $CanonicalRoot 'skills\workflow'))
        runtime_installed = (Test-Path -LiteralPath (Join-Path $runtimeRoot 'AGENTS.md'))
        migration_activated = (Test-Path -LiteralPath $activation)
        claude_reviewer = (Test-Path -LiteralPath (Join-Path $ClaudeTarget 'agents\agent-workflow-reviewer.md'))
        codex_reviewer = (Test-Path -LiteralPath (Join-Path $CodexTarget 'agents\agent-workflow-reviewer.toml'))
        antigravity_reviewer = (Test-Path -LiteralPath (Join-Path $AntigravityTarget 'config\agents\agent-workflow-reviewer\agent.md'))
    } | ConvertTo-Json -Depth 4
}

function Uninstall-Managed {
    if (-not (Test-Path -LiteralPath $stateFile)) { Write-Output 'No v4 managed-runtime manifest found.'; return }
    $state = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($item in $state.files) {
        if ($item.kind -eq 'canonical-skill-junction') {
            if (Test-Path -LiteralPath $item.path -PathType Container) {
                if ($DryRun) { Write-Output "[dry-run] remove $($item.path)" }
                else { Remove-ManagedJunction $item.path }
            }
            continue
        }
        if ($item.kind -in @('merged-hooks','merged-entrypoint','canonical-entrypoint','canonical-hardlink','canonical-shared','canonical-shared-source','canonical-agent-adapter')) { continue }
        if (-not (Test-Path -LiteralPath $item.path -PathType Leaf)) { continue }
        if ($item.sha256 -and (Get-Hash $item.path) -ne $item.sha256) {
            Write-Warning "Kept modified managed file: $($item.path)"
            continue
        }
        if ($DryRun) { Write-Output "[dry-run] remove $($item.path)" }
        else { Remove-Item -LiteralPath $item.path -Force }
    }
    Remove-ManagedHooks (Join-Path $ClaudeTarget 'settings.json')
    Remove-ManagedHooks (Join-Path $CodexTarget 'hooks.json')
    Remove-ManagedHooks (Join-Path $AntigravityTarget 'config\hooks.json') -TopLevel
    foreach ($entrypoint in @((Join-Path $ClaudeTarget 'CLAUDE.md'),(Join-Path $CodexTarget 'AGENTS.md'),(Join-Path $AntigravityTarget 'GEMINI.md'))) {
        if (-not (Test-Path -LiteralPath $entrypoint)) { continue }
        $existing = Get-Content -LiteralPath $entrypoint -Raw -Encoding UTF8
        $clean = [regex]::Replace($existing, '(?s)\r?\n?<!-- agent-workflow v4 managed:start -->.*?<!-- agent-workflow v4 managed:end -->\r?\n?', '').Trim()
        if ($DryRun) { Write-Output "[dry-run] remove managed block from $entrypoint" }
        elseif ($clean) { [IO.File]::WriteAllText($entrypoint, $clean + "`r`n", $utf8NoBom) }
        else { Remove-Item -LiteralPath $entrypoint -Force }
    }
    $canonicalPath = Join-Path $CanonicalRoot 'AGENTS.md'
    if (Test-Path -LiteralPath $canonicalPath -PathType Leaf) {
        $cleanCanonical = Get-UnmanagedEntrypointContent $canonicalPath
        if ($DryRun) { Write-Output "[dry-run] remove managed block from $canonicalPath" }
        elseif ($cleanCanonical) { [IO.File]::WriteAllText($canonicalPath, $cleanCanonical + "`r`n", $utf8NoBom) }
        else { Remove-Item -LiteralPath $canonicalPath -Force }
    }
    Write-Output 'Managed runtime removed. Knowledge, projects, tasks, and imports were preserved.'
}

if ($Action -eq 'Status') { Show-Status; exit 0 }
if ($Action -eq 'Uninstall') { Uninstall-Managed; exit 0 }
# Verify answers the question Status does not: is the runtime that is actually loaded still
# intact, still parseable, and still the current repo version. It reads only, so it is safe to
# run at any time, and it exits non-zero so it can gate a script.
if ($Action -eq 'Verify') {
    & (Join-Path $repoRoot 'scripts\runtime-check.ps1') -StateRoot $StateRoot
    exit $LASTEXITCODE
}
if (Test-LegacyKnowledge) { throw 'v3 knowledge or history was found. Run migrate-v3.ps1 through Validate and Activate before installing v4.' }

Install-CanonicalSharedSources
Install-Runtime
$allEntrypointPaths = @(
    (Join-Path $ClaudeTarget 'CLAUDE.md'),
    (Join-Path $CodexTarget 'AGENTS.md'),
    (Join-Path $AntigravityTarget 'GEMINI.md')
)
$entrypointDestinations = @()
if ($TargetAgent -in @('Claude','Both','All')) { $entrypointDestinations += $allEntrypointPaths[0] }
if ($TargetAgent -in @('Codex','Both','All')) { $entrypointDestinations += $allEntrypointPaths[1] }
if ($TargetAgent -in @('Antigravity','All')) { $entrypointDestinations += $allEntrypointPaths[2] }
Install-CanonicalEntrypoints (Join-Path $runtimeRoot 'AGENTS.md') (Join-Path $CanonicalRoot 'AGENTS.md') $entrypointDestinations $allEntrypointPaths
if ($TargetAgent -in @('Claude','Both','All')) { Install-Claude }
if ($TargetAgent -in @('Codex','Both','All')) { Install-Codex }
if ($TargetAgent -in @('Antigravity','All')) { Install-Antigravity }

if ($TargetAgent -in @('Codex','Both','All') -and -not $DryRun) {
    $untrustedCodexHooks = @(Get-UntrustedCodexHooks (Join-Path $CodexTarget 'hooks.json') (Join-Path $CodexTarget 'config.toml') (Join-Path $runtimeRoot 'hooks'))
    if ($untrustedCodexHooks.Count -gt 0) {
        Write-Output "[install] Codex has not trusted $($untrustedCodexHooks.Count) agent-workflow hook(s) yet - they were written to hooks.json but will not run until trusted:"
        foreach ($key in $untrustedCodexHooks) { Write-Output "  - $key" }
        Write-Output '[install] Open an interactive Codex session in this profile and approve the hook trust prompt (or use the config/batchWrite app-server method) before relying on git-guard/impact-guard/quality-gate on Codex.'
    }
}

Backup-V3Runtime

$state = [ordered]@{
    schema_version = 4
    installed_at = (Get-Date).ToString('o')
    source = $repoRoot
    files = @($managed)
}
Write-Utf8Json $stateFile $state
Write-Output "agent-workflow v4 $Action complete for $TargetAgent."
