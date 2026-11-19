"use client";

/**
 * 首页（11/16 重新设计）：只有「等你」和输入框；会议、本月各是一页（MeetingsPage、月份页），从左栏进。
 * - 等你：focusList（lib/home/focus）合成、排好的一份，露 5 件，其余「还有 N 件」；会议行、「这台电脑没连上」和等你行混排。
 * - 等你：一件两行（原话；来源 · 哪件 Task · 截止）。短的（批准、单选、合回、开工、岗位建议）在行尾就地答，推荐的那个是次按钮、另一个弱按钮；
 *   答完这一行变成状态词（「已批准」）停 2 秒再收走，不弹 toast。行首不放强调色点（组头已经写了「等你」）。
 *   会后确认（Nexus 推来的会上待定事项，17.2 第 43 条）：第二行「会后确认 · 待确认的内容 · 截止 11/12 18:00」，行尾「确认」「修改」「拒绝」；
 *   点「修改」（或点这一行）就地展开：有会上原话的先写原话，下面输入框预填原内容，改完「提交」。
 * - 输入框：InputBar（14.5）；框下面「发给」默认自动（打字停下 300ms 后问一次分发接口，只认最后一次），也能选伙伴或某个项目；发出去以后跳进那条对话。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dropdown, Header } from "@heroui/react";
import { Check, ChevronDown, EyeOff } from "lucide-react";
import { PersonAvatar } from "@/components/avatar/PersonAvatar";
import type { Buddy } from "@/components/buddy/useBuddy";
import { HeroButton } from "@/components/HeroButton";
import { FailedLine } from "@/components/work/DecisionBox";
import { localOptions, oneTap } from "@/components/work/decisions";
import { InputBar } from "./InputBar";
import { FocusMeetingRow, ReadError } from "./PartnerMeetings";
import { MEETING_ROW_PREFIX, focusList, meetingVersion, visibleCount, type FocusRow } from "@/lib/home/focus";
import type { PartnerMeeting } from "@/lib/home/partnerMeetingFeed";
import type { HomeMeeting } from "./MeetingControl";
import { usePartnerMeetings } from "@/lib/home/partnerMeetingFeed";
import { ConfirmAndHandOff } from "@/components/meeting/MeetingWorkHandoffs";
import { acceptDrafts, acceptProjectDrafts, decideAutoRelay, decideNexusConfirmation, ignoreWaiting, planKey, type PlanTarget } from "@/lib/board/cloud";
import { useLocalRunner, type LocalRunnerState } from "@/lib/local/LocalRunnerProvider";
import { decideProposal } from "@/lib/team/roles";
import { canCommandHere, decide } from "@/lib/work/actions";
import { mergeCard } from "@/lib/work/merge";
import { waitingHref } from "@/lib/home/derive";
import type { Project } from "@/lib/home/projects";
import type { ProjectsApi } from "./useProjects";
import { clock, monthDayTime, relativeDayTime } from "@/lib/companyTime";
import type { RouteTarget, WaitingItem, WorkHomeData } from "@/lib/home/types";
import type { WorkHomeApi } from "@/lib/home/useWorkHome";
import { ICON } from "./StateIcon";
import { usePhone } from "./usePhone";
import { pageHref } from "./view";
import h from "@/styles/home.module.css";
import x from "@/styles/decision-box.module.css";
import m from "./partner-meetings.module.css";
import { FadeText } from "@/lib/home/overflowFade";

export type SendTarget = "auto" | RouteTarget;
type HomeSend = (text: string, target: SendTarget, files: File[]) => Promise<void> | void;

export function HomeView({ data, api, buddy, today, go, route, onSend, projects, meeting, trail, offline = false, recordingMeetingId }: {
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
  /** 这台电脑没连上、没配对（第 73 条）：「等你」里一行，点了去连接页。 */
  offline?: boolean;
  /** 这台电脑正在录的那场会（在伙伴台胶囊上，不进等你）。 */
  recordingMeetingId: string | null;
}) {
  return (
    <div className={h.homeView} data-testid="home-view">
      <header className={h.viewHead}><h1 className={h.viewTitle} tabIndex={-1}>{today}</h1>{trail}</header>
      <div className={h.homeScroll}>
        <div className={h.homeInner}>
          <HomeWaiting data={data} api={api} go={go} offline={offline} recordingMeetingId={recordingMeetingId} meeting={meeting} />
        </div>
      </div>
      <HomeComposer buddy={buddy} projects={projects.projects} route={route} onSend={onSend} />
    </div>
  );
}

