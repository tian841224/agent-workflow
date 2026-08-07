# agent-workflow v4 - deterministic checks before review or completion.
[CmdletBinding()]
param(
    [string]$RepoRoot = (Get-Location).Path,
    [switch]$Detailed
)

$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path -LiteralPath $RepoRoot -ErrorAction Stop).Path
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$logRoot = Join-Path ([IO.Path]::GetTempPath()) ('agent-workflow-pre-review-' + [guid]::NewGuid().ToString('N'))
$failures = [System.Collections.Generic.List[string]]::new()
$ran = 0
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

function Write-Log([string]$Path, $Lines) {
    $text = (@($Lines) | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
    [IO.File]::WriteAllText($Path, $text, $utf8NoBom)
}

function Add-Skip([string]$Name, [string]$Reason) {
    Write-Output "[SKIP] $Name - $Reason"
}

function Add-Failure([string]$Name, $Output) {
    $safeName = $Name -replace '[^a-zA-Z0-9._-]', '-'
    $logPath = Join-Path $logRoot ($safeName + '.log')
    Write-Log $logPath $Output
    $script:failures.Add("$Name ($logPath)")
    Write-Output "[FAIL] $Name"
    if ($Detailed) { @($Output) | ForEach-Object { Write-Output $_ } }
}

function Invoke-Check([string]$Name, [scriptblock]$Action, [switch]$FailOnOutput) {
    $script:ran++
    $output = @()
    $exitCode = 0
    try {
        $global:LASTEXITCODE = 0
        $output = @(& $Action 2>&1)
        $exitCode = $LASTEXITCODE
    } catch {
        $output = @($_.Exception.Message)
        $exitCode = 1
    }
    if ($exitCode -ne 0 -or ($FailOnOutput -and $output.Count -gt 0)) {
        Add-Failure $Name $output
        return
    }
    Write-Output "[PASS] $Name"
    if ($Detailed -and $output.Count -gt 0) { $output | ForEach-Object { Write-Output $_ } }
}

Push-Location $repo
try {
    $isGo = Test-Path -LiteralPath (Join-Path $repo 'go.mod')
    $isNode = Test-Path -LiteralPath (Join-Path $repo 'package.json')
    $extraPath = Join-Path $repo '.pre-review-extra.ps1'

    if ($isGo) {
        if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
            Add-Failure 'go toolchain' 'go executable was not found on PATH.'
        } else {
            $goFiles = @()
            if (Get-Command git -ErrorAction SilentlyContinue) {
                & git rev-parse --is-inside-work-tree 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) {
                    $goFiles = @(& git diff --name-only HEAD -- '*.go' 2>$null) +
                        @(& git ls-files --others --exclude-standard -- '*.go' 2>$null) |
                        Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
                        Select-Object -Unique
                }
            }
            if ($goFiles.Count -eq 0) {
                Add-Skip 'gofmt' 'no changed Go files'
            } elseif (-not (Get-Command gofmt -ErrorAction SilentlyContinue)) {
                Add-Failure 'gofmt' 'gofmt executable was not found on PATH.'
            } else {
                Invoke-Check 'gofmt' { & gofmt -l @goFiles } -FailOnOutput
            }
            Invoke-Check 'go vet' { & go vet ./... }
            Invoke-Check 'go build' { & go build ./... }
            Invoke-Check 'go test' { & go test ./... }
            if (Get-Command golangci-lint -ErrorAction SilentlyContinue) {
                Invoke-Check 'golangci-lint' { & golangci-lint run ./... }
            } else {
                Add-Skip 'golangci-lint' 'not installed'
            }
        }
    }

    if ($isNode) {
        $pkg = $null
        try {
            $pkg = Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        } catch {
            Add-Failure 'package.json' $_.Exception.Message
        }
        if ($pkg) {
            if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
                Add-Failure 'npm' 'npm executable was not found on PATH.'
            } else {
                $scripts = $pkg.scripts
                $hasTypecheck = $scripts -and ($scripts.PSObject.Properties.Name -contains 'typecheck')
                $hasTypescript = ($pkg.devDependencies -and $pkg.devDependencies.PSObject.Properties.Name -contains 'typescript') -or
                    ($pkg.dependencies -and $pkg.dependencies.PSObject.Properties.Name -contains 'typescript')
                foreach ($scriptName in @('lint','typecheck','build','test')) {
                    $hasScript = $scripts -and ($scripts.PSObject.Properties.Name -contains $scriptName)
                    if ($scriptName -eq 'typecheck' -and -not $hasTypecheck -and $hasTypescript) {
                        $tsc = Join-Path $repo 'node_modules\.bin\tsc.cmd'
                        if (Test-Path -LiteralPath $tsc) {
                            Invoke-Check 'typecheck (tsc --noEmit)' { & $tsc --noEmit }
                        } else {
                            Add-Skip 'typecheck' 'typescript is declared but node_modules/.bin/tsc.cmd is unavailable'
                        }
                    } elseif ($hasScript) {
                        Invoke-Check "npm run $scriptName" { & npm run $scriptName --if-present }
                    } else {
                        Add-Skip "npm run $scriptName" 'script is not defined'
                    }
                }
            }
        }
    }

    if (-not $isGo -and -not $isNode) {
        Add-Skip 'language checks' 'no go.mod or package.json'
    }

    if (Test-Path -LiteralPath $extraPath) {
        $hostExe = if ($PSVersionTable.PSEdition -eq 'Core') { Join-Path $PSHOME 'pwsh.exe' } else { Join-Path $PSHOME 'powershell.exe' }
        Invoke-Check 'pre-review-extra' { & $hostExe -NoProfile -ExecutionPolicy Bypass -File $extraPath }
    } else {
        Add-Skip 'pre-review-extra' 'not configured'
    }
} finally {
    Pop-Location
}

if ($failures.Count -gt 0) {
    Write-Output 'RESULT: FAIL'
    $failures | ForEach-Object { Write-Output "  - $_" }
    Write-Output "LOG_DIR: $logRoot"
    exit 1
}

if (Test-Path -LiteralPath $logRoot) { Remove-Item -LiteralPath $logRoot -Recurse -Force }
if ($ran -eq 0) { Write-Output 'RESULT: SKIP' } else { Write-Output 'RESULT: PASS' }
exit 0
