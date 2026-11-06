"use client";

/**
 * Task 管线里，验收以后要你拍板的（新首页设计第 4.5 条，契约 TaskFeedItem 的 card_blocked 和 card_passed 的合回）：
 * - 受阻（连续两次没过）：「按这个改（推荐）/ 我去看看 / 仍然通过」。按这个改 = 把改法说给执行的会话（只在跑它的这台电脑上），
 *   再告诉云端已经送回（/handbacks/:id/returned）；仍然通过 = 推翻（/handbacks/:id/overrule）。
 * - 验收过了没合回：「合进 main（推荐）/ 先不合」。本机程序在主文件夹干净、停在原分支、没冲突时自己合（D），合不了、或本人关了「验收过就合回」才问；
 *   只在那张卡跑的这台电脑上能合。合不了的原因写在框下，首页「等你」也列一条。
 * 第一次没过不问：改法自动送回执行员重做（useAutoReturn）。
 */
import { useState } from "react";
import type { TTaskFeedItem } from "@warmap/contracts";
import { DecisionBox } from "@/components/work/DecisionBox";
import { useHandheld } from "@/components/ui/useHandheld";
import { markReturned, overrule } from "@/lib/board/cloud";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { canCommandHere, reply } from "@/lib/work/actions";
import { mergeCard, useMergeIssues } from "@/lib/work/merge";
import type { Worker } from "@/lib/work/workers";
import { showWorkspaceToast } from "@/lib/toast";
import { cardHref } from "@/lib/home/derive";

const fail = (error: unknown) => showWorkspaceToast({ text: error instanceof Error ? error.message : "没成功，请重试" });

/** Task 管线里答过的验收行（这台电脑上记着）：同一件不再问，一行写答了什么。 */
const ANSWERED_KEY = "tianshu-feed-answered-v2";
const readAnswered = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(ANSWERED_KEY) ?? "{}") as Record<string, string>; } catch { return {}; } };
export const answeredOf = (id: string): string | null => readAnswered()[id] ?? null;
export const markAnswered = (id: string, answer: string) => {
  try { localStorage.setItem(ANSWERED_KEY, JSON.stringify(Object.fromEntries([...Object.entries(readAnswered()), [id, answer]].slice(-50)))); } catch { /* 下次再问 */ }
};

type Blocked = Extract<TTaskFeedItem, { kind: "card_blocked" }>;

export function BlockedDecision({ item, worker, go, onChanged }: { item: Blocked; worker: Worker | null; go: (href: string) => void; onChanged: () => void }) {
  const local = useLocalRunner();
  const handheld = useHandheld();
  // 送回去、算通过以后，到下一次交回之前云端还是受阻：这里记着答过了，不再给选项（免得改法送两遍）。
  const [answer, setAnswer] = useState<string | null>(() => answeredOf(item.id));
  const here = !!worker && canCommandHere(worker, local.phase === "ready", handheld);
  const fix = item.fix?.trim() || null;
  const options = [...(here ? [{ label: "按这个改", recommended: true }] : []), { label: "我去看看" }, { label: "仍然通过" }];
  const pick = async (label: string) => {
    try {
      if (label === "按这个改" && worker) {
        await reply(local.runner, worker, `验收没过，按这几条再改一遍：\n${fix ?? "照验收员写的改法"}`);
        await markReturned(item.cardId, item.handbackId).catch(() => undefined);
      } else if (label === "我去看看") { go(cardHref(item.cardId)); return; }
      else await overrule(item.cardId, item.handbackId, "本人判仍然通过");
      markAnswered(item.id, label);
      setAnswer(label);
      onChanged();
    } catch (error) { fail(error); }
  };
  if (answer) return <DecisionBox kind="question" title={`「${item.title}」受阻`} options={[]} onPick={() => undefined} resolved={answer} />;
  return (
    <DecisionBox kind="question" testId="blocked-decision" title={`「${item.title}」受阻`}
      body={fix ? <span style={{ whiteSpace: "pre-wrap" }}>{fix}</span> : undefined}
      options={options} onPick={([index]) => pick(options[index!]!.label)} />
  );
}

/** 只在跑这张卡的这台电脑上（有本机会话、在工作树里做）出；别处 Task 管线里那一行写「还没合回」。 */
export function MergeDecision({ worker, onChanged }: { worker: Worker; onChanged: () => void }) {
  const local = useLocalRunner();
  const issue = useMergeIssues().find((entry) => entry.sessionId === worker.session?.id) ?? null;
  const [later, setLater] = useState(false);
  const session = worker.session;
  const ws = session?.workspace;
  if (!session || ws?.kind !== "worktree" || ws.mergedCommit) return null;
  const title = `「${worker.title}」还没合回`;
  if (later) return <DecisionBox kind="question" title={title} options={[]} onPick={() => undefined} resolved="先不合" />;
  const merge = async () => {
    const result = await mergeCard(local.runner, session, worker.title);
    if (result.ok) showWorkspaceToast({ text: `已合进 ${ws.baseBranch}` });
    await local.refresh();
    onChanged();
  };
  return (
    <DecisionBox kind="question" testId="merge-decision" title={title} body={issue ? issue.text : undefined}
      options={[{ label: `合进 ${ws.baseBranch}`, recommended: true }, { label: "先不合" }]}
      onPick={([index]) => (index === 0 ? merge() : setLater(true))} />
  );
}
