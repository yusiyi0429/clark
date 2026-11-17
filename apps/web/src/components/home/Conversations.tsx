"use client";

/**
 * 展示区里的两种对话：
 * - 总管线：伙伴唯一的对话（总线程），一直聊下去；页头左边是伙伴的名字。
 * 两种对话的页头正中都是伙伴的「在场」（Presence，设计 4.2）：形象钉在正中，状态胶囊挂在它下面。
 * - 项目对话（16.3，原来的 Task 管线并进来了）：每个项目一条单独的对话。先聊计划，规划员拆好后在对话里给出开工的选项框；开了以后写开了哪几个子会话，
 *   验收行（过了、受阻、约定都达到、返工）和挂上新 Task 的分隔线也由网页按时间插进这条对话。B 的接口没上时是这个标签页里的假对话（lib/home/pipeline）。
 * 首页输入框发来的话（outbox）进了对应的对话就发出去。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TCardPlanView, THomePlanTask } from "@warmap/contracts";
import type { Buddy } from "@/components/buddy/useBuddy";
import { ChatColumn } from "@/components/rail/ChatPane";
import { PendingBoxes, PendingDock } from "@/components/work/DecisionBox";
import { WorkTimeline, type TimedBlock } from "@/components/work/WorkTimeline";
import type { ConversationData } from "@/conversation/useConversation";
import { useConversation } from "@/conversation/useConversation";
import { openProjectPipeline, planKey, type PlanTarget } from "@/lib/board/cloud";
import type { Worker } from "@/lib/work/workers";
import { usePipelineConversation } from "@/lib/home/pipeline";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { uploadToConversation } from "@/lib/home/attachments";
import { useAnswerOptionFill } from "@/conversation/answerOptions";
import { ReactionsProvider } from "@/conversation/Reactions";
import { InputBar } from "./InputBar";
import type { Project } from "@/lib/home/projects";
import type { FeedItem, ProjectFeedItem, WaitingItem } from "@/lib/home/types";
import type { WorkHomeApi } from "@/lib/home/useWorkHome";
import { PlanDecision, PlanningLine } from "./PlanDecision";
import { GoalChangeDecision, feedBlocks, useProjectFeed } from "./TaskFeed";
import { HandoverRule, HandoverSummary, ProjectPull, TransferHistory, useReceived } from "./Transfer";
import { noteSeenSequence } from "@/lib/home/transfer";
import { useViewChrome } from "./view";
import { usePhone } from "./usePhone";
import h from "@/styles/home.module.css";
import p from "@/styles/presence.module.css";

import { StateIcon } from "./StateIcon";
import { HeroButton } from "@/components/HeroButton";
import { chatModelLabel } from "@/lib/local/runModel";
import { PermissionModeMenu, ProjectModeContext, useProjectMode } from "@/components/cards/PermissionMode";
import { showWorkspaceToast } from "@/lib/toast";
import { FolderMenu, FolderText, FootText } from "./InputFooter";
import { PipelineModelMenu } from "./PipelineModel";
import { usePartnerWorkEvents } from "./PartnerWorkEvents";
import { usePartnerTeam } from "./PartnerTeam";
import { usePartnerMeetingFeed } from "./PartnerMeetings";
import { useMeetingWorkHandoffFeed } from "../meeting/MeetingWorkHandoffs";
import { Presence } from "./Presence";

/** 首页输入框发来、等着进对话的一句。 */
/** files：首页输入框带的附件，到了那条对话再传（14.5）。 */
export type OutboxEntry = { id: number; target: "main" | string; text: string; files: File[]; team?: boolean };
/** 排着的几句（按发出的先后），每条对话只取给自己的。 */
export type Outbox = OutboxEntry[];

/** 同一条对话里换了模型（67 条）：在换的那一处画一行「换成 来源 · 模型」，样子同「11 月目标」那条分隔线。 */
const modelRule = (label: string) => <p className={h.monthRule} role="separator" data-testid="model-rule">换成 {label}</p>;

