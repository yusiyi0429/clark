"use client";

/**
 * 验收以后要你拍板的（新首页设计第 4.5 条；主循环第 61、62 条；契约 CardHandbackBrief 的 headline、gaps、relay、passedWithGap）：
 * - 等你补、受阻并成一个框（HandbackDecision），子会话里钉在输入框上方（第 54 条），项目对话里受阻那一行用同一个；等你补在项目对话里只指过去。
 *   第一行是验收员那一句人话（headline）。
 *   等你补：逐条列要你做什么（gaps 里 fixBy = person 的），「我来补（推荐）/ 就到这里 / 改完成标准」。
 *   受阻：「验收意见」默认收起，点开是逐条的理由和改法，「再改一轮（推荐）/ 我去看看 / 改完成标准 / 就到这里」。
 *   「就到这里」必须写一句原因（没达到那几条的短标题列在输入框上面，输入框空着提交不了），推翻成有缺口通过。
 *   「再改一轮」「我来补」都走登记（…/relay）：在跑它的这台电脑上登记完马上认领送出去；手机上、别的电脑上框上写「电脑在线后执行 / 送到」，送到以后照 relay.state 收起。
 *   「我来补」在这台电脑上把输入框填好、聚焦（发出时由子会话页走登记）；别处就在框里写。
 * - 验收过了没合回：「合进 main（推荐）/ 先不合」。本机程序在主文件夹干净、停在原分支、没冲突时自己合，合不了、或本人关了「验收过就合回」（本机报 needsMerge）才问；
 *   只在那张卡跑的这台电脑上能合。合不了的原因写在框下，首页「等你」也列一条。
 * 第一次没过不问：改法自动送回执行员重做（useAutoReturn）。
 * 「先不合」记在这台浏览器上（attention.ts），两处一起收起，左栏不再是橙点。
 */
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { TCardGapItem, TCardHandbackBrief, TCardHandbackView, TTaskFeedItem } from "@warmap/contracts";
import type { TLocalSessionSummary } from "@/lib/local/runner";
import { DecisionBox, FailedLine } from "@/components/work/DecisionBox";
import { usePhone } from "./usePhone";
import { CloudError, overrule, relayHandback } from "@/lib/board/cloud";
import { runClaimedCommands, type SayVia } from "@/lib/buddy/sessionCommands";
import { isMergeLater, markMergeLater } from "@/lib/home/attention";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { canCommandHere } from "@/lib/work/actions";
import { mergeCard, useMergeIssues } from "@/lib/work/merge";
import type { Worker } from "@/lib/work/workers";
import { cardHref } from "@/lib/home/derive";
import { SourceWordIssues } from "@/components/cards/SourceWords";
import h from "@/styles/home.module.css";
import x from "@/styles/decision-box.module.css";


/** Task 管线里答过的验收行（这台电脑上记着）：同一件不再问，一行写答了什么。 */
const ANSWERED_KEY = "tianshu-feed-answered-v2";
const readAnswered = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(ANSWERED_KEY) ?? "{}") as Record<string, string>; } catch { return {}; } };
export const answeredOf = (id: string): string | null => readAnswered()[id] ?? null;
export const markAnswered = (id: string, answer: string) => {
  try { localStorage.setItem(ANSWERED_KEY, JSON.stringify(Object.fromEntries([...Object.entries(readAnswered()), [id, answer]].slice(-50)))); } catch { /* 下次再问 */ }
};

/** 框要的那次交回：云端的摘要（项目动态带的、卡详情里的都行）；卡详情里的多带验收员逐条的理由。 */
export type HandbackForBox = Pick<TCardHandbackBrief, "id" | "outcome" | "headline" | "sourceWordIssues" | "returnText" | "returnedAt">
  & Partial<Pick<TCardHandbackBrief, "gaps" | "relay" | "passedWithGap">> & { result?: TCardHandbackView["result"] };

/** 推翻的原因上限（OverruleCardHandbackRequest.reason）；我来补的上限（CardRelayRequest.text）。 */
const REASON_MAX = 200;
const SUPPLY_MAX = 3000;

/** 「我来补」预填：要本人补的每条一行。 */
export const supplyPrefill = (gaps: readonly TCardGapItem[]) => gaps.filter((gap) => gap.fixBy === "person").map((gap) => `${gap.short}：`).join("\n");
/** 写了东西：不是空的，也不只是预填的那几个字。 */
export const wroteMore = (prefill: string) => (text: string) => { const value = text.trim(); return !!value && value !== prefill.trim(); };

