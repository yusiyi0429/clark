"use client";

/**
 * 首页：等你、会议、本月 Mission 下的 Task、输入框。
 * - 等你：一件两行（原话；来源 · 哪件 Task · 截止）。短的（批准、单选、合回、开工、岗位建议）在行尾就地答，推荐的那个是次按钮、另一个弱按钮；
 *   答完这一行变成状态词（「已批准」）停 2 秒再收走，不弹 toast。行首不放强调色点（组头已经写了「等你」）。
 *   会后确认（Nexus 推来的会上待定事项，17.2 第 43 条）：第二行「会后确认 · 待确认的内容 · 截止 11/12 18:00」，行尾「确认」「修改」「拒绝」；
 *   点「修改」（或点这一行）就地展开：有会上原话的先写原话，下面输入框预填原内容，改完「提交」。
 * - 本月（16.4、主循环第 66 条）：按 Mission 分组列这个月的 Task，名字下面小字「11/20 验收」，行尾写现状（「1 件等你 · 2 个在跑」，monthStatus），
 *   有等你的排最前，其次有新结果的、在跑的；本月的 Task 不止挂在一个项目上时最后是项目名 chip（点了进项目）；没挂上的是「挂到…」（选现有项目或新建）。
 * - 输入框：InputBar（14.5）；框下面「发给」默认自动（打字停下 300ms 后问一次分发接口，只认最后一次），也能选伙伴或某个项目；发出去以后跳进那条对话。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dropdown, Header } from "@heroui/react";
import { Check, ChevronDown, Plus } from "lucide-react";
import { PersonAvatar } from "@/components/avatar/PersonAvatar";
import type { Buddy } from "@/components/buddy/useBuddy";
import { HeroButton } from "@/components/HeroButton";
import { FailedLine, failureOf, type Failure } from "@/components/work/DecisionBox";
import { localOptions, oneTap } from "@/components/work/decisions";
import { InputBar } from "./InputBar";
import { MeetingWaitingRows, PartnerHomeMeetings, meetingWaitingItems } from "./PartnerMeetings";
import type { HomeMeeting } from "./MeetingControl";
import { usePartnerMeetings } from "@/lib/home/partnerMeetingFeed";
import { ConfirmAndHandOff } from "@/components/meeting/MeetingWorkHandoffs";
import { acceptDrafts, acceptProjectDrafts, decideAutoRelay, decideNexusConfirmation, planKey, type PlanTarget } from "@/lib/board/cloud";
import { useLocalRunner, type LocalRunnerState } from "@/lib/local/LocalRunnerProvider";
import { decideProposal } from "@/lib/team/roles";
import { canCommandHere, decide } from "@/lib/work/actions";
import { mergeCard } from "@/lib/work/merge";
import { missionHref, monthStatus, monthTaskSubs, taskGateLabel, taskHref, waitingHref } from "@/lib/home/derive";
import { projectHref, type Project } from "@/lib/home/projects";
import type { ProjectsApi } from "./useProjects";
import { monthDayTime, relativeDayTime } from "@/lib/companyTime";
import type { HomeMonthMission, RouteTarget, WaitingItem, WorkHomeData } from "@/lib/home/types";
import type { WorkHomeApi } from "@/lib/home/useWorkHome";
import { ICON } from "./StateIcon";
import { usePhone } from "./usePhone";
import { pageHref } from "./view";
import h from "@/styles/home.module.css";
import x from "@/styles/decision-box.module.css";
import m from "./partner-meetings.module.css";

export type SendTarget = "auto" | RouteTarget;
type HomeSend = (text: string, target: SendTarget, files: File[]) => Promise<void> | void;

export function HomeView({ data, api, buddy, today, go, route, onSend, projects, meeting, trail, offline = false }: {
  data: WorkHomeData;
  api: WorkHomeApi;
  buddy: Buddy | null;
  /** 「11 月 7 日 周六」：页头和「今天」行一样。 */
  today: string;
  go: (href: string) => void;
  /** 「自动」会发去哪（打字时实时显示）。 */
  route: (text: string) => Promise<RouteTarget>;
  onSend: HomeSend;
  projects: ProjectsApi;
  meeting: HomeMeeting;
  /** 页头右上角（后台任务按钮）。 */
  trail?: ReactNode;
  /** 这台电脑没连上、没配对（第 73 条）：「等你」最前面一行，点了去连接页。 */
  offline?: boolean;
}) {
  return (
    <div className={h.homeView} data-testid="home-view">
      <header className={h.viewHead}><h1 className={h.viewTitle} tabIndex={-1}>{today}</h1>{trail}</header>
      <div className={h.homeScroll}>
        <div className={h.homeInner}>
          <HomeWaiting data={data} api={api} go={go} offline={offline} />
          <PartnerHomeMeetings meeting={meeting} />
          {api.planFailed ? (
            <section aria-label="Task" className={h.section}>
              <p className={h.planFailed} data-testid="plan-read-failed">本体读取失败<HeroButton variant="ghost" size="sm" onPress={() => void api.retryPlan()}>重试</HeroButton></p>
            </section>
          ) : null}
          <HomeMonth data={data} api={api} projects={projects} go={go} />
        </div>
      </div>
      <HomeComposer buddy={buddy} projects={projects.projects} route={route} onSend={onSend} />
    </div>
  );
}

