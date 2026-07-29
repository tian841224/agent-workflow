# managed by agent-workflow v2 — PostToolUse hook: 編輯後依副檔名快檢
# matcher: Edit|Write|MultiEdit
# .go 檔: 跑 gofmt -l 與該 package 的 go vet。
# .ts/.tsx/.js/.jsx 檔(找得到 prettier 設定「且」node_modules 已本地安裝 prettier 時): 跑本地 prettier --check。
# 刻意只用本地已安裝的執行檔、不透過 npx 自動下載 — npx 對未安裝套件預設會觸發網路安裝,
# 對逐次編輯觸發的 hook 是不可接受的延遲/網路依賴,牴觸「沒裝就跳過」的設計初衷。
# 失敗回 decision=block 要求立即修正。其餘副檔名 / 找不到設定或本地安裝 / 逾時 → 放行。
# 任何解析失敗 → exit 0。

$ErrorActionPreference = 'Stop'
try {
    $raw = [Console]::In.ReadToEnd()
    $payload = $raw | ConvertFrom-Json
    $filePath = if ($payload.toolCall) {
        $args = $payload.toolCall.args
        if ($args.TargetFile) { $args.TargetFile } else { $args.AbsolutePath }
    } else { $payload.tool_input.file_path }
    if (-not $filePath) { exit 0 }
    if (-not (Test-Path $filePath)) { exit 0 }

    $problems = @()

    if ($filePath -like '*.go') {
        # 由檔案往上找 go.mod, 找不到就放行
        $dir = Split-Path -Parent (Resolve-Path $filePath)
        $modRoot = $null
        $probe = $dir
        while ($probe) {
            if (Test-Path (Join-Path $probe 'go.mod')) { $modRoot = $probe; break }
            $parent = Split-Path -Parent $probe
            if ($parent -eq $probe) { break }
            $probe = $parent
        }
        if (-not $modRoot) { exit 0 }

        $fmtOut = & gofmt -l $filePath 2>&1
        if ($LASTEXITCODE -eq 0 -and $fmtOut) {
            $problems += "gofmt 未格式化: $filePath (請執行 gofmt -w)"
        }

        # go vet 該檔所在 package (timeout 15s, 超時放行)
        $job = Start-Job -ScriptBlock {
            param($root, $pkgDir)
            Set-Location $root
            $out = & go vet $pkgDir 2>&1
            [pscustomobject]@{ Code = $LASTEXITCODE; Out = ($out | Out-String) }
        } -ArgumentList $modRoot, $dir
        if (Wait-Job $job -Timeout 15) {
            $res = Receive-Job $job
            if ($res.Code -ne 0) {
                $vetMsg = ($res.Out -split "`r?`n" | Select-Object -First 8) -join '; '
                $problems += "go vet 失敗: $vetMsg"
            }
        }
        Remove-Job $job -Force -ErrorAction SilentlyContinue
    } elseif ($filePath -match '\.(ts|tsx|js|jsx)$') {
        # 由檔案往上找 prettier 設定(.prettierrc* 或 package.json 的 prettier 欄位) 與專案根(package.json 所在目錄)
        $dir = Split-Path -Parent (Resolve-Path $filePath)
        $hasPrettierConfig = $false
        $projRoot = $null
        $probe = $dir
        while ($probe) {
            if (Get-ChildItem -Path $probe -Filter '.prettierrc*' -Force -ErrorAction SilentlyContinue) {
                $hasPrettierConfig = $true
            }
            $pkgJson = Join-Path $probe 'package.json'
            if (Test-Path $pkgJson) {
                $projRoot = $probe
                try {
                    $pkg = Get-Content $pkgJson -Raw -Encoding UTF8 | ConvertFrom-Json
                    if ($pkg.PSObject.Properties.Name -contains 'prettier') { $hasPrettierConfig = $true }
                } catch {}
                break  # 找到 package.json 即視為專案根, 不再往上找
            }
            $parent = Split-Path -Parent $probe
            if ($parent -eq $probe) { break }
            $probe = $parent
        }
        if (-not $hasPrettierConfig -or -not $projRoot) { exit 0 }

        # 只用專案本地已安裝的 prettier 執行檔, 不透過 npx 自動下載(見檔頭說明); 沒裝就放行
        $prettierBin = Join-Path $projRoot 'node_modules\.bin\prettier.cmd'
        if (-not (Test-Path $prettierBin)) { exit 0 }

        # prettier --check (timeout 15s, 逾時放行), 不跑 tsc(整包型別檢查留給 pre-review)
        $job = Start-Job -ScriptBlock {
            param($bin, $f)
            $out = & $bin --check $f 2>&1
            [pscustomobject]@{ Code = $LASTEXITCODE; Out = ($out | Out-String) }
        } -ArgumentList $prettierBin, $filePath
        if (Wait-Job $job -Timeout 15) {
            $res = Receive-Job $job
            if ($res.Code -ne 0) {
                $fmtMsg = ($res.Out -split "`r?`n" | Select-Object -First 8) -join '; '
                $problems += "prettier 未格式化: $filePath (請執行 prettier --write) — $fmtMsg"
            }
        }
        Remove-Job $job -Force -ErrorAction SilentlyContinue
    } else {
        exit 0
    }

    if ($problems.Count -gt 0) {
        $out = @{ decision = 'block'; reason = "post-edit-check: $($problems -join ' | ')" }
        Write-Output ($out | ConvertTo-Json -Depth 3 -Compress)
    }
    exit 0
} catch {
    exit 0
}
