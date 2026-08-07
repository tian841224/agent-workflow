# agent-workflow v4 - minimal indexed knowledge search and maintenance.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Search','Upsert','Reindex')][string]$Action,
    [string]$Query,
    [string]$Topic,
    [string]$Content,
    [ValidateSet('All','Global','Project')][string]$Scope = 'All',
    [string]$ProjectId,
    [string]$Path = (Get-Location).Path,
    [string]$StateRoot = (Join-Path $env:USERPROFILE '.agent-workflow'),
    [ValidateSet('verified','needs_verification')][string]$Status = 'verified',
    [string[]]$Relationship = @(),
    [switch]$ApprovedByUser,
    [ValidateRange(1,50)][int]$Limit = 8
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-Hash([string]$Value) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
        return (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '')
    } finally { $sha.Dispose() }
}

function Assert-StatePath([string]$Target) {
    $state = [IO.Path]::GetFullPath($StateRoot).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    $full = [IO.Path]::GetFullPath($Target)
    if (-not $full.StartsWith($state, [StringComparison]::OrdinalIgnoreCase)) { throw "Knowledge path escapes StateRoot: $full" }
}

function Test-ChildPath([string]$Root, [string]$Candidate) {
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    $candidatePath = [IO.Path]::GetFullPath($Candidate)
    return $candidatePath.StartsWith($rootPath, [StringComparison]::OrdinalIgnoreCase)
}