export function HomeWaiting({ data, api, go, offline = false, phone = false }: {
  data: WorkHomeData; api: WorkHomeApi; go: (href: string) => void; offline?: boolean; phone?: boolean;
}) {
  const { items } = usePartnerMeetings();
  const meetings = meetingWaitingItems(items, data.waiting);
  const [confirmed, setConfirmed] = useState<ConfirmedReceipt | null>(null);
  const count = data.waiting.length + meetings.length + Number(offline);
  if (!count && !confirmed) return null;
  return <section aria-label="等你" className={phone ? h.phoneWaiting : h.section}>
    {count ? <p className={h.sectionTitle}>等你 <span>{count}</span></p> : null}
    {confirmed ? <p className={m.receipt} role="status">{confirmed.title} · {confirmed.done}
      <HeroButton variant="ghost" size="sm" onPress={() => go(confirmed.href)}>{confirmed.showReceipts ? "查看递送回执" : "选择工作去向"}</HeroButton>
      <HeroButton variant="ghost" size="sm" aria-label="收起确认回执" onPress={() => setConfirmed(null)}>收起</HeroButton>
    </p> : null}
    {offline ? <ul className={h.waiting}><li className={h.wait} data-kind="machine">
      <button type="button" className={h.waitMain} onClick={() => go(pageHref("connections"))} data-testid="wait-machine"><span className={h.waitTitle}>这台电脑没连上</span></button>
    </li></ul> : null}
    {data.waiting.length ? <WaitingList items={data.waiting} api={api} go={go} onConfirmed={setConfirmed} /> : null}
    {meetings.length ? <MeetingWaitingRows items={meetings} go={go} /> : null}
  </section>;
}

export function HomeMonth({ data, api, projects, go }: { data: WorkHomeData; api: WorkHomeApi; projects: ProjectsApi; go: (href: string) => void }) {
  const missions = data.month.missions.filter((mission) => mission.tasks.length && mission.period === data.period);
  const status = useMonthStatus(data, api);
  const manyProjects = new Set(missions.flatMap((mission) => mission.tasks.flatMap((task) => task.project ? [task.project.projectId] : []))).size > 1;
  if (!missions.length) return null;
  return <section aria-label="本月" className={h.section}>
    <p className={h.sectionTitle}>本月</p>
    {missions.map((mission) => <div key={mission.missionId} className={h.taskList}>
      <button type="button" className={h.missionTitle} onClick={() => go(missionHref(mission.missionId))} data-testid="month-mission" title={mission.title}><span className={h.ellipsis}>{mission.title}</span></button>
      {[...mission.tasks].sort((a, b) => (status(a)?.rank ?? 3) - (status(b)?.rank ?? 3)).map((task) => (
        <MonthRow key={task.taskId} task={task} gate={taskGateLabel(projects.all, api.work.plan, { taskId: task.taskId, missionId: mission.missionId })}
          status={status(task)} showProject={manyProjects} projects={projects} go={go} />
      ))}
    </div>)}
  </section>;
}

