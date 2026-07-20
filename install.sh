#!/bin/bash
# Claude Dev-Flow Kit 安裝腳本（Git Bash / macOS / Linux）
# 用法: ./install.sh [目標 .claude 目錄，預設 $HOME/.claude]
#
# 三種檔案分開處理（見 README.md「安裝方式」）：
#   類別 A（markdown，含 CLAUDE.md）→ 依標題段落自動合併：同標題取代、新標題附加到檔尾，永遠冪等
#   類別 B（可執行腳本）           → 逐字相同就略過；不同則不動原檔，kit 版本另存 <name>.kit.sh
#   類別 C（會累積使用者資料的檔案）→ 只在不存在時建立，存在就完全不動
#
# 不覆蓋、不詢問、全自動——這是本腳本的核心設計原則。

set -u

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-$HOME/.claude}"
mkdir -p "$DEST"

echo "Claude Dev-Flow Kit 安裝目標: $DEST"
echo ""

KIT_SUFFIX_NOTICE=()

# ---------- 類別 A：markdown 依標題段落自動合併 ----------
# $1 = 相對路徑, $2 = 標題層級（"#" 或 "##"）
merge_markdown() {
  local rel="$1" hashes="$2"
  local src="$SRC/$rel" dest="$DEST/$rel"

  if [ ! -e "$dest" ]; then
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    echo "✅ 新安裝: $rel"
    return
  fi

  if cmp -s "$src" "$dest"; then
    echo "⏭️  已是最新（內容相同）: $rel"
    return
  fi

  local tmpdir
  tmpdir="$(mktemp -d)"
  # 把 src 依標題行切成一個個 section 檔（sec_1.md, sec_2.md, ...），每個檔案第一行就是該段標題
  awk -v hashes="$hashes" -v outdir="$tmpdir" '
    BEGIN { n = 0 }
    index($0, hashes) == 1 && substr($0, length(hashes)+1, 1) != "#" && substr($0, length(hashes)+1, 1) == " " {
      n++
      fname = outdir "/sec_" n ".md"
    }
    n > 0 { print > fname }
  ' "$src"

  local n_sections
  n_sections=$(find "$tmpdir" -maxdepth 1 -name 'sec_*.md' | wc -l | tr -d ' ')

  local i heading secfile working
  working="$dest"
  local changed=0
  for ((i = 1; i <= n_sections; i++)); do
    secfile="$tmpdir/sec_$i.md"
    heading="$(head -n 1 "$secfile")"

    if grep -qxF "$heading" "$working"; then
      # 取代：從該標題行開始，到下一個同層級標題（不含）或檔尾為止，換成 secfile 內容
      local newsec
      newsec="$(cat "$secfile")"
      local out="$tmpdir/dest_out_$i.md"
      awk -v hashes="$hashes" -v heading="$heading" -v newsec="$newsec" '
        BEGIN { replacing = 0; done = 0 }
        {
          if (!done && $0 == heading) {
            print newsec
            print ""
            replacing = 1
            done = 1
            next
          }
          if (replacing) {
            if (index($0, hashes) == 1 && substr($0, length(hashes)+1, 1) == " ") {
              replacing = 0
            } else {
              next
            }
          }
          print
        }
      ' "$working" > "$out"
      working="$out"
      changed=1
    else
      # 附加到檔尾
      { echo ""; cat "$secfile"; } >> "$working"
      changed=1
    fi
  done

  if [ "$working" != "$dest" ]; then
    cp "$working" "$dest"
  fi
  rm -rf "$tmpdir"
  echo "🔀 已合併（保留既有內容，同標題段落已更新、新段落已附加）: $rel"
}

# ---------- 類別 B：可執行腳本，逐字相同才略過，不同則並存 ----------
handle_script() {
  local rel="$1"
  local src="$SRC/$rel" dest="$DEST/$rel"

  if [ ! -e "$dest" ]; then
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    chmod +x "$dest"
    echo "✅ 新安裝: $rel"
    return
  fi

  if cmp -s "$src" "$dest"; then
    echo "⏭️  已是最新（內容相同）: $rel"
    return
  fi

  local kitpath="${dest%.sh}.kit.sh"
  cp "$src" "$kitpath"
  chmod +x "$kitpath" "$dest" 2>/dev/null
  KIT_SUFFIX_NOTICE+=("$rel -> $(basename "$kitpath")")
  echo "⚠️  內容不同，原檔保留不動，kit 版本另存: $(basename "$kitpath")"
}

# ---------- 類別 C：只在不存在時建立 ----------
bootstrap_only() {
  local rel="$1"
  local src="$SRC/$rel" dest="$DEST/$rel"

  if [ -e "$dest" ]; then
    echo "⏭️  已存在，不覆蓋、不合併（保留你累積的資料）: $rel"
    return
  fi
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  echo "✅ 新安裝: $rel"
}

echo "=== 類別 A：Markdown 文件（自動按標題段落合併）==="
merge_markdown "CLAUDE.md" "#"
merge_markdown "agents/architect.md" "##"
merge_markdown "agents/debugger.md" "##"
merge_markdown "agents/pm.md" "##"
merge_markdown "agents/qa.md" "##"
merge_markdown "agents/reviewer.md" "##"
merge_markdown "acceptance/README.md" "##"
merge_markdown "state/README.md" "##"
merge_markdown "rules/learning.md" "##"
merge_markdown "rules/prompt-coaching.md" "##"
merge_markdown "skills/learn/SKILL.md" "##"
merge_markdown "skills/evolve/SKILL.md" "##"
merge_markdown "skills/promptcoach/SKILL.md" "##"
merge_markdown "skills/tdd/SKILL.md" "##"
merge_markdown "skills/tdd/tests.md" "##"
merge_markdown "skills/tdd/mocking.md" "##"

echo ""
echo "=== 類別 B：可執行腳本（相同則略過，不同則並存）==="
handle_script "scripts/pre-review.sh"
handle_script "scripts/verify-evidence.sh"

echo ""
echo "=== 類別 C：資料類檔案（只在不存在時建立）==="
bootstrap_only "memory/MEMORY.md"
bootstrap_only "memory/inbox.md"
bootstrap_only "memory/prompt-coach/inbox.md"
bootstrap_only "memory/prompt-coach/patterns.md"
bootstrap_only "DECISION_LOG.md"
bootstrap_only "products/INDEX.md"

echo ""
echo "=== 安裝完成 ==="
if [ "${#KIT_SUFFIX_NOTICE[@]}" -gt 0 ]; then
  echo "⚠️  以下腳本內容與 kit 版本不同，已並存為 .kit.sh，建議自行比對後決定是否採用："
  for n in "${KIT_SUFFIX_NOTICE[@]}"; do echo "   - $n"; done
fi
echo ""
echo "下一步："
echo "  1. 在 $DEST/products/INDEX.md 依「如何新增產品」段落登錄你自己的產品"
echo "  2. 若想要每週自動回顧自我學習迴圈，可自行用 /schedule 建立一個執行 evolve skill 的排程任務（本 kit 不預裝）"