/** 首页最多等会议数据这么久再画清单（设计 4.9）。 */
const MEETINGS_WAIT_MS = 800;

/**
 * 首页「等你」（设计第 4 节）：focusList 合成、排好的一份清单，露 5 件，其余收进「还有 N 件」；
 * 空的时候一行「没有等你的事」。首次打开等会议数据到了（最多 800ms）再画，等的时候空着（aria-busy），不闪空态。
 * 云端首页还没问到（api.known 为 false）时也不写「没有等你的事」。
 */
export function HomeWaiting({ data, api, go, offline = false, phone = false, recordingMeetingId, meeting }: {
  data: WorkHomeData; api: WorkHomeApi; go: (href: string) => void; offline?: boolean; phone?: boolean;
  recordingMeetingId: string | null; meeting: Pick<HomeMeeting, "start">;
}) {
  const { items, error, loaded, reload } = usePartnerMeetings();
  const [confirmed, setConfirmed] = useState<ConfirmedReceipt | null>(null);
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (loaded) return;
    const timer = window.setTimeout(() => setWaited(true), MEETINGS_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [loaded]);
  const rows = focusList({ waiting: data.waiting, meetings: items, offline, recordingMeetingId, now: Date.now(), ignoredMeetings: data.ignoredMeetings });
  const className = phone ? h.phoneWaiting : h.section;
  if (!loaded && !waited) return <section aria-label="等你" aria-busy="true" className={className} />;
  return <section aria-label="等你" aria-busy={!api.known || undefined} className={className}>
    {rows.length ? <p className={h.sectionTitle}>等你 <span>{rows.length}</span></p> : null}
    {confirmed ? <p className={m.receipt} role="status">{confirmed.title} · {confirmed.done}
      <HeroButton variant="ghost" size="sm" onPress={() => go(confirmed.href)}>{confirmed.showReceipts ? "查看递送回执" : "选择工作去向"}</HeroButton>
      <HeroButton variant="ghost" size="sm" aria-label="收起确认回执" onPress={() => setConfirmed(null)}>收起</HeroButton>
    </p> : null}
    {rows.length ? <WaitingList items={[]} rows={rows} fold meeting={meeting} api={api} go={go} onConfirmed={setConfirmed} />
      : !error && api.known ? <p className={h.waitEmpty} data-testid="wait-empty">没有等你的事</p> : null}
    {error ? <ReadError message={error} retry={reload} /> : null}
  </section>;
}

/**
 * 等你一行行尾的时间位（设计 4.7）：只写钟点事实。会议「11:44 开始」「已到时间」「进行中」；截止照原来的写法（「剩 5 小时」「已过截止」，
 * 会后确认写时刻）；额度那条的 dueAt 是恢复时刻，不写；开完的会日期在第二行，不写。
 */