/** 「本月」每件 Task 的现状（monthStatus）：子会话从首页数据里取，按看板的卡和 worker 认是哪件 Task 的；做完了的为 null，不写。 */
function useMonthStatus(data: WorkHomeData, api: WorkHomeApi) {
  const { workers, boards } = api.work;
  const subs = useMemo(() => [...data.projects.flatMap((project) => project.subSessions), ...data.other.subSessions], [data.projects, data.other.subSessions]);
  return useMemo(() => {
    const cache = new Map<string, ReturnType<typeof monthStatus> | null>();
    return (task: HomeMonthMission["tasks"][number]) => {
      if (!cache.has(task.taskId)) {
        const board = boards[task.taskId];
        const planning = workers.some((worker) => worker.kind === "plan" && worker.taskId === task.taskId && worker.state !== "done")
          || board?.plan?.status === "queued" || board?.plan?.status === "running";
        cache.set(task.taskId, task.completedAt ? null
          : monthStatus(monthTaskSubs(task.taskId, subs, workers, board?.cards), data.waiting.filter((item) => item.taskId === task.taskId).length, planning));
      }
      return cache.get(task.taskId)!;
    };
  }, [subs, workers, boards, data.waiting]);
}

/**
 * 「本月」一行：Task 名，下面小字验收截止（挂着的项目目标的截止日，没挂的退回这个 Mission 下一个验收时间点；做完了先写「已完成」）；
 * 行尾现状（有等你的前面一个橙点），本月不止一个项目时再是项目名 chip；
 * 没挂上的「挂到…」：选现有项目（PUT 挂接）或用 Task 名新建一个挂上（POST 带 taskId）；没成在行尾写「失败 · 重试」。
 */
function MonthRow({ task, gate, status, showProject, projects, go }: {
  task: HomeMonthMission["tasks"][number]; gate: string | null; status: ReturnType<typeof monthStatus> | null; showProject: boolean; projects: ProjectsApi; go: (href: string) => void;
}) {
  const [failed, setFailed] = useState<Failure | null>(null);
  const attempt = (run: () => Promise<unknown>) => {
    const once = () => { setFailed(null); void run().catch((error) => setFailed(failureOf(error, once))); };
    once();
  };
  const { project } = task;
  return (
    <div className={h.monthRow}>
      <button type="button" className={h.taskLine} onClick={() => go(project ? projectHref(project.projectId) : taskHref(task.taskId))} data-testid="home-task">
        <span className={h.taskText}>
          <span className={h.taskName}>{task.name}</span>
          {task.completedAt || gate ? <span className={h.taskSub}>{[task.completedAt ? "已完成" : null, gate].filter(Boolean).join(" · ")}</span> : null}
        </span>
        {status?.text ? <span className={h.taskGate} title={status.text} data-testid="task-status">{status.waiting ? <span className={h.count}><i aria-hidden /></span> : null}{status.text}</span> : null}
      </button>
      {failed ? <FailedLine inline {...failed} />
        : project ? (showProject ? <button type="button" className={h.statusChip} onClick={() => go(projectHref(project.projectId))} data-testid="task-project" title={project.name}><span className={h.ellipsis}>{project.name}</span></button> : null)
        : <AttachMenu taskName={task.name} projects={projects.projects} onPick={(projectId) => attempt(() => projects.actions.attach(task.taskId, projectId))}
          onCreate={() => attempt(() => projects.actions.create(task.name, task.taskId))} />}
    </div>
  );
}

type RunAction = { label: string; done: string; primary?: boolean; run: () => Promise<unknown> };
type ConfirmedReceipt = { href: string; title: string; done: string; showReceipts?: boolean };
/** 行尾的一个按钮：就地办（run），点了去那件事里（href，开工的「改一改」进项目对话），或就地展开来改（edit，会后确认的「修改」）。 */
type Action = RunAction | { label: string; primary?: boolean; href: string } | { label: string; primary?: boolean; edit: true };
/** away：这里答不了的 inline_local（手机、别的电脑、本机没就绪），行尾画「等你 · {电脑名}」chip。 */
export type WaitingRowAnswer = { actions: Action[]; away: string | null };

