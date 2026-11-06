"use client";

/**
 * Task 管线里的验收行（新首页设计第 4.5 条，契约 GET /api/me/tasks/:taskId/feed）。网页按时间插进 Task 管线的对话：
 * - 过了：一行「「greet」验收过了（5/5），已合进 main」，行尾能推翻（写原因；合回以后推翻由管线开返工子会话）；没合回的在这台电脑上接着问合不合。
 * - 受阻：选项框「按这个改（推荐）/ 我去看看 / 仍然通过」。
 * - 约定都达到：「约定 n 条都达到了，交给认可人？」——交给认可人 = 把攒着的出一版，到 Task 详情里对表、请认可人看、交付（V1 的面板）。
 * - 合回以后被推翻：一行「推翻了「a」，开了返工「b」」，点了进返工的子会话。
 * 第一次没过不出：改法自动送回重做，不打扰你。B 的接口没上时由看板上的卡拼（derive.ts 的 deriveFeed，没有返工那一种）。
 */
import { useEffect, useMemo, useState } from "react";
import { Check, CornerDownRight } from "lucide-react";
import type { TTaskFeedItem } from "@warmap/contracts";
import { DecisionBox } from "@/components/work/DecisionBox";
import type { TimedBlock } from "@/components/work/WorkTimeline";
import { CloudError, overrule, readTaskFeed, shipPending } from "@/lib/board/cloud";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import type { TaskBoard } from "@/lib/board/useTaskBoard";
import { useMergeIssues } from "@/lib/work/merge";
import type { Worker } from "@/lib/work/workers";
import { showWorkspaceToast } from "@/lib/toast";
import { cardHref, deriveFeed, infoHref } from "@/lib/home/derive";
import type { FeedItem } from "@/lib/home/types";
import type { WorkHomeApi } from "@/lib/home/useWorkHome";
import { BlockedDecision, MergeDecision, answeredOf, markAnswered } from "./TaskDecisions";
import h from "@/styles/home.module.css";

const POLL_MS = 5000;
const ICON = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

