[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Lookup','List','Stale','Check')][string]$Action,
    [string[]]$Paths = @(),
    [string]$RepoRoot = (Get-Location).Path,
    [string]$DocRoot = 'docs',
    [string]$Doc
)

# Read-only lookup over a target repo's own docs/ (architecture, dataflow, module write-ups),
# keyed by path instead of the keyword search knowledge.ps1 already does. The two answer
# different questions - "what does this code do and why" versus "did we hit this before" - and
# keying by path is what a keyword index cannot do: a task starts with a set of files it is
# about to touch, not a topic string.
#
# No write action on purpose. The doc body is prose an agent edits directly like any other
# markdown file; this script only answers "which docs cover these paths" and "are they still
# current", and flags format problems (Check). It never proposes content.
#
# No line-count ceiling and no scheduled re-review, on purpose: commit f9394a7 removed a whole
# scheduled-review mechanism from this framework for being too heavy, and a cap on doc length
# would force thin coverage on genuinely complex modules - the opposite of the point. Staleness
# is derived from git history so it cannot be gamed by editing a field; a doc nobody revisits
# just goes stale and Lookup reports that plainly, it does not silently disappear.

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom

function Invoke-GitOut([string]$Repo, [string[]]$GitArgs) {
    # git writes routine progress to stderr even on success; with $ErrorActionPreference = 'Stop'
    # capturing that via 2>&1 would promote a clean run into a terminating error. Same fix as
    # worktree-fingerprint.ps1: relax the preference for the call and split stdout from stderr by
    # record type afterwards.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $captured = & git -C $Repo @GitArgs 2>&1
        $code = $LASTEXITCODE
        $out = @($captured | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ })
        $err = @($captured | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { [string]$_ })
        return [pscustomobject]@{ ExitCode = $code; Lines = $out; StdErr = ($err -join "`n") }
    } finally { $ErrorActionPreference = $previous }
}

function ConvertFrom-MetadataValue([string]$Value) {
    $trimmed = $Value.Trim()
    if (-not $trimmed) { return $null }
    if ($trimmed.StartsWith('"') -or $trimmed.StartsWith('[')) {
        try { return $trimmed | ConvertFrom-Json } catch { return $trimmed }
    }
    return $trimmed
}

# covers is the same kind of repo-relative path list as file_ownership; Test-PrefixOverlap comes
# from path-grammar.ps1 (shared with orchestrate.ps1, split-plan.ps1 and validate-task.ps1).
# Test-CoversEntry keeps its own name here (the call sites below all say "covers", not
# "ownership") but is a thin alias over the same shared grammar rule.
. (Join-Path $PSScriptRoot 'path-grammar.ps1')
function Test-CoversEntry([string]$Entry) { return Test-OwnershipEntry $Entry }

# A directory entry ("game/Seth_1/") already carries its own boundary in the trailing slash, so
# a plain StartsWith cannot false-match "game/Seth_10017/x.js": character 12 of the entry is '/'
# where the candidate has '0', so the comparison fails before it reaches the rest of the digits.
function Test-CoversMatch([string]$Entry, [string]$QueryRelative) {
    if ($Entry.EndsWith('/')) {
        return $QueryRelative.StartsWith($Entry, [StringComparison]::OrdinalIgnoreCase) -or
               $QueryRelative.Equals($Entry.TrimEnd('/'), [StringComparison]::OrdinalIgnoreCase)
    }
    return $QueryRelative.Equals($Entry, [StringComparison]::OrdinalIgnoreCase)
}