/**
 * 等你一行的行尾（5.4.4「就地答」、9.6，契约 WaitingAnswer）：
 * - inline_local（批准、回答、合回）要本机办：只在 deviceId 那台电脑上画按钮，答案直接回给那个子会话；单选、最多 2 个短选项才就地答（3 个的点进去答，不藏第三个）。
 *   批准旁边是「换个做法」（进那个子会话说）。
 *   别处（手机、别的电脑、本机没就绪）画「等你 · {deviceName}」，整行点进去看。
 * - inline（开工、岗位建议、自动接力）走云端，手机上也能：开工「开始」= 接受派活单并登记开工（配对的电脑上开着的网页认领后开，同 PlanDecision 开不了本机时），
 *   「改一改」进项目对话；岗位建议「采纳 / 不要」；自动接力到了上限（18.12）「继续 / 停下」；
 *   会后确认（17.2 第 43 条）「确认 / 修改 / 拒绝」，没有内容可改的不出「修改」。
 * - open 的（受阻、会后确认、Mission Card、请你认可、月份、电脑、额度）整行点进去。
 */
export function waitingAnswer(item: WaitingItem, { api, local, handheld }: { api: Pick<WorkHomeApi, "deviceId" | "work">; local: LocalRunnerState; handheld: boolean }): WaitingRowAnswer {
  const ready = local.phase === "ready";
  const actions = waitingActions(item, api, local, ready, handheld);
  const here = ready && !handheld && (!item.deviceId || item.deviceId === api.deviceId);
  return { actions, away: !actions.length && item.answer === "inline_local" && !here ? `等你 · ${item.deviceName ?? "那台电脑"}` : null };
}