export const NEEDS_OPTIONS = ["我来补", "就到这里", "改完成标准"] as const;
export const BLOCKED_OPTIONS = ["再改一轮", "我去看看", "改完成标准", "就到这里"] as const;
const RELAY_LABEL = { return: "再改一轮", supply: "我来补" } as const;
const PENDING_CHIP = { return: "电脑在线后执行", supply: "电脑在线后送到" } as const;

/** 在跑它的这台电脑上：登记完马上认领、送给执行方（不等下一轮）。 */
export function useRelayNow(): (via?: SayVia | null) => Promise<void> {
  const local = useLocalRunner();
  return async (via) => {
    const deviceId = local.status?.deviceId;
    if (deviceId) await runClaimedCommands(deviceId, local, via).catch(() => undefined);
  };
}

/**
 * 等你补、受阻的框（见文件头）。here：跑这张卡的就是这台电脑、不是手机（登记完马上送出去）。
 * onFill：这台电脑上「我来补」把输入框填好、聚焦；不给（项目对话、手机、别的电脑）就在框里写。
 * stale：这次交回已经不是这张卡最近的那次（项目对话里的老行），收成「已失效」。
 */
export function HandbackDecision({ cardId, handback, here, via, onFill, onLook, onEdit, onChanged, stale = false }: {
  cardId: string; handback: HandbackForBox; here: boolean;
  /** 子会话页里：登记完马上认领，转话走这一页的发话，像平时说话一样先画出来（见 SayVia）。 */
  via?: SayVia | null;
  onFill?: (text: string) => void; onLook: () => void; onEdit: () => void; onChanged: () => void; stale?: boolean;
}) {
  const relayNow = useRelayNow();
  const [mode, setMode] = useState<"stop" | "supply" | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const needs = handback.outcome === "needs_person";
  const title = handback.headline?.trim() || (needs ? "等你补" : "验收两次没过");
  const gaps = handback.gaps ?? [];
  const relay = handback.relay ?? null;
  const settled = (text: string) => <DecisionBox kind="question" testId="handback-decision" title={title} options={[]} onPick={() => undefined} resolved={text} />;
  if (stale) return <DecisionBox kind="question" testId="handback-decision" title={title} options={[]} onPick={() => undefined} expired />;
  if (handback.passedWithGap) return settled("就到这里");
  if (answer) return settled(answer);
  if (relay?.state === "delivered") return settled(RELAY_LABEL[relay.kind]);
  if (!needs && !relay && handback.returnedAt) return settled("再改一轮");
  if (relay?.state === "pending") {
    return <DecisionBox kind="question" testId="handback-decision" title={title} options={[]} onPick={() => undefined} blocked={PENDING_CHIP[relay.kind]} />;
  }
  const done = (label: string) => { setAnswer(label); setMode(null); onChanged(); };
  const send = async (body: { kind: "return" } | { kind: "supply"; text: string }) => {
    // 已经登记过、处理过（409）：框上写一句现状，同时重读卡，照云端的样子画。
    try { await relayHandback(cardId, handback.id, body); }
    catch (error) { if (error instanceof CloudError && error.status === 409) onChanged(); throw error; }
    if (here) await relayNow(via);
    setMode(null);
    onChanged();
  };

  if (mode === "stop") return <StopBox title={title} gaps={gaps} onCancel={() => setMode(null)} onSubmit={async (reason) => { await overrule(cardId, handback.id, reason); done("就到这里"); }} />;
  if (mode === "supply") return <SupplyBox title={title} gaps={gaps} onCancel={() => setMode(null)} onSubmit={(text) => send({ kind: "supply", text })} />;

  const labels: readonly string[] = needs ? NEEDS_OPTIONS : BLOCKED_OPTIONS;
  const options = labels.map((label, index) => ({ label, recommended: index === 0 }));
  const pick = async (label: string) => {
    if (label === "我来补") { if (here && onFill) onFill(supplyPrefill(gaps)); else setMode("supply"); return; }
    if (label === "再改一轮") return send({ kind: "return" });
    if (label === "我去看看") return onLook();
    if (label === "改完成标准") return onEdit();
    setMode("stop");
  };
  // 要你做的那几条；和第一行同一句的不再写一遍。
  const mine = gaps.filter((gap) => gap.fixBy === "person").map((gap) => ({ index: gap.index, text: gap.fix ?? gap.short })).filter((row) => sameLine(row.text) !== sameLine(title));
  const unmet = handback.result?.criteria.filter((row) => row.verdict !== "met") ?? [];
  const opinion = unmet.length ? unmet.map((row) => (
    <li key={row.index}><span>{row.text}</span>{row.reason ? <small>{row.reason}</small> : null}{row.fix ? <small>改法：{row.fix}</small> : null}</li>
  )) : gaps.length ? gaps.map((gap) => <li key={gap.index}><span>{gap.short}</span>{gap.fix ? <small>改法：{gap.fix}</small> : null}</li>)
    : handback.returnText ? <li><span style={{ whiteSpace: "pre-wrap" }}>{handback.returnText}</span></li> : null;
  const body = needs
    ? (mine.length ? <ul className={h.wordIssues} data-testid="handback-needs">{mine.map((row) => <li key={row.index}>{row.text}</li>)}</ul> : undefined)
    : opinion || handback.sourceWordIssues.length ? <>
      <button type="button" className={x.fold} aria-expanded={open} onClick={() => setOpen(!open)} data-testid="handback-opinion">
        {open ? <ChevronDown size={16} strokeWidth={1.8} aria-hidden /> : <ChevronRight size={16} strokeWidth={1.8} aria-hidden />}验收意见
      </button>
      {open ? <>
        {opinion ? <ul className={h.wordIssues}>{opinion}</ul> : null}
        <SourceWordIssues issues={handback.sourceWordIssues} className={h.wordIssues} tagClassName={h.chip} />
      </> : null}
    </> : undefined;
  return (
    <DecisionBox kind="question" testId="handback-decision" title={title} body={body} options={options} onPick={([index]) => pick(options[index!]!.label)}
      footer={relay?.state === "failed" ? <FailedLine inline note={relay.message || "没送到"} onRetry={() => undefined} /> : undefined} />
  );
}

