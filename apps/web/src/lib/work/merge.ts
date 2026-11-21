/**
 * 卡的分支合回（ADR 0038）：卡在自己的 git 工作树里做，验收过了以后本人点「合并」，本机把分支合回主文件夹（POST /v1/sessions/:id/merge），从不自动合。
 * 合不了的那几张记在这里（这个页面里，跨首页和卡页），左栏「worker 等你」列出来，写清为什么、能再点。
 */
import { useSyncExternalStore } from "react";
import type { TCardGit, TLocalMergeResponse, TLocalWorkspace } from "@warmap/contracts";
import type { LocalRunner, TLocalSessionSummary } from "@/lib/local/runner";

export type MergeIssue = { sessionId: string; cardId: string | null; title: string; text: string };

let issues: MergeIssue[] = [];
const listeners = new Set<() => void>();
const publish = (next: MergeIssue[]) => { issues = next; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export const useMergeIssues = () => useSyncExternalStore(subscribe, () => issues, () => issues);

/** 文件太多时只列前几个。 */
const fileList = (files: string[]) => (files.length > 5 ? `${files.slice(0, 5).join("、")} 等 ${files.length} 个` : files.join("、"));

/** 合不了的原因，说人话。 */
export function mergeBlockedText(result: Extract<TLocalMergeResponse, { merged: false }>, baseBranch: string): string {
  if (result.reason === "base_not_checked_out") return `主文件夹现在不在 ${baseBranch} 分支上，切回去再合并`;
  if (result.reason === "dirty") return `主文件夹有没提交的改动：${fileList(result.files)}`;
  return `有冲突：${fileList(result.files)}。这次合并已放弃，主文件夹没动`;
}

/** 卡在哪做：工作树写分支，不是 git 仓库写文件夹。 */
export function placeText(workspace: TLocalWorkspace): string {
  return workspace.kind === "worktree" ? `分支 ${workspace.branch}` : `文件夹 ${workspace.folder}`;
}

/** 云端记的这次交回（手机和别的电脑上看）：交回的提交，验收员验过的提交。 */
export function commitText(git: TCardGit): string {
  return `交回 ${git.commit.slice(0, 7)}${git.verifiedCommit ? ` · 验过 ${git.verifiedCommit.slice(0, 7)}` : ""}`;
}

/** 会话真正在做的那个文件夹的完整路径（复制路径用）：工作树是它自己的目录，普通文件夹就是那个文件夹。 */
export function placePath(workspace: TLocalWorkspace): string {
  return workspace.kind === "worktree" ? workspace.path : workspace.folder;
}

/** 行里放得下的：分支名，或文件夹的最后一段。 */
export function shortPlace(workspace: TLocalWorkspace): string {
  return workspace.kind === "worktree" ? workspace.branch : workspace.folder.split(/[\\/]/).filter(Boolean).pop() ?? workspace.folder;
}

/** 合并：成了返回合回的提交；合不了（含 409）记成一条等你，返回原因。 */
export async function mergeCard(runner: LocalRunner, session: TLocalSessionSummary, title: string): Promise<{ ok: true; commit: string } | { ok: false; text: string }> {
  const base = session.workspace?.kind === "worktree" ? session.workspace.baseBranch : "";
  let text: string;
  try {
    const result = await runner.mergeSession(session.id);
    if (result.merged) {
      publish(issues.filter((issue) => issue.sessionId !== session.id));
      return { ok: true, commit: result.commit };
    }
    text = mergeBlockedText(result, base);
  } catch (error) {
    // 409（不在工作树里、还在跑、交回后又改过、已合过）和连不上本机：本机的话原样写。
    text = error instanceof Error ? error.message : "没合成，请重试";
  }
  const cardId = session.subject.kind === "card" ? session.subject.cardId ?? null : null;
  publish([...issues.filter((issue) => issue.sessionId !== session.id), { sessionId: session.id, cardId, title, text }]);
  return { ok: false, text };
}

