-- ADR 0038：卡在自己的 git 工作树里做。交回记分支和提交（本机同步条目 handback 的 git：branch、baseBranch、baseCommit、commit），
-- 本机验收员的结论记它验的提交。在文件夹里做的卡两样都为空。合回主文件夹是本机的事，云端不记。
ALTER TABLE card_handbacks
  ADD COLUMN git JSONB,
  ADD COLUMN verified_commit TEXT;
