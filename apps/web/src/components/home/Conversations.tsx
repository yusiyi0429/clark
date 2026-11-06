"use client";

/**
 * 展示区里的两种对话：
 * - 总管线：伙伴唯一的对话（总线程），一直聊下去；页头正中是伙伴形象（从左上角飞过来）。
 * - Task 管线：每件 Task 一条单独的对话。先聊计划，规划员拆好后在对话里给出开工的选项框；开了以后写开了哪几个子会话，
 *   验收结果、这一单全部完成也由网页按时间插进这条对话。B 的对话接口到之前是这个标签页里的假对话（lib/home/pipeline）。
 * 首页输入框发来的话（outbox）进了对应的对话就发出去。
 */
import { useEffect, useMemo, useRef } from "react";
import { Info } from "lucide-react";
import type { THomePlanTask } from "@warmap/contracts";
import { BuddyMark } from "@/components/buddy/BuddyMark";
import type { Buddy } from "@/components/buddy/useBuddy";
import { ChatColumn } from "@/components/rail/ChatPane";
import { PendingBoxes, PendingChip } from "@/components/work/DecisionBox";
import { WorkTimeline, type TimedBlock } from "@/components/work/WorkTimeline";
import { workNotes } from "@/components/work/WorkNotes";
import type { ConversationData } from "@/conversation/useConversation";
import { useConversation } from "@/conversation/useConversation";
import { usePipelineConversation } from "@/lib/home/pipeline";
import { infoHref } from "@/lib/home/derive";
import type { HomeTask, SubSession } from "@/lib/home/types";
import type { WorkHomeApi } from "@/lib/home/useWorkHome";
import { useHandheld } from "@/components/ui/useHandheld";
import { PlanDecision, PlanningLine, StartedRecord } from "./PlanDecision";
import { BlockedDecision, MergeDecision } from "./TaskDecisions";
import { subHref } from "./LeftColumn";
import { useViewChrome } from "./view";
import h from "@/styles/home.module.css";

const ICON = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

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
  useOutbox(data, "main", outbox, consume);
  useEffect(() => { onSpeaking(data.streaming); return () => onSpeaking(false); }, [data.streaming, onSpeaking]);
  const name = buddy?.name?.trim() || "伙伴";
  return (
    <PendingBoxes>
      <div className={h.convo} data-testid="buddy-view">
        <ChatColumn data={data} buddy={buddy}
          head={(
            <div className={h.buddyHead}>
              <span className={h.headSide}>{chrome.lead}</span>
              <span className={h.buddyFigure} data-buddy-figure="head" role="img" aria-label={name}><BuddyMark buddy={buddy} place="sheet" active={data.streaming} /></span>
              <span className={h.headSide} data-end="">{chrome.trail}</span>
            </div>
          )}
          timeline={(current) => <WorkTimeline data={current} blocks={[]} />}
          above={<PendingChip />} />
      </div>
    </PendingBoxes>
  );
}

export function PipelineView({ task, home, api, buddy, outbox, consume, go, onSplit }: {
  task: THomePlanTask;
  home: HomeTask | null;
  api: WorkHomeApi;
  buddy: Buddy | null;
  outbox: Outbox;
  consume: (id: number) => void;
  go: (href: string) => void;
  onSplit: (taskId: string) => void;
}) {
  const chrome = useViewChrome();
  const handheld = useHandheld();
  const { work } = api;
  const board = work.boards[task.taskId] ?? null;
  const mine = useMemo(() => work.workers.filter((worker) => worker.taskId === task.taskId), [work.workers, task.taskId]);
  // 已经拆过、开过的 Task，假对话开头不再问「先怎么开始」（刷新后不会再拆一遍）。
  const begun = !!(board?.plan || board?.drafts.length || mine.length);
  // 看板读到以前先不开对话：要先知道拆没拆过。
  const pipelineTask = useMemo(() => ({ taskId: task.taskId, name: task.name, criteria: task.criteria }), [task.taskId, task.name, task.criteria]);
  const data = usePipelineConversation(board ? pipelineTask : null,
    { split: () => onSplit(task.taskId) }, begun);
  useOutbox(data, task.taskId, outbox, consume);
  const subs = useMemo(() => home?.subSessions ?? [], [home]);
  const changed = work.refresh;
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
    // 验收以后要你拍板的：受阻（按这个改 / 我去看看 / 仍然通过）、验收过了还没合回（合进 main / 先不合）。
    for (const worker of cards) {
      const handback = worker.item!.card?.handback;
      const at = handback?.finishedAt ?? worker.endedAt ?? new Date().toISOString();
      if (worker.state === "doing" && worker.mark === "blocked") list.push({ key: `blocked:${worker.key}`, at, node: <BlockedDecision worker={worker} go={go} onChanged={() => void changed()} /> });
      if (worker.state === "done" && worker.session?.workspace?.kind === "worktree") list.push({ key: `merge:${worker.key}`, at: `${at}~`, node: <MergeDecision worker={worker} onChanged={() => void changed()} /> });
    }
    list.push(...workNotes({ workers: mine, tasks: [task], boards: work.boards,
      on: { openWorker: (key) => { const worker = mine.find((entry) => entry.key === key); if (worker?.cardId) go(subHref({ kind: "card", id: worker.cardId })); }, openTask: (taskId) => go(infoHref(taskId)), changed: () => void changed() } }));
    return list;
  }, [mine, board, task, work.roles, work.boards, handheld, changed, data, subs, go]);
  return (
    <PendingBoxes>
      <div className={h.convo} data-testid="pipeline-view">
        <ChatColumn data={data} buddy={buddy} label={task.name}
          head={(
            <header className={h.viewHead} data-flush="">
              {chrome.lead}
              <span className={h.viewTitle}>{task.name}</span>
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