function waitingActions(item: WaitingItem, api: Pick<WorkHomeApi, "deviceId" | "work">, local: LocalRunnerState, ready: boolean, handheld: boolean): Action[] {
  if (item.deviceId && item.deviceId !== api.deviceId) return [];
  const worker = item.sessionId ? api.work.workers.find((entry) => entry.session?.id === item.sessionId) : undefined;
  // 批准、回答要在跑它的这台电脑上办（本机程序就绪、不是手机）。
  const here = ready && !handheld && (worker ? canCommandHere(worker, ready, handheld) : !!item.sessionId && !!item.deviceId);
  if ((item.kind === "approval" || item.kind === "question") && !here) return [];
  const sessionId = item.sessionId;
  if (item.kind === "approval" && sessionId) {
    // 契约的 permission（aa6aba9e）：批的就是这一步；有越界路径的只能点进去「允许这一次」，不就地批。
    const permission = item.permission;
    if (permission?.outsidePaths.length) return [{ label: "去看看", href: waitingHref(item) }];
    const allow = permission ? () => local.runner.decidePermission(sessionId, permission.requestId, { decision: "allow" }) : worker ? () => decide(local.runner, worker, "allow") : null;
    return allow ? [{ label: "批准", done: "已批准", primary: true, run: allow }, { label: "换个做法", href: waitingHref(item) }] : [];
  }
  // 就地答：契约的 question（原样的提问），只有一个问题、单选、最多 3 个选项时；别的点进去答。
  const question = item.kind === "question" ? item.question ?? worker?.session?.pendingQuestion ?? null : null;
  if (question && sessionId) {
    if (!oneTap(question) || question.questions[0]!.options.length > 3) return [];
    const { options, order } = localOptions(question.questions[0]!.options);
    return options.map((option, index) => ({
      label: option.label, done: "已回答", primary: index === 0,
      run: () => local.runner.answerQuestion(sessionId, question.requestId, { choices: [[question.questions[0]!.options[order[index]!]!.label]] }),
    }));
  }
  if (item.kind === "role" && item.open.kind === "role") {
    const id = item.open.id;
    return [{ label: "采纳", done: "已采纳", primary: true, run: () => decideProposal(id, "accept") }, { label: "不要", done: "已回答", run: () => decideProposal(id, "dismiss") }];
  }
  if (item.kind === "auto_relay" && item.projectId) {
    const id = item.projectId;
    return [{ label: "继续", done: "已继续", primary: true, run: () => decideAutoRelay(id, "continue") }, { label: "停下", done: "已停下", run: () => decideAutoRelay(id, "stop") }];
  }
  if (item.kind === "nexus_confirmation" && item.confirmation) {
    const { id, value } = item.confirmation;
    return [
      { label: "确认", done: "已确认", primary: true, run: () => decideNexusConfirmation(id, "confirmed") },
      ...(value !== null ? [{ label: "修改", edit: true as const }] : []),
      { label: "拒绝", done: "已拒绝", run: () => decideNexusConfirmation(id, "rejected") },
    ];
  }
  if (item.kind === "merge" && item.sessionId) {
    const session = local.sessions.find((entry) => entry.id === item.sessionId);
    if (!session || !ready || handheld) return [];
    const base = session.workspace?.kind === "worktree" ? session.workspace.baseBranch : "main";
    return [{ label: `合进 ${base}`, done: "已合回", primary: true, run: async () => { const result = await mergeCard(local.runner, session, item.source ?? ""); if (!result.ok) throw new Error(result.text); } }];
  }
  // 计划等你开工：一件 Task 的，或没挂 Task 的项目的（16.3，taskId 为 null、projectId 有值）。
  const target: PlanTarget | null = item.kind === "plan_start" ? (item.taskId ? { taskId: item.taskId } : item.projectId ? { projectId: item.projectId } : null) : null;
  if (target) {
    const drafts = (api.work.boards[planKey(target)]?.drafts ?? []).map((draft) => ({ id: draft.id }));
    if (!drafts.length) return [];
    return [
      { label: "开始", done: "已开工", primary: true, run: () => ("taskId" in target ? acceptDrafts(target.taskId, drafts, true) : acceptProjectDrafts(target.projectId, drafts, true)) },
      { label: "改一改", href: waitingHref(item) },
    ];
  }
  return [];
}

function useActions(api: WorkHomeApi) {
  const local = useLocalRunner();
  const handheld = usePhone();
  return (item: WaitingItem) => waitingAnswer(item, { api, local, handheld });
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 截止（5.4.4「时间只写截止」）：「剩 2 天」；不到 24 小时「剩 5 小时」、不到 1 小时「剩 20 分钟」、过了「已过截止」，这三档是警告色。 */
export function dueText(dueAt: string, now: number): { text: string; warn: boolean } {
  const left = Date.parse(dueAt) - now;
  if (left <= 0) return { text: "已过截止", warn: true };
  if (left >= DAY) return { text: `剩 ${Math.floor(left / DAY)} 天`, warn: false };
  if (left >= HOUR) return { text: `剩 ${Math.floor(left / HOUR)} 小时`, warn: true };
  return { text: `剩 ${Math.max(1, Math.floor(left / 60_000))} 分钟`, warn: true };
}

/** 会后确认这一行的第二行和截止（17.2 第 43 条）：「会后确认 · 待确认的内容」，截止写时刻「截止 11/12 18:00」；别的种类为 null，照原来的写。 */
export function confirmationLine(item: WaitingItem, now: number): { from: string; due: { text: string; warn: boolean } | null } | null {
  if (item.kind !== "nexus_confirmation") return null;
  const value = item.confirmation?.value?.replace(/\s+/g, " ").trim();
  return {
    from: [item.source, value].filter(Boolean).join(" · "),
    due: item.dueAt ? { text: `截止 ${monthDayTime(item.dueAt)}`, warn: dueText(item.dueAt, now).warn } : null,
  };
}

/** 会后确认展开的那一块：有会上原话的先写原话；有内容的给输入框（预填原内容），改了才能「提交」。 */
function ConfirmEdit({ value, quote, busy, requestId, onConfirmed, onSubmit, onCancel }: {
  value: string | null; quote: string | null; busy: boolean; requestId: string; onConfirmed: (ref: string) => void; onSubmit: (value: string) => void; onCancel: () => void;
}) {
  const [text, setText] = useState(value ?? "");
  const next = text.trim();
  // 输入框的高度跟着内容：按换行和每行大约 30 个字估，2 到 8 行，再长自己滚。
  const rows = Math.min(8, Math.max(2, text.split("\n").reduce((count, line) => count + Math.max(1, Math.ceil(line.length / 30)), 0)));
  return (
    <div className={h.waitEdit} data-testid="confirm-edit">
      {quote ? <blockquote className={h.waitQuote} data-testid="confirm-quote">{quote}</blockquote> : null}
      {value !== null ? (
        <>
          <textarea className={h.noteEdit} value={text} rows={rows} maxLength={20000} aria-label="内容" autoFocus
            onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onCancel(); } }} data-testid="confirm-value" />
          <div className={h.noteFoot}>
            <HeroButton variant="tertiary" size="sm" isDisabled={busy || !next || next === value.trim()} onPress={() => onSubmit(next)}>提交</HeroButton>
            <HeroButton variant="ghost" size="sm" isDisabled={busy} onPress={onCancel}>取消</HeroButton>
          </div>
        </>
      ) : null}
      {!busy && (value === null || !!next) ? <ConfirmAndHandOff requestId={requestId}
        amendedValue={value !== null && next !== value.trim() ? next : undefined} onConfirmed={onConfirmed} /> : null}
    </div>
  );
}

