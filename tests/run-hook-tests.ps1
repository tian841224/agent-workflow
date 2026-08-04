# managed by agent-workflow v2 — hooks 測試腳本
# 以 stdin JSON 餵各 hook, assert stdout 決策。全部通過 exit 0, 任一失敗 exit 1。

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$hooksDir = Join-Path $repoRoot 'hooks'
$testWorkflowHome = Join-Path $repoRoot '.tmp-hook-home'
$env:AI_WORKFLOW_HOME = $testWorkflowHome
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

# fixture: .ts/prettier 分支 — 刻意用假 prettier.cmd 模擬本地安裝(見 post-edit-check.ps1 檔頭:
# 不透過 npx 自動下載, 只認 node_modules/.bin 下已存在的執行檔), 不依賴真的網路安裝
$nodeFixDir = Join-Path $PSScriptRoot 'fixtures\node-ts'
$binDir = Join-Path $nodeFixDir 'node_modules\.bin'
New-Item -ItemType Directory -Force $binDir | Out-Null
[System.IO.File]::WriteAllText((Join-Path $nodeFixDir 'package.json'), '{"name":"node-ts-fixture","prettier":{}}', $enc)
$fakePrettier = "@echo off`r`nfindstr /C:`"BAD_FORMAT`" `"%2`" >nul`r`nif %ERRORLEVEL%==0 (`r`n  echo Code style issues found in %2`r`n  exit /b 1`r`n) else (`r`n  echo All matched files use fake-prettier code style!`r`n  exit /b 0`r`n)`r`n"
[System.IO.File]::WriteAllText((Join-Path $binDir 'prettier.cmd'), $fakePrettier, $enc)
[System.IO.File]::WriteAllText((Join-Path $nodeFixDir 'bad.ts'), "const x = 1;  // BAD_FORMAT`n", $enc)
[System.IO.File]::WriteAllText((Join-Path $nodeFixDir 'good.ts'), "const x = 1;`n", $enc)
$tsEditBad = @{ tool_name = 'Edit'; tool_input = @{ file_path = (Join-Path $nodeFixDir 'bad.ts') } } | ConvertTo-Json -Compress
Assert-Case '.ts 未格式化(本地已裝 prettier) → block' 'post-edit-check.ps1' $tsEditBad { param($r) $r.Stdout -match '"decision":"block"' -and $r.Stdout -match 'prettier' }
$tsEditGood = @{ tool_name = 'Edit'; tool_input = @{ file_path = (Join-Path $nodeFixDir 'good.ts') } } | ConvertTo-Json -Compress
Assert-Case '.ts 已格式化 → 放行' 'post-edit-check.ps1' $tsEditGood { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }

# fixture: 有 prettier 設定但本地未安裝(沒有 node_modules/.bin/prettier.cmd) → 放行,不觸發 npx 下載
$noInstallDir = Join-Path $PSScriptRoot 'fixtures\node-ts-no-install'
New-Item -ItemType Directory -Force $noInstallDir | Out-Null
[System.IO.File]::WriteAllText((Join-Path $noInstallDir 'package.json'), '{"name":"node-ts-no-install","prettier":{}}', $enc)
[System.IO.File]::WriteAllText((Join-Path $noInstallDir 'bad.ts'), "const x = 1;  // BAD_FORMAT`n", $enc)
$tsNoInstall = @{ tool_name = 'Edit'; tool_input = @{ file_path = (Join-Path $noInstallDir 'bad.ts') } } | ConvertTo-Json -Compress
Assert-Case '有 prettier 設定但未本地安裝 → 放行(不觸發 npx 下載)' 'post-edit-check.ps1' $tsNoInstall { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }

