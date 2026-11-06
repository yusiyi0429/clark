"use client";

/**
 * Task 管线里，验收以后要你拍板的两件（新首页设计第 4.5 条）：
 * - 受阻（连续两次没过）：「按这个改（推荐）/ 我去看看 / 仍然通过」。按这个改是把验收员的改法交给执行的会话再做一遍。
 * - 验收过了还没合回：「合进 main（推荐）/ 先不合」。本机程序以后会在主文件夹干净、停在原分支、没冲突时自己合（D），合不了才问；
 *   在那之前每张验收过的卡都在这里问一句。合不了的原因写在框下，首页「等你」也列一条。
 * 第一次没过不问：改法自动送回执行员重做（useAutoReturn）。
 */
import { useState } from "react";
import { DecisionBox } from "@/components/work/DecisionBox";
import { useHandheld } from "@/components/ui/useHandheld";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { canCommandHere, overruleWorker, reply } from "@/lib/work/actions";
import { mergeCard, useMergeIssues } from "@/lib/work/merge";
import type { Worker } from "@/lib/work/workers";
import { showWorkspaceToast } from "@/lib/toast";
import { cardHref } from "@/lib/home/derive";

const fail = (error: unknown) => showWorkspaceToast({ text: error instanceof Error ? error.message : "没成功，请重试" });

/** 验收员写的改法（自动送回执行员的就是这一段），交给执行的会话时照这个写。 */
const fixText = (worker: Worker): string | null => worker.item?.card?.handback?.returnText?.trim() || null;

export function BlockedDecision({ worker, go, onChanged }: { worker: Worker; go: (href: string) => void; onChanged: () => void }) {
  const local = useLocalRunner();
  const handheld = useHandheld();
  const here = canCommandHere(worker, local.phase === "ready", handheld);
  const fixes = fixText(worker);
  const options = [...(here ? [{ label: "按这个改", recommended: true }] : []), { label: "我去看看" }, { label: "仍然通过" }];
  const pick = async (label: string) => {
    try {
      if (label === "按这个改") await reply(local.runner, worker, `验收没过，按这几条再改一遍：\n${fixes ?? "照验收员写的改法"}`);
      else if (label === "我去看看") { if (worker.cardId) go(cardHref(worker.cardId)); return; }
      else await overruleWorker(worker, "本人判仍然通过");
      onChanged();
    } catch (error) { fail(error); }
  };
  return (
    <DecisionBox kind="question" testId="blocked-decision" title={`「${worker.title}」受阻`}
      body={fixes ? <span style={{ whiteSpace: "pre-wrap" }}>{fixes}</span> : undefined}
      options={options} onPick={([index]) => pick(options[index!]!.label)} />
  );
}

export function MergeDecision({ worker, onChanged }: { worker: Worker; onChanged: () => void }) {
  const local = useLocalRunner();
  const issue = useMergeIssues().find((entry) => entry.sessionId === worker.session?.id) ?? null;
  const [later, setLater] = useState(false);
  const session = worker.session;
  const ws = session?.workspace;
  if (!session || ws?.kind !== "worktree") return null;
  const title = `「${worker.title}」验收过了`;
  if (ws.mergedCommit) return <DecisionBox kind="question" title={title} options={[]} onPick={() => undefined} resolved={`已合进 ${ws.baseBranch}`} />;
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
