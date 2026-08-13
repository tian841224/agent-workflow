[CmdletBinding()]
param(
    [string]$Path = (Get-Location).Path,
    [string]$Base
)

# Deterministic fingerprint of "everything this working tree changed relative to Base",
# including untracked-but-not-ignored files.
#
# Roles record the fingerprint they reviewed; task-gate.ps1 recomputes it at Stop/Close, so any
# edit made after a role signed off invalidates that signature and forces a re-review. Without
# this, `- result: PASS` written three fixes ago still satisfies the gate.
#
# Tracked changes come from `git diff --output=<file>`, never through PowerShell's line
# pipeline: that pipeline splits on newlines and rejoins with [Environment]::NewLine, turning
# every LF into CRLF and changing the hash for reasons unrelated to the content.
#
# Untracked files are folded in separately because `git diff` cannot see them at all - a brand
# new source file (this has happened: three core files including a migration were never
# `git add`ed) would otherwise be invisible to both the reviewer and this fingerprint.
#
# Deliberately NOT `git add -A` into a throwaway index, which is how orchestrate.ps1 builds
# delivery patches: a fresh index has no stat cache and re-hashes the whole worktree. This runs
# on every turn end, so it has to stay cheap.

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom

function Write-Result($Value) {
    Write-Output ($Value | ConvertTo-Json -Depth 5 -Compress)
    exit 0
}

function Invoke-GitOut([string]$Repo, [string[]]$GitArgs) {
    # git writes routine progress to stderr even on success; with $ErrorActionPreference = 'Stop'
    # capturing that via 2>&1 would promote a clean run into a terminating error. Relax the
    # preference for the call and split stdout from stderr by record type afterwards, so nothing
    # git says on stderr can leak into this hook's own stderr either.
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

function Get-BytesSha256([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return (($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $sha.Dispose() }
}

$patchFile = $null
try {
    if (-not (Test-Path -LiteralPath $Path)) { Write-Result @{ sha256 = $null; error = "path does not exist: $Path" } }

    $topLevel = Invoke-GitOut $Path @('rev-parse', '--show-toplevel')
    if ($topLevel.ExitCode -ne 0 -or -not $topLevel.Lines) { Write-Result @{ sha256 = $null; error = 'not a git repository' } }
    $repo = $topLevel.Lines[0].Trim()

    if (-not $Base) { $Base = 'HEAD' }
    $resolvedBase = Invoke-GitOut $repo @('rev-parse', '--verify', "$Base^{commit}")
    if ($resolvedBase.ExitCode -ne 0 -or -not $resolvedBase.Lines) { Write-Result @{ sha256 = $null; error = "cannot resolve base '$Base' (a repository with no commits has nothing to diff against)" } }
    $baseSha = $resolvedBase.Lines[0].Trim()

    $patchFile = Join-Path ([IO.Path]::GetTempPath()) ('agent-workflow-fp-' + [guid]::NewGuid().ToString('N') + '.patch')
    # --no-renames keeps every entry single-path; --full-index keeps the patch meaningful after a
    # gc. Both match how orchestrate.ps1 produces delivery patches, so the two agree on what
    # "the same change" means.
    $diff = Invoke-GitOut $repo @('diff', '--binary', '--full-index', '--no-renames', "--output=$patchFile", $baseSha)
    if ($diff.ExitCode -ne 0) { Write-Result @{ sha256 = $null; error = "git diff failed: $($diff.StdErr)" } }
    # Declared as [byte[]] and assigned separately on purpose: PowerShell unrolls an empty array
    # returned from an if-expression into $null, so a clean working tree (empty diff) would
    # otherwise blow up here instead of producing the fingerprint of "no changes".
    [byte[]]$patchBytes = @()
    if (Test-Path -LiteralPath $patchFile) { $patchBytes = [IO.File]::ReadAllBytes($patchFile) }
    if ($null -eq $patchBytes) { [byte[]]$patchBytes = @() }

    $others = Invoke-GitOut $repo @('ls-files', '--others', '--exclude-standard')
    if ($others.ExitCode -ne 0) { Write-Result @{ sha256 = $null; error = "git ls-files failed: $($others.StdErr)" } }
    $untracked = @($others.Lines | Where-Object { $_ })

    # `ls-files --others` output is already sorted, but sorting again makes the fingerprint
    # independent of any future git ordering change.
    $untrackedDigest = New-Object System.Text.StringBuilder
    foreach ($relative in ($untracked | Sort-Object)) {
        $full = Join-Path $repo ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
        $fileHash = if (Test-Path -LiteralPath $full -PathType Leaf) { Get-BytesSha256 ([IO.File]::ReadAllBytes($full)) } else { 'missing' }
        [void]$untrackedDigest.AppendLine("$relative $fileHash")
    }

    $combined = New-Object System.IO.MemoryStream
    if ($patchBytes.Length -gt 0) { $combined.Write($patchBytes, 0, $patchBytes.Length) }
    $tail = $utf8NoBom.GetBytes("`n--untracked--`n" + $untrackedDigest.ToString())
    $combined.Write($tail, 0, $tail.Length)

    Write-Result @{
        sha256          = Get-BytesSha256 $combined.ToArray()
        base            = $baseSha
        untracked_count = $untracked.Count
    }
} catch {
    Write-Result @{ sha256 = $null; error = $_.Exception.Message }
} finally {
    if ($patchFile) { Remove-Item -LiteralPath $patchFile -Force -ErrorAction SilentlyContinue }
}