/** 输入框下面一行的右边：最近一轮实际用的「来源 · 模型」（67 条，走 Chat 的才有；由 Chat 的配置定，不能点）。 */
export function ModelText({ data }: { data: Pick<ConversationData, "model"> }) {
  const label = chatModelLabel(data.model);
  return label ? <FootText testId="chat-model">{label}</FootText> : null;
}

/** 对话读好了、没在回答时，把 outbox 里给这条对话的第一句发出去（一次一句，回完再发下一句）。 */
type TeamIntercept = (text: string, files: File[]) => Promise<boolean>;
function useOutbox(data: ConversationData, key: "main" | string, outbox: Outbox, consume: (id: number) => void, intercept?: TeamIntercept, composing = false) {
  const sent = useRef(new Set<number>());
  const next = outbox.find((entry) => entry.target === key);
  useEffect(() => {
    if (!next || sent.current.has(next.id)) return;
    if (next.team ? !intercept || composing : data.historyStatus !== "ready" || data.streaming) return;
    sent.current.add(next.id);
    void (async () => {
      const ok = next.team && intercept ? await intercept(next.text, next.files) : await sendWithFiles(data, next.text, next.files);
      if (ok) consume(next.id);
      else sent.current.delete(next.id);
    })().catch((err) => { sent.current.delete(next.id); showWorkspaceToast({text: err instanceof Error ? err.message : "发送失败"}); });
  }, [next, data, consume, intercept, composing]);
}

/** 先把附件传给这条对话（云端转给 Chat），回执随这句话发出去。 */
async function sendWithFiles(data: ConversationData, text: string, files: File[]): Promise<boolean> {
  const attachments = files.length ? await uploadToConversation(data.scope, files) : [];
  return data.send(text, [], { attachments });
}

/**
 * 总管线、Task 管线底下的输入框（14.5）：InputBar，回答进行中右边是停止；回答末尾的选项填进框里；草稿按对话存。
 * context：「关于：{Mission}」胶囊，发出的这一句前面带上它，发完就去掉。
 */
