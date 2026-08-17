# agent-workflow v4 - shared repo-relative path grammar for file_ownership and covers.
#
# Both fields describe the same shape of data - a set of repo-relative path prefixes/exact
# files - and the rule was kept as four independent copies (orchestrate.ps1, split-plan.ps1,
# project-doc.ps1's Test-CoversEntry, and an inline block in validate-task.ps1), synchronized
# only by a "must stay identical" code comment in three of them. A comment does not enforce
# anything; this file does, by being the only place the rule is written.
#
# Dot-sourced, not invoked as `& path-grammar.ps1`: every caller needs these functions defined
# in its own scope to call directly. A subprocess call would only return whatever the script
# printed, not define callable functions in the caller.

function Test-OwnershipEntry([string]$Entry) {
    if (-not $Entry) { return 'must not be empty' }
    if ($Entry -match '^([a-zA-Z]:|/|\\)') { return 'must be repo-relative' }
    if ($Entry -match '\\') { return 'must use / as the separator' }
    if ($Entry -like './*') { return 'must not start with ./' }
    if ($Entry -match '(^|/)\.\.(/|$)') { return 'must not contain ..' }
    if ($Entry -match '[\[\],]') { return 'must not contain , [ or ]' }
    return ''
}

# Windows paths are case-insensitive, so ownership/covers comparison must be too: comparing
# ordinally would let src/Payment/ and src/payment/ claim the same directory.
function Test-PrefixOverlap([string]$Left, [string]$Right) {
    if ($Left.Equals($Right, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($Left.EndsWith('/') -and $Right.StartsWith($Left, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($Right.EndsWith('/') -and $Left.StartsWith($Right, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    return $false
}
