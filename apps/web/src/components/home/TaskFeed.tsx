"use client";

/**
 * 项目对话里的验收行（新首页设计第 4.5 条、16.3，契约 GET /api/me/projects/:projectId/feed）。网页按时间插进项目对话：
 * - 过了：管线说的一句话「greet 验收过了（5/5），已合进 main」，鼠标移上去句尾出「推翻」（弱按钮；写原因；合回以后推翻由管线开返工子会话）；
 *   没合回的在这台电脑上接着问合不合。
 * - 受阻：选项框「再改一轮（推荐）/ 我去看看 / 改完成标准 / 就到这里」（主循环第 62 条，同子会话里钉住的那个）；等你补只指过去。
 * - 约定都达到：「约定 n 条都达到了，交给认可人？」——交给认可人 = 把攒着的出一版，到 Task 详情里对表、请认可人看、交付（V1 的面板）。
 * - 合回以后被推翻：一句「推翻了，开了返工「b」」，点了进返工的子会话。
 * - 子会话的提问和批准（14.3）：都在这里出选项框，框顶上一行写子会话名，答案直接回给那个子会话；子会话页里只留一行问题和「去回答」。
 * 挂上一件 Task（goal_linked）由项目对话自己画成分隔线，不在这里。
 * 第一次没过不出：改法自动送回重做，不打扰你。B 的接口没上时由各件 Task 看板上的卡拼（derive.ts 的 deriveFeed，没有返工那一种）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { TLocalQuestionAnswerRequest, TProjectGoalChangedItem, TProjectSubSessionDecisionItem, TTaskFeedItem } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { DecisionBox } from "@/components/work/DecisionBox";
import { ApprovalDecision, QuestionDecision, awayChip } from "@/components/work/decisions";
import type { TimedBlock } from "@/components/work/WorkTimeline";
import { useHandheld } from "@/components/ui/useHandheld";
import { CloudError, answerGoalChange, overrule, readProjectFeed, shipPending } from "@/lib/board/cloud";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { useSessionEvents } from "@/lib/local/useSessionEvents";
import { running } from "@/lib/local/sessionView";
import { canCommandHere } from "@/lib/work/actions";
import { useMergeIssues } from "@/lib/work/merge";
import type { Worker } from "@/lib/work/workers";
import { askAnchor, cardHref, deriveFeed, goalAnchor, infoHref } from "@/lib/home/derive";
import type { FeedItem, ProjectFeedItem, WaitingItem } from "@/lib/home/types";
import type { WorkHomeApi } from "@/lib/home/useWorkHome";
import { BlockedDecision, MergeDecision, answeredOf, markAnswered } from "./TaskDecisions";
import { subKey } from "./SubRows";
import f from "@/styles/task-feed.module.css";

const POLL_MS = 5000;
/** 推翻的原因（OverruleCardHandbackRequest.reason 的上限）。 */
const REASON_MAX = 200;

