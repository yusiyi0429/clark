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
import { PendingBoxes, PendingChip } from "@/components/work/DecisionBox";
import { WorkTimeline, type TimedBlock } from "@/components/work/WorkTimeline";
import type { ConversationData } from "@/conversation/useConversation";
import { useConversation } from "@/conversation/useConversation";
import { openPipeline } from "@/lib/board/cloud";
import { usePipelineConversation } from "@/lib/home/pipeline";
import { infoHref } from "@/lib/home/derive";
import type { HomeTask, SubSession } from "@/lib/home/types";
import type { WorkHomeApi } from "@/lib/home/useWorkHome";
import { useHandheld } from "@/components/ui/useHandheld";
import { PlanDecision, PlanningLine, StartedRecord } from "./PlanDecision";
import { feedBlocks, useTaskFeed } from "./TaskFeed";
import { subHref } from "./LeftColumn";
import { useDarkScheme, useViewChrome } from "./view";
import h from "@/styles/home.module.css";

import { ICON } from "./StateIcon";

/** 首页输入框发来、等着进对话的一句。 */
export type Outbox = { id: number; target: "main" | string; text: string } | null;

/** 对话读好了、没在回答时，把 outbox 里给这条对话的那句发出去。 */
function useOutbox(data: ConversationData, key: "main" | string, outbox: Outbox, consume: (id: number) => void) {
  const sent = useRef<number | null>(null);
  useEffect(() => {
    if (!outbox || outbox.target !== key || sent.current === outbox.id) return;
    if (data.historyStatus !== "ready" || data.streaming) return;
    sent.current = outbox.id;
    consume(outbox.id);
    void data.send(outbox.text, []);
  }, [outbox, key, data, consume]);
}

export function BuddyView({ buddy, outbox, consume, onSpeaking }: { buddy: Buddy | null; outbox: Outbox; consume: (id: number) => void; onSpeaking: (speaking: boolean) => void }) {
  const data = useConversation("global");
  const chrome = useViewChrome();
  const dark = useDarkScheme();
  useOutbox(data, "main", outbox, consume);
  useEffect(() => { onSpeaking(data.streaming); return () => onSpeaking(false); }, [data.streaming, onSpeaking]);
  const name = buddy?.name?.trim() || "伙伴";
  return (
    <PendingBoxes>
      <div className={h.convo} data-testid="buddy-view">
        <ChatColumn data={data} buddy={buddy} tone={dark ? "dark" : "light"}
          head={(
            <header className={h.viewHead} data-flush="">
              {chrome.lead}
              <h1 className={h.viewTitle} tabIndex={-1}>{name}</h1>
              {chrome.trail}
            </header>
          )}
          timeline={(current) => <WorkTimeline data={current} blocks={[]} />}
          above={<PendingChip />} />
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
  /** 伙伴在这条管线里说话（伙伴台换成「在说」）。 */
  onSpeaking: (speaking: boolean) => void;
};

/** B 的 Task 管线（live）用真的对话；接口没上时是这个标签页里的假对话（lib/home/pipeline）。 */
export function PipelineView(props: PipelineProps) {
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
function PipelineBody({ data, task, home, api, buddy, outbox, consume, go, onSpeaking }: PipelineProps & { data: ConversationData }) {
  const chrome = useViewChrome();
  const dark = useDarkScheme();
  const handheld = useHandheld();
  const { work } = api;
  useEffect(() => { onSpeaking(data.streaming); return () => onSpeaking(false); }, [data.streaming, onSpeaking]);
  const board = work.boards[task.taskId] ?? null;
  const mine = useMemo(() => work.workers.filter((worker) => worker.taskId === task.taskId), [work.workers, task.taskId]);
  useOutbox(data, task.taskId, outbox, consume);
  const feed = useTaskFeed(task.taskId, board, api);
  const subs = useMemo(() => home?.subSessions ?? [], [home]);
  const changed = api.refresh;
  const blocks = useMemo<TimedBlock[]>(() => {
    const list: TimedBlock[] = [];
    const planner = mine.find((worker) => worker.kind === "plan" && worker.state !== "done");
    if (planner) list.push({ key: `planning:${planner.key}`, at: planner.startedAt ?? planner.requestedAt ?? new Date().toISOString(), node: <PlanningLine planner={planner} /> });
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
      list.push({ key: `started:${task.taskId}`, at: first, node: <StartedRecord subs={[...cardSubs].sort(byTitle(cards))} onOpen={(sub: SubSession) => go(subHref(sub))} /> });
    }
    list.push(...feedBlocks({ items: feed, workers: mine, taskId: task.taskId, go, onSay: (text) => void data.send(text, []), onChanged: () => void changed() }));
    return list;
  }, [mine, board, task, work.roles, handheld, changed, data, subs, go, feed]);
  return (
    <PendingBoxes>
      <div className={h.convo} data-testid="pipeline-view">
        <ChatColumn data={data} buddy={buddy} label={task.name} tone={dark ? "dark" : "light"}
          head={(
            <header className={h.viewHead} data-flush="">
              {chrome.lead}
              <h1 className={h.viewTitle} tabIndex={-1}>{task.name}</h1>
              <button type="button" className={h.icon} aria-label="详情" title="详情" aria-pressed={false} onClick={() => go(infoHref(task.taskId))}><Info {...ICON} /></button>
              {chrome.trail}
            </header>
          )}
          timeline={(current) => <WorkTimeline data={current} blocks={blocks} />}
          above={<PendingChip />} />
      </div>
    </PendingBoxes>
  );
}

/** 开了哪几个子会话：按卡在看板里的先后。 */
const byTitle = (cards: { cardId: string | null; item: { createdAt: string } | null }[]) => (a: SubSession, b: SubSession) => {
  const at = (sub: SubSession) => cards.find((card) => card.cardId === sub.id)?.item?.createdAt ?? "";
  return at(a).localeCompare(at(b));
};
