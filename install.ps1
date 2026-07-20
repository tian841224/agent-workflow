# Claude Dev-Flow Kit 安裝腳本（原生 PowerShell）
# 用法: .\install.ps1 [-Dest <目標 .claude 目錄，預設 $HOME\.claude>]
#
# 三種檔案分開處理（見 README.md「安裝方式」），邏輯與 install.sh 完全對等：
#   類別 A（markdown，含 CLAUDE.md）→ 依標題段落自動合併：同標題取代、新標題附加到檔尾，永遠冪等
#   類別 B（可執行腳本）           → 逐字相同就略過；不同則不動原檔，kit 版本另存 <name>.kit.sh
#   類別 C（會累積使用者資料的檔案）→ 只在不存在時建立，存在就完全不動
#
# 不覆蓋、不詢問、全自動——這是本腳本的核心設計原則。

param(
    [string]$Dest = (Join-Path $HOME ".claude")
)

$ErrorActionPreference = "Stop"
$Src = $PSScriptRoot
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

Write-Host "Claude Dev-Flow Kit 安裝目標: $Dest"
Write-Host ""

$script:KitSuffixNotice = @()

function Get-Sha256 {
    param([string]$Path)
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Merge-Markdown {
    param([string]$Rel, [string]$Level)
    $SrcFile = Join-Path $Src $Rel
    $DestFile = Join-Path $Dest $Rel

    if (-not (Test-Path -LiteralPath $DestFile)) {
        New-Item -ItemType Directory -Force -Path (Split-Path $DestFile) | Out-Null
        Copy-Item -LiteralPath $SrcFile -Destination $DestFile
        Write-Host "✅ 新安裝: $Rel"
        return
    }

    if ((Get-Sha256 $SrcFile) -eq (Get-Sha256 $DestFile)) {
        Write-Host "⏭️  已是最新（內容相同）: $Rel"
        return
    }

    $srcLines = @(Get-Content -LiteralPath $SrcFile -Encoding utf8)
    $destLines = [System.Collections.Generic.List[string]]::new([string[]](Get-Content -LiteralPath $DestFile -Encoding utf8))

    $prefix = "$Level "
    $headingIdx = @()
    for ($i = 0; $i -lt $srcLines.Count; $i++) {
        if ($srcLines[$i].StartsWith($prefix)) { $headingIdx += $i }
    }

    for ($h = 0; $h -lt $headingIdx.Count; $h++) {
        $start = $headingIdx[$h]
        $end = if ($h + 1 -lt $headingIdx.Count) { $headingIdx[$h + 1] - 1 } else { $srcLines.Count - 1 }
        $section = $srcLines[$start..$end]
        $heading = $srcLines[$start]

        $matchIdx = -1
        for ($j = 0; $j -lt $destLines.Count; $j++) {
            if ($destLines[$j] -ceq $heading) { $matchIdx = $j; break }
        }

        if ($matchIdx -ge 0) {
            $sectionEnd = $destLines.Count - 1
            for ($j = $matchIdx + 1; $j -lt $destLines.Count; $j++) {
                if ($destLines[$j].StartsWith($prefix)) { $sectionEnd = $j - 1; break }
            }
            $destLines.RemoveRange($matchIdx, $sectionEnd - $matchIdx + 1)
            $insert = [System.Collections.Generic.List[string]]::new([string[]]$section)
            $insert.Add("")
            $destLines.InsertRange($matchIdx, $insert)
        }
        else {
            $destLines.Add("")
            $destLines.AddRange([string[]]$section)
        }
    }

    Set-Content -LiteralPath $DestFile -Value $destLines -Encoding utf8NoBOM
    Write-Host "🔀 已合併（保留既有內容，同標題段落已更新、新段落已附加）: $Rel"
}

function Install-Script {
    param([string]$Rel)
    $SrcFile = Join-Path $Src $Rel
    $DestFile = Join-Path $Dest $Rel

    if (-not (Test-Path -LiteralPath $DestFile)) {
        New-Item -ItemType Directory -Force -Path (Split-Path $DestFile) | Out-Null
        Copy-Item -LiteralPath $SrcFile -Destination $DestFile
        Write-Host "✅ 新安裝: $Rel"
        return
    }

    if ((Get-Sha256 $SrcFile) -eq (Get-Sha256 $DestFile)) {
        Write-Host "⏭️  已是最新（內容相同）: $Rel"
        return
    }

    $kitPath = $DestFile -replace '\.sh$', '.kit.sh'
    Copy-Item -LiteralPath $SrcFile -Destination $kitPath
    $script:KitSuffixNotice += "$Rel -> $(Split-Path $kitPath -Leaf)"
    Write-Host "⚠️  內容不同，原檔保留不動，kit 版本另存: $(Split-Path $kitPath -Leaf)"
}

function Install-BootstrapOnly {
    param([string]$Rel)
    $SrcFile = Join-Path $Src $Rel
    $DestFile = Join-Path $Dest $Rel

    if (Test-Path -LiteralPath $DestFile) {
        Write-Host "⏭️  已存在，不覆蓋、不合併（保留你累積的資料）: $Rel"
        return
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $DestFile) | Out-Null
    Copy-Item -LiteralPath $SrcFile -Destination $DestFile
    Write-Host "✅ 新安裝: $Rel"
}

Write-Host "=== 類別 A：Markdown 文件（自動按標題段落合併）==="
Merge-Markdown "CLAUDE.md" "#"
Merge-Markdown "agents/architect.md" "##"
Merge-Markdown "agents/debugger.md" "##"
Merge-Markdown "agents/pm.md" "##"
Merge-Markdown "agents/qa.md" "##"
Merge-Markdown "agents/reviewer.md" "##"
Merge-Markdown "acceptance/README.md" "##"
Merge-Markdown "state/README.md" "##"
Merge-Markdown "rules/learning.md" "##"
Merge-Markdown "rules/prompt-coaching.md" "##"
Merge-Markdown "skills/learn/SKILL.md" "##"
Merge-Markdown "skills/evolve/SKILL.md" "##"
Merge-Markdown "skills/promptcoach/SKILL.md" "##"
Merge-Markdown "skills/tdd/SKILL.md" "##"
Merge-Markdown "skills/tdd/tests.md" "##"
Merge-Markdown "skills/tdd/mocking.md" "##"

Write-Host ""
Write-Host "=== 類別 B：可執行腳本（相同則略過，不同則並存）==="
Install-Script "scripts/pre-review.sh"
Install-Script "scripts/verify-evidence.sh"

Write-Host ""
Write-Host "=== 類別 C：資料類檔案（只在不存在時建立）==="
Install-BootstrapOnly "memory/MEMORY.md"
Install-BootstrapOnly "memory/inbox.md"
Install-BootstrapOnly "memory/prompt-coach/inbox.md"
Install-BootstrapOnly "memory/prompt-coach/patterns.md"
Install-BootstrapOnly "DECISION_LOG.md"
Install-BootstrapOnly "products/INDEX.md"

Write-Host ""
Write-Host "=== 安裝完成 ==="
if ($script:KitSuffixNotice.Count -gt 0) {
    Write-Host "⚠️  以下腳本內容與 kit 版本不同，已並存為 .kit.sh，建議自行比對後決定是否採用："
    foreach ($n in $script:KitSuffixNotice) { Write-Host "   - $n" }
}
Write-Host ""
Write-Host "下一步："
Write-Host "  1. 在 $Dest\products\INDEX.md 依「如何新增產品」段落登錄你自己的產品"
Write-Host "  2. 若想要每週自動回顧自我學習迴圈，可自行用 /schedule 建立一個執行 evolve skill 的排程任務（本 kit 不預裝）"