# GetFullPath is pure string manipulation and does not require the path to exist - queried paths
# are routinely paths a task is about to create, not ones that exist yet.
function Get-RepoRelative([string]$RootFull, [string]$Path) {
    $full = if ([IO.Path]::IsPathRooted($Path)) { [IO.Path]::GetFullPath($Path) } else { [IO.Path]::GetFullPath((Join-Path $RootFull $Path)) }
    if ($full.Equals($RootFull, [StringComparison]::OrdinalIgnoreCase)) { return '' }
    $prefix = $RootFull + [IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "path is outside the repo root (${RootFull}): $Path"
    }
    return $full.Substring($prefix.Length).Replace('\', '/')
}

function Get-DocFile([string]$DocRootFull) {
    if (-not (Test-Path -LiteralPath $DocRootFull -PathType Container)) { return @() }
    return @(Get-ChildItem -LiteralPath $DocRootFull -Recurse -File -Filter '*.md' -ErrorAction SilentlyContinue)
}

# Only a file with a doc_type: key is a managed doc - an unrelated markdown file dropped into
# docs/ by hand must not be silently swept into Lookup results or Check output.
function Read-Doc([string]$RootFull, [System.IO.FileInfo]$File) {
    $raw = Get-Content -LiteralPath $File.FullName -Raw -Encoding UTF8
    $match = [regex]::Match($raw, '(?ms)^---\r?\n(.*?)\r?\n---\r?\n?(.*)$')
    if (-not $match.Success) { return $null }
    $metadata = @{}
    foreach ($line in ($match.Groups[1].Value -split '\r?\n')) {
        if ($line -match '^([a-z_]+):[ \t]*(.*)$') { $metadata[$Matches[1]] = ConvertFrom-MetadataValue $Matches[2] }
    }
    if (-not $metadata.doc_type) { return $null }
    return [pscustomobject]@{
        path          = $File.FullName
        relative_path = Get-RepoRelative $RootFull $File.FullName
        doc_type      = [string]$metadata.doc_type
        covers        = @($metadata.covers | Where-Object { $_ })
        body          = $match.Groups[2].Value
    }
}

# Compares two "when did this last change" timestamps derived from git history, never from a
# field in the doc itself - a verified_at-style field only ever drifts from reality, and this
# cannot be gamed by editing metadata without touching either the doc or the code it covers.
function Get-Staleness([string]$RepoRoot, [bool]$IsGit, [string]$DocRelative, [string[]]$CoversRelative) {
    if (-not $IsGit) { return [pscustomobject]@{ stale = 'unknown'; stale_pending = $false } }
    if (-not $CoversRelative -or $CoversRelative.Count -eq 0) { return [pscustomobject]@{ stale = $false; stale_pending = $false } }

    $docLog = Invoke-GitOut $RepoRoot (@('log', '-1', '--format=%ct', '--') + @($DocRelative))
    $docLines = @($docLog.Lines | Where-Object { $_ })
    $docTime = if ($docLog.ExitCode -eq 0 -and $docLines.Count -gt 0) { [long]$docLines[0] } else { $null }

    $coversLog = Invoke-GitOut $RepoRoot (@('log', '-1', '--format=%ct', '--') + $CoversRelative)
    $coversLines = @($coversLog.Lines | Where-Object { $_ })
    $coversTime = if ($coversLog.ExitCode -eq 0 -and $coversLines.Count -gt 0) { [long]$coversLines[0] } else { $null }

    # A doc with no commit history yet (freshly written, still untracked) has nothing to be
    # stale against - it was just written to describe the current state, not a leftover.
    $stale = ($null -ne $docTime) -and ($null -ne $coversTime) -and ($coversTime -gt $docTime)

    $docStatus = Invoke-GitOut $RepoRoot (@('status', '--porcelain', '--') + @($DocRelative))
    $docDirty = @($docStatus.Lines | Where-Object { $_ }).Count -gt 0
    $coversStatus = Invoke-GitOut $RepoRoot (@('status', '--porcelain', '--') + $CoversRelative)
    $coversDirty = @($coversStatus.Lines | Where-Object { $_ }).Count -gt 0
    $stalePending = $coversDirty -and -not $docDirty

    return [pscustomobject]@{ stale = $stale; stale_pending = $stalePending }
}

$resolvedRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$topLevel = Invoke-GitOut $resolvedRoot @('rev-parse', '--show-toplevel')
$isGit = $topLevel.ExitCode -eq 0 -and @($topLevel.Lines | Where-Object { $_ }).Count -gt 0
if ($isGit) { $resolvedRoot = (Resolve-Path -LiteralPath ($topLevel.Lines[0].Trim())).Path }
$docRootFull = Join-Path $resolvedRoot $DocRoot

function Get-AllDoc {
    return @(Get-DocFile $docRootFull | ForEach-Object { Read-Doc $resolvedRoot $_ } | Where-Object { $_ })
}

function Get-DocResult($DocEntry) {
    $staleness = Get-Staleness $resolvedRoot $isGit $DocEntry.relative_path $DocEntry.covers
    return [pscustomobject]@{
        path          = $DocEntry.path
        doc_type      = $DocEntry.doc_type
        covers        = @($DocEntry.covers)
        stale         = $staleness.stale
        stale_pending = $staleness.stale_pending
    }
}

switch ($Action) {
    'Lookup' {
        $allDocs = Get-AllDoc
        $moduleDocs = @($allDocs | Where-Object { $_.doc_type -eq 'module' })
        $overviewDocs = @($allDocs | Where-Object { $_.doc_type -ne 'module' })
        $queryRelative = @($Paths | ForEach-Object { Get-RepoRelative $resolvedRoot $_ } | Where-Object { $_ } | Sort-Object -Unique)

        $ranked = @()
        foreach ($docEntry in $moduleDocs) {
            $matchedBy = @()
            $bestLength = -1
            foreach ($query in $queryRelative) {
                foreach ($entry in $docEntry.covers) {
                    if (Test-CoversMatch $entry $query) {
                        $matchedBy += $query
                        if ($entry.Length -gt $bestLength) { $bestLength = $entry.Length }
                    }
                }
            }
            $matchedBy = @($matchedBy | Sort-Object -Unique)
            if ($matchedBy.Count -gt 0) {
                $result = Get-DocResult $docEntry
                $result | Add-Member NoteProperty matched_by $matchedBy
                $ranked += [pscustomobject]@{ result = $result; rank = $bestLength }
            }
        }
        $sorted = @($ranked | Sort-Object -Property rank -Descending | ForEach-Object { $_.result })

        foreach ($docEntry in $overviewDocs) {
            $result = Get-DocResult $docEntry
            $result | Add-Member NoteProperty matched_by @()
            $sorted += $result
        }

        $matchedQueries = @($ranked | ForEach-Object { $_.result.matched_by } | Sort-Object -Unique)
        $uncovered = @($queryRelative | Where-Object { $matchedQueries -notcontains $_ })

        [pscustomobject]@{ docs = $sorted; uncovered = $uncovered } | ConvertTo-Json -Depth 8
    }
    'List' {
        $results = @(Get-AllDoc | ForEach-Object { Get-DocResult $_ })
        ConvertTo-Json -InputObject @($results) -Depth 8
    }
    'Stale' {
        $results = @(Get-AllDoc | ForEach-Object { Get-DocResult $_ } | Where-Object { $_.stale -eq $true -or $_.stale_pending -eq $true })
        ConvertTo-Json -InputObject @($results) -Depth 8
    }
    'Check' {
        $moduleRequiredSections = @('Responsibility', 'Entrypoints', 'Flow', 'Shared state', 'Invariants and gotchas', 'Unverified')
        $apiRequiredSections = @('Endpoint', 'Auth', 'Request', 'Response', 'Errors', 'Invariants and gotchas', 'Unverified')
        $allowedDocTypes = @('architecture', 'dataflow', 'module', 'api')

        function Get-MissingSection([string]$Body, [string[]]$Required) {
            $missing = @()
            foreach ($name in $Required) {
                $escaped = [regex]::Escape($name)
                $sectionMatch = [regex]::Match($Body, "(?ms)^## $escaped.*?\r?\n(.*?)(?=^## |\z)")
                if (-not $sectionMatch.Success) { $missing += $name; continue }
                $sectionBody = $sectionMatch.Groups[1].Value.Trim()
                if (-not $sectionBody -or $sectionBody -match '^<.*>$') { $missing += $name }
            }
            return $missing
        }

        function Get-DocIssue($DocEntry) {
            $issues = @()
            if ($allowedDocTypes -notcontains $DocEntry.doc_type) { $issues += "unknown doc_type: $($DocEntry.doc_type)" }
            if (@($DocEntry.covers).Count -eq 0) { $issues += 'covers must not be empty' }
            foreach ($entry in @($DocEntry.covers)) {
                $reason = Test-CoversEntry $entry
                if ($reason) { $issues += "covers entry '$entry': $reason" }
            }
            if ($DocEntry.doc_type -eq 'module') {
                foreach ($name in (Get-MissingSection $DocEntry.body $moduleRequiredSections)) {
                    $issues += "missing or empty section: $name"
                }
            }
            if ($DocEntry.doc_type -eq 'api') {
                foreach ($name in (Get-MissingSection $DocEntry.body $apiRequiredSections)) {
                    $issues += "missing or empty section: $name"
                }
            }
            return $issues
        }

        $targetDocs = if ($Doc) {
            $resolvedDocPath = if ([IO.Path]::IsPathRooted($Doc)) { $Doc } else { Join-Path $resolvedRoot $Doc }
            if (-not (Test-Path -LiteralPath $resolvedDocPath -PathType Leaf)) { throw "doc not found: $Doc" }
            $entry = Read-Doc $resolvedRoot (Get-Item -LiteralPath $resolvedDocPath)
            if (-not $entry) {
                [pscustomobject]@{ path = $resolvedDocPath; doc_type = ''; issues = @('missing or invalid frontmatter (doc_type is required)') } | ConvertTo-Json -Depth 6
                return
            }
            @($entry)
        } else {
            Get-AllDoc
        }

        $results = @($targetDocs | ForEach-Object {
            [pscustomobject]@{ path = $_.path; doc_type = $_.doc_type; issues = @(Get-DocIssue $_); _entry = $_ }
        })

        # Overlap only makes sense within the same doc_type checked against the whole set together
        # (a module doc and an api doc legitimately cover the same file - one is structure, the
        # other is contract); a single -Doc check has nothing to compare against.
        if (-not $Doc) {
            foreach ($overlapType in @('module', 'api')) {
                $typeResults = @($results | Where-Object { $_._entry.doc_type -eq $overlapType })
                for ($i = 0; $i -lt $typeResults.Count; $i++) {
                    for ($j = $i + 1; $j -lt $typeResults.Count; $j++) {
                        foreach ($left in @($typeResults[$i]._entry.covers)) {
                            foreach ($right in @($typeResults[$j]._entry.covers)) {
                                if (Test-PrefixOverlap $left $right) {
                                    $typeResults[$i].issues = @($typeResults[$i].issues) + "covers overlaps with $($typeResults[$j].path) ('$left' vs '$right')"
                                }
                            }
                        }
                    }
                }
            }
        }

        $output = @($results | ForEach-Object { [pscustomobject]@{ path = $_.path; doc_type = $_.doc_type; issues = @($_.issues) } })
        ConvertTo-Json -InputObject @($output) -Depth 8
    }
}
