"use client";

/**
 * 展示区里的两种对话：
 * - 总管线：伙伴唯一的对话（总线程），一直聊下去；页头标题是伙伴的名字（伙伴只在左栏的伙伴台上，说话时台上的它在动）。
 * - Task 管线：每件 Task 一条单独的对话。先聊计划，规划员拆好后在对话里给出开工的选项框；开了以后写开了哪几个子会话，
 *   验收行（过了、受阻、约定都达到、返工）也由网页按时间插进这条对话。B 的接口没上时是这个标签页里的假对话（lib/home/pipeline）。
 * 首页输入框发来的话（outbox）进了对应的对话就发出去。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Info } from "lucide-react";
import type { THomePlanTask } from "@warmap/contracts";
import type { Buddy } from "@/components/buddy/useBuddy";
import { ChatColumn } from "@/components/rail/ChatPane";
import { PendingBoxes, PendingDock } from "@/components/work/DecisionBox";
import { WorkTimeline, type TimedBlock } from "@/components/work/WorkTimeline";
import type { ConversationData } from "@/conversation/useConversation";
import { useConversation } from "@/conversation/useConversation";
import { openPipeline } from "@/lib/board/cloud";
import { usePipelineConversation } from "@/lib/home/pipeline";
import { infoHref } from "@/lib/home/derive";
import type { HomeTask, SubSession } from "@/lib/home/types";
import type { WorkHomeApi } from "@/lib/home/useWorkHome";
import { PlanDecision, PlanningLine, StartedRecord } from "./PlanDecision";
import { feedBlocks, useTaskFeed } from "./TaskFeed";
import { subHref, subIcon } from "./LeftColumn";
import { useViewChrome } from "./view";
import { usePhone } from "./usePhone";
import h from "@/styles/home.module.css";

import { ICON, StateIcon } from "./StateIcon";
import { HeroButton } from "@/components/HeroButton";

/** 首页输入框发来、等着进对话的一句。 */
export type OutboxEntry = { id: number; target: "main" | string; text: string };
/** 排着的几句（按发出的先后），每条对话只取给自己的。 */
export type Outbox = OutboxEntry[];

/** 对话读好了、没在回答时，把 outbox 里给这条对话的第一句发出去（一次一句，回完再发下一句）。 */
function useOutbox(data: ConversationData, key: "main" | string, outbox: Outbox, consume: (id: number) => void) {
  const sent = useRef(new Set<number>());
  const next = outbox.find((entry) => entry.target === key && !sent.current.has(entry.id)) ?? null;
  useEffect(() => {
    if (!next || data.historyStatus !== "ready" || data.streaming) return;
    sent.current.add(next.id);
    consume(next.id);
    void data.send(next.text, []);
  }, [next, data, consume]);
}

/**
 * Esc 的顺序（5.4.2「今天」行）：菜单 → 「自己说」 → 抽屉 → 停止正在流式输出的回复 → 回首页。
 * 回复在写时，没人要的 Esc 先停下它（和 Claude Code 里 Esc 打断回复一样），外壳看到 defaultPrevented 就不回首页。
 * 捕获阶段挂在 window 上，排在外壳的 Esc 前面；输入框、菜单、弹层、选项框里的 Esc 照它们自己的来。
 */
function useEscStopsReply(data: ConversationData) {
  const { streaming, stop } = data;
  useEffect(() => {
    if (!streaming) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=\"true\"], [role=dialog], [role=menu], [role=listbox]")) return;
      event.preventDefault();
      stop();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [streaming, stop]);
}

/** context：从 Mission 详情「问伙伴」带来的「关于：{Mission}」，输入框左上角一枚胶囊（14.5），去掉调 onClearContext。 */
export function BuddyView({ buddy, outbox, consume, onSpeaking, context = null, onClearContext }: {
  buddy: Buddy | null; outbox: Outbox; consume: (id: number) => void; onSpeaking: (speaking: boolean) => void; context?: string | null; onClearContext?: () => void;
}) {
  const data = useConversation("global");
  const chrome = useViewChrome();
  useOutbox(data, "main", outbox, consume);
  useEscStopsReply(data);
  useEffect(() => { onSpeaking(data.streaming); return () => onSpeaking(false); }, [data.streaming, onSpeaking]);
  const name = buddy?.name?.trim() || "伙伴";
  return (
    <PendingBoxes>
      <div className={h.convo} data-testid="buddy-view">
        <ChatColumn data={data} buddy={buddy} tone="light"
          head={(
            <header className={h.viewHead} data-flush="">
              {chrome.lead}
              <h1 className={h.viewTitle} tabIndex={-1}>{name}</h1>
              {chrome.trail}
            </header>
          )}
          timeline={(current) => <WorkTimeline data={current} blocks={[]} />}
          dock={(latest) => <PendingDock latest={latest} />} />
      </div>
    </PendingBoxes>
  );
}

