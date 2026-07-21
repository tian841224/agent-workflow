# managed by claude-workflow v2 — PreToolUse hook: git 寫入攔截
# matcher: Bash|PowerShell
# 破壞性/不可逆操作 → deny; commit/push/rebase/merge 等寫入 → ask (每次由使用者確認)
# 其他指令 → exit 0 不干預。任何解析失敗 → exit 0 (hook 壞掉不得癱瘓正常工作)。

$ErrorActionPreference = 'Stop'
try {
    $raw = [Console]::In.ReadToEnd()
    $payload = $raw | ConvertFrom-Json
    $cmd = $payload.tool_input.command
    if (-not $cmd) { exit 0 }

    # 壓縮空白後對整串指令掃描 (涵蓋 &&/;/| 串接與 git -C <path> 前綴)
    $flat = ($cmd -replace '\s+', ' ')
    if ($flat -notmatch '\bgit\b') { exit 0 }

    # deny: 不可逆/破壞性 (規則寫窄, 明確命中才擋)
    $denyPatterns = @(
        '\bgit\b[^&;|]*\bpush\b[^&;|]*(\s-f\b|\s--force\b|\s--force-with-lease\b)',
        '\bgit\b[^&;|]*\breset\b[^&;|]*\s--hard\b',
        '\bgit\b[^&;|]*\bclean\b[^&;|]*\s-[a-zA-Z]*f',
        '\bgit\b[^&;|]*\bbranch\b[^&;|]*\s-D\b',
        '\bgit\b[^&;|]*\bfilter-branch\b',
        '\bgit\b[^&;|]*\bcheckout\b[^&;|]*\s--\s',
        '\bgit\b[^&;|]*\brestore\b(?![^&;|]*--staged)',
        '\bgit\b[^&;|]*\bstash\b[^&;|]*\b(drop|clear)\b',
        '\bgit\b[^&;|]*\breflog\b[^&;|]*\bexpire\b',
        '\bgit\b[^&;|]*\bupdate-ref\b[^&;|]*\s-d\b'
    )
    foreach ($p in $denyPatterns) {
        if ($flat -match $p) {
            $out = @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'deny'; permissionDecisionReason = "git-guard: 攔截不可逆/破壞性 git 操作 (pattern: $p)。此類操作請由使用者自行在終端執行。" } }
            Write-Output ($out | ConvertTo-Json -Depth 5 -Compress)
            exit 0
        }
    }

    # ask: 一般 git 寫入 (規則寫寬, 寧可誤攔多問一次)
    $askPatterns = @(
        '\bgit\b[^&;|]*\bcommit\b',
        '\bgit\b[^&;|]*\bpush\b',
        '\bgit\b[^&;|]*\brebase\b',
        '\bgit\b[^&;|]*\bmerge\b(?![^&;|]*--abort)',
        '\bgit\b[^&;|]*\breset\b',
        '\bgit\b[^&;|]*\bcherry-pick\b',
        '\bgit\b[^&;|]*\btag\b[^&;|]*\s-d\b',
        '\bgit\b[^&;|]*\bam\b\s',
        '\bgit\b[^&;|]*\brevert\b(?![^&;|]*--abort)'
    )
    foreach ($p in $askPatterns) {
        if ($flat -match $p) {
            $out = @{ hookSpecificOutput = @{ hookEventName = 'PreToolUse'; permissionDecision = 'ask'; permissionDecisionReason = 'git-guard: git 寫入操作需使用者確認 (workflow 紀律: 不自行 commit/push)。' } }
            Write-Output ($out | ConvertTo-Json -Depth 5 -Compress)
            exit 0
        }
    }

    exit 0
} catch {
    exit 0
}
