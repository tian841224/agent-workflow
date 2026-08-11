$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$knowledge = Join-Path $root 'scripts\knowledge.ps1'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }

function Write-Utf8([string]$Path, [string]$Text) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('agent-workflow-knowledge-tests-' + [guid]::NewGuid().ToString('N'))
$profileHome = Join-Path $sandbox 'profile'
$state = Join-Path $profileHome '.agent-workflow'
$repo = Join-Path $sandbox 'repo'
$oldProfile = $env:USERPROFILE

function Invoke-Knowledge([hashtable]$Splat) {
    return (& $knowledge @Splat | Out-String)
}
function Search-Knowledge([hashtable]$Splat) {
    $text = Invoke-Knowledge $Splat
    if (-not $text.Trim()) { return @() }
    return @($text | ConvertFrom-Json)
}

try {
    New-Item -ItemType Directory -Force -Path $repo, $state | Out-Null
    & git -C $repo init --quiet
    Write-Utf8 (Join-Path $repo 'fixture.txt') 'fixture'
    & git -C $repo add fixture.txt
    & git -C $repo -c user.name=agent-workflow -c user.email=agent-workflow@example.invalid commit --quiet -m fixture
    $env:USERPROFILE = $profileHome
    $base = @{ Path = $repo; StateRoot = $state }

    # --- baseline: existing behaviour must keep working ---
    Invoke-Knowledge ($base + @{ Action='Upsert'; Scope='Project'; Topic='exchange-pending-recovery'; Content='pending settlement recovery uses a lease' }) | Out-Null
    $hits = Search-Knowledge ($base + @{ Action='Search'; Query='pending recovery'; ExcludeNative=$true })
    Assert (@($hits | Where-Object { $_.topic -eq 'exchange-pending-recovery' }).Count -eq 1) 'project upsert was not searchable'

    $threw = $false
    try { Invoke-Knowledge ($base + @{ Action='Upsert'; Scope='Project'; Topic='leak'; Content='password: hunter2' }) | Out-Null }
    catch { $threw = $true }
    Assert $threw 'credential content was not rejected'

    $threw = $false
    try { Invoke-Knowledge ($base + @{ Action='Upsert'; Scope='Global'; Topic='g'; Content='global fact' }) | Out-Null }
    catch { $threw = $true }
    Assert $threw 'global upsert without -ApprovedByUser was allowed'

    # --- native federation: the unified store must surface each agent's own memory ---
    Write-Utf8 (Join-Path $profileHome '.codex\memories\codex-native-note.md') "codex remembers the deferred settlement lease`nsecond line"
    Write-Utf8 (Join-Path $profileHome '.codex\memory\codex-legacy-note.md') 'legacy singular codex memory about settlement'
    Write-Utf8 (Join-Path $profileHome '.codex\memories\rollout_summaries\2026-08-10T00-00-00-xxxx-settlement_session.md') 'session summary about settlement'
    Write-Utf8 (Join-Path $profileHome '.claude\projects\c--repo\memory\claude-note.md') 'claude remembers the settlement rule'
    Write-Utf8 (Join-Path $profileHome '.codex\memories\.git\config') 'settlement'

    $nativeSplat = $base + @{ Action='Search'; Query='settlement'; Scope='Global'; Limit=20 }
    $native = Search-Knowledge $nativeSplat
    Assert (@($native | Where-Object { $_.topic -eq 'codex-native-note' }).Count -eq 1) 'Codex memories were not visible from the unified store'
    Assert (@($native | Where-Object { $_.topic -eq 'codex-legacy-note' }).Count -eq 1) 'Codex singular memory dir was not visible'
    Assert (@($native | Where-Object { $_.topic -eq 'claude-note' }).Count -eq 1) 'Claude project memory was not visible'
    foreach ($item in @($native | Where-Object { $_.topic -in @('codex-native-note','codex-legacy-note','claude-note') })) {
        Assert ($item.scope -eq 'native') "native hit did not report scope native: $($item.topic)"
        Assert ($item.status -eq 'needs_verification') "native hit must be needs_verification: $($item.topic)"
        Assert ($item.source) "native hit did not report its source platform: $($item.topic)"
        Assert (Test-Path -LiteralPath $item.path) "native hit path is not readable: $($item.path)"
    }
    Assert (-not @($native | Where-Object { $_.topic -like '*settlement_session*' })) 'auto-generated rollout summaries must be excluded by default'
    Assert (-not @($native | Where-Object { $_.path -match '\\\.git\\' })) 'git internals must never be searched'

    # Excerpt is the only signal Search returns, so frontmatter must never occupy it.
    Write-Utf8 (Join-Path $profileHome '.claude\projects\c--repo\memory\fm-note.md') "---`nname: fm-note`nmetadata:`n  node_type: memory`n---`n`nthe settlement lease is released on commit`n"
    $fm = @(Search-Knowledge $nativeSplat | Where-Object { $_.topic -eq 'fm-note' })
    Assert ($fm.Count -eq 1) 'frontmatter native note was not found'
    Assert ($fm[0].excerpt -eq 'the settlement lease is released on commit') "excerpt leaked frontmatter: $($fm[0].excerpt)"

    $withSummaries = Search-Knowledge ($nativeSplat + @{ IncludeSessionSummaries=$true })
    Assert (@($withSummaries | Where-Object { $_.topic -like '*settlement_session*' }).Count -eq 1) '-IncludeSessionSummaries did not opt rollout summaries in'

    $excluded = Search-Knowledge ($base + @{ Action='Search'; Query='settlement'; Scope='Global'; ExcludeNative=$true })
    Assert (-not @($excluded | Where-Object { $_.scope -eq 'native' })) '-ExcludeNative still returned native memory'

    # Native stores are read-only: nothing may be copied into the curated index.
    $entries = @(Get-ChildItem (Join-Path $state 'knowledge\global\entries') -Filter *.md -EA SilentlyContinue)
    Assert ($entries.Count -eq 0) 'native memory was copied into the curated global store'
    $codexNote = Join-Path $profileHome '.codex\memories\codex-native-note.md'
    $codexBefore = Get-Content -LiteralPath $codexNote -Raw
    Search-Knowledge $nativeSplat | Out-Null
    Assert ((Get-Content -LiteralPath $codexNote -Raw) -eq $codexBefore) 'search mutated a native memory file'

    Write-Output 'knowledge tests passed'
} finally {
    $env:USERPROFILE = $oldProfile
    Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}