type PipelineProps = {
  task: THomePlanTask;
  home: HomeTask | null;
  api: WorkHomeApi;
  buddy: Buddy | null;
  outbox: Outbox;
  consume: (id: number) => void;
  go: (href: string) => void;
  onSplit: (taskId: string) => void;
  /** 拆卡登记没成（出「拆卡失败 · 重试」）。 */
  splitFailed?: boolean;
  /** 这个标签页里自动开工没开起来的子会话 id：管线里那一行写「失败」加「手动开始」。 */
  startFailed?: ReadonlySet<string>;
  onManualStart?: (subId: string) => void;
  /** 伙伴在这条管线里说话（伙伴台换成「在说」）。 */
  onSpeaking: (speaking: boolean) => void;
};

/**
 * B 的 Task 管线（live）用真的对话；接口确定没上（404）时是这个标签页里的假对话（lib/home/pipeline）。
 * 还不知道（首页接口第一次还没回、或一直出错）时先空着等：不开假对话（写进去的话会丢，「拆成几步」还会真的开规划员）。
 */
export function PipelineView(props: PipelineProps) {
  if (!props.api.known) return <div className={h.convo} aria-busy />;
  return props.api.live ? <LivePipeline {...props} /> : <MockPipeline {...props} />;
}

/** 第一次打开时建这件 Task 的管线对话（POST /api/me/tasks/:taskId/pipeline），收发走现有对话接口，scope 是 plan-task:<taskId>。 */
function LivePipeline(props: PipelineProps) {
  const { taskId } = props.task;
  const [scope, setScope] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void openPipeline(taskId).then((answer) => answer?.scope ?? `plan-task:${taskId}`, () => `plan-task:${taskId}`).then((next) => { if (alive) setScope(next); });
    return () => { alive = false; };
  }, [taskId]);
  return scope ? <LivePipelineBody scope={scope} {...props} /> : <div className={h.convo} aria-busy />;
}

function LivePipelineBody({ scope, ...props }: PipelineProps & { scope: string }) {
  const data = useConversation(scope);
  return <PipelineBody data={data} {...props} />;
}

function MockPipeline(props: PipelineProps) {
  const { task, api, onSplit } = props;
  const board = api.work.boards[task.taskId] ?? null;
  // 已经拆过、开过的 Task，假对话开头不再问「先怎么开始」（刷新后不会再拆一遍）；看板读到以前先不开对话：要先知道拆没拆过。
  const begun = !!(board?.plan || board?.drafts.length || api.work.workers.some((worker) => worker.taskId === task.taskId));
  const pipelineTask = useMemo(() => ({ taskId: task.taskId, name: task.name, criteria: task.criteria }), [task.taskId, task.name, task.criteria]);
  const data = usePipelineConversation(board ? pipelineTask : null, { split: () => onSplit(task.taskId) }, begun);
  return <PipelineBody data={data} {...props} />;
}

/**
 * Task 管线的对话，网页按时间插进去的几块：规划员在拆（一行）、拆好的派活单（开工的选项框）、开了哪几个子会话、
 * 验收行（过了、受阻、约定都达到、返工，TaskFeed）。
 */
