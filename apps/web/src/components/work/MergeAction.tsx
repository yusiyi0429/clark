"use client";

/**
 * 卡验收过了以后的「合并」（ADR 0038）：把卡的分支合回主文件夹，只在这台电脑上点（本机会话在这里）。
 * 合上了写「已合并」和提交；合不了、或本机没自动合回（needsMerge），在按钮旁写原因（左栏「worker 等你」也列一条）。卡不在工作树里做时什么都不出。
 */
import { useState } from "react";
import { HeroButton } from "@/components/HeroButton";
import { useHandheld } from "@/components/ui/useHandheld";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import type { TLocalSessionSummary } from "@/lib/local/runner";
import { showWorkspaceToast } from "@/lib/toast";
import { mergeCard, useMergeIssues } from "@/lib/work/merge";
import w from "@/styles/v2-work.module.css";

export function MergeAction({ session, title, accepted, onChanged }: { session: TLocalSessionSummary | null; title: string; accepted: boolean; onChanged: () => void }) {
  const local = useLocalRunner();
  const handheld = useHandheld();
  const issue = useMergeIssues().find((entry) => entry.sessionId === session?.id) ?? null;
  const [busy, setBusy] = useState(false);
  const ws = session?.workspace;
  if (!session || ws?.kind !== "worktree") return null;
  if (ws.mergedCommit) return <span className={w.dim} data-testid="merged">已合并 · {ws.mergedCommit.slice(0, 7)}</span>;
  if (!accepted || handheld || local.phase !== "ready") return null;
  const merge = async () => {
    setBusy(true);
    const result = await mergeCard(local.runner, session, title);
    if (result.ok) showWorkspaceToast({ text: `已合并到 ${ws.baseBranch}（${result.commit.slice(0, 7)}）` });
    await local.refresh();
    setBusy(false);
    onChanged();
  };
  return (
    <div className={w.rowActs} data-testid="merge-action">
      <HeroButton variant="secondary" size="sm" isDisabled={busy} onPress={() => void merge()}>合并</HeroButton>
      {issue || ws.needsMerge ? <span className={w.m}>{issue?.text ?? ws.needsMerge?.message}</span> : null}
    </div>
  );
}