/** board：这件 Task 的看板（所有的卡和标准；worker 列表只带今天完成的）。 */
export function useTaskFeed(taskId: string, board: TaskBoard | null, api: WorkHomeApi): FeedItem[] {
  const merges = useMergeIssues();
  const local = useLocalRunner();
  const [cloud, setCloud] = useState<{ taskId: string; items: FeedItem[] } | null>(null);
  useEffect(() => {
    if (!api.live) return;
    let alive = true;
    const load = () => readTaskFeed(taskId).then((data) => { if (alive && data) setCloud({ taskId, items: data.items }); }, () => undefined);
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [api.live, taskId]);
  const mine = useMemo(() => api.work.workers.filter((worker) => worker.taskId === taskId), [api.work.workers, taskId]);
  const derived = useMemo(() => deriveFeed({ cards: board?.cards ?? [], workers: mine, criteria: board?.criteria.map((criterion) => criterion.text) ?? [], merges, sessions: local.sessions }),
    [board, mine, merges, local.sessions]);
  return api.live ? (cloud?.taskId === taskId ? cloud.items : []) : derived;
}

/** 验收行变成对话里按时间插的几块；合不合回的选项框接在「过了」那一行后面。 */
export function feedBlocks({ items, workers, taskId, go, onSay, onChanged }: {
  items: FeedItem[];
  workers: Worker[];
  taskId: string;
  go: (href: string) => void;
  onSay: (text: string) => void;
  onChanged: () => void;
}): TimedBlock[] {
  const workerOf = (cardId: string) => workers.find((worker) => worker.cardId === cardId && worker.kind === "card") ?? null;
  return items.flatMap((item): TimedBlock[] => {
    switch (item.kind) {
      case "card_passed": {
        const worker = workerOf(item.cardId);
        const blocks: TimedBlock[] = [{ key: item.id, at: item.at, node: <PassedLine item={item} worker={worker} go={go} onChanged={onChanged} /> }];
        if (item.merge?.state === "needs_merge" && worker?.session) blocks.push({ key: `${item.id}:merge`, at: `${item.at}~`, node: <MergeDecision worker={worker} onChanged={onChanged} /> });
        return blocks;
      }
      case "card_blocked": return [{ key: item.id, at: item.at, node: <BlockedDecision item={item} worker={workerOf(item.cardId)} go={go} onChanged={onChanged} /> }];
      case "criteria_met": return [{ key: item.id, at: item.at, node: <CriteriaDecision item={item} taskId={taskId} go={go} onSay={onSay} /> }];
      case "rework_opened": return [{ key: item.id, at: item.at, node: (
        <p className={h.line} data-testid="feed-rework">
          <CornerDownRight {...ICON} />
          <button type="button" className={h.lineLink} onClick={() => go(cardHref(item.cardId))}>推翻了，开了返工「{item.title}」</button>
          {item.reason ? <span className={h.lineMore}>{item.reason}</span> : null}
        </p>
      ) }];
    }
  });
}

type Passed = Extract<TTaskFeedItem, { kind: "card_passed" }>;

function passedText(item: Passed): string {
  const merge = item.merge;
  const where = merge?.state === "merged" ? `，已合进 ${merge.baseBranch ?? "原分支"}` : merge?.state === "needs_merge" ? "，还没合回" : "";
  return `「${item.title}」验收过了（${item.met}/${item.total}）${where}`;
}

/** 过了的一行。推翻要写原因：点了就地展开一个只写原因的选项框。推翻的是这张卡最近一次交回（看板上的）。 */
function PassedLine({ item, worker, go, onChanged }: { item: Passed; worker: Worker | null; go: (href: string) => void; onChanged: () => void }) {
  const [undoing, setUndoing] = useState(false);
  const handback = worker?.item?.card?.handback;
  const canUndo = !!handback && handback.status === "done" && !handback.overruled && handback.outcome === "pass";
  return (
    <div data-testid="feed-passed">
      <p className={h.line}>
        <Check {...ICON} />
        <button type="button" className={h.lineLink} onClick={() => go(cardHref(item.cardId))}>{passedText(item)}</button>
        {canUndo && !undoing ? <button type="button" className={h.lineAct} onClick={() => setUndoing(true)}>推翻</button> : null}
      </p>
      {undoing && handback ? (
        <DecisionBox kind="question" testId="overrule-box" title={`推翻「${item.title}」`}
          options={[{ label: "不推翻" }]} onPick={() => setUndoing(false)}
          other={{ label: "写原因…", placeholder: "为什么推翻", onSubmit: async (reason) => {
            try { await overrule(item.cardId, handback.id, reason); showWorkspaceToast({ text: "已推翻" }); setUndoing(false); onChanged(); }
            catch (error) { showWorkspaceToast({ text: error instanceof Error ? error.message : "没成功，请重试" }); }
          } }} />
      ) : null}
    </div>
  );
}

type Met = Extract<TTaskFeedItem, { kind: "criteria_met" }>;

/**
 * 约定都达到了：交给认可人 = 把攒着的出一版（没东西可攒也行，最新那版照旧），然后到 Task 详情里看对表、请认可人看、交付——
 * 评审要跑一会儿，请人看和交付都要等它评完，所以不在这里一口气做完。答过的（这台电脑上）不再问。
 */
function CriteriaDecision({ item, taskId, go, onSay }: { item: Met; taskId: string; go: (href: string) => void; onSay: (text: string) => void }) {
  const [answer, setAnswer] = useState<string | null>(() => answeredOf(item.id));
  const title = `约定 ${item.total} 条都达到了，交给认可人？`;
  if (answer) return <DecisionBox kind="question" title={title} options={[]} onPick={() => undefined} resolved={answer} />;
  const settle = (text: string) => { markAnswered(item.id, text); setAnswer(text); };
  // 出一版没成（文件太多、产出缺了）：框留着，照样去 Task 详情里改；没有攒着的东西也算成了（最新那版照旧）。
  const hand = async () => {
    try { await shipPending(taskId); settle("交给认可人"); }
    catch (error) {
      if (error instanceof CloudError && error.code === "NOTHING_PENDING") settle("交给认可人");
      else showWorkspaceToast({ text: error instanceof Error ? error.message : "没出成一版" });
    }
    go(infoHref(taskId));
  };
  return (
    <DecisionBox kind="question" testId="criteria-decision" title={title}
      options={[{ label: "交给认可人", recommended: true }, { label: "先不交" }]}
      onPick={([index]) => (index === 0 ? hand() : settle("先不交"))}
      other={{ onSubmit: (text) => { settle(text); onSay(text); } }} />
  );
}
