"use client";

/**
 * Task 管线里的验收行（新首页设计第 4.5 条，契约 GET /api/me/tasks/:taskId/feed）。网页按时间插进 Task 管线的对话：
 * - 过了：管线说的一句话「greet 验收过了（5/5），已合进 main」，鼠标移上去句尾出「推翻」（弱按钮；写原因；合回以后推翻由管线开返工子会话）；
 *   没合回的在这台电脑上接着问合不合。
 * - 受阻：选项框「按这个改（推荐）/ 我去看看 / 仍然通过」。
 * - 约定都达到：「约定 n 条都达到了，交给认可人？」——交给认可人 = 把攒着的出一版，到 Task 详情里对表、请认可人看、交付（V1 的面板）。
 * - 合回以后被推翻：一句「推翻了，开了返工「b」」，点了进返工的子会话。
 * - 子会话的提问和批准（14.3）：都在这里出选项框，框顶上一行写子会话名，答案直接回给那个子会话；子会话页里只留一行问题和「去回答」。
 * 第一次没过不出：改法自动送回重做，不打扰你。B 的接口没上时由看板上的卡拼（derive.ts 的 deriveFeed，没有返工那一种）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { TLocalQuestionAnswerRequest, TTaskFeedItem } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { DecisionBox } from "@/components/work/DecisionBox";
import { ApprovalDecision, QuestionDecision, awayChip } from "@/components/work/decisions";
import type { TimedBlock } from "@/components/work/WorkTimeline";
import { useHandheld } from "@/components/ui/useHandheld";
import { CloudError, overrule, readTaskFeed, shipPending } from "@/lib/board/cloud";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { useSessionEvents } from "@/lib/local/useSessionEvents";
import { running } from "@/lib/local/sessionView";
import type { TaskBoard } from "@/lib/board/useTaskBoard";
import { canCommandHere } from "@/lib/work/actions";
import { useMergeIssues } from "@/lib/work/merge";
import type { Worker } from "@/lib/work/workers";
import { cardHref, deriveFeed, infoHref } from "@/lib/home/derive";
import type { FeedItem } from "@/lib/home/types";
import type { WorkHomeApi } from "@/lib/home/useWorkHome";
import { BlockedDecision, MergeDecision, answeredOf, markAnswered } from "./TaskDecisions";
import f from "@/styles/task-feed.module.css";

const POLL_MS = 5000;
/** 推翻的原因（OverruleCardHandbackRequest.reason 的上限）。 */
const REASON_MAX = 200;

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

/** 子会话页「去回答」跳过来的地址：Task 管线，锚在那个子会话的选项框上。 */
export const askAnchor = (sessionId: string) => `ask-${sessionId}`;

/**
 * 验收行变成对话里按时间插的几块；合不合回的选项框接在「过了」那一句后面。子会话在问、在等批准的，也在这里出选项框（14.3）。
 * onSay：「自己说」发进 Task 管线；发不出去（管线正在回话）时回 false。
 */
export function feedBlocks({ items, workers, taskId, go, onSay, onChanged }: {
  items: FeedItem[];
  workers: Worker[];
  taskId: string;
  go: (href: string) => void;
  onSay: (text: string) => unknown;
  onChanged: () => void;
}): TimedBlock[] {
  const workerOf = (cardId: string) => workers.find((worker) => worker.cardId === cardId && worker.kind === "card") ?? null;
  const feed = items.flatMap((item): TimedBlock[] => {
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
        <p className={f.sentence} data-testid="feed-rework">
          <button type="button" className={f.sentenceLink} onClick={() => go(cardHref(item.cardId))}>推翻了，开了返工「{item.title}」</button>
          {item.reason ? <span className={f.more}>{item.reason}</span> : null}
        </p>
      ) }];
    }
  });
  // 子会话在问、在等批准（这台电脑上跑的看本机会话；别的电脑上跑的只知道在等批准）。
  const asking = workers.flatMap((worker): TimedBlock[] => {
    if (worker.kind !== "card" && worker.kind !== "topic") return [];
    const session = worker.session;
    // 本机上正在跑的会话都挂一块（没在问时什么都不画），这样一问就出，不等会话列表刷新；停着的看摘要里有没有挂着的。
    if (session ? !(running(session.status) || session.pendingPermissions > 0 || session.pendingQuestion) : worker.mark !== "approval") return [];
    return [{ key: `ask:${worker.key}`, at: session?.updatedAt ?? worker.startedAt ?? new Date().toISOString(), node: <SubSessionAsk worker={worker} /> }];
  });
  return [...feed, ...asking];
}

type Passed = Extract<TTaskFeedItem, { kind: "card_passed" }>;

/** 结果那一句（5.4.3，只有一种写法）：「greet 验收过了（5/5），已合进 main」；合不回来写「无法合回」。 */
export function passedText(item: Passed): string {
  const merge = item.merge;
  const where = merge?.state === "merged" ? `，已合进 ${merge.baseBranch ?? "原分支"}` : merge?.state === "needs_merge" ? "，无法合回" : "";
  return `${item.title} 验收过了（${item.met}/${item.total}）${where}`;
}