function ChatInput({ data, placeholder, onHeight, context, footer, intercept }: {
  data: ConversationData; placeholder: string; onHeight: (height: number) => void; context?: { label: string; onClear: () => void } | null; footer?: { left?: ReactNode; right?: ReactNode };
  intercept?: TeamIntercept;
}) {
  const [fill, setFill] = useState<{ text: string; nonce: number } | null>(null);
  useAnswerOptionFill(data.scope, (text) => setFill({ text, nonce: Date.now() }));
  return (
    <InputBar placeholder={placeholder} busy={data.streaming} interruptible={data.interruptible} onStop={data.stop} textRequired={!intercept} onHeight={onHeight} fill={fill} context={context} footer={footer} emoji
      draftKey={`tianshu-home-draft-v1:${data.scope}`}
      onSend={async (text, files) => {
        if (intercept && await intercept(text,files)) return true;
        const message = context ? `${context.label}\n\n${text}` : text;
        const ok = await sendWithFiles(data, message, files);
        if (ok) context?.onClear();
        return ok;
      }} />
  );
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

/**
 * context：从 Mission 详情「问伙伴」带来的「关于：{Mission}」，输入框左上角一枚胶囊（14.5），去掉调 onClearContext。
 */
export function BuddyView({ buddy, outbox, consume, onSpeaking, waiting, go, context = null, onClearContext }: {
  buddy: Buddy | null; outbox: Outbox; consume: (id: number) => void; onSpeaking: (speaking: boolean) => void; context?: string | null; onClearContext?: () => void;
  waiting: WaitingItem[]; go: (href: string) => void;
}) {
  const data = useConversation("global");
  const chrome = useViewChrome();
  const team = usePartnerTeam();
  const events = usePartnerWorkEvents(waiting, go);
  const meetingFeed = usePartnerMeetingFeed();
  const handoffFeed = useMeetingWorkHandoffFeed();
  useOutbox(data, "main", outbox, consume, team.intercept, team.composing);
  useEscStopsReply(data);
  useEffect(() => { onSpeaking(data.streaming); return () => onSpeaking(false); }, [data.streaming, onSpeaking]);
  const name = buddy?.name?.trim() || "伙伴";
  return (
    <PendingBoxes>
      <div className={h.convo} data-testid="buddy-view">
        <ChatColumn data={data} buddy={buddy} tone="light"
          head={(
            <>
              <header className={`${h.viewHead} ${p.head}`} data-flush="">
                <div className={p.side}>{chrome.lead}<h1 className={h.viewTitle} tabIndex={-1}>{name}</h1></div>
                <Presence buddy={buddy} data={data} go={go} />
                <div className={p.side} data-end="">{chrome.trail}</div>
              </header>
            </>
          )}
          timeline={(current) => <>{meetingFeed.notice}{handoffFeed.notice}<ReactionsProvider scope={current.scope}><WorkTimeline data={current} blocks={[...team.blocks, ...events, ...meetingFeed.blocks, ...handoffFeed.blocks]} modelRule={modelRule} /></ReactionsProvider></>}
          dock={(latest) => <>{team.composer}<PendingDock latest={latest} /></>}
          input={(onHeight) => <ChatInput data={data} placeholder={`与${name}讨论…`} onHeight={onHeight} intercept={team.intercept} footer={{ left: team.launcher, right: <ModelText data={data} /> }}
            context={context ? { label: context, onClear: () => onClearContext?.() } : null} />} />
      </div>
    </PendingBoxes>
  );
}

type PipelineProps = {
  project: Project;
  /** 挂着的本月 Task（本月计划里的，带标准）：规划员、派活单、开了哪几个子会话按件插进对话。 */
  tasks: THomePlanTask[];
  api: WorkHomeApi;
  buddy: Buddy | null;
  outbox: Outbox;
  consume: (id: number) => void;
  go: (href: string) => void;
  /** 拆卡（一件 Task，或这个项目本身：没挂 Task 时也能拆，16.3）。 */
  onSplit: (target: PlanTarget) => void;
  /** 拆卡登记没成的那一个（planKey，出「拆卡失败 · 重试」）。 */
  splitFailed?: string | null;
  /** 这个标签页里自动开工没开起来的子会话 id：对话里那一行写「失败」加「手动开始」。 */
  startFailed?: ReadonlySet<string>;
  onManualStart?: (subId: string) => void;
  /** 伙伴在这条对话里说话（伙伴台换成「在说」）。 */
  onSpeaking: (speaking: boolean) => void;
  /** 页头右边（「详情」）、项目自己的几块（转交，16.7）。页头只留项目名和信息按钮，本月的 Task 在信息页和首页「本月」里看（19 条）。 */
  trail: ReactNode;
  blocks?: TimedBlock[];
  /** 接手以后「拉到这台电脑」拉好了（重读这台电脑上绑的文件夹）。 */
  onPulled?: () => void;
  /** 输入框下面左边选文件夹（只在还没绑时给；同项目详情，绑这台电脑上加过的一个，null 是「此电脑」）。 */
  onSetFolder?: (folderId: string | null) => Promise<void>;
  /** 文件夹菜单里的「选择其他文件夹…」「新建文件夹…」：本机一步绑到这个项目上（32 条）。 */
  onPickFolder?: () => Promise<unknown>;
  onCreateFolder?: (name: string) => Promise<unknown>;
  /** 文件夹菜单里的「添加文件夹…」（同项目详情「文件夹」一节）；绑满了不给。 */
  onAddFolder?: () => Promise<unknown>;
  /** 这个项目在这台电脑上绑的文件夹（17.2 第 32 条）：派活单开工就在它里面开。 */
  bound?: { id: string; path: string; label: string } | null;
};

/**
 * 项目对话（16.3）：B 的接口在（live）时是真的对话；接口确定没上（404）时是这个标签页里接本月那件 Task 的假对话（lib/home/pipeline）。
 * 还不知道（首页接口第一次还没回、或一直出错）时先空着等：不开假对话（写进去的话会丢，「拆成几步」还会真的开规划员）。
 */
/**
 * 拆卡那几块插在哪条消息后面（17.2 第 29 条，项目对话的消息不带时间，按序号插；null 放最后）：
 * 规划员在拆——登记了还没开的用登记时记的，开起来以后用这次（排着、在拆的）计划记的；派活单是开拆那一下的；开了哪几个子会话是开工那一下的。
 */
/**
 * 项目对话里留哪些项目动态（本人 11/16 定 A：只留对话本身）：转交那几行、还没答的「Task 改了」、子会话还开着的问和批准、约定都达到（答过就收起）。
 * 挂上 Task 的分隔线、子会话报告、验收行、会议交接不进对话：子会话状态在左栏和项目详情，结果在子会话页，要处理的在「等你」。
 */
const CONVERSATION_FEED = new Set<ProjectFeedItem["kind"]>(["handover", "handover_summary", "transfer_declined", "goal_changed", "sub_session_decision", "criteria_met"]);
export function conversationFeed(feed: readonly ProjectFeedItem[]): ProjectFeedItem[] {
  return feed.filter((item) => CONVERSATION_FEED.has(item.kind) && !(item.kind === "goal_changed" && item.answer));
}

export function planAnchors(planner: Pick<Worker, "afterSequence"> | undefined, plan: Pick<TCardPlanView, "status" | "afterSequence" | "startedAfterSequence"> | null) {
  return {
    planning: planner?.afterSequence ?? (plan && (plan.status === "queued" || plan.status === "running") ? plan.afterSequence : null),
    drafts: plan?.afterSequence ?? null,
    started: plan?.startedAfterSequence ?? null,
  };
}

export function PipelineView(props: PipelineProps) {
  if (!props.api.known) return <div className={h.convo} aria-busy />;
  return props.api.live ? <LivePipeline {...props} /> : props.tasks[0] ? <MockPipeline {...props} task={props.tasks[0]} /> : <div className={h.convo} aria-busy />;
}

/** 第一次打开时建这个项目的对话（POST /api/me/projects/:projectId/pipeline），收发走现有对话接口，scope 是 project:<projectId>。 */
function LivePipeline(props: PipelineProps) {
  const { id, scope: fallback } = props.project;
  const [scope, setScope] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void openProjectPipeline(id).then((answer) => answer?.scope ?? fallback, () => fallback).then((next) => { if (alive) setScope(next); });
    return () => { alive = false; };
  }, [id, fallback]);
  return scope ? <LivePipelineBody scope={scope} {...props} /> : <div className={h.convo} aria-busy />;
}