/** 项目对话的动态。接口没上时由挂着的各件 Task 的看板拼（所有的卡和标准；worker 列表只带今天完成的），没有 goal_linked。 */
export function useProjectFeed(projectId: string, taskIds: readonly string[], api: WorkHomeApi): ProjectFeedItem[] {
  const merges = useMergeIssues();
  const local = useLocalRunner();
  const [cloud, setCloud] = useState<{ projectId: string; items: ProjectFeedItem[] } | null>(null);
  useEffect(() => {
    if (!api.live) return;
    let alive = true;
    const load = () => readProjectFeed(projectId).then((data) => { if (alive && data) setCloud({ projectId, items: data.items }); }, () => undefined);
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [api.live, projectId]);
  const { boards, workers } = api.work;
  const key = taskIds.join(",");
  const derived = useMemo(() => key.split(",").filter(Boolean).flatMap((taskId) => {
    const board = boards[taskId];
    return deriveFeed({ taskId, cards: board?.cards ?? [], workers: workers.filter((worker) => worker.taskId === taskId), criteria: board?.criteria.map((criterion) => criterion.text) ?? [],
      merges, sessions: local.sessions });
  }).sort((a, b) => a.at.localeCompare(b.at)), [key, boards, workers, merges, local.sessions]);
  return api.live ? (cloud?.projectId === projectId ? cloud.items : []) : derived;
}

/** 子会话页「去回答」、等你那一行跳过来的地址：项目对话，锚在那个子会话的选项框上（定义在 derive，等你的地址也用它）。 */
export { askAnchor } from "@/lib/home/derive";

/**
 * 验收行变成对话里按时间插的几块；合不合回的选项框接在「过了」那一句后面。子会话在问、在等批准的，也在这里出选项框（14.3）。
 * onSay：「自己说」发进项目对话；发不出去（对话正在回话）时回 false。
 */
export function feedBlocks({ items, workers, go, onSay, onChanged, remoteAsks, decisions = [] }: {
  items: FeedItem[];
  workers: Worker[];
  /** 项目动态里子会话要人介入的那几条（18.10）：按它记下的位置出决定卡，标字母；还开着的才画，答过、失效的不画（同本机那边答过就收起）。 */
  decisions?: TProjectSubSessionDecisionItem[];
  /** 子会话的字母（subKey → 字母，同左栏），决定卡上标「B · 标题」。 */
  /** 别的电脑上跑的子会话在问、在等批准：卡或专题的 id → 等你里那一条（带原话 question、要批准的那一步 permission，契约 aa6aba9e）。 */
  remoteAsks?: ReadonlyMap<string, WaitingItem>;
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
        if (item.merge?.state === "needs_merge" && worker?.session) blocks.push({ key: `${item.id}:merge`, at: `${item.at}~`, node: <MergeDecision session={worker.session} title={worker.title} onChanged={onChanged} /> });
        return blocks;
      }
      case "card_blocked": return [{ key: item.id, at: item.at, node: <BlockedDecision item={item} worker={workerOf(item.cardId)} go={go} onChanged={onChanged} /> }];
      // 等你补（主循环第 61 条）：框钉在子会话里，这里照第 54 条只指过去。
      case "card_needs_person": return [{ key: item.id, at: item.at, node: (
        <p className={f.sentence} data-testid="feed-needs-person">
          <button type="button" className={f.sentenceLink} onClick={() => go(cardHref(item.cardId))}>{item.title} 等你补</button>
          {item.handback?.headline ? <span className={f.more}>{item.handback.headline}</span> : null}
        </p>
      ) }];
      case "criteria_met": return [{ key: item.id, at: item.at, node: <CriteriaDecision item={item} go={go} onSay={onSay} /> }];
      case "rework_opened": return [{ key: item.id, at: item.at, node: (
        <p className={f.sentence} data-testid="feed-rework">
          <button type="button" className={f.sentenceLink} onClick={() => go(cardHref(item.cardId))}>推翻了，开了返工「{item.title}」</button>
          {item.reason ? <span className={f.more}>{item.reason}</span> : null}
        </p>
      ) }];
    }
  });
  // 云端记下的决定卡（18.10）：排在它记下的位置；答、批照旧走下面这块（这台电脑上的直接交给本机）。
  const subOf = (worker: Worker) => worker.cardId ?? worker.topicId ?? "";
  const placed = new Set<string>();
  const recorded = decisions.flatMap((item): TimedBlock[] => {
    const worker = item.status === "open" ? workers.find((entry) => (entry.kind === "card" || entry.kind === "topic") && subOf(entry) === item.sub.id) : undefined;
    if (!worker || placed.has(worker.key)) return [];
    placed.add(worker.key);
    const remote = { kind: item.question ? "question" as const : "approval" as const, question: item.question, permission: item.permission };
    return [{ key: item.id, at: item.at, afterSequence: item.afterSequence, node: <SubSessionAsk worker={worker} remote={remote} /> }];
  });
  // 子会话在问、在等批准（这台电脑上跑的看本机会话；别的电脑上跑的只知道在等批准）。
  const asking = workers.flatMap((worker): TimedBlock[] => {
    if ((worker.kind !== "card" && worker.kind !== "topic") || placed.has(worker.key)) return [];
    const session = worker.session;
    // 本机上正在跑的会话都挂一块（没在问时什么都不画），这样一问就出，不等会话列表刷新；停着的看摘要里有没有挂着的。
    const remote = session ? undefined : remoteAsks?.get(worker.cardId ?? worker.topicId ?? "");
    if (session ? !(running(session.status) || session.pendingPermissions > 0 || session.pendingQuestion) : worker.mark !== "approval" && !remote) return [];
    return [{ key: `ask:${worker.key}`, at: session?.updatedAt ?? worker.startedAt ?? new Date().toISOString(), node: <SubSessionAsk worker={worker} remote={remote} /> }];
  });
  return [...feed, ...recorded, ...asking];
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
          other={{ label: "写原因", maxLength: REASON_MAX, onSubmit: async (reason) => {
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
function CriteriaDecision({ item, go, onSay }: { item: Met; go: (href: string) => void; onSay: (text: string) => unknown }) {
  const { taskId } = item;
  const [answer, setAnswer] = useState<string | null>(() => answeredOf(item.id));
  const title = `约定 ${item.total} 条都达到了，交给认可人？`;
  // 答过就收起（本人 11/16：项目对话只留对话本身，不留答过的记录）。
  if (answer) return null;
  const settle = (text: string) => { markAnswered(item.id, text); setAnswer(text); };
  // 出一版没成（文件太多、产出缺了）：框留着，原处写「失败 · 重试」（原因在 title 里）；没有攒着的东西也算成了（最新那版照旧）。
  const hand = async () => {
    try { await shipPending(taskId); }
    catch (error) { if (!(error instanceof CloudError && error.code === "NOTHING_PENDING")) throw error; }
    settle("交给认可人");
    go(infoHref(taskId));
  };
  // 自己说：发进项目对话；管线正在回话发不出去时算失败（框留着、写「失败 · 重试」），发出去了才收起。
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

const ANSWER_LABEL = { stop: "停掉", keep: "留着" } as const;

/**
 * 月中 Task 改了或取消了（16.4，项目动态 goal_changed）：还有没做完的子会话时问「停掉（推荐）/ 留着」，下面列出那几个；答过的收成一行。
 * 停掉：先告诉云端（了结还排着的开工），再停这台电脑上在跑的那几个（同转交的「停掉」）；别的电脑上在跑的只能在那台电脑上停。
 * 从等你那一行跳来（地址带 #goal-<id>）时滚到这里。
 */
export function GoalChangeDecision({ projectId, item, onChanged }: { projectId: string; item: TProjectGoalChangedItem; onChanged: () => void }) {
  const local = useLocalRunner();
  const ref = useRef<HTMLDivElement>(null);
  const title = `${item.taskName}：${item.change === "cancelled" ? "Task 取消了" : "Task 改了"}`;
  useEffect(() => {
    if (item.answer || window.location.hash !== `#${goalAnchor(item.id)}`) return;
    ref.current?.scrollIntoView({ block: "center" });
    ref.current?.querySelector<HTMLElement>("[data-selected]")?.focus({ preventScroll: true });
  }, [item.answer, item.id]);
  const answer = async (value: "stop" | "keep") => {
    await answerGoalChange(projectId, item.id, value);
    if (value === "stop" && local.phase === "ready") {
      const ids = new Set(item.sessions.map((session) => session.id));
      for (const session of local.sessions.filter((entry) => running(entry.status) && ids.has(entry.subject.cardId ?? entry.subject.topicId ?? ""))) await local.runner.kill(session.id);
      await local.refresh();
    }
    onChanged();
  };
  return (
    <div ref={ref} id={goalAnchor(item.id)} data-testid="goal-change">
      {item.answer ? <DecisionBox kind="question" title={title} options={[]} onPick={() => undefined} resolved={ANSWER_LABEL[item.answer]} />
        : <DecisionBox kind="question" title={title} testId="goal-change-box"
          body={<ul className={f.goalSessions}>{item.sessions.map((session) => <li key={session.id}>{session.title}</li>)}</ul>}
          options={[{ label: "停掉", recommended: true }, { label: "留着" }]}
          onPick={([index]) => answer(index === 0 ? "stop" : "keep")} />}
    </div>
  );
}

/**
 * 子会话的提问和批准，由项目对话转达（14.3）：框顶上一行 12 淡色写子会话名，下面是问题和选项，答案直接回给那个子会话。
 * 只有跑它的这台电脑上能答；别处只留问题和「等你 · {电脑名}」。从子会话页「去回答」跳来（地址带 #ask-会话）时滚到这里。
 */
function SubSessionAsk({ worker, remote: item }: { worker: Worker; remote?: Pick<WaitingItem, "kind" | "question" | "permission"> }) {
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
  // 别的电脑上跑的：照等你那一条写原话（问的什么、要批准哪一步），这里答不了，行尾「等你 · 电脑名」。
  const remoteQuestion = !session && item?.kind === "question" ? item.question : null;
  const remote = !session && !remoteQuestion && (worker.mark === "approval" || item?.kind === "approval");
  if (!question && !pending.length && !remote && !remoteQuestion) return null;
  return (
    <div ref={ref} id={session ? askAnchor(session.id) : undefined} className={f.ask} data-testid="sub-ask">
      <p className={f.askFrom}>{worker.title}</p>
      {pending.length && session ? (
        <ApprovalDecision requests={pending} blocked={blocked} inWorktree={session.workspace?.kind === "worktree"} onDecide={(request, decision, { forSession, message }) => local.runner.decidePermission(session.id, request.requestId,
          { decision, ...(forSession ? { allowForSession: true } : {}), ...(message ? { message } : {}) }).then(() => local.refresh())} />
      ) : null}
      {question ? <QuestionDecision key={question.requestId} request={question} blocked={blocked} onAnswer={answer} /> : null}
      {remoteQuestion ? <QuestionDecision key={remoteQuestion.requestId} request={remoteQuestion} blocked={awayChip(worker.device)} onAnswer={async () => undefined} /> : null}
      {remote ? <DecisionBox kind="approval" title={item?.permission?.title ?? worker.ask?.text ?? "等你批准"} options={[]} onPick={() => undefined} blocked={awayChip(worker.device)} /> : null}
    </div>
  );
}


