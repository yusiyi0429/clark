"use client";

/**
 * Task 管线里，验收以后要你拍板的（新首页设计第 4.5 条，契约 TaskFeedItem 的 card_blocked 和 card_passed 的合回）：
 * - 受阻（连续两次没过）：「按这个改（推荐）/ 我去看看 / 仍然通过」。按这个改 = 把改法说给执行的会话（只在跑它的这台电脑上），
 *   再告诉云端已经送回（/handbacks/:id/returned）；仍然通过 = 推翻（/handbacks/:id/overrule）。
 * - 验收过了没合回：「合进 main（推荐）/ 先不合」。本机程序在主文件夹干净、停在原分支、没冲突时自己合，合不了、或本人关了「验收过就合回」（本机报 needsMerge）才问；
 *   只在那张卡跑的这台电脑上能合。合不了的原因写在框下，首页「等你」也列一条。
 * 第一次没过不问：改法自动送回执行员重做（useAutoReturn）。
 * 子会话页里同样两样钉在输入框上方（第 54 条）：受阻用 SessionBlocked（补一句让它接着做 / 接受现在的结果 / 不做了），合回同一个 MergeDecision。
 * 「先不合」记在这台浏览器上（attention.ts），两处一起收起，左栏不再是橙点。
 */
import { useState } from "react";
import type { TCardHandbackView, TTaskFeedItem } from "@warmap/contracts";
import type { TLocalSessionSummary } from "@/lib/local/runner";
import { DecisionBox } from "@/components/work/DecisionBox";
import { usePhone } from "./usePhone";
import { markReturned, overrule, updateSubSession } from "@/lib/board/cloud";
import { isMergeLater, markMergeLater } from "@/lib/home/attention";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { canCommandHere, reply } from "@/lib/work/actions";
import { mergeCard, useMergeIssues } from "@/lib/work/merge";
import type { Worker } from "@/lib/work/workers";
import { cardHref } from "@/lib/home/derive";
import { SourceWordIssues } from "@/components/cards/SourceWords";
import h from "@/styles/home.module.css";


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
  const handheld = usePhone();
  // 送回去、算通过以后，到下一次交回之前云端还是受阻：这里记着答过了，不再给选项（免得改法送两遍）。
  const [answer, setAnswer] = useState<string | null>(() => answeredOf(item.id));
  const here = !!worker && canCommandHere(worker, local.phase === "ready", handheld);
  const fix = item.fix?.trim() || null;
  const options = [...(here ? [{ label: "按这个改", recommended: true }] : []), { label: "我去看看" }, { label: "仍然通过" }];
  // 没成的交给选项框：原处写「失败 · 重试」。
  const pick = async (label: string) => {
    if (label === "按这个改" && worker) {
      await reply(local.runner, worker, `验收没过，按这几条再改一遍：\n${fix ?? "照验收员写的改法"}`);
      await markReturned(item.cardId, item.handbackId).catch(() => undefined);
    } else if (label === "我去看看") { go(cardHref(item.cardId)); return; }
    else await overrule(item.cardId, item.handbackId, "本人判仍然通过");
    markAnswered(item.id, label);
    setAnswer(label);
    onChanged();
  };
  if (answer) return <DecisionBox kind="question" title={`「${item.title}」受阻`} options={[]} onPick={() => undefined} resolved={answer} />;
  return (
    <DecisionBox kind="question" testId="blocked-decision" title={`「${item.title}」受阻`}
      body={fix || item.sourceWordIssues.length ? <>
        {fix ? <span style={{ whiteSpace: "pre-wrap" }}>{fix}</span> : null}
        <SourceWordIssues issues={item.sourceWordIssues} className={h.wordIssues} tagClassName={h.chip} />
      </> : undefined}
      options={options} onPick={([index]) => pick(options[index!]!.label)} />
  );
}

/** 只在跑这张卡的这台电脑上（有本机会话、在工作树里做）出；别处 Task 管线里那一行写「无法合回」。 */
export function MergeDecision({ session, title: cardTitle, onChanged }: { session: TLocalSessionSummary | null; title: string; onChanged: () => void }) {
  const local = useLocalRunner();
  const issue = useMergeIssues().find((entry) => entry.sessionId === session?.id) ?? null;
  const [later, setLater] = useState(() => !!session && isMergeLater(session.id));
  const ws = session?.workspace;
  if (!session || ws?.kind !== "worktree" || ws.mergedCommit || !(ws.needsMerge || issue)) return null;
  const title = `「${cardTitle}」无法合回`;
  if (later) return <DecisionBox kind="question" title={title} options={[]} onPick={() => undefined} resolved="先不合" />;
  const merge = async () => {
    await mergeCard(local.runner, session, cardTitle);
    await local.refresh();
    onChanged();
  };
  const notNow = () => { markMergeLater(session.id); setLater(true); onChanged(); };
  return (
    <DecisionBox kind="question" testId="merge-decision" title={title} body={issue?.text ?? ws.needsMerge?.message}
      options={[{ label: `合进 ${ws.baseBranch}`, recommended: true }, { label: "先不合" }]}
      onPick={([index]) => (index === 0 ? merge() : notNow())} />
  );
}

/**
 * 子会话页里受阻的框（第 54 条，钉在输入框上方）：标题写卡在哪（事项的 blocker，没有时「验收两次没过」），下面列没达到的几条和怎么补。
 * 补一句让它接着做（这台电脑上有这个会话时）：说给执行方，告诉云端已经送回；接受现在的结果：仍然通过（推翻没过）；
 * 不做了：这台电脑上在跑就停掉，子会话归档（左栏「已归档」里能恢复）。答过记成项目对话那份同一条（blocked:{交回 id}），那边也收起。
 */
export function SessionBlocked({ cardId, handback, blocker, canSay, onSay, onStop, onChanged, onGone }: {
  cardId: string; handback: TCardHandbackView | null; blocker: string | null; canSay: boolean;
  onSay: (text: string) => Promise<unknown>; onStop: () => Promise<unknown>; onChanged: () => void; onGone: () => void;
}) {
  const key = handback ? `blocked:${handback.id}` : null;
  const [answer, setAnswer] = useState<string | null>(() => (key ? answeredOf(key) : null));
  const title = blocker ? `受阻：${blocker}` : "受阻：验收两次没过";
  const done = (label: string) => { if (key) markAnswered(key, label); setAnswer(label); onChanged(); };
  if (answer) return <DecisionBox kind="question" title={title} options={[]} onPick={() => undefined} resolved={answer} />;
  const unmet = (handback?.result?.criteria ?? []).filter((row) => row.verdict !== "met");
  const options = [...(handback ? [{ label: "接受现在的结果" }] : []), { label: "不做了" }];
  const pick = async (label: string) => {
    if (label === "接受现在的结果" && handback) await overrule(cardId, handback.id, "本人接受现在的结果");
    else { await onStop(); await updateSubSession("card", cardId, { archived: true }); done(label); onGone(); return; }
    done(label);
  };
  return (
    <DecisionBox kind="question" testId="session-blocked" title={title}
      body={unmet.length ? <ul className={h.wordIssues}>{unmet.map((row) => <li key={row.index}>{row.text}{row.fix ? <small>怎么补：{row.fix}</small> : null}</li>)}</ul> : undefined}
      options={options} onPick={([index]) => pick(options[index!]!.label)}
      other={canSay ? { label: "补一句让它接着做", maxLength: 2000, onSubmit: async (text) => {
        await onSay(text);
        if (handback) await markReturned(cardId, handback.id).catch(() => undefined);
        done(text);
      } } : undefined} />
  );
}
