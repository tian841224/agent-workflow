# 整理既有分支的 commit

把分支上已有的 commit 重新分組、合併，最終檔案內容不變。類型、拆分方案與確認依 [SKILL.md](SKILL.md)；rebase、reset 與強制推送的授權依入口文件的硬護欄。

## 方案

- 依功能分組，每組一個 commit；1～2 個檔案的小修改併入相關的功能 commit。
- 方案列出每個新 commit 的完整標題、來源舊 commit、檔案與新順序，取得使用者確認後才執行。
- 同一組的舊 commit 在原歷史中不相鄰時才調整順序。調整後先依新順序用 `git merge-tree --write-tree --merge-base=<舊 commit>^ <模擬中的 tip> <舊 commit>` 逐個模擬（模擬 tip 以 `git commit-tree` 建立），確認沒有衝突，且最終 tree 與原 tip 相同。模擬只寫入暫時物件，不改分支或工作樹。
- 模擬只能找出文字衝突。舊 commit 之間的語意相依（例如後面的 commit 用到前面 commit 新增的常數）要靠下方逐個新 commit 的 build 與測試發現；發現後調整順序，commit 內容與標題不變。

## 重建

不用互動式 rebase，也不動使用者目前 checkout 的分支與工作樹：

1. 建備份分支指向原 tip。
2. `git worktree add -b tmp/<名稱> <暫存路徑> <base>`，在這個 worktree 重建。
3. 每組依序 `git -C <暫存路徑> cherry-pick -n <來源 commit…>` 與 `git -C <暫存路徑> commit -F <訊息檔>`；訊息檔以 UTF-8 寫在暫存目錄。
4. 每個新 commit 單獨跑專案的 build 與測試。失敗時停止，處理相依後從該組重做。
5. 全部完成後確認 `git rev-parse <新 tip>^{tree}` 與備份分支相同、`git diff <備份分支> <新 tip>` 無輸出，且訊息沒有署名行。

## 收尾

- `git worktree list` 確認目標分支沒有被任何 worktree checkout，再 `git branch -f <分支> tmp/<名稱>`。
- 移除暫存 worktree 與訊息檔，用 `git branch -D` 刪除暫存分支（`-d` 以目前 checkout 的分支判斷是否已合併，會拒絕）。
- 備份分支保留並告知使用者名稱，由使用者確認無誤後自行刪除。

## 已 push 的分支

改寫後本機與遠端分岔，PR／MR 仍是舊歷史。更新遠端需要使用者明確授權，並以帶預期值的 lease 推送，遠端若被別人更動，推送會被拒絕：

```text
git push --force-with-lease=<分支>:<預期的遠端 SHA> origin <分支>:<分支>
```

推送前用 `git ls-remote --heads origin <分支>` 確認遠端 tip 等於預期值；推送後確認 PR／MR 的 commit 列表與新歷史一致（指令見 [pull-request.md](pull-request.md)）。
