# agent-workflow v4 one-time knowledge and history migration.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Inventory','DryRun','Stage','Validate','Activate')][string]$Action,
    [string]$StateRoot = (Join-Path $env:USERPROFILE '.agent-workflow'),
    [string]$ClaudeRoot = (Join-Path $env:USERPROFILE '.claude'),
    [string]$CodexRoot = (Join-Path $env:USERPROFILE '.codex'),
    [string]$RepoSearchRoot = (Join-Path $env:USERPROFILE 'Documents'),
    [string]$RunId,
    [string]$AcceptUnresolvedManifestHash
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$importsRoot = Join-Path $StateRoot 'imports'

function Ensure-Directory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Force -Path $Path | Out-Null }
}

function Write-Utf8Json([string]$Path, $Value) {
    Ensure-Directory (Split-Path -Parent $Path)
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 40), $utf8NoBom)
    Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json | Out-Null
}

function Get-Hash([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TextHash([string]$Value) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
        return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally { $sha.Dispose() }
}

function Get-StableId([string]$Value) { return (Get-TextHash $Value).Substring(0, 16) }

function Normalize-Path([string]$Value) {
    return ([IO.Path]::GetFullPath($Value).TrimEnd('\', '/').Replace('\', '/').ToLowerInvariant())
}

function Get-ImportDirectory {
    if ($RunId) {
        $path = Join-Path $importsRoot $RunId
        if (-not (Test-Path -LiteralPath $path)) { throw "Import run not found: $RunId" }
        return $path
    }
    $latest = Get-ChildItem -LiteralPath $importsRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'manifest.json') } |
        Sort-Object Name -Descending | Select-Object -First 1
    if (-not $latest) { throw 'No migration inventory exists. Run -Action Inventory first.' }
    return $latest.FullName
}

function Save-Manifest([string]$Path, $Manifest) {
    $Manifest.manifest_hash = ''
    $json = $Manifest | ConvertTo-Json -Depth 40
    $Manifest.manifest_hash = Get-TextHash $json
    Write-Utf8Json $Path $Manifest
}

function Resolve-GitProject([string]$Path) {
    $directory = if (Test-Path -LiteralPath $Path -PathType Container) { $Path } else { Split-Path -Parent $Path }
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & git -C $directory rev-parse --is-inside-work-tree 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { return $null }
        $root = (& git -C $directory rev-parse --show-toplevel).Trim()
        $commonRaw = (& git -C $directory rev-parse --git-common-dir).Trim()
        $common = if ([IO.Path]::IsPathRooted($commonRaw)) { [IO.Path]::GetFullPath($commonRaw) } else { [IO.Path]::GetFullPath((Join-Path $root $commonRaw)) }
        $remoteOut = & git -C $directory config --get remote.origin.url 2>$null
        $remote = if ($LASTEXITCODE -eq 0 -and $remoteOut) { ($remoteOut | Select-Object -First 1).Trim().ToLowerInvariant() } else { '' }
        $roots = @(& git -C $directory rev-list --max-parents=0 HEAD 2>$null | Sort-Object)
        $fingerprint = if ($LASTEXITCODE -eq 0 -and $roots.Count -gt 0) { ($roots -join ',').ToLowerInvariant() } else { '' }
        $identity = $common.Replace('\','/').ToLowerInvariant() + '|' + $remote + '|' + $fingerprint
        return [pscustomobject]@{ id = Get-StableId $identity; root = $root; common_dir = $common; remote = $remote; repo_fingerprint = $fingerprint }
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
}

function Get-Classification([IO.FileInfo]$File, [string]$Origin) {
    $path = $File.FullName
    $lower = $path.ToLowerInvariant()
    if ($File.Extension -notin @('.md','.txt','.json')) { return [pscustomobject]@{ category='excluded'; project_id=''; reason='unsupported file type' } }
    if ($lower -match '[\\/](transcripts?|tool-results?|cache|build|dist|bin|obj)[\\/]' -or $File.Name -match '(?i)(credential|secret|token|cookie)') {
        return [pscustomobject]@{ category='excluded'; project_id=''; reason='runtime, build, transcript, or credential data' }
    }
    $candidateText = Get-Content -LiteralPath $path -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    if ($candidateText -match '(?i)-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]+|\b(password|secret|token|api[_-]?key|connection[_-]?string)\s*[:=]\s*[^\s`]+') {
        return [pscustomobject]@{ category='excluded'; project_id=''; reason='content appears to contain credential material' }
    }
    if ($lower -match '[\\/]acceptance[\\/]' -or $File.Name -match '(?i)^(spec|checklist|plan|mini-spec)\.md$') {
        $project = Resolve-GitProject $path
        $id = if ($project) { $project.id } else { '' }
        $reason = if ($id) { '' } else { 'project mapping required' }
        $projectRoot = if ($project) { $project.root } else { '' }
        $commonDir = if ($project) { $project.common_dir } else { '' }
        $remote = if ($project) { $project.remote } else { '' }
        $fingerprint = if ($project) { $project.repo_fingerprint } else { '' }
        return [pscustomobject]@{ category='history'; project_id=$id; project_root=$projectRoot; git_common_dir=$commonDir; remote=$remote; repo_fingerprint=$fingerprint; reason=$reason }
    }
    if ($Origin -eq 'global') { return [pscustomobject]@{ category='global-knowledge'; project_id=''; project_root=''; git_common_dir=''; remote=''; repo_fingerprint=''; reason='' } }
    $gitProject = Resolve-GitProject $path
    if ($gitProject) { return [pscustomobject]@{ category='project-knowledge'; project_id=$gitProject.id; project_root=$gitProject.root; git_common_dir=$gitProject.common_dir; remote=$gitProject.remote; repo_fingerprint=$gitProject.repo_fingerprint; reason='' } }
    if ($Origin -eq 'project-memory') {
        return [pscustomobject]@{ category='unresolved'; project_id=''; project_root=''; git_common_dir=''; remote=''; repo_fingerprint=''; reason='legacy project slug has no verified repository mapping' }
    }
    return [pscustomobject]@{ category='unresolved'; project_id=''; project_root=''; git_common_dir=''; remote=''; repo_fingerprint=''; reason='no reliable project or global mapping' }
}

function Add-Candidate([Collections.Generic.List[object]]$List, [string]$Path, [string]$Origin) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
    $file = Get-Item -LiteralPath $Path
    $classification = Get-Classification $file $Origin
    $status = if ($classification.category -eq 'excluded') { 'excluded' } elseif ($classification.category -eq 'unresolved' -or $classification.reason -eq 'project mapping required') { 'unresolved' } else { 'pending' }
    $List.Add([ordered]@{
        source_path = $file.FullName
        origin = $Origin
        category = $classification.category
        project_id = $classification.project_id
        project_root = [string]$classification.project_root
        git_common_dir = [string]$classification.git_common_dir
        remote = [string]$classification.remote
        repo_fingerprint = [string]$classification.repo_fingerprint
        topic = [IO.Path]::GetFileNameWithoutExtension($file.Name).ToLowerInvariant()
        sha256 = Get-Hash $file.FullName
        bytes = $file.Length
        status = $status
        reason = $classification.reason
        snapshot_path = ''
        destination = ''
        relationships = @()
    })
}

function Invoke-Inventory {
    $id = if ($RunId) { $RunId } else { Get-Date -Format 'yyyyMMdd-HHmmss' }
    $runDir = Join-Path $importsRoot $id
    if (Test-Path -LiteralPath (Join-Path $runDir 'manifest.json')) {
        Write-Output "Inventory ${id} already exists; no duplicate run was created."
        return
    }
    Ensure-Directory $runDir
    $sources = [Collections.Generic.List[object]]::new()
    $seen = @{}

    $roots = @(
        [pscustomobject]@{ path=(Join-Path $ClaudeRoot 'memory'); origin='global' },
        [pscustomobject]@{ path=(Join-Path $ClaudeRoot 'projects'); origin='project-memory' },
        [pscustomobject]@{ path=(Join-Path $CodexRoot 'memories'); origin='global' }
    )
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root.path)) { continue }
        foreach ($file in (Get-ChildItem -LiteralPath $root.path -Recurse -File -ErrorAction SilentlyContinue)) {
            if ($seen.ContainsKey($file.FullName)) { continue }
            $seen[$file.FullName] = $true
            Add-Candidate $sources $file.FullName $root.origin
        }
    }
    if (Test-Path -LiteralPath $RepoSearchRoot) {
        foreach ($name in @('MEMORY.md','overview.md','DECISIONS.md')) {
            foreach ($file in (Get-ChildItem -LiteralPath $RepoSearchRoot -Recurse -File -Filter $name -ErrorAction SilentlyContinue)) {
                if ($file.FullName -match '[\\/](\.git|node_modules|vendor)[\\/]') { continue }
                if ($seen.ContainsKey($file.FullName)) { continue }
                $seen[$file.FullName] = $true
                Add-Candidate $sources $file.FullName 'repository'
            }
        }
    }

    $manifest = [pscustomobject][ordered]@{
        schema_version = 4
        run_id = $id
        created_at = (Get-Date).ToString('o')
        updated_at = (Get-Date).ToString('o')
        state = 'inventoried'
        manifest_hash = ''
        sources = @($sources)
    }
    Save-Manifest (Join-Path $runDir 'manifest.json') $manifest
    Write-Output "Inventory ${id}: $($sources.Count) sources; unresolved=$(@($sources | Where-Object status -eq 'unresolved').Count); excluded=$(@($sources | Where-Object status -eq 'excluded').Count)"
}