function PipelineBody({ data, task, home, api, buddy, outbox, consume, go, onSpeaking, onSplit, splitFailed, startFailed, onManualStart }: PipelineProps & { data: ConversationData }) {
  const chrome = useViewChrome();
  const handheld = usePhone();
  const { work } = api;
  useEscStopsReply(data);
  useEffect(() => { onSpeaking(data.streaming); return () => onSpeaking(false); }, [data.streaming, onSpeaking]);
  const board = work.boards[task.taskId] ?? null;
  const mine = useMemo(() => work.workers.filter((worker) => worker.taskId === task.taskId), [work.workers, task.taskId]);
  useOutbox(data, task.taskId, outbox, consume);
  const feed = useTaskFeed(task.taskId, board, api);
  const subs = useMemo(() => home?.subSessions ?? [], [home]);
  const changed = api.refresh;
  const waiting = api.data.waiting;
  // 专题行排在第一次看到它的时候（契约没有开出时间；updatedAt 会跟着动，用它排这一行会在对话里跳）。
  const seen = useRef(new Map<string, string>());
  const firstSeen = (id: string, at: string) => { if (!seen.current.has(id)) seen.current.set(id, at); return seen.current.get(id)!; };
  const blocks = useMemo<TimedBlock[]>(() => {
    const list: TimedBlock[] = [];
    const planner = mine.find((worker) => worker.kind === "plan" && worker.state !== "done");
    if (planner) list.push({ key: `planning:${planner.key}`, at: planner.startedAt ?? planner.requestedAt ?? new Date().toISOString(), node: <PlanningLine planner={planner} /> });
    // 拆卡没做完（出了错才给兜底）：一行「拆卡失败」加「重试」（弱按钮）。
    else if ((board?.plan?.status === "failed" && !board.drafts.length) || splitFailed) {
      const plan = board?.plan?.status === "failed" ? board.plan : null;
      list.push({ key: `plan-failed:${plan?.id ?? task.taskId}`, at: plan ? plan.finishedAt ?? plan.createdAt : new Date().toISOString(), node: (
        <p className={h.line} data-testid="plan-failed"><StateIcon state="failed" />拆卡失败<HeroButton variant="ghost" size="sm" onPress={() => onSplit(task.taskId)}>重试</HeroButton></p>
      ) });
    }
    if (board?.drafts.length) {
      // 拆好的时候（规划员拆完同步上来那一刻）；没有记录时当作现在，放在最后。
      list.push({ key: `plan:${board.drafts[0]!.id}`, at: board.plan?.finishedAt ?? board.plan?.createdAt ?? new Date().toISOString(), node: (
        <PlanDecision task={task} drafts={board.drafts} roles={work.roles?.roles ?? []} handheld={handheld} onChanged={() => void changed()}
          onSay={(text) => data.send(text, [])} />
      ) });
    }
    // 开了以后：从最早那张卡开工的时候起，写开了哪几个子会话（按开工时间排在对话里）。
    const cards = mine.filter((worker) => worker.kind === "card" && worker.item);
    const first = cards.map((worker) => worker.item!.createdAt).sort()[0];
    const cardSubs = subs.filter((sub) => sub.kind === "card");
    if (first && cardSubs.length) {
      list.push({ key: `started:${task.taskId}`, at: first, node: <StartedRecord task={task.name} subs={[...cardSubs].sort(byTitle(cards))} onOpen={(sub: SubSession) => go(subHref(sub))} /> });
    }
    // 管线或伙伴开的探索子会话（专题）：开出时一行（5.4.3 事件行），按开出的时间排；点了进那个子会话。
    for (const sub of subs.filter((entry) => entry.kind === "topic")) {
      list.push({ key: `topic:${sub.id}`, at: firstSeen(sub.id, sub.updatedAt), node: (
        <p className={h.line} data-testid="topic-opened"><StateIcon {...subIcon(sub)} /><button type="button" className={h.lineLink} onClick={() => go(subHref(sub))}>{sub.title}</button></p>
      ) });
    }
    // 自动开工没开起来的（这个标签页里试过的）：那一行「失败」加「手动开始」（弱按钮，5.4.3、9.8：手动开始只有这一处）。
    for (const sub of subs.filter((entry) => startFailed?.has(entry.id) && entry.state === "queued")) {
      list.push({ key: `start-failed:${sub.id}`, at: new Date().toISOString(), node: (
        <p className={h.line} data-testid="start-failed"><StateIcon state="failed" /><span className={h.lineMore}>{sub.title} · 失败</span>
          {onManualStart ? <HeroButton variant="ghost" size="sm" onPress={() => onManualStart(sub.id)}>手动开始</HeroButton> : null}</p>
      ) });
    }
    // 别的电脑上跑的子会话：等你里那一条（按本机会话对上卡、专题）带着原话，管线里照它写。
    const remoteAsks = new Map(subs.flatMap((sub) => {
      const item = sub.sessionId ? waiting.find((entry) => entry.sessionId === sub.sessionId && (entry.kind === "approval" || entry.kind === "question")) : undefined;
      return item ? [[sub.id, item] as const] : [];
    }));
    list.push(...feedBlocks({ items: feed, workers: mine, taskId: task.taskId, go, onSay: (text) => data.send(text, []), onChanged: () => void changed(), remoteAsks }));
    return list;
  }, [mine, board, task, work.roles, handheld, changed, data, subs, go, feed, onSplit, splitFailed, startFailed, onManualStart, waiting]);
  return (
    <PendingBoxes>
      <div className={h.convo} data-testid="pipeline-view">
        <ChatColumn data={data} buddy={buddy} label={task.name} tone="light"
          head={(
            <header className={h.viewHead} data-flush="">
              {chrome.lead}
              <h1 className={h.viewTitle} tabIndex={-1}>{task.name}</h1>
              <button type="button" className={h.icon} aria-label="详情" title="详情" aria-pressed={false} onClick={() => go(infoHref(task.taskId))}><Info {...ICON} /></button>
              {chrome.trail}
            </header>
          )}
          timeline={(current) => <WorkTimeline data={current} blocks={blocks} />}
          dock={(latest) => <PendingDock latest={latest} />} />
      </div>
    </PendingBoxes>
  );
}

/** 开了哪几个子会话：按卡在看板里的先后。 */
const byTitle = (cards: { cardId: string | null; item: { createdAt: string } | null }[]) => (a: SubSession, b: SubSession) => {
  const at = (sub: SubSession) => cards.find((card) => card.cardId === sub.id)?.item?.createdAt ?? "";
  return at(a).localeCompare(at(b));
};