function LivePipelineBody({ scope, ...props }: PipelineProps & { scope: string }) {
  const data = useConversation(scope);
  return <PipelineBody data={data} {...props} />;
}

function MockPipeline({ task, ...props }: PipelineProps & { task: THomePlanTask }) {
  const { api, onSplit } = props;
  const board = api.work.boards[task.taskId] ?? null;
  // 已经拆过、开过的 Task，假对话开头不再问「先怎么开始」（刷新后不会再拆一遍）；看板读到以前先不开对话：要先知道拆没拆过。
  const begun = !!(board?.plan || board?.drafts.length || api.work.workers.some((worker) => worker.taskId === task.taskId));
  const pipelineTask = useMemo(() => ({ taskId: task.taskId, name: task.name, criteria: task.criteria }), [task.taskId, task.name, task.criteria]);
  const data = usePipelineConversation(board ? pipelineTask : null, { split: () => onSplit({ taskId: task.taskId }) }, begun);
  return <PipelineBody data={data} {...props} />;
}

/**
 * 项目对话（本人 11/16 定 A：像跟 Claude Code 对话，只留对话本身）：本人的话、它的回复、它这一轮的步骤清单和选项框之外，
 * 只插还要本人处理的那一步——规划员在拆（一行）、拆卡失败、拆好的派活单（开工的选项框，开了就收起）、自动开工没开起来、
 * 子会话开着的问和批准、约定都达到、还没答的「Task 改了」、转交那几行。子会话列表、开工记录、报告、验收行都不进对话。
 */