function Invoke-DryRun {
    $runDir = Get-ImportDirectory
    $manifest = Get-Content -LiteralPath (Join-Path $runDir 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $manifest.sources | Group-Object category,status | Sort-Object Name | Select-Object Name,Count | Format-Table -AutoSize
    $manifest.sources | Where-Object status -eq 'unresolved' | Select-Object source_path,reason | Format-Table -AutoSize
    Write-Output "No files changed. Manifest: $($manifest.manifest_hash)"
}

function Write-KnowledgeEntry([string]$Destination, $Source, [string]$SnapshotRelative, [string]$Scope) {
    $raw = Get-Content -LiteralPath $Source.source_path -Raw -Encoding UTF8
    $related = @($Source.relationships) -join ', '
    $now = (Get-Date).ToString('o')
    $contentHash = Get-TextHash ($raw.Trim())
    $header = @"
---
id: $($Source.sha256)
topic: $($Source.topic)
source_path: $($Source.source_path)
source_sha256: $($Source.sha256)
snapshot: $SnapshotRelative
scope: $Scope
project_id: $($Source.project_id)
origin: imported
content_sha256: $contentHash
status: needs_verification
relationships: [$related]
created_at: $now
updated_at: $now
imported_at: $now
---

"@
    Ensure-Directory (Split-Path -Parent $Destination)
    [IO.File]::WriteAllText($Destination, $header + $raw, $utf8NoBom)
}

function Write-Indexes([string]$Stage) {
    $globalEntries = Join-Path $Stage 'knowledge\global\entries'
    $globalIndex = @()
    if (Test-Path -LiteralPath $globalEntries) {
        $globalIndex = @(Get-ChildItem -LiteralPath $globalEntries -File -Filter '*.md' | Sort-Object Name | ForEach-Object { [ordered]@{ id=$_.BaseName; path=("entries/" + $_.Name) } })
    }
    Write-Utf8Json (Join-Path $Stage 'knowledge\global\index.json') ([ordered]@{ scope='global'; entries=$globalIndex })

    $projectsRoot = Join-Path $Stage 'projects'
    if (-not (Test-Path -LiteralPath $projectsRoot)) { return }
    foreach ($project in (Get-ChildItem -LiteralPath $projectsRoot -Directory)) {
        $entriesDir = Join-Path $project.FullName 'knowledge\entries'
        $entries = @()
        if (Test-Path -LiteralPath $entriesDir) {
            $entries = @(Get-ChildItem -LiteralPath $entriesDir -File -Filter '*.md' | Sort-Object Name | ForEach-Object { [ordered]@{ id=$_.BaseName; path=("entries/" + $_.Name) } })
        }
        Write-Utf8Json (Join-Path $project.FullName 'knowledge\index.json') ([ordered]@{ scope='project'; project_id=$project.Name; entries=$entries })
        $historyRoot = Join-Path $project.FullName 'history\tasks'
        $history = @()
        if (Test-Path -LiteralPath $historyRoot) { $history = @(Get-ChildItem -LiteralPath $historyRoot -Directory | Sort-Object Name | ForEach-Object { $_.Name }) }
        Write-Utf8Json (Join-Path $project.FullName 'history\index.json') ([ordered]@{ project_id=$project.Name; tasks=$history })
    }
}

function Invoke-Stage {
    $runDir = Get-ImportDirectory
    $manifestPath = Join-Path $runDir 'manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $stage = Join-Path $runDir 'stage'
    $snapshots = Join-Path $runDir 'source-snapshots'
    Ensure-Directory $stage
    Ensure-Directory $snapshots
    $canonical = @{}
    $topics = @{}
    $projects = @{}
    $historyTasks = @{}

    foreach ($source in $manifest.sources) {
        if ($source.status -eq 'excluded') { continue }
        $extension = [IO.Path]::GetExtension($source.source_path)
        $snapshot = Join-Path $snapshots ($source.sha256 + $extension)
        if (-not (Test-Path -LiteralPath $snapshot)) { Copy-Item -LiteralPath $source.source_path -Destination $snapshot }
        if ((Get-Hash $snapshot) -ne $source.sha256) { throw "Snapshot hash mismatch: $snapshot" }
        (Get-Item -LiteralPath $snapshot).IsReadOnly = $true
        $source.snapshot_path = $snapshot.Substring($runDir.Length + 1)

        if ($source.status -eq 'unresolved') { continue }
        if ($source.project_id -and $source.project_root -and -not $projects.ContainsKey($source.project_id)) {
            $projectPath = Join-Path $stage "projects\$($source.project_id)\project.json"
            $projectRoot = [IO.Path]::GetFullPath($source.project_root)
            $projectData = [ordered]@{
                id = $source.project_id
                canonical_root = $projectRoot
                git_common_dir = $source.git_common_dir
                remote = $source.remote
                repo_fingerprint = $source.repo_fingerprint
                aliases = @($projectRoot, (Split-Path -Parent $source.source_path) | Sort-Object -Unique)
                worktrees = @([ordered]@{ id=(Get-StableId (Normalize-Path $projectRoot)); path=$projectRoot })
                created_at = (Get-Date).ToString('o')
                updated_at = (Get-Date).ToString('o')
            }
            Write-Utf8Json $projectPath $projectData
            $projects[$source.project_id] = $true
        }
        if ($source.category -ne 'history' -and $canonical.ContainsKey($source.sha256)) {
            $source.status = 'deduplicated'
            $source.destination = $canonical[$source.sha256]
            continue
        }

        if ($source.category -in @('global-knowledge','project-knowledge')) {
            if ($topics.ContainsKey($source.topic) -and $topics[$source.topic].hash -ne $source.sha256) {
                $previous = $topics[$source.topic]
                $relation = if ($previous.category -ne $source.category) { 'scope-conflict' } else { 'related' }
                $source.relationships = @("${relation}:$($previous.hash)")
            } else { $topics[$source.topic] = [pscustomobject]@{ hash=$source.sha256; category=$source.category } }
        }

        if ($source.category -eq 'global-knowledge') {
            $destination = Join-Path $stage "knowledge\global\entries\$($source.sha256).md"
            Write-KnowledgeEntry $destination $source $source.snapshot_path 'global'
        } elseif ($source.category -eq 'project-knowledge') {
            $destination = Join-Path $stage "projects\$($source.project_id)\knowledge\entries\$($source.sha256).md"
            Write-KnowledgeEntry $destination $source $source.snapshot_path 'project'
        } elseif ($source.category -eq 'history') {
            $taskKey = Get-StableId (Split-Path -Parent $source.source_path)
            $destination = Join-Path $stage "projects\$($source.project_id)\history\tasks\$taskKey\$([IO.Path]::GetFileName($source.source_path))"
            Ensure-Directory (Split-Path -Parent $destination)
            Copy-Item -LiteralPath $source.source_path -Destination $destination -Force
            $historyKey = Split-Path -Parent $destination
            if (-not $historyTasks.ContainsKey($historyKey)) { $historyTasks[$historyKey] = [Collections.Generic.List[object]]::new() }
            $historyTasks[$historyKey].Add([ordered]@{ source=$source.source_path; sha256=$source.sha256; file=[IO.Path]::GetFileName($destination) })
        }
        $source.destination = $destination.Substring($stage.Length + 1)
        $source.status = 'imported'
        if (-not $canonical.ContainsKey($source.sha256)) { $canonical[$source.sha256] = $source.destination }
    }
    foreach ($historyKey in $historyTasks.Keys) {
        Write-Utf8Json (Join-Path $historyKey 'summary.json') ([ordered]@{ status='historical'; imported_at=(Get-Date).ToString('o'); sources=@($historyTasks[$historyKey]) })
    }
    Write-Indexes $stage
    $manifest.state = 'staged'
    $manifest.updated_at = (Get-Date).ToString('o')
    Save-Manifest $manifestPath $manifest
    Write-Output "Staged import: $($manifest.run_id)"
}

function Invoke-Validate {
    $runDir = Get-ImportDirectory
    $manifestPath = Join-Path $runDir 'manifest.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $issues = [Collections.Generic.List[string]]::new()
    $allowed = @('imported','deduplicated','unresolved','excluded')
    $stage = Join-Path $runDir 'stage'
    if (-not (Test-Path -LiteralPath (Join-Path $stage 'knowledge\global\index.json'))) { $issues.Add('missing global knowledge index') }
    foreach ($source in $manifest.sources) {
        if ($allowed -notcontains $source.status) { $issues.Add("unclassified: $($source.source_path)"); continue }
        if ($source.status -ne 'excluded') {
            $snapshot = Join-Path $runDir $source.snapshot_path
            if (-not (Test-Path -LiteralPath $snapshot)) { $issues.Add("missing snapshot: $($source.source_path)") }
            elseif ((Get-Hash $snapshot) -ne $source.sha256) { $issues.Add("snapshot hash mismatch: $($source.source_path)") }
        }
        if ($source.status -in @('imported','deduplicated')) {
            $destination = Join-Path (Join-Path $runDir 'stage') $source.destination
            if (-not (Test-Path -LiteralPath $destination)) { $issues.Add("missing staged entry: $($source.destination)") }
        }
    }
    foreach ($project in (Get-ChildItem -LiteralPath (Join-Path $stage 'projects') -Directory -ErrorAction SilentlyContinue)) {
        foreach ($required in @('project.json','knowledge\index.json','history\index.json')) {
            if (-not (Test-Path -LiteralPath (Join-Path $project.FullName $required))) { $issues.Add("missing project index or identity: $($project.Name)/$required") }
        }
    }
    $success = ($issues.Count -eq 0)
    if ($success) {
        $manifest.state = 'validated'
        $manifest.updated_at = (Get-Date).ToString('o')
        Save-Manifest $manifestPath $manifest
    }
    $report = [ordered]@{
        run_id = $manifest.run_id
        validated_at = (Get-Date).ToString('o')
        source_count = @($manifest.sources).Count
        classified_count = @($manifest.sources | Where-Object { $allowed -contains $_.status }).Count
        unresolved_count = @($manifest.sources | Where-Object status -eq 'unresolved').Count
        manifest_hash = $manifest.manifest_hash
        success = $success
        issues = @($issues)
    }
    Write-Utf8Json (Join-Path $runDir 'validation-report.json') $report
    if ($issues.Count -gt 0) { throw "Migration validation failed: $($issues -join '; ')" }
    Write-Output "Validated $($manifest.run_id): $($report.source_count) sources conserved."
}

function Merge-Tree([string]$Source, [string]$Destination) {
    if (-not (Test-Path -LiteralPath $Source)) { return }
    Ensure-Directory $Destination
    $base = (Get-Item -LiteralPath $Source).FullName
    foreach ($file in (Get-ChildItem -LiteralPath $Source -Recurse -File)) {
        $relative = $file.FullName.Substring($base.Length).TrimStart('\','/')
        $target = Join-Path $Destination $relative
        Ensure-Directory (Split-Path -Parent $target)
        Copy-Item -LiteralPath $file.FullName -Destination $target -Force
    }
}

function Invoke-Activate {
    $runDir = Get-ImportDirectory
    $manifest = Get-Content -LiteralPath (Join-Path $runDir 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $reportPath = Join-Path $runDir 'validation-report.json'
    if ($manifest.state -ne 'validated' -or -not (Test-Path -LiteralPath $reportPath)) { throw 'Run Validate successfully before Activate.' }
    $report = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $report.success) { throw 'Validation report is not successful.' }
    if ($report.unresolved_count -gt 0 -and $AcceptUnresolvedManifestHash -ne $report.manifest_hash) {
        throw "Unresolved sources require explicit confirmation. Re-run Activate with -AcceptUnresolvedManifestHash '$($report.manifest_hash)'."
    }

    $temp = Join-Path $StateRoot ".activation-$($manifest.run_id)"
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
    Ensure-Directory $temp
    Merge-Tree (Join-Path $StateRoot 'knowledge') (Join-Path $temp 'knowledge')
    Merge-Tree (Join-Path $StateRoot 'projects') (Join-Path $temp 'projects')
    Merge-Tree (Join-Path $runDir 'stage\knowledge') (Join-Path $temp 'knowledge')
    Merge-Tree (Join-Path $runDir 'stage\projects') (Join-Path $temp 'projects')

    $backup = Join-Path $runDir 'previous-active'
    Ensure-Directory $backup
    try {
        foreach ($name in @('knowledge','projects')) {
            $current = Join-Path $StateRoot $name
            if (Test-Path -LiteralPath $current) { Move-Item -LiteralPath $current -Destination (Join-Path $backup $name) -Force }
            $candidate = Join-Path $temp $name
            if (Test-Path -LiteralPath $candidate) { Move-Item -LiteralPath $candidate -Destination $current -Force }
        }
    } catch {
        $failed = Join-Path $runDir 'failed-activation'
        Ensure-Directory $failed
        foreach ($name in @('knowledge','projects')) {
            $current = Join-Path $StateRoot $name
            $previous = Join-Path $backup $name
            if ((Test-Path -LiteralPath $current) -and (Test-Path -LiteralPath $previous)) { Move-Item -LiteralPath $current -Destination (Join-Path $failed $name) -Force }
            if ((Test-Path -LiteralPath $previous) -and -not (Test-Path -LiteralPath $current)) { Move-Item -LiteralPath $previous -Destination $current -Force }
        }
        throw
    }
    Remove-Item -LiteralPath $temp -Recurse -Force
    $manifest.state = 'activated'
    $manifest.updated_at = (Get-Date).ToString('o')
    Save-Manifest (Join-Path $runDir 'manifest.json') $manifest
    Write-Utf8Json (Join-Path $StateRoot 'activation.json') ([ordered]@{ version=4; run_id=$manifest.run_id; manifest_hash=$manifest.manifest_hash; activated_at=(Get-Date).ToString('o') })
    Write-Output "Activated v4 data from import $($manifest.run_id). v3 sources remain untouched and v4 will not read them."
}

switch ($Action) {
    'Inventory' { Invoke-Inventory }
    'DryRun' { Invoke-DryRun }
    'Stage' { Invoke-Stage }
    'Validate' { Invoke-Validate }
    'Activate' { Invoke-Activate }
}