/** 两句是不是同一句：不看首尾空白和句末标点。 */
const sameLine = (text: string) => text.trim().replace(/[。.！!；;，,]+$/, "");

type WriteBox = { title: string; gaps: readonly TCardGapItem[]; onCancel: () => void; onSubmit: (text: string) => Promise<unknown> };

/** 「就到这里」：没达到的那几条（短标题）列在上面，下面写一句原因；空着提交不了。 */
export function StopBox({ title, gaps, onCancel, onSubmit }: WriteBox) {
  return (
    <DecisionBox kind="question" testId="handback-stop" title={title} options={[{ label: "取消" }]} onPick={onCancel}
      body={gaps.length ? <ul className={h.wordIssues} data-testid="handback-stop-gaps">{gaps.map((gap) => <li key={gap.index}>{gap.short}</li>)}</ul> : undefined}
      other={{ label: "原因", maxLength: REASON_MAX, focus: true, onSubmit }} />
  );
}

/** 手机上、别的电脑上的「我来补」：就在框里写（预填每条要补的短标题），发出去是登记。 */
export function SupplyBox({ title, gaps, onCancel, onSubmit }: WriteBox) {
  const prefill = supplyPrefill(gaps);
  return (
    <DecisionBox kind="question" testId="handback-supply" title={title} options={[{ label: "取消" }]} onPick={onCancel}
      other={{ label: "我来补", maxLength: SUPPLY_MAX, initial: prefill, accept: wroteMore(prefill), onSubmit }} />
  );
}

type Blocked = Extract<TTaskFeedItem, { kind: "card_blocked" }>;

/** 项目对话里受阻的那一行：同一个框；「我去看看」「改完成标准」进那个子会话。 */
export function BlockedDecision({ item, worker, go, onChanged }: { item: Blocked; worker: Worker | null; go: (href: string) => void; onChanged: () => void }) {
  const local = useLocalRunner();
  const handheld = usePhone();
  const here = !!worker && canCommandHere(worker, local.phase === "ready", handheld);
  const handback: HandbackForBox = item.handback ?? { id: item.handbackId, outcome: "fail", headline: null, sourceWordIssues: item.sourceWordIssues, returnText: item.fix, returnedAt: null };
  const latest = worker?.item?.card?.handback?.id ?? null;
  return (
    <HandbackDecision cardId={item.cardId} handback={handback} here={here} stale={!!latest && latest !== handback.id}
      onLook={() => go(cardHref(item.cardId))} onEdit={() => go(`${cardHref(item.cardId)}#agreement`)} onChanged={onChanged} />
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