function Write-Utf8Json([string]$Target, $Value) {
    Assert-StatePath $Target
    $parent = Split-Path -Parent $Target
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $temp = Join-Path $parent ('.knowledge-' + [guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($temp, ($Value | ConvertTo-Json -Depth 12), $utf8NoBom)
    Get-Content -LiteralPath $temp -Raw -Encoding UTF8 | ConvertFrom-Json | Out-Null
    Move-Item -LiteralPath $temp -Destination $Target -Force
}

function Write-Utf8Text([string]$Target, [string]$Value) {
    Assert-StatePath $Target
    $parent = Split-Path -Parent $Target
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    $temp = Join-Path $parent ('.knowledge-' + [guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($temp, $Value, $utf8NoBom)
    Move-Item -LiteralPath $temp -Destination $Target -Force
}

function Resolve-ProjectId([switch]$Ensure) {
    if ($ProjectId) {
        if ($ProjectId -notmatch '^[a-f0-9]{16}$') { throw 'ProjectId must be a 16-character lowercase hex id.' }
        return $ProjectId
    }
    $resolver = Join-Path $PSScriptRoot 'project-resolver.ps1'
    if (-not (Test-Path -LiteralPath $resolver)) { throw 'project-resolver.ps1 is missing.' }
    $raw = if ($Ensure) { & $resolver -Path $Path -Ensure | Out-String } else { & $resolver -Path $Path | Out-String }
    $resolved = $raw | ConvertFrom-Json
    return $resolved.project_id
}

function Get-KnowledgeRoot([string]$SelectedScope, [string]$SelectedProjectId) {
    if ($SelectedScope -eq 'Global') { return Join-Path $StateRoot 'knowledge\global' }
    if (-not $SelectedProjectId) { throw 'Project scope requires project_id.' }
    return Join-Path $StateRoot "projects\$SelectedProjectId\knowledge"
}

function ConvertFrom-MetadataValue([string]$Value) {
    $trimmed = $Value.Trim()
    if (-not $trimmed) { return $null }
    if ($trimmed.StartsWith('"') -or $trimmed.StartsWith('[')) {
        try { return $trimmed | ConvertFrom-Json } catch { return $trimmed }
    }
    return $trimmed
}

function Read-Entry([string]$EntryPath) {
    $raw = Get-Content -LiteralPath $EntryPath -Raw -Encoding UTF8
    $match = [regex]::Match($raw, '(?ms)^---\r?\n(.*?)\r?\n---\r?\n?(.*)$')
    if (-not $match.Success) { return $null }
    $metadata = @{}
    foreach ($line in ($match.Groups[1].Value -split '\r?\n')) {
        if ($line -match '^([a-z_]+):[ \t]*(.*)$') { $metadata[$Matches[1]] = ConvertFrom-MetadataValue $Matches[2] }
    }
    $body = $match.Groups[2].Value.Trim()
    $contentHash = if ($metadata.content_sha256) { [string]$metadata.content_sha256 } else { Get-Hash $body }
    return [pscustomobject]@{
        path = $EntryPath
        id = [string]$metadata.id
        topic = [string]$metadata.topic
        scope = [string]$metadata.scope
        project_id = [string]$metadata.project_id
        origin = if ($metadata.origin) { [string]$metadata.origin } else { 'imported' }
        status = if ($metadata.status) { [string]$metadata.status } else { 'needs_verification' }
        relationships = @($metadata.relationships)
        created_at = [string]$metadata.created_at
        updated_at = if ($metadata.updated_at) { [string]$metadata.updated_at } else { [string]$metadata.imported_at }
        content_sha256 = $contentHash
        body = $body
    }
}

function Get-EntryFiles([string]$KnowledgeRoot) {
    $entriesRoot = Join-Path $KnowledgeRoot 'entries'
    $indexPath = Join-Path $KnowledgeRoot 'index.json'
    if (Test-Path -LiteralPath $indexPath) {
        try {
            $index = Get-Content -LiteralPath $indexPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $files = @($index.entries | ForEach-Object { Join-Path $KnowledgeRoot ([string]$_.path).Replace('/','\') } | Where-Object { (Test-ChildPath $KnowledgeRoot $_) -and (Test-Path -LiteralPath $_ -PathType Leaf) })
            if ($files.Count -gt 0) { return $files }
        } catch { }
    }
    if (-not (Test-Path -LiteralPath $entriesRoot)) { return @() }
    return @(Get-ChildItem -LiteralPath $entriesRoot -File -Filter '*.md' | Select-Object -ExpandProperty FullName)
}

function Get-Entries([string]$KnowledgeRoot, [switch]$ScanAll) {
    $entries = @()
    $files = if ($ScanAll) {
        $entriesRoot = Join-Path $KnowledgeRoot 'entries'
        if (Test-Path -LiteralPath $entriesRoot) { @(Get-ChildItem -LiteralPath $entriesRoot -File -Filter '*.md' | Select-Object -ExpandProperty FullName) } else { @() }
    } else { @(Get-EntryFiles $KnowledgeRoot) }
    foreach ($file in $files) {
        $entry = Read-Entry $file
        if ($entry) { $entries += $entry }
    }
    return $entries
}

function Set-EntryStatus([string]$EntryPath, [string]$NewStatus) {
    $raw = Get-Content -LiteralPath $EntryPath -Raw -Encoding UTF8
    $now = (Get-Date).ToString('o')
    if ($raw -match '(?m)^status:') { $raw = [regex]::Replace($raw, '(?m)^status:[ \t]*.*$', "status: $NewStatus", 1) }
    else { $raw = [regex]::Replace($raw, '(?m)^relationships:', "status: $NewStatus`r`nrelationships:", 1) }
    if ($raw -match '(?m)^updated_at:') { $raw = [regex]::Replace($raw, '(?m)^updated_at:[ \t]*.*$', "updated_at: $now", 1) }
    else { $raw = [regex]::Replace($raw, '(?m)^imported_at:', "updated_at: $now`r`nimported_at:", 1) }
    Write-Utf8Text $EntryPath $raw
}

function Rebuild-Index([string]$SelectedScope, [string]$SelectedProjectId) {
    $root = Get-KnowledgeRoot $SelectedScope $SelectedProjectId
    $entriesRoot = Join-Path $root 'entries'
    New-Item -ItemType Directory -Force -Path $entriesRoot | Out-Null
    $items = @(Get-ChildItem -LiteralPath $entriesRoot -File -Filter '*.md' | ForEach-Object {
        $entry = Read-Entry $_.FullName
        if ($entry) {
            [ordered]@{
                id = $entry.id
                topic = $entry.topic
                path = 'entries/' + $_.Name
                status = $entry.status
                updated_at = $entry.updated_at
                content_sha256 = $entry.content_sha256
            }
        }
    } | Sort-Object topic,id)
    $index = [ordered]@{
        schema_version = 1
        scope = $SelectedScope.ToLowerInvariant()
        project_id = if ($SelectedScope -eq 'Project') { $SelectedProjectId } else { $null }
        updated_at = (Get-Date).ToString('o')
        entries = $items
    }
    Write-Utf8Json (Join-Path $root 'index.json') $index
    return [pscustomobject]@{ scope=$SelectedScope.ToLowerInvariant(); project_id=$SelectedProjectId; count=$items.Count; index=(Join-Path $root 'index.json') }
}

function Invoke-Search {
    $project = if ($Scope -in @('All','Project')) { Resolve-ProjectId } else { '' }
    $targets = @()
    if ($Scope -in @('All','Global')) { $targets += [pscustomobject]@{ scope='Global'; project='' } }
    if ($Scope -in @('All','Project')) { $targets += [pscustomobject]@{ scope='Project'; project=$project } }
    $queryText = if ($Query) { $Query.ToLowerInvariant() } else { '' }
    $terms = @($queryText -split '\s+' | Where-Object { $_ })
    $results = @()
    foreach ($target in $targets) {
        $root = Get-KnowledgeRoot $target.scope $target.project
        foreach ($entry in (Get-Entries $root)) {
            $topicText = $entry.topic.ToLowerInvariant()
            $bodyText = $entry.body.ToLowerInvariant()
            $score = 0
            foreach ($term in $terms) {
                if ($topicText.Contains($term)) { $score += 3 }
                if ($bodyText.Contains($term)) { $score += 1 }
            }
            if ($terms.Count -gt 0 -and $score -eq 0) { continue }
            $firstLine = @($entry.body -split '\r?\n' | Where-Object { $_.Trim() -and $_.Trim() -ne '---' -and $_ -notmatch '^[a-z_]+:' } | Select-Object -First 1)[0]
            if ($firstLine -and $firstLine.Length -gt 180) { $firstLine = $firstLine.Substring(0,180) }
            $results += [pscustomobject]@{
                id = $entry.id
                topic = $entry.topic
                scope = $entry.scope
                project_id = $entry.project_id
                status = $entry.status
                score = $score
                updated_at = $entry.updated_at
                excerpt = $firstLine
                path = $entry.path
            }
        }
    }
    $selected = @($results | Sort-Object @{Expression='score';Descending=$true},@{Expression='updated_at';Descending=$true} | Select-Object -First $Limit)
    ConvertTo-Json -InputObject $selected -Depth 6
}

function Invoke-Upsert {
    if ($Scope -eq 'All') { throw 'Upsert requires Scope Global or Project.' }
    if (-not $Topic -or -not $Content) { throw 'Upsert requires non-empty Topic and Content.' }
    $Topic = $Topic.Trim()
    $Content = $Content.Trim()
    if (-not $Topic -or -not $Content) { throw 'Upsert requires non-empty Topic and Content.' }
    if ($Topic.Length -gt 120 -or $Topic -match '[\r\n]') { throw 'Topic must be a single line of at most 120 characters.' }
    foreach ($relation in $Relationship) {
        if ($relation -notmatch '^(related|supersedes|scope-conflict):[a-f0-9]{64}$') { throw "Invalid relationship: $relation" }
    }
    if ($Scope -eq 'Global' -and -not $ApprovedByUser) { throw 'Global knowledge writes require -ApprovedByUser.' }
    if ($Content -match '(?i)-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]+|\b(password|secret|token|api[_-]?key|connection[_-]?string)\s*[:=]\s*[^\s`]+') {
        throw 'Knowledge content appears to contain credential material.'
    }

    $project = if ($Scope -eq 'Project') { Resolve-ProjectId -Ensure } else { '' }
    $root = Get-KnowledgeRoot $Scope $project
    $entriesRoot = Join-Path $root 'entries'
    New-Item -ItemType Directory -Force -Path $entriesRoot | Out-Null
    $entries = @(Get-Entries $root -ScanAll)
    $normalizedContent = $Content
    $contentHash = Get-Hash $normalizedContent
    $native = $entries | Where-Object { $_.origin -eq 'native' -and $_.topic -eq $Topic } | Select-Object -First 1
    $duplicate = $entries | Where-Object { $_.content_sha256 -eq $contentHash } | Select-Object -First 1
    if ($duplicate) {
        $resultAction = 'deduplicated'
        if ($Status -eq 'verified' -and $duplicate.status -ne 'verified') {
            Set-EntryStatus $duplicate.path 'verified'
            Rebuild-Index $Scope $project | Out-Null
            $resultAction = 'verified'
        }
        [pscustomobject]@{ action=$resultAction; id=$duplicate.id; topic=$duplicate.topic; path=$duplicate.path; status=$Status } | ConvertTo-Json -Depth 4
        return
    }

    $sameTopic = @($entries | Where-Object { $_.topic -eq $Topic -and $_.id -ne $native.id })
    $id = if ($native) { $native.id } else { Get-Hash ($Scope.ToLowerInvariant() + '|' + $project + '|' + $Topic.ToLowerInvariant()) }
    $createdAt = if ($native.created_at) { $native.created_at } else { (Get-Date).ToString('o') }
    $relations = @($Relationship)
    if ($native) { $relations += @($native.relationships) }
    if (-not $native) { $relations += @($sameTopic | ForEach-Object { 'supersedes:' + $_.id }) }
    $relations = @($relations | Where-Object { $_ } | Sort-Object -Unique)
    $now = (Get-Date).ToString('o')
    $sourcePath = 'agent-workflow://native/' + $Scope.ToLowerInvariant() + '/' + $Topic
    $yamlTopic = $Topic | ConvertTo-Json -Compress
    $yamlProject = if ($project) { $project | ConvertTo-Json -Compress } else { 'null' }
    $yamlSource = $sourcePath | ConvertTo-Json -Compress
    $yamlRelations = if ($relations.Count -gt 0) { ConvertTo-Json -InputObject @($relations) -Compress } else { '[]' }
    $entryText = @"
---
id: $id
topic: $yamlTopic
scope: $($Scope.ToLowerInvariant())
project_id: $yamlProject
origin: native
source_path: $yamlSource
source_sha256: $contentHash
snapshot: native
content_sha256: $contentHash
status: $Status
relationships: $yamlRelations
created_at: $createdAt
updated_at: $now
imported_at: null
---

$normalizedContent
"@
    $destination = Join-Path $entriesRoot ($id + '.md')
    Write-Utf8Text $destination $entryText
    Rebuild-Index $Scope $project | Out-Null
    $resultAction = if ($native) { 'updated' } else { 'created' }
    [pscustomobject]@{ action=$resultAction; id=$id; topic=$Topic; scope=$Scope.ToLowerInvariant(); project_id=$project; path=$destination; status=$Status } | ConvertTo-Json -Depth 5
}

switch ($Action) {
    'Search' { Invoke-Search }
    'Upsert' { Invoke-Upsert }
    'Reindex' {
        $project = if ($Scope -in @('All','Project')) { Resolve-ProjectId -Ensure } else { '' }
        $result = @()
        if ($Scope -in @('All','Global')) { $result += Rebuild-Index 'Global' '' }
        if ($Scope -in @('All','Project')) { $result += Rebuild-Index 'Project' $project }
        ConvertTo-Json -InputObject @($result) -Depth 5
    }
}
