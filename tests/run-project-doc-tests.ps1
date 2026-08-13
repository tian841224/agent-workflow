$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$projectDoc = Join-Path $root 'scripts\project-doc.ps1'
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('agent-workflow-project-doc-tests-' + [guid]::NewGuid().ToString('N'))
$repo = Join-Path $sandbox 'repo'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Invoke-ProjectDoc([hashtable]$Arguments) {
    $splat = @{ RepoRoot = $repo } + $Arguments
    $raw = (& $projectDoc @splat | Out-String)
    return $raw | ConvertFrom-Json
}

# ConvertFrom-Json hands a single-element JSON array to the pipeline as one object, and
# ConvertTo-Json on the far side unwraps a one-item array into a bare object - the same
# PowerShell 5.1 quirk documented in run-retro-tests.ps1. Wrap every list result in @().
function Invoke-ProjectDocList([hashtable]$Arguments) {
    $parsed = Invoke-ProjectDoc $Arguments
    if ($null -eq $parsed) { return @() }
    return @($parsed | ForEach-Object { $_ })
}

# Check -Doc returns a JSON array so the multi-doc form and the single-doc form share one shape.
# Accessing .issues through member-enumeration on that outer (1-element) array collapses an EMPTY
# inner issues array to $null in PowerShell 5.1 - @($null) then reports Count 1, not 0 - so this
# indexes into the single element first and reads .issues off that scalar object directly.
function Invoke-ProjectDocCheck([string]$DocPath) {
    $raw = (& $projectDoc -Action Check -Doc $DocPath -RepoRoot $repo | Out-String)
    $parsed = @($raw | ConvertFrom-Json | ForEach-Object { $_ })
    return $parsed[0]
}

function Write-RepoFile([string]$RelativePath, [string]$Text) {
    $full = Join-Path $repo $RelativePath
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $full) | Out-Null
    [IO.File]::WriteAllText($full, $Text, $utf8NoBom)
    return $full
}

function Write-ModuleDoc([string]$RelativePath, [string[]]$Covers, [switch]$OmitSections, [string]$Note = 'none') {
    $coversJson = '[' + (($Covers | ForEach-Object { $_ | ConvertTo-Json -Compress }) -join ', ') + ']'
    $sections = if ($OmitSections) { '' } else {
        @"

## Responsibility
test module

## Entrypoints
test entrypoint

## Flow
A > B > C

## Shared state
none

## Invariants and gotchas
$Note

## Unverified
none
"@
    }
    $content = @"
---
doc_type: module
covers: $coversJson
---
$sections
"@
    return Write-RepoFile $RelativePath $content
}

function Invoke-GitCommit([string]$Message) {
    & git -C $repo add -A | Out-Null
    & git -C $repo -c user.name=agent-workflow -c user.email=agent-workflow@example.invalid commit --quiet -m $Message | Out-Null
}