/**
 * 等你的一行（5.4.4「等你行」）。有摘要（契约 WaitingItem.summary，主循环第 66 条：批准是那句人话，等你补、受阻是验收员那一句，提问是问题原文）的第二行写它，
 * 和第一行一样的不再写一遍；再下面一行（没摘要时是第二行）依次是对方（请你认可的：头像 16 和名字）、来源、截止；没有截止的不写时间，时间（5.6 相对时间）放在整行能点的那块的 title 里。
 * 额度那条的 dueAt 是恢复的时刻（原话里已经写了），不当截止写。
 * 答完先在原处写状态词，停 2 秒再刷新（收走）；失败在原处写「失败」加「重试」，不弹 toast。
 */
export function WaitingList({ items, api, go, onConfirmed }: { items: WaitingItem[]; api: WorkHomeApi; go: (href: string) => void; onConfirmed?: (receipt: ConfirmedReceipt) => void }) {
  const answer = useActions(api);
  const local = useLocalRunner();
  const [state, setState] = useState<Record<string, { busy?: boolean; done?: string; failed?: RunAction; reason?: string }>>({});
  // 会后确认展开着的那一行（一次只开一行）。
  const [editing, setEditing] = useState<string | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);
  // 一行的状态按「这一次请求」记：同一个子会话接着又要批准、又问的，等你行的 id 不变，at（这次请求的时间）变了就是新的一行，不沿用「已批准」。
  // 刷新收走以后也清掉，同一条再来时照样有按钮。
  const keyOf = (item: WaitingItem) => `${item.id}|${item.at ?? ""}`;
  const forget = (key: string) => setState((current) => { const { [key]: _gone, ...rest } = current; return rest; });
  const run = async (item: WaitingItem, action: RunAction) => {
    const key = keyOf(item);
    setState((current) => ({ ...current, [key]: { busy: true } }));
    try {
      const result = await action.run();
      if (item.kind === "nexus_confirmation" && action.done !== "已拒绝" && result && typeof result === "object" && "confirmationRef" in result && typeof result.confirmationRef === "string") {
        onConfirmed?.({ href: `/me/work/buddy#meeting-work-${encodeURIComponent(result.confirmationRef)}`, title: item.title, done: action.done });
      }
      setState((current) => ({ ...current, [key]: { done: action.done } }));
      timers.current.push(window.setTimeout(() => { void Promise.all([local.refresh(), api.refresh()]).finally(() => forget(key)); }, 2000));
    } catch (error) {
      setState((current) => ({ ...current, [key]: { failed: action, reason: error instanceof Error ? error.message : undefined } }));
      // 会后确认没成多半是过期、作废或别处已经处理了：重读一次，已经不在的这一行就消失。
      if (item.kind === "nexus_confirmation") void api.refresh();
    }
  };
  const now = Date.now();
  return (
    <ul className={h.waiting} data-testid="waiting-list">
      {items.map((item) => {
        const { actions, away } = answer(item);
        const row = state[keyOf(item)];
        const confirm = confirmationLine(item, now);
        const due = confirm ? confirm.due : item.dueAt && item.kind !== "quota" ? dueText(item.dueAt, now) : null;
        // 批准那一行：越界路径写在来源后面（9.6、契约 permission.outsidePaths）。
        const outside = item.permission?.outsidePaths.length ? `越界：${item.permission.outsidePaths.join("、")}` : null;
        const from = confirm ? confirm.from : [item.person?.name, item.source, outside].filter(Boolean).join(" · ");
        // 会后确认没有自己的页面：点这一行就地展开（看全内容和会上原话，能改的在这里改）。
        const detail = confirm && !row?.done ? item.confirmation ?? null : null;
        const canOpen = !!detail;
        const open = canOpen && editing === keyOf(item);
        const toggle = () => setEditing(open ? null : keyOf(item));
        const summary = item.summary?.trim() && item.summary.trim() !== item.title.trim() ? item.summary.trim() : null;
        return (
          <li key={item.id} className={h.wait} data-kind={item.kind} data-done={row?.done ? "" : undefined} data-editing={open ? "" : undefined}>
            <button type="button" className={h.waitMain} aria-expanded={canOpen ? open : undefined} onClick={() => { if (!confirm) go(waitingHref(item)); else if (canOpen) toggle(); }}
              title={!due && item.at ? relativeDayTime(item.at, new Date(now)) : undefined}>
              <span className={h.waitTitle}>{item.title}</span>
              {summary ? <span className={h.waitSummary} title={summary} data-testid="wait-summary">{summary}</span> : null}
              {from || due ? (
                <span className={h.waitSource}>
                  {item.person ? <PersonAvatar personId={item.person.personId} className={h.waitAvatar}>{null}</PersonAvatar> : null}
                  {from ? <span className={h.waitFrom}>{from}</span> : null}
                  {from && due ? <span aria-hidden>·</span> : null}
                  {due ? <span className={h.waitDue} data-warn={due.warn ? "" : undefined} data-testid="wait-due">{due.text}</span> : null}
                </span>
              ) : null}
            </button>
            <span className={h.waitActs}>
              {row?.done ? <span className={h.waitDone}>{row.done}</span>
                : row?.failed ? <FailedLine inline reason={row.reason} onRetry={() => void run(item, row.failed!)} />
                : away ? <span className={`${x.waitChip} ${h.waitAway}`} data-testid="wait-away"><i aria-hidden />{away}</span>
                : open && detail?.value !== null ? null
                : actions.map((action) => (
                  <HeroButton key={action.label} variant={action.primary ? "tertiary" : "ghost"} size="sm" isDisabled={row?.busy}
                    onPress={() => { if ("href" in action) go(action.href); else if ("edit" in action) toggle(); else void run(item, action); }}>{action.label}</HeroButton>
                ))}
            </span>
            {open && detail ? (
              <ConfirmEdit value={detail.value} quote={detail.quote} busy={!!row?.busy} requestId={detail.id}
                onConfirmed={(ref) => {
                  onConfirmed?.({ href: `/me/work/buddy#meeting-work-${encodeURIComponent(ref)}`, title: item.title, done: "已确认", showReceipts: true });
                  setEditing(null);
                  void api.refresh();
                }} onCancel={() => setEditing(null)}
                onSubmit={(value) => { setEditing(null); void run(item, { label: "修改", done: "已修改", run: () => decideNexusConfirmation(detail.id, "amended", value) }); }} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** 没挂项目的 Task 后面「挂到…」（16.4）：点开选现有项目，或者用 Task 名新建一个挂上。 */
function AttachMenu({ taskName, projects, onPick, onCreate }: { taskName: string; projects: Project[]; onPick: (projectId: string) => void; onCreate: () => void }) {
  return (
    <Dropdown>
      <Dropdown.Trigger className={h.statusChip} data-testid="task-attach">挂到…</Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end" offset={8} className={h.pop}>
        <Dropdown.Menu aria-label="挂到" className={h.menuList} onAction={(key) => (key === "new" ? onCreate() : onPick(String(key)))}>
          <Dropdown.Section className={h.menuSection}>
            {projects.map((project) => <Dropdown.Item key={project.id} id={project.id} textValue={project.name} className={h.menuItem}>{project.name}</Dropdown.Item>)}
          </Dropdown.Section>
          <Dropdown.Section className={h.menuSection}>
            <Dropdown.Item key="new" id="new" textValue={`新建「${taskName}」`} className={h.menuItem}><Plus {...ICON} />新建「{taskName}」</Dropdown.Item>
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/**
 * 首页底部的输入框（5.4.3「输入框和『发给』」、14.5、16.4）：InputBar，占位「说点什么…」；框下面「发给」默认自动，回车发出，跳进那条对话（附件到了那条对话再传）。
 * 「发给」是选择器的触发器：「发给」淡色 + 目标墨色 + ChevronDown；点开是弹层：自动、伙伴，再是各项目，当前那项行尾一个勾。
 */
export function HomeComposer({ buddy, projects, route, onSend }: { buddy: Buddy | null; projects: Project[]; route: (text: string) => Promise<RouteTarget>; onSend: HomeSend }) {
  const [text, setText] = useState("");
  const [target, setTarget] = useState<SendTarget>("auto");
  const [guess, setGuess] = useState<RouteTarget>("main");
  const asked = useRef(0);
  const name = buddy?.name?.trim() || "伙伴";
  const nameOf = (value: RouteTarget) => (value === "main" ? name : projects.find((project) => project.id === value.projectId)?.name ?? name);
  useEffect(() => {
    if (target !== "auto") return;
    const value = text.trim();
    const timer = window.setTimeout(() => {
      const ask = ++asked.current;
      if (!value) { setGuess("main"); return; }
      void route(value).then((next) => { if (ask === asked.current) setGuess(next); });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [text, target, route]);
  const label = target === "auto" ? (text.trim() ? `自动 · ${nameOf(guess)}` : "自动") : nameOf(target);
  const send = async (value: string, files: File[]) => { await onSend(value, target, files); return true; };
  const keyOf = (value: SendTarget) => (value === "auto" || value === "main" ? value : `project:${value.projectId}`);
  const current = keyOf(target);
  const pick = (key: string) => setTarget(key === "auto" || key === "main" ? key : { projectId: key.slice("project:".length) });
  const item = (key: string, text: string) => (
    <Dropdown.Item key={key} id={key} textValue={text} className={h.menuItem}><span className={h.grow}>{text}</span>{current === key ? <Check {...ICON} /> : null}</Dropdown.Item>
  );
  return (
    <div className={h.composerDock}>
      <InputBar placeholder="说点什么…" textRequired onText={setText} onSend={send} draftKey="tianshu-home-draft-v1:home"
        footer={{ left: (
          <Dropdown>
            <Dropdown.Trigger className={h.sendTo} data-testid="send-to"><span className={h.sendToLabel}>发给</span><b>{label}</b><ChevronDown {...ICON} /></Dropdown.Trigger>
            <Dropdown.Popover placement="top start" offset={8} className={h.pop}>
              <Dropdown.Menu aria-label="发给" className={h.menuList} onAction={(key) => pick(String(key))}>
                <Dropdown.Section className={h.menuSection}>
                  {item("auto", "自动")}
                  {item("main", name)}
                </Dropdown.Section>
                {projects.length ? (
                  <Dropdown.Section className={h.menuSection}>
                    <Header className={h.menuHeader}>项目</Header>
                    {projects.map((project) => item(`project:${project.id}`, project.name))}
                  </Dropdown.Section>
                ) : null}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        ) }} />
    </div>
  );
}