export function waitTime(row: FocusRow, now: number): { text: string; warn: boolean } | null {
  if (row.kind === "machine") return null;
  if (row.kind === "meeting") {
    if (row.when !== "soon") return null;
    if (row.item.stage === "live") return { text: "进行中", warn: true };
    const start = Date.parse(row.item.at);
    return { text: now < start ? `${clock(new Date(start))} 开始` : "已到时间", warn: true };
  }
  const { item } = row;
  const confirm = confirmationLine(item, now);
  if (confirm) return confirm.due;
  return item.dueAt && item.kind !== "quota" ? dueText(item.dueAt, now) : null;
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

/** 忽略一件等你（方案 A）：带原因调接口，成了重读首页，这一行就不在等你里了。 */
export async function ignoreItem(item: WaitingItem, reason: string, refresh: () => Promise<unknown>): Promise<void> {
  await ignoreWaiting(item.id, reason);
  await refresh();
}

/** 忽略一行会议（本人 11/16）：会议行不在服务端的等你里，带这一场当时的样子存下，重读首页后不再列；那一场有了新变化又回来。 */
export async function ignoreMeeting(item: PartnerMeeting, reason: string, refresh: () => Promise<unknown>): Promise<void> {
  await ignoreWaiting(`${MEETING_ROW_PREFIX}${item.id}`, reason, meetingVersion(item));
  await refresh();
}

/** 等你一行「忽略」展开的那一块：输入框「原因」和「忽略」，原因为空点不了，回车同「忽略」；Esc 或点这一行以外收起；没成写「失败」加「重试」。 */
export function IgnoreBox({ onIgnore, onClose }: { onIgnore: (reason: string) => Promise<unknown>; onClose: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ reason?: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (event: PointerEvent) => { if (!box.current?.closest("li")?.contains(event.target as Node)) onClose(); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [onClose]);
  const reason = text.trim();
  const submit = async () => {
    if (!reason || busy) return;
    setBusy(true);
    setFailed(null);
    try { await onIgnore(reason); } catch (error) {
      setFailed({ reason: error instanceof Error ? error.message : undefined });
      setBusy(false);
    }
  };
  return (
    <div ref={box} className={h.waitEdit} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <input className={h.noteEdit} value={text} placeholder="原因" aria-label="原因" maxLength={500} autoFocus
        onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
      <div className={h.noteFoot}>
        {failed ? <FailedLine inline reason={failed.reason} onRetry={() => void submit()} />
          : <HeroButton variant="tertiary" size="sm" isDisabled={busy || !reason} onPress={() => void submit()}>忽略</HeroButton>}
      </div>
    </div>
  );
}

/**
 * 等你的一行（5.4.4「等你行」）。有摘要（契约 WaitingItem.summary，主循环第 66 条：批准是那句人话，等你补、受阻是验收员那一句，提问是问题原文）的第二行写它，
 * 和第一行一样的不再写一遍；再下面一行（没摘要时是第二行）依次是对方（请你认可的：头像 16 和名字）、来源、截止；没有截止的不写时间，时间（5.6 相对时间）放在整行能点的那块的 title 里。
 * 额度那条的 dueAt 是恢复的时刻（原话里已经写了），不当截止写。
 * 答完先在原处写状态词，停 2 秒再刷新（收走）；失败在原处写「失败」加「重试」，不弹 toast。
 */
export function WaitingList({ items, rows: given, fold = false, meeting, api, go, onConfirmed }: {
  items: WaitingItem[];
  /** 首页：focusList 排好的一份（等你行、会议、这台电脑没连上混排）；不给就只画 items。 */
  rows?: FocusRow[];
  /** 露 5 件，其余收进「还有 N 件」（就地展开，不换页）。 */
  fold?: boolean;
  /** 会议行「开始录音」。 */
  meeting?: Pick<HomeMeeting, "start">;
  api: WorkHomeApi; go: (href: string) => void; onConfirmed?: (receipt: ConfirmedReceipt) => void;
}) {
  const answer = useActions(api);
  const local = useLocalRunner();
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<Record<string, { busy?: boolean; done?: string; failed?: RunAction; reason?: string }>>({});
  // 会后确认展开着的那一行（一次只开一行）。
  const [editing, setEditing] = useState<string | null>(null);
  // 「忽略」展开着的那一行（一次只开一行）。
  const [ignoring, setIgnoring] = useState<string | null>(null);
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
  const all: FocusRow[] = given ?? items.map((item) => ({ kind: "waiting", item }));
  const shown = fold && !expanded ? all.slice(0, visibleCount(all.length)) : all;
  const timeSlot = (row: FocusRow) => {
    const time = waitTime(row, now);
    return time ? <span className={h.waitTime} data-warn={time.warn ? "" : undefined} data-testid="wait-due">{time.text}</span> : null;
  };
  return (
    <ul className={h.waiting} data-testid="waiting-list">
      {shown.map((focus) => {
        if (focus.kind === "machine") return (
          <li key="machine" className={h.wait} data-kind="machine">
            <button type="button" className={h.waitMain} onClick={() => go(pageHref("connections"))} data-testid="wait-machine"><span className={h.waitTitle}>这台电脑没连上</span></button>
          </li>
        );
        if (focus.kind === "meeting") {
          const key = `meeting:${focus.item.id}`;
          const ignoreOpen = ignoring === key;
          return (
            <FocusMeetingRow key={key} item={focus.item} when={focus.when} time={timeSlot(focus)} go={go} meeting={meeting ?? { start: async () => null }} ignore={<>
              <span className={h.waitIgnore}>
                <HeroButton variant="ghost" size="sm" isIconOnly title="忽略" aria-label="忽略" aria-expanded={ignoreOpen}
                  onPress={() => setIgnoring(ignoreOpen ? null : key)}><EyeOff {...ICON} /></HeroButton>
              </span>
              {ignoreOpen ? <IgnoreBox onClose={() => setIgnoring(null)}
                onIgnore={async (reason) => { await ignoreMeeting(focus.item, reason, api.refresh); setIgnoring(null); }} /> : null}
            </>} />
          );
        }
        const { item } = focus;
        const { actions, away } = answer(item);
        const row = state[keyOf(item)];
        const confirm = confirmationLine(item, now);
        // 批准那一行：越界路径写在来源后面（9.6、契约 permission.outsidePaths）。
        const outside = item.permission?.outsidePaths.length ? `越界：${item.permission.outsidePaths.join("、")}` : null;
        const from = confirm ? confirm.from : [item.person?.name, item.source, outside].filter(Boolean).join(" · ");
        // 会后确认没有自己的页面：点这一行就地展开（看全内容和会上原话，能改的在这里改）。
        const detail = confirm && !row?.done ? item.confirmation ?? null : null;
        const canOpen = !!detail;
        const open = canOpen && editing === keyOf(item);
        const toggle = () => setEditing(open ? null : keyOf(item));
        const summary = item.summary?.trim() && item.summary.trim() !== item.title.trim() ? item.summary.trim() : null;
        const ignoreOpen = ignoring === keyOf(item);
        return (
          <li key={item.id} className={h.wait} data-kind={item.kind} data-done={row?.done ? "" : undefined} data-editing={open || ignoreOpen ? "" : undefined}>
            <button type="button" className={h.waitMain} aria-expanded={canOpen ? open : undefined} onClick={() => { if (!confirm) go(waitingHref(item)); else if (canOpen) toggle(); }}
              title={!waitTime(focus, now) && item.at ? relativeDayTime(item.at, new Date(now)) : undefined}>
              <span className={h.waitTitle}>{item.title}</span>
              {summary ? <FadeText className={h.waitSummary} title={summary} data-testid="wait-summary">{summary}</FadeText> : null}
              {from ? (
                <span className={h.waitSource}>
                  {item.person ? <PersonAvatar personId={item.person.personId} className={h.waitAvatar}>{null}</PersonAvatar> : null}
                  <span className={h.waitFrom}>{from}</span>
                </span>
              ) : null}
            </button>
            {timeSlot(focus)}
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
            {!row?.done ? (
              <span className={h.waitIgnore}>
                <HeroButton variant="ghost" size="sm" isIconOnly title="忽略" aria-label="忽略" aria-expanded={ignoreOpen}
                  onPress={() => setIgnoring(ignoreOpen ? null : keyOf(item))}><EyeOff {...ICON} /></HeroButton>
              </span>
            ) : null}
            {ignoreOpen ? <IgnoreBox onClose={() => setIgnoring(null)}
              onIgnore={async (reason) => { await ignoreItem(item, reason, api.refresh); setIgnoring(null); }} /> : null}
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
      {shown.length < all.length ? (
        <li className={h.wait} data-kind="more">
          <button type="button" className={h.waitMain} onClick={() => setExpanded(true)} data-testid="wait-more"><span className={h.waitMore}>还有 {all.length - shown.length} 件</span></button>
        </li>
      ) : null}
    </ul>
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
      <InputBar placeholder="说点什么" textRequired onText={setText} onSend={send} draftKey="tianshu-home-draft-v1:home"
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