New-Item -ItemType Directory -Force -Path $sandbox, $repo | Out-Null
try {
    & git -C $repo init --quiet
    Write-RepoFile 'game/gameList/Seth_10017/a.go' 'package a' | Out-Null
    Write-RepoFile 'game/gameList/Seth_1/a.go' 'package a1' | Out-Null
    Invoke-GitCommit 'seed code'

    # --- 1: directory-prefix covers matches a nested file, not a sibling with a shared stem ---
    Write-ModuleDoc 'docs/modules/ab.md' @('a/b/') | Out-Null
    Write-RepoFile 'a/b/c.go' 'package ab' | Out-Null
    Write-RepoFile 'a/bc.go' 'package abc' | Out-Null
    Invoke-GitCommit 'seed ab'
    $abLookup = Invoke-ProjectDoc @{ Action = 'Lookup'; Paths = @('a/b/c.go') }
    Assert (@($abLookup.docs).Count -eq 1) "covers 'a/b/' did not match a/b/c.go: $($abLookup | ConvertTo-Json -Depth 6)"
    $abcLookup = Invoke-ProjectDoc @{ Action = 'Lookup'; Paths = @('a/bc.go') }
    Assert (@($abcLookup.docs).Count -eq 0) "covers 'a/b/' incorrectly matched the sibling a/bc.go"
    Assert (@($abcLookup.uncovered) -contains 'a/bc.go') 'a/bc.go was not reported as uncovered'

    # --- 2: the exact false-match this whole boundary check exists for ---
    Write-ModuleDoc 'docs/modules/seth1.md' @('game/gameList/Seth_1/') | Out-Null
    Invoke-GitCommit 'seed seth1 doc'
    $seth10017 = Invoke-ProjectDoc @{ Action = 'Lookup'; Paths = @('game/gameList/Seth_10017/a.go') }
    Assert (@($seth10017.docs | Where-Object { $_.path -match 'seth1\.md$' }).Count -eq 0) "covers 'game/gameList/Seth_1/' falsely matched game/gameList/Seth_10017/a.go"
    Assert (@($seth10017.uncovered) -contains 'game/gameList/Seth_10017/a.go') 'Seth_10017/a.go was not reported uncovered despite the Seth_1/ lookalike doc'
    $seth1 = Invoke-ProjectDoc @{ Action = 'Lookup'; Paths = @('game/gameList/Seth_1/a.go') }
    Assert (@($seth1.docs | Where-Object { $_.path -match 'seth1\.md$' }).Count -eq 1) 'covers game/gameList/Seth_1/ did not match its own directory'

    # --- 3: longest-prefix-first ranking; architecture/dataflow always appended, unconditionally ---
    Write-ModuleDoc 'docs/modules/game.md' @('game/') | Out-Null
    $archContent = @"
---
doc_type: architecture
covers: ["game/"]
---

overview
"@
    Write-RepoFile 'docs/architecture.md' $archContent | Out-Null
    $flowContent = @"
---
doc_type: dataflow
covers: ["game/"]
---

flow
"@
    Write-RepoFile 'docs/dataflow.md' $flowContent | Out-Null
    Invoke-GitCommit 'seed game + overview docs'
    $rankLookup = Invoke-ProjectDoc @{ Action = 'Lookup'; Paths = @('game/gameList/Seth_10017/a.go') }
    $rankDocs = @($rankLookup.docs)
    Assert ($rankDocs.Count -eq 3) "expected 3 docs (module + architecture + dataflow), got $($rankDocs.Count): $($rankLookup | ConvertTo-Json -Depth 6)"
    Assert ($rankDocs[0].doc_type -eq 'module') "the more specific module doc (game/gameList/Seth_10017/) did not sort first: $($rankDocs | ConvertTo-Json -Depth 4)"
    $lastTwoTypes = @($rankDocs[1].doc_type, $rankDocs[2].doc_type)
    Assert (($lastTwoTypes -contains 'architecture') -and ($lastTwoTypes -contains 'dataflow')) 'architecture/dataflow were not appended after the matched module doc'
    Assert (@($rankDocs | Where-Object { $_.doc_type -ne 'module' })[0].matched_by.Count -eq 0) 'overview doc unexpectedly carries matched_by entries'

    # --- 4: uncovered for a path nothing describes ---
    $emptyLookup = Invoke-ProjectDoc @{ Action = 'Lookup'; Paths = @('totally/unrelated/path.go') }
    Assert (@($emptyLookup.uncovered) -contains 'totally/unrelated/path.go') 'a path with no covering doc was not reported as uncovered'

    # --- 5: staleness driven by git history, not by editing the doc ---
    Write-RepoFile 'game/gameList/Seth_10017/a.go' 'package a // changed' | Out-Null
    Invoke-GitCommit 'change seth 10017 code only'
    $staleAfterCodeChange = Invoke-ProjectDocList @{ Action = 'Stale' }
    $seth10017Stale = @($staleAfterCodeChange | Where-Object { $_.path -match 'seth1\.md$' })
    Assert ($seth10017Stale.Count -eq 0) 'a doc whose covered path was NOT touched was reported stale'
    $gameDocStale = @($staleAfterCodeChange | Where-Object { $_.path -match 'game\.md$' })
    Assert ($gameDocStale.Count -eq 1) 'the doc covering game/ was not reported stale after game/gameList/Seth_10017/a.go changed'
    Assert ($gameDocStale[0].stale -eq $true) 'stale flag was not true for the doc covering the changed path'

    # Doc and code updated together in the same commit must not be flagged stale. The doc's own
    # content has to actually change here (a byte-identical rewrite produces no git diff, which
    # would make this case pass for the wrong reason - the doc simply would not have "moved").
    Write-ModuleDoc 'docs/modules/game.md' @('game/') -Note 'updated alongside the code in this same commit' | Out-Null
    Write-RepoFile 'game/gameList/Seth_10017/a.go' 'package a // changed again, doc updated too' | Out-Null
    Invoke-GitCommit 'change code and doc together'
    $staleAfterTogether = Invoke-ProjectDocList @{ Action = 'Stale' }
    Assert (@($staleAfterTogether | Where-Object { $_.path -match 'game\.md$' }).Count -eq 0) 'a doc updated in the same commit as its covered code was still reported stale'

    # --- 6: stale_pending - covers has an uncommitted change, the doc does not ---
    Write-RepoFile 'game/gameList/Seth_10017/a.go' 'package a // uncommitted' | Out-Null
    $pendingLookup = Invoke-ProjectDoc @{ Action = 'Lookup'; Paths = @('game/gameList/Seth_10017/a.go') }
    $pendingGameDoc = @($pendingLookup.docs | Where-Object { $_.path -match 'game\.md$' })
    Assert ($pendingGameDoc.Count -eq 1) 'game doc missing from lookup during the stale_pending check'
    Assert ($pendingGameDoc[0].stale_pending -eq $true) 'stale_pending was not set when the covered path has an uncommitted change and the doc does not'
    & git -C $repo checkout -- 'game/gameList/Seth_10017/a.go' | Out-Null

    # --- 7: a freshly written, still-untracked doc is never stale ---
    Write-RepoFile 'fresh/x.go' 'package fresh' | Out-Null
    Invoke-GitCommit 'seed fresh module code'
    # Deliberately NOT committed below - this is the "just wrote it" bootstrap moment the
    # staleness rule exists to protect (a doc with no commit history has nothing to be stale
    # against, so it must not be judged against the code it describes).
    Write-ModuleDoc 'docs/modules/fresh.md' @('fresh/') | Out-Null
    $freshLookup = Invoke-ProjectDoc @{ Action = 'Lookup'; Paths = @('fresh/x.go') }
    $freshDoc = @($freshLookup.docs | Where-Object { $_.path -match 'fresh\.md$' })
    Assert ($freshDoc.Count -eq 1) 'fresh untracked doc did not match its own covers'
    Assert ($freshDoc[0].stale -eq $false) 'a freshly written, untracked doc was reported stale'

    # --- 8: a markdown file with no doc_type: frontmatter is ignored entirely ---
    Write-RepoFile 'docs/README.md' "# just a note`n`nnot a managed doc" | Out-Null
    Invoke-GitCommit 'add unmanaged markdown and commit the still-pending fresh doc'
    $allDocs = Invoke-ProjectDocList @{ Action = 'List' }
    Assert (@($allDocs | Where-Object { $_.path -match 'README\.md$' }).Count -eq 0) 'a markdown file without doc_type: frontmatter was treated as a managed doc'

    # --- 9: a non-git directory reports stale: "unknown" instead of throwing ---
    $plainDir = Join-Path $sandbox 'plain'
    New-Item -ItemType Directory -Force -Path (Join-Path $plainDir 'docs/modules') | Out-Null
    $plainDoc = @"
---
doc_type: module
covers: ["src/"]
---

## Responsibility
test
## Entrypoints
test
## Flow
test
## Shared state
test
## Invariants and gotchas
test
## Unverified
none
"@
    [IO.File]::WriteAllText((Join-Path $plainDir 'docs/modules/x.md'), $plainDoc, $utf8NoBom)
    $plainListRaw = ((& $projectDoc -Action List -RepoRoot $plainDir | Out-String) | ConvertFrom-Json)
    $plainList = @($plainListRaw | ForEach-Object { $_ })
    Assert ($plainList.Count -eq 1) 'List did not find the doc in a non-git directory'
    Assert ($plainList[0].stale -eq 'unknown') "non-git directory did not report stale: unknown, got: $($plainList[0].stale)"

    # --- 10: Check reports frontmatter/grammar/section violations, never flags length ---
    Write-ModuleDoc 'docs/modules/incomplete.md' @('incomplete/') -OmitSections | Out-Null
    $badCovers = @"
---
doc_type: module
covers: ["../escape", "C:/absolute", "back\\slash"]
---

## Responsibility
x
## Entrypoints
x
## Flow
x
## Shared state
x
## Invariants and gotchas
x
## Unverified
x
"@
    Write-RepoFile 'docs/modules/badcovers.md' $badCovers | Out-Null
    Invoke-GitCommit 'seed check fixtures'

    $incompleteCheck = Invoke-ProjectDocCheck 'docs/modules/incomplete.md'
    $incompleteIssues = @($incompleteCheck.issues)
    foreach ($section in @('Responsibility', 'Entrypoints', 'Flow', 'Shared state', 'Invariants and gotchas', 'Unverified')) {
        Assert (@($incompleteIssues | Where-Object { $_ -match [regex]::Escape($section) }).Count -gt 0) "Check did not report the missing section: $section"
    }

    $badCoversCheck = Invoke-ProjectDocCheck 'docs/modules/badcovers.md'
    $badCoversIssues = @($badCoversCheck.issues)
    Assert (@($badCoversIssues | Where-Object { $_ -match '\.\.' }).Count -gt 0) 'Check did not flag a covers entry containing ..'
    Assert (@($badCoversIssues | Where-Object { $_ -match 'repo-relative' }).Count -gt 0) 'Check did not flag an absolute covers entry'
    Assert (@($badCoversIssues | Where-Object { $_ -match 'separator' }).Count -gt 0) 'Check did not flag a backslash covers entry'

    # A long, complete module doc must never be reported as a violation - there is deliberately
    # no line-count ceiling (see project-doc.ps1's header comment for why).
    $longBody = (1..400 | ForEach-Object { "Line $_ of a deliberately long invariant explanation." }) -join "`n"
    $longDoc = @"
---
doc_type: module
covers: ["long/"]
---

## Responsibility
test
## Entrypoints
test
## Flow
test
## Shared state
test
## Invariants and gotchas
$longBody
## Unverified
none
"@
    Write-RepoFile 'docs/modules/long.md' $longDoc | Out-Null
    Invoke-GitCommit 'seed long doc'
    $longCheck = Invoke-ProjectDocCheck 'docs/modules/long.md'
    Assert (@($longCheck.issues).Count -eq 0) "a long but complete module doc was flagged: $($longCheck.issues -join '; ')"

    Write-Output 'project-doc tests passed'
} finally {
    Set-Location $root
    Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}