/** 过了的那一句：是管线说的话（正文），鼠标移上去句尾出「推翻」（弱按钮）。推翻要写原因：点了就地展开一个只写原因的选项框。推翻的是这张卡最近一次交回（看板上的）。 */
function PassedLine({ item, worker, go, onChanged }: { item: Passed; worker: Worker | null; go: (href: string) => void; onChanged: () => void }) {
  const [undoing, setUndoing] = useState(false);
  const handback = worker?.item?.card?.handback;
  const canUndo = !!handback && handback.status === "done" && !handback.overruled && handback.outcome === "pass";
  return (
    <div data-testid="feed-passed">
      <p className={f.sentence}>
        <button type="button" className={f.sentenceLink} onClick={() => go(cardHref(item.cardId))}>{passedText(item)}</button>
        {canUndo && !undoing ? <HeroButton variant="ghost" size="sm" className={f.undo} onPress={() => setUndoing(true)}>推翻</HeroButton> : null}
      </p>
      {undoing && handback ? (
        <DecisionBox kind="question" testId="overrule-box" title={`推翻 ${item.title}`}
          options={[{ label: "不推翻" }]} onPick={() => setUndoing(false)}
          other={{ label: "写原因…", placeholder: "为什么推翻", maxLength: REASON_MAX, onSubmit: async (reason) => {
            await overrule(item.cardId, handback.id, reason); setUndoing(false); onChanged();
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
function CriteriaDecision({ item, taskId, go, onSay }: { item: Met; taskId: string; go: (href: string) => void; onSay: (text: string) => unknown }) {
  const [answer, setAnswer] = useState<string | null>(() => answeredOf(item.id));
  const title = `约定 ${item.total} 条都达到了，交给认可人？`;
  if (answer) return <DecisionBox kind="question" title={title} options={[]} onPick={() => undefined} resolved={answer} />;
  const settle = (text: string) => { markAnswered(item.id, text); setAnswer(text); };
  // 出一版没成（文件太多、产出缺了）：框留着，原处写「失败 · 重试」（原因在 title 里）；没有攒着的东西也算成了（最新那版照旧）。
  const hand = async () => {
    try { await shipPending(taskId); }
    catch (error) { if (!(error instanceof CloudError && error.code === "NOTHING_PENDING")) throw error; }
    settle("交给认可人");
    go(infoHref(taskId));
  };
  // 自己说：发进 Task 管线；管线正在回话发不出去时算失败（框留着、写「失败 · 重试」），发出去了才收起。
  const say = async (text: string) => {
    if ((await onSay(text)) === false) throw new Error("没发出去");
    settle(text);
  };
  return (
    <DecisionBox kind="question" testId="criteria-decision" title={title}
      options={[{ label: "交给认可人", recommended: true }, { label: "先不交" }]}
      onPick={([index]) => (index === 0 ? hand() : settle("先不交"))}
      other={{ onSubmit: say }} />
  );
}

/**
 * 子会话的提问和批准，由 Task 管线转达（14.3）：框顶上一行 12 淡色写子会话名，下面是问题和选项，答案直接回给那个子会话。
 * 只有跑它的这台电脑上能答；别处只留问题和「等你 · {电脑名}」。从子会话页「去回答」跳来（地址带 #ask-会话）时滚到这里。
 */
function SubSessionAsk({ worker }: { worker: Worker }) {
  const local = useLocalRunner();
  const handheld = useHandheld();
  const session = worker.session;
  const { view } = useSessionEvents(local.runner, session?.id ?? null);
  const ref = useRef<HTMLDivElement>(null);
  const here = canCommandHere(worker, local.phase === "ready", handheld);
  const blocked = here ? null : awayChip(worker.device);
  // 连上事件流以后只认事件流（答过、作废了就是没有），还没连上时照会话摘要。
  const linked = !!view.lastSeq;
  const question = session ? (linked ? view.question : session.pendingQuestion ?? null) : null;
  const pending = linked ? view.pending : [];
  useEffect(() => {
    if (!session || window.location.hash !== `#${askAnchor(session.id)}`) return;
    ref.current?.scrollIntoView({ block: "center" });
    ref.current?.querySelector<HTMLElement>("[data-selected]")?.focus({ preventScroll: true });
  }, [session, question, pending.length]);
  const answer = async (body: TLocalQuestionAnswerRequest) => {
    if (!session || !question) return;
    await local.runner.answerQuestion(session.id, question.requestId, body);
    await local.refresh();
  };
  const remote = !session && worker.mark === "approval";
  if (!question && !pending.length && !remote) return null;
  return (
    <div ref={ref} id={session ? askAnchor(session.id) : undefined} className={f.ask} data-testid="sub-ask">
      <p className={f.askFrom}>{worker.title}</p>
      {pending.length && session ? (
        <ApprovalDecision requests={pending} blocked={blocked} onDecide={(request, decision, { forSession, message }) => local.runner.decidePermission(session.id, request.requestId,
          { decision, ...(forSession ? { allowForSession: true } : {}), ...(message ? { message } : {}) }).then(() => local.refresh())} />
      ) : null}
      {question ? <QuestionDecision key={question.requestId} request={question} blocked={blocked} onAnswer={answer} /> : null}
      {remote ? <DecisionBox kind="approval" title={worker.ask?.text ?? "等你批准"} options={[]} onPick={() => undefined} blocked={awayChip(worker.device)} /> : null}
    </div>
  );
}
