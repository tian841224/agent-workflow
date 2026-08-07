$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $root 'scripts\pre-review.ps1'
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('agent-workflow-pre-review-tests-' + [guid]::NewGuid().ToString('N'))
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$hostExe = if ($PSVersionTable.PSEdition -eq 'Core') { Join-Path $PSHOME 'pwsh.exe' } else { Join-Path $PSHOME 'powershell.exe' }

function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Write-Text([string]$Path, [string]$Content) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}
function Invoke-PreReview([string]$Repo) {
    $output = @(& $hostExe -NoProfile -ExecutionPolicy Bypass -File $scriptPath -RepoRoot $Repo 2>&1)
    return [pscustomobject]@{ code = $LASTEXITCODE; text = ($output -join "`n"); lines = $output }
}

try {
    New-Item -ItemType Directory -Force -Path $sandbox | Out-Null
    $fakeBin = Join-Path $sandbox 'bin'
    New-Item -ItemType Directory -Force -Path $fakeBin | Out-Null
    Write-Text (Join-Path $fakeBin 'go.cmd') @'
@echo off
if /I "%PRE_REVIEW_FAIL_STEP%"=="go-%1" (
  echo simulated go failure
  exit /b 9
)
exit /b 0
'@
    Write-Text (Join-Path $fakeBin 'gofmt.cmd') "@echo off`r`nif defined PRE_REVIEW_UNFORMATTED echo main.go`r`nexit /b 0`r`n"
    Write-Text (Join-Path $fakeBin 'golangci-lint.cmd') "@echo off`r`nexit /b 0`r`n"
    Write-Text (Join-Path $fakeBin 'npm.cmd') @'
@echo off
if defined PRE_REVIEW_NPM_LOG echo %*>>"%PRE_REVIEW_NPM_LOG%"
exit /b 0
'@
    $oldPath = $env:PATH
    $env:PATH = $fakeBin + [IO.Path]::PathSeparator + $oldPath

    $unsupported = Join-Path $sandbox 'unsupported'
    New-Item -ItemType Directory -Force -Path $unsupported | Out-Null
    $result = Invoke-PreReview $unsupported
    Assert ($result.code -eq 0 -and $result.text -match 'RESULT: SKIP') 'unsupported project should return SKIP'

    $custom = Join-Path $sandbox 'custom'
    New-Item -ItemType Directory -Force -Path $custom | Out-Null
    Write-Text (Join-Path $custom '.pre-review-extra.ps1') "Write-Output 'custom detail'`nexit 0`n"
    $result = Invoke-PreReview $custom
    Assert ($result.code -eq 0 -and $result.text -match '\[PASS\] pre-review-extra' -and $result.text -match 'RESULT: PASS') 'custom extra should pass'
    Assert ($result.text -notmatch 'custom detail') 'successful detail leaked into concise output'

    $goRepo = Join-Path $sandbox 'go'
    New-Item -ItemType Directory -Force -Path $goRepo | Out-Null
    Write-Text (Join-Path $goRepo 'go.mod') "module example.test/pre-review`n`ngo 1.22`n"
    Write-Text (Join-Path $goRepo 'main.go') "package main`nfunc main() {}`n"
    & git -C $goRepo init --quiet
    $result = Invoke-PreReview $goRepo
    Assert ($result.code -eq 0 -and $result.text -match '\[PASS\] gofmt') "changed Go file was not checked by gofmt:`n$($result.text)"
    foreach ($name in @('go vet','go build','go test','golangci-lint')) { Assert ($result.text -match "\[PASS\] $([regex]::Escape($name))") "missing Go check: $name" }

    $nodeRepo = Join-Path $sandbox 'node'
    New-Item -ItemType Directory -Force -Path $nodeRepo | Out-Null
    Write-Text (Join-Path $nodeRepo 'package.json') '{"scripts":{"lint":"fake","typecheck":"fake","build":"fake","test":"fake"}}'
    $env:PRE_REVIEW_NPM_LOG = Join-Path $sandbox 'npm-args.log'
    $result = Invoke-PreReview $nodeRepo
    Assert ($result.code -eq 0 -and $result.text -match 'RESULT: PASS') "Node project should pass:`n$($result.text)"
    $npmArgs = Get-Content -LiteralPath $env:PRE_REVIEW_NPM_LOG -Encoding UTF8
    foreach ($name in @('lint','typecheck','build','test')) {
        Assert ($result.text -match "\[PASS\] npm run $name") "missing npm check: $name"
        Assert (@($npmArgs) -contains "run $name --if-present") "npm received incorrect arguments for: $name"
    }
    Remove-Item Env:\PRE_REVIEW_NPM_LOG

    $env:PRE_REVIEW_FAIL_STEP = 'go-test'
    $result = Invoke-PreReview $goRepo
    Remove-Item Env:\PRE_REVIEW_FAIL_STEP
    Assert ($result.code -eq 1 -and $result.text -match 'RESULT: FAIL') 'failed Go check should return exit 1'
    Assert ($result.text -notmatch 'simulated go failure') 'failure detail leaked into concise output'
    $logDir = [regex]::Match($result.text, '(?m)^LOG_DIR:\s*(.+)$').Groups[1].Value.Trim()
    Assert ($logDir -and (Test-Path -LiteralPath $logDir)) 'failure log directory was not preserved'
    Assert ((Get-Content -LiteralPath (Join-Path $logDir 'go-test.log') -Raw -Encoding UTF8) -match 'simulated go failure') 'failure log is missing command output'
    Remove-Item -LiteralPath $logDir -Recurse -Force

    Write-Output 'pre-review tests passed'
} finally {
    if ($oldPath) { $env:PATH = $oldPath }
    Remove-Item Env:\PRE_REVIEW_FAIL_STEP -ErrorAction SilentlyContinue
    Remove-Item Env:\PRE_REVIEW_UNFORMATTED -ErrorAction SilentlyContinue
    Remove-Item Env:\PRE_REVIEW_NPM_LOG -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $sandbox) { Remove-Item -LiteralPath $sandbox -Recurse -Force }
}
