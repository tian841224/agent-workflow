# managed by claude-workflow v2 — hooks 測試腳本
# 以 stdin JSON 餵各 hook, assert stdout 決策。全部通過 exit 0, 任一失敗 exit 1。

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$hooksDir = Join-Path $repoRoot 'hooks'
$script:failed = 0
$script:passed = 0

function Invoke-Hook($hookName, $stdinJson) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $hooksDir $hookName)`""
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $proc = [System.Diagnostics.Process]::Start($psi)
    $proc.StandardInput.Write($stdinJson)
    $proc.StandardInput.Close()
    $stdout = $proc.StandardOutput.ReadToEnd()
    $proc.WaitForExit()
    return [pscustomobject]@{ ExitCode = $proc.ExitCode; Stdout = $stdout.Trim() }
}

function Assert-Case($name, $hookName, $stdinJson, [scriptblock]$check) {
    $r = Invoke-Hook $hookName $stdinJson
    if (& $check $r) {
        $script:passed++
        Write-Output "[PASS] $name"
    } else {
        $script:failed++
        Write-Output "[FAIL] $name  (exit=$($r.ExitCode) stdout=$($r.Stdout))"
    }
}

function BashCmd($cmd) {
    return (@{ tool_name = 'Bash'; tool_input = @{ command = $cmd }; cwd = 'C:\tmp' } | ConvertTo-Json -Compress)
}

Write-Output '=== git-guard.ps1 ==='
Assert-Case 'force push → deny' 'git-guard.ps1' (BashCmd 'git push --force origin main') { param($r) $r.Stdout -match '"permissionDecision":"deny"' }
Assert-Case 'push -f → deny' 'git-guard.ps1' (BashCmd 'git push -f') { param($r) $r.Stdout -match '"permissionDecision":"deny"' }
Assert-Case 'reset --hard → deny' 'git-guard.ps1' (BashCmd 'cd /d/x && git reset --hard HEAD~1') { param($r) $r.Stdout -match '"permissionDecision":"deny"' }
Assert-Case 'clean -fd → deny' 'git-guard.ps1' (BashCmd 'git clean -fd') { param($r) $r.Stdout -match '"permissionDecision":"deny"' }
Assert-Case 'branch -D → deny' 'git-guard.ps1' (BashCmd 'git branch -D feature-x') { param($r) $r.Stdout -match '"permissionDecision":"deny"' }
Assert-Case 'checkout -- path → deny' 'git-guard.ps1' (BashCmd 'git checkout -- src/main.go') { param($r) $r.Stdout -match '"permissionDecision":"deny"' }
Assert-Case 'stash drop → deny' 'git-guard.ps1' (BashCmd 'git stash drop') { param($r) $r.Stdout -match '"permissionDecision":"deny"' }
Assert-Case 'commit → ask' 'git-guard.ps1' (BashCmd 'git commit -m "fix"') { param($r) $r.Stdout -match '"permissionDecision":"ask"' }
Assert-Case 'push (非 force) → ask' 'git-guard.ps1' (BashCmd 'git push origin develop') { param($r) $r.Stdout -match '"permissionDecision":"ask"' }
Assert-Case 'rebase → ask' 'git-guard.ps1' (BashCmd 'git rebase develop') { param($r) $r.Stdout -match '"permissionDecision":"ask"' }
Assert-Case 'git -C 前綴 commit → ask' 'git-guard.ps1' (BashCmd 'git -C C:/x/y commit -m msg') { param($r) $r.Stdout -match '"permissionDecision":"ask"' }
Assert-Case '串接指令中的 commit → ask' 'git-guard.ps1' (BashCmd 'go test ./... && git commit -am done') { param($r) $r.Stdout -match '"permissionDecision":"ask"' }
Assert-Case 'git status → 不干預' 'git-guard.ps1' (BashCmd 'git status') { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }
Assert-Case 'git diff → 不干預' 'git-guard.ps1' (BashCmd 'git diff --stat') { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }
Assert-Case 'merge --abort → 不 ask' 'git-guard.ps1' (BashCmd 'git merge --abort') { param($r) $r.Stdout -eq '' }
Assert-Case '非 git 指令 → 不干預' 'git-guard.ps1' (BashCmd 'ls -la') { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }
Assert-Case '壞 JSON → exit 0 不干預' 'git-guard.ps1' 'not-json{{{' { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }

Write-Output '=== post-edit-check.ps1 ==='
# fixture: 含 gofmt 錯誤的 go 檔
$fixDir = Join-Path $PSScriptRoot 'fixtures\badgo'
New-Item -ItemType Directory -Force $fixDir | Out-Null
$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $fixDir 'go.mod'), "module badgo`n`ngo 1.21`n", $enc)
[System.IO.File]::WriteAllText((Join-Path $fixDir 'bad.go'), "package main`n`nfunc main()   {`n}`n", $enc)
$editJson = @{ tool_name = 'Edit'; tool_input = @{ file_path = (Join-Path $fixDir 'bad.go') } } | ConvertTo-Json -Compress
Assert-Case '未格式化 .go → block' 'post-edit-check.ps1' $editJson { param($r) $r.Stdout -match '"decision":"block"' -and $r.Stdout -match 'gofmt' }
[System.IO.File]::WriteAllText((Join-Path $fixDir 'good.go'), "package other`n", $enc) # 非 main package 避免重複宣告
$editJson2 = @{ tool_name = 'Edit'; tool_input = @{ file_path = 'C:\tmp\note.md' } } | ConvertTo-Json -Compress
Assert-Case '非 .go 檔 → 放行' 'post-edit-check.ps1' $editJson2 { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }
Assert-Case '壞 JSON → exit 0' 'post-edit-check.ps1' '{{{' { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }

Write-Output '=== stop-check.ps1 ==='
# fixture: 假 acceptance 目錄 (用假 cwd 對應 slug)
$fakeCwd = 'C:\tmp\stopcheck-demo'
$slug = ($fakeCwd -replace '[:\\/]', '-')
$accTask = Join-Path $env:USERPROFILE ".claude\projects\$slug\acceptance\demo"
New-Item -ItemType Directory -Force (Join-Path $accTask 'evidence') | Out-Null
$cl = "# demo`n- project: $fakeCwd`n- frozen: 2026-07-20`n`n### A1 x`n- cmd: ``echo hi```n- expect: ``hi```n- evidence: evidence/A1.txt`n- status: [ ]`n"
[System.IO.File]::WriteAllText((Join-Path $accTask 'checklist.md'), $cl, $enc)
$stopJson = @{ cwd = $fakeCwd; stop_hook_active = $false } | ConvertTo-Json -Compress
Assert-Case '缺件 → block' 'stop-check.ps1' $stopJson { param($r) $r.Stdout -match '"decision":"block"' -and $r.Stdout -match 'A1' }
$stopJsonActive = @{ cwd = $fakeCwd; stop_hook_active = $true } | ConvertTo-Json -Compress
Assert-Case 'stop_hook_active → 放行' 'stop-check.ps1' $stopJsonActive { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }
[System.IO.File]::WriteAllText((Join-Path $accTask 'checklist.md'), "<!-- paused -->`n$cl", $enc)
Assert-Case 'paused 標記 → 放行' 'stop-check.ps1' $stopJson { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }
$stopJsonNoAcc = @{ cwd = 'C:\tmp\no-such-project'; stop_hook_active = $false } | ConvertTo-Json -Compress
Assert-Case '無 acceptance 目錄 → 放行' 'stop-check.ps1' $stopJsonNoAcc { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }
Assert-Case '壞 JSON → exit 0' 'stop-check.ps1' 'xxx' { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }

# spec.md 檢查（SDD：checklist 是 spec.md 的延伸，缺規格書或規格書未凍結都要擋）
$accTask2 = Join-Path $env:USERPROFILE ".claude\projects\$slug\acceptance\demo2"
New-Item -ItemType Directory -Force (Join-Path $accTask2 'evidence') | Out-Null
[System.IO.File]::WriteAllText((Join-Path $accTask2 'evidence\A1.txt'), "# 2026-07-20T00:00:00+08:00 `$ echo hi`nhi`n", $enc)
$cl2 = "# demo2`n- project: $fakeCwd`n- frozen: 2026-07-20`n`n### A1 x`n- cmd: ``echo hi```n- expect: ``hi```n- evidence: evidence/A1.txt`n- status: [x]`n"
[System.IO.File]::WriteAllText((Join-Path $accTask2 'checklist.md'), $cl2, $enc)
$stopJson2 = @{ cwd = $fakeCwd; stop_hook_active = $false } | ConvertTo-Json -Compress
Assert-Case 'spec.md 缺失 → block' 'stop-check.ps1' $stopJson2 { param($r) $r.Stdout -match '"decision":"block"' -and $r.Stdout -match 'spec\.md 缺失' }
[System.IO.File]::WriteAllText((Join-Path $accTask2 'spec.md'), "# demo2 spec`n- project: $fakeCwd`n- frozen: draft`n", $enc)
Assert-Case 'spec.md 未凍結(draft) → block' 'stop-check.ps1' $stopJson2 { param($r) $r.Stdout -match '"decision":"block"' -and $r.Stdout -match 'draft' }
[System.IO.File]::WriteAllText((Join-Path $accTask2 'spec.md'), "# demo2 spec`n- project: $fakeCwd`n- frozen: 2026-07-20`n", $enc)
Assert-Case 'spec.md 已凍結 + checklist 全過 → 放行' 'stop-check.ps1' $stopJson2 { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }

# 清理 stop-check fixture
Remove-Item -Recurse -Force (Join-Path $env:USERPROFILE ".claude\projects\$slug") -ErrorAction SilentlyContinue

Write-Output ''
Write-Output ("=== 結果: PASS {0} / FAIL {1} ===" -f $script:passed, $script:failed)
if ($script:failed -gt 0) { exit 1 }
exit 0