function PipelineBody({ data, project, tasks, api, buddy, outbox, consume, go, onSpeaking, onSplit, splitFailed, startFailed, onManualStart, trail, blocks: own, onPulled, onSetFolder, onPickFolder, onCreateFolder, onAddFolder, bound = null }: PipelineProps & { data: ConversationData }) {
  const chrome = useViewChrome();
  const handheld = usePhone();
  const { work } = api;
  useEscStopsReply(data);
  useEffect(() => { onSpeaking(data.streaming); return () => onSpeaking(false); }, [data.streaming, onSpeaking]);
  useOutbox(data, project.id, outbox, consume);
  // 转交卡排在本人看到的最后一条后面（16.7）：发起「准备交接」时带上这个序号。
  const lastSequence = data.messages.at(-1)?.sequence;
  useEffect(() => { noteSeenSequence(project.id, lastSequence); }, [project.id, lastSequence]);
  const subs = project.subSessions;
  // 这个项目里的 worker：挂着的 Task 下的，和项目里的子会话。
  const mine = useMemo(() => {
    const taskIds = new Set(project.goals.map((goal) => goal.taskId));
    const subIds = new Set(subs.map((sub) => sub.id));
    return work.workers.filter((worker) => (!!worker.taskId && taskIds.has(worker.taskId)) || worker.projectId === project.id || subIds.has(worker.cardId ?? worker.topicId ?? ""));
  }, [work.workers, project.goals, project.id, subs]);
  const taskIds = useMemo(() => project.goals.map((goal) => goal.taskId), [project.goals]);
  const feed = useProjectFeed(project.id, taskIds, api);
  // 接手过来的（16.7）：分隔线后第一条是交接说明；带上了对话记录时原来那段收在最上面；文件夹 chip 写「拉到这台电脑」。
  const summary = [...feed].reverse().find((item): item is Extract<ProjectFeedItem, { kind: "handover_summary" }> => item.kind === "handover_summary") ?? null;
  const received = useReceived(summary?.transferId ?? null);
  const local = useLocalRunner();
  const pull = received.clone && !project.folder && local.phase === "ready" && !handheld
    ? <ProjectPull projectId={project.id} name={project.name} clone={received.clone} onPulled={() => onPulled?.()} /> : null;
  // 交出去了（原负责人这边）：只读，不能发（输入框画成空的；不给 input 时 ChatColumn 会退回它自己的输入框）。
  const readOnly = project.transfer?.status === "accepted";
  // 输入框下面左边：这个项目绑的文件夹（照 Claude Code，开始以后不在这里改）。这台电脑上还没绑才给下拉（「此电脑」）；
  // 绑了写工作目录那个的名字、悬停出路径，点开能在资源管理器中显示、复制路径、添加文件夹（没绑满时），换在项目详情；手机上、本机没连上只写名字。
  const pickFolder = onSetFolder ? (id: string | null) => onSetFolder(id).catch(() => showWorkspaceToast({ text: "没改成" })) : undefined;
  const here = !handheld && local.phase === "ready";
  const folder = here && bound ? <FolderText name={bound.label} title={bound.path} path={bound.path} onAdd={onAddFolder} />
    : here && pickFolder ? <FolderMenu folders={local.folders} onPick={(id) => void pickFolder(id)}
      onPickOther={onPickFolder} onCreate={onCreateFolder} />
    : project.folder ? <FootText>{project.folder}</FootText> : null;
  // 输入框下面左侧：这个项目以后新开子会话的默认权限模式（17.2 第 11 条）。
  const mode = useProjectMode(project.id);
  const changed = api.refresh;
  const waiting = api.data.waiting;
  const [dropped, setDropped] = useState<{ key: string; id: string; at: string; afterSequence: number | null }[]>([]);
  const blocks = useMemo<TimedBlock[]>(() => {
    const list: TimedBlock[] = [];
    const kept = conversationFeed(feed);
    if (own) list.push(...own);
    // 转交那几行（16.7）：换人的分隔线（两边都有）、接手人那边的交接说明、原负责人那边「X没接」；还没答的「Task 改了」。
    for (const item of kept) {
      if (item.kind === "handover") list.push({ key: item.id, at: item.at, node: <HandoverRule item={item} /> });
      else if (item.kind === "handover_summary") list.push({ key: item.id, at: item.at, node: <HandoverSummary item={item} onSay={(text) => data.send(text, [])} /> });
      else if (item.kind === "goal_changed") list.push({ key: item.id, at: item.at, node: <GoalChangeDecision projectId={project.id} item={item} onChanged={() => void changed()} /> });
      else if (item.kind === "transfer_declined") list.push({ key: item.id, at: item.at, node: <p className={h.line} data-testid="transfer-declined"><StateIcon state="stopped" />{item.by.name}没接</p> });
    }
    if (summary && received.history) list.push({ key: `history:${summary.transferId}`, at: "0000-01-01T00:00:00.000Z", node: <TransferHistory history={received.history} from={summary.from} /> });
    // 拆卡的几块，每件挂着的 Task 一组，项目本身（不挂 Task 的卡和派活单，16.3）一组：规划员在拆、拆卡失败、派活单（开了就收起）。
    // 按序号插（17.2 第 29 条，项目对话的消息不带时间）：在开拆那一下的序号后面；为 null 放最后。
    const projectBoard = work.boards[planKey({ projectId: project.id })] ?? null;
    const projectCards = new Set((projectBoard?.cards ?? []).map((card) => card.id));
    const groups: { target: PlanTarget; name: string; of: (worker: Worker) => boolean }[] = [
      ...tasks.map((task) => ({ target: { taskId: task.taskId }, name: task.name, of: (worker: Worker) => worker.taskId === task.taskId })),
      { target: { projectId: project.id }, name: project.name, of: (worker: Worker) => !worker.taskId && (worker.projectId === project.id || projectCards.has(worker.cardId ?? "")) },
    ];
    for (const { target, name, of } of groups) {
      const key = planKey(target);
      const board = work.boards[key] ?? null;
      const ofTarget = mine.filter(of);
      const planner = ofTarget.find((worker) => worker.kind === "plan" && worker.state !== "done");
      const anchors = planAnchors(planner, board?.plan ?? null);
      if (planner) list.push({ key: `planning:${planner.key}`, at: planner.startedAt ?? planner.requestedAt ?? new Date().toISOString(), afterSequence: anchors.planning, node: <PlanningLine planner={planner} /> });
      // 拆卡没做完（出了错才给兜底）：一行「拆卡失败」加「重试」（弱按钮）。
      else if ((board?.plan?.status === "failed" && !board.drafts.length) || splitFailed === key) {
        const plan = board?.plan?.status === "failed" ? board.plan : null;
        list.push({ key: `plan-failed:${plan?.id ?? key}`, at: plan ? plan.finishedAt ?? plan.createdAt : new Date().toISOString(), afterSequence: plan?.afterSequence ?? null, node: (
          <p className={h.line} data-testid="plan-failed"><StateIcon state="failed" />拆卡失败<HeroButton variant="ghost" size="sm" onPress={() => onSplit(target)}>重试</HeroButton></p>
        ) });
      }
      // 选了「不要了」的派活单：对话里不再画（本人 11/16：只留还要处理的那一步）。
      const gone = dropped.filter((entry) => entry.key === key);
      if (board?.drafts.length && !gone.some((entry) => entry.id === board.drafts[0]!.id)) {
        // 拆好的时候（规划员拆完同步上来那一刻）；没有记录时当作现在，放在最后。
        const first = { key, id: board.drafts[0]!.id, at: board.plan?.finishedAt ?? board.plan?.createdAt ?? new Date().toISOString(), afterSequence: anchors.drafts };
        list.push({ key: `plan:${first.id}`, at: first.at, afterSequence: first.afterSequence, node: (
          <PlanDecision target={target} name={name} drafts={board.drafts} roles={work.roles?.roles ?? []} handheld={handheld} onChanged={() => void changed()} afterSequence={lastSequence}
            onDropped={() => setDropped((current) => [...current, first])}
            folder={bound} onSetFolder={pickFolder} onPickFolder={onPickFolder} onCreateFolder={onCreateFolder}
            onSay={(text) => data.send(text, [])} />
        ) });
      }
    }
    // 自动开工没开起来的（这个标签页里试过的）：那一行「失败」加「手动开始」（弱按钮，5.4.3、9.8：手动开始只有这一处）。
    for (const sub of subs.filter((entry) => startFailed?.has(entry.id) && entry.state === "queued")) {
      list.push({ key: `start-failed:${sub.id}`, at: new Date().toISOString(), node: (
        <p className={h.line} data-testid="start-failed"><StateIcon state="failed" /><span className={h.lineMore}>{sub.title} · 失败</span>
          {onManualStart ? <HeroButton variant="ghost" size="sm" onPress={() => onManualStart(sub.id)}>手动开始</HeroButton> : null}</p>
      ) });
    }
    // 别的电脑上跑的子会话：等你里那一条（按本机会话对上卡、专题）带着原话，对话里照它写。
    const remoteAsks = new Map(subs.flatMap((sub) => {
      const item = sub.sessionId ? waiting.find((entry) => entry.sessionId === sub.sessionId && (entry.kind === "approval" || entry.kind === "question")) : undefined;
      return item ? [[sub.id, item] as const] : [];
    }));
    const decisions = kept.filter((item): item is Extract<ProjectFeedItem, { kind: "sub_session_decision" }> => item.kind === "sub_session_decision");
    const PROJECT_ONLY = new Set<ProjectFeedItem["kind"]>(["goal_linked", "handover", "handover_summary", "transfer_declined", "goal_changed", "sub_session_report", "sub_session_decision","meeting_handoff"]);
    const checks = kept.filter((item): item is FeedItem => !PROJECT_ONLY.has(item.kind));
    list.push(...feedBlocks({ items: checks, workers: mine, go, onSay: (text) => data.send(text, []), onChanged: () => void changed(), remoteAsks, decisions }));
    return list;
  }, [mine, tasks, work.boards, work.roles, handheld, changed, data, subs, go, feed, onSplit, splitFailed, startFailed, onManualStart, waiting, own, project, summary, received.history, lastSequence, dropped]);
  return (
    <ProjectModeContext.Provider value={mode?.value ?? null}>
    <PendingBoxes>
      <div className={h.convo} data-testid="pipeline-view">
        <ChatColumn data={data} buddy={buddy} label={project.name} tone="light"
          head={(
            <>
              <header className={`${h.viewHead} ${p.head}`} data-flush="">
                <div className={p.side}>{chrome.lead}<h1 className={h.viewTitle} tabIndex={-1}>{project.name}</h1></div>
                <Presence buddy={buddy} data={data} go={go} />
                <div className={p.side} data-end="">{pull}{trail}{chrome.trail}</div>
              </header>
            </>
          )}
          timeline={(current) => <ReactionsProvider scope={current.scope}><WorkTimeline data={current} blocks={blocks} modelRule={modelRule} /></ReactionsProvider>}
          dock={(latest) => <PendingDock latest={latest} />}
          input={readOnly ? () => null : (onHeight) => <ChatInput data={data} placeholder={handheld ? "说点什么…" : `与${project.name}讨论…`} onHeight={onHeight} footer={{
            left: folder,
            right: <><PipelineModelMenu projectId={project.id} fallback={<ModelText data={data} />} sheet={handheld} />{mode ? <PermissionModeMenu modes={mode.modes} value={mode.value} sheet={handheld} onChange={mode.set} /> : null}</>,
          }} />} />
      </div>
    </PendingBoxes>
    </ProjectModeContext.Provider>
  );
}