# fixture: 無 prettier 設定(package.json 無 prettier 欄位、無 .prettierrc) → 放行
$noConfigDir = Join-Path $PSScriptRoot 'fixtures\node-ts-no-config'
New-Item -ItemType Directory -Force $noConfigDir | Out-Null
[System.IO.File]::WriteAllText((Join-Path $noConfigDir 'package.json'), '{"name":"node-ts-no-config"}', $enc)
[System.IO.File]::WriteAllText((Join-Path $noConfigDir 'bad.ts'), "const x = 1;  // BAD_FORMAT`n", $enc)
$tsNoConfig = @{ tool_name = 'Edit'; tool_input = @{ file_path = (Join-Path $noConfigDir 'bad.ts') } } | ConvertTo-Json -Compress
Assert-Case '無 prettier 設定 → 放行' 'post-edit-check.ps1' $tsNoConfig { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }

Write-Output '=== stop-check.ps1 ==='
# fixture: 假 acceptance 目錄 (用假 cwd 對應 slug)
$fakeCwd = 'C:\tmp\stopcheck-demo'
$slug = ($fakeCwd -replace '[:\\/]', '-')
$accTask = Join-Path $testWorkflowHome "projects\$slug\acceptance\demo"
New-Item -ItemType Directory -Force $accTask | Out-Null
$cl = "# demo`n- project: $fakeCwd`n- frozen: 2026-07-20`n`n### A1 x`n- cmd: ``echo hi```n- expect: ``hi```n- status: [ ]`n"
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
$accTask2 = Join-Path $testWorkflowHome "projects\$slug\acceptance\demo2"
New-Item -ItemType Directory -Force $accTask2 | Out-Null
$cl2 = "# demo2`n- project: $fakeCwd`n- frozen: 2026-07-20`n`n### A1 x`n- cmd: ``echo hi```n- expect: ``hi```n- status: [x]`n"
[System.IO.File]::WriteAllText((Join-Path $accTask2 'checklist.md'), $cl2, $enc)
$stopJson2 = @{ cwd = $fakeCwd; stop_hook_active = $false } | ConvertTo-Json -Compress
Assert-Case 'spec.md 缺失 → block' 'stop-check.ps1' $stopJson2 { param($r) $r.Stdout -match '"decision":"block"' -and $r.Stdout -match 'spec\.md 缺失' }
[System.IO.File]::WriteAllText((Join-Path $accTask2 'spec.md'), "# demo2 spec`n- project: $fakeCwd`n- frozen: draft`n", $enc)
Assert-Case 'spec.md 未凍結(draft) → block' 'stop-check.ps1' $stopJson2 { param($r) $r.Stdout -match '"decision":"block"' -and $r.Stdout -match 'draft' }
[System.IO.File]::WriteAllText((Join-Path $accTask2 'spec.md'), "# demo2 spec`n- project: $fakeCwd`n- frozen: 2026-07-20`n", $enc)
Assert-Case 'spec.md 已凍結 + checklist 全過 → 放行' 'stop-check.ps1' $stopJson2 { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }

# mini-spec.md 檢查（標準軌：無 checklist.md，只有 mini-spec.md 單檔；不檢查 spec.md/plan.md）
$accTask3 = Join-Path $testWorkflowHome "projects\$slug\acceptance\demo3"
New-Item -ItemType Directory -Force $accTask3 | Out-Null
$ms = "# demo3 mini-spec`n- project: $fakeCwd`n- frozen: draft`n`n### A1 x`n- cmd: ``echo hi```n- expect: ``hi```n- status: [ ]`n"
[System.IO.File]::WriteAllText((Join-Path $accTask3 'mini-spec.md'), $ms, $enc)
$stopJson3 = @{ cwd = $fakeCwd; stop_hook_active = $false } | ConvertTo-Json -Compress
Assert-Case 'mini-spec.md 未凍結(draft) → block' 'stop-check.ps1' $stopJson3 { param($r) $r.Stdout -match '"decision":"block"' -and $r.Stdout -match 'mini-spec\.md 未凍結' }
$msFrozenUnchecked = "# demo3 mini-spec`n- project: $fakeCwd`n- frozen: 2026-07-20`n`n### A1 x`n- cmd: ``echo hi```n- expect: ``hi```n- status: [ ]`n"
[System.IO.File]::WriteAllText((Join-Path $accTask3 'mini-spec.md'), $msFrozenUnchecked, $enc)
Assert-Case 'mini-spec.md 凍結但有未勾條目 → block' 'stop-check.ps1' $stopJson3 { param($r) $r.Stdout -match '"decision":"block"' -and $r.Stdout -match 'A1' }
$msFrozenChecked = "# demo3 mini-spec`n- project: $fakeCwd`n- frozen: 2026-07-20`n`n### A1 x`n- cmd: ``echo hi```n- expect: ``hi```n- status: [x]`n"
[System.IO.File]::WriteAllText((Join-Path $accTask3 'mini-spec.md'), $msFrozenChecked, $enc)
Assert-Case 'mini-spec.md 凍結 + 全勾 → 放行' 'stop-check.ps1' $stopJson3 { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }
[System.IO.File]::WriteAllText((Join-Path $accTask3 'mini-spec.md'), "<!-- paused -->`n$msFrozenUnchecked", $enc)
Assert-Case 'mini-spec.md paused 標記 → 放行' 'stop-check.ps1' $stopJson3 { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }

# 清理 stop-check fixture
Remove-Item -Recurse -Force (Join-Path $testWorkflowHome "projects\$slug") -ErrorAction SilentlyContinue

Write-Output '=== knowhow-check.ps1 ==='
# fixture: 假 cwd + 假 transcript JSONL(assistant tool_use 事件)
$khCwd = 'C:\tmp\knowhow-demo'
$khSlug = ($khCwd -replace '[:\\/]', '-')
$khFixDir = Join-Path $PSScriptRoot 'fixtures\knowhow'
New-Item -ItemType Directory -Force $khFixDir | Out-Null
$khMemDir = Join-Path $testWorkflowHome "projects\$khSlug\memory"

function New-KhEditLine($ts, $path) {
    return (@{ type = 'assistant'; timestamp = $ts; message = @{ content = @(@{ type = 'tool_use'; name = 'Edit'; input = @{ file_path = $path } }) } } | ConvertTo-Json -Compress -Depth 6)
}
function New-KhTextLine($ts, $text) {
    return (@{ type = 'assistant'; timestamp = $ts; message = @{ content = @(@{ type = 'text'; text = $text }) } } | ConvertTo-Json -Compress -Depth 6)
}

# 3 筆專案內修改、無宣告、無 memory 目錄 → block
$khLines1 = @(
    (New-KhEditLine '2020-01-01T00:00:00Z' (Join-Path $khCwd 'a.go')),
    (New-KhEditLine '2020-01-01T00:00:01Z' (Join-Path $khCwd 'b.go')),
    (New-KhEditLine '2020-01-01T00:00:02Z' (Join-Path $khCwd 'c.go'))
)
$khTranscript1 = Join-Path $khFixDir 'block.jsonl'
[System.IO.File]::WriteAllLines($khTranscript1, $khLines1, $enc)
Remove-Item -Recurse -Force $khMemDir -ErrorAction SilentlyContinue
$khJson1 = @{ cwd = $khCwd; transcript_path = $khTranscript1; stop_hook_active = $false } | ConvertTo-Json -Compress
Assert-Case '≥3 筆實質修改、無宣告、無 memory → block' 'knowhow-check.ps1' $khJson1 { param($r) $r.Stdout -match '"decision":"block"' -and $r.Stdout -match '無可沉澱' }

Assert-Case 'stop_hook_active → 放行' 'knowhow-check.ps1' (@{ cwd = $khCwd; transcript_path = $khTranscript1; stop_hook_active = $true } | ConvertTo-Json -Compress) { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }
Assert-Case '無 transcript_path → 放行' 'knowhow-check.ps1' (@{ cwd = $khCwd; stop_hook_active = $false } | ConvertTo-Json -Compress) { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }
Assert-Case '壞 JSON → exit 0' 'knowhow-check.ps1' 'xxx' { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }

# 僅 2 筆修改(低於門檻) → 放行
$khLines2 = @(
    (New-KhEditLine '2020-01-01T00:00:00Z' (Join-Path $khCwd 'a.go')),
    (New-KhEditLine '2020-01-01T00:00:01Z' (Join-Path $khCwd 'b.go'))
)
$khTranscript2 = Join-Path $khFixDir 'below-threshold.jsonl'
[System.IO.File]::WriteAllLines($khTranscript2, $khLines2, $enc)
$khJson2 = @{ cwd = $khCwd; transcript_path = $khTranscript2; stop_hook_active = $false } | ConvertTo-Json -Compress
Assert-Case '僅 2 筆修改(低於門檻) → 放行' 'knowhow-check.ps1' $khJson2 { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }

# 2 筆專案內 + 2 筆 .claude 路徑下(應被排除，不計入門檻) → 放行
$khLines3 = @(
    (New-KhEditLine '2020-01-01T00:00:00Z' (Join-Path $khCwd 'a.go')),
    (New-KhEditLine '2020-01-01T00:00:01Z' (Join-Path $khCwd 'b.go')),
    (New-KhEditLine '2020-01-01T00:00:02Z' (Join-Path $khCwd '.claude\c.go')),
    (New-KhEditLine '2020-01-01T00:00:03Z' (Join-Path $khCwd '.claude\d.go'))
)
$khTranscript3 = Join-Path $khFixDir 'exclude-dotclaude.jsonl'
[System.IO.File]::WriteAllLines($khTranscript3, $khLines3, $enc)
$khJson3 = @{ cwd = $khCwd; transcript_path = $khTranscript3; stop_hook_active = $false } | ConvertTo-Json -Compress
Assert-Case '.claude 路徑下修改不計入門檻 → 放行' 'knowhow-check.ps1' $khJson3 { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }

# 3 筆修改 + assistant text 含「已沉澱」 → 放行
$khLines4 = $khLines1 + (New-KhTextLine '2020-01-01T00:00:03Z' '已沉澱：修正了 XX 邏輯（xx-pitfall.md）')
$khTranscript4 = Join-Path $khFixDir 'declared.jsonl'
[System.IO.File]::WriteAllLines($khTranscript4, $khLines4, $enc)
$khJson4 = @{ cwd = $khCwd; transcript_path = $khTranscript4; stop_hook_active = $false } | ConvertTo-Json -Compress
Assert-Case '3 筆修改 + 已宣告「已沉澱」 → 放行' 'knowhow-check.ps1' $khJson4 { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }

# 3 筆修改 + memory 目錄下有檔案(mtime 晚於 session 起點) → 放行
New-Item -ItemType Directory -Force $khMemDir | Out-Null
[System.IO.File]::WriteAllText((Join-Path $khMemDir 'MEMORY.md'), "# Memory Index`n", $enc)
Assert-Case '3 筆修改 + memory 已更新 → 放行' 'knowhow-check.ps1' $khJson1 { param($r) $r.Stdout -eq '' -and $r.ExitCode -eq 0 }

# 3 筆修改，session 起點在未來(memory 檔相對更舊) + 無宣告 → block
$khLinesFuture = @(
    (New-KhEditLine '2030-01-01T00:00:00Z' (Join-Path $khCwd 'a.go')),
    (New-KhEditLine '2030-01-01T00:00:01Z' (Join-Path $khCwd 'b.go')),
    (New-KhEditLine '2030-01-01T00:00:02Z' (Join-Path $khCwd 'c.go'))
)
$khTranscriptFuture = Join-Path $khFixDir 'future-session.jsonl'
[System.IO.File]::WriteAllLines($khTranscriptFuture, $khLinesFuture, $enc)
$khJsonFuture = @{ cwd = $khCwd; transcript_path = $khTranscriptFuture; stop_hook_active = $false } | ConvertTo-Json -Compress
Assert-Case 'memory 檔早於 session 起點 → block' 'knowhow-check.ps1' $khJsonFuture { param($r) $r.Stdout -match '"decision":"block"' }

# 清理 knowhow-check fixture
Remove-Item -Recurse -Force $khMemDir -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $khFixDir -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $testWorkflowHome -ErrorAction SilentlyContinue

Write-Output ''
Write-Output ("=== 結果: PASS {0} / FAIL {1} ===" -f $script:passed, $script:failed)
if ($script:failed -gt 0) { exit 1 }
exit 0
