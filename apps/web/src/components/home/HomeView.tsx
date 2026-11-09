"use client";

/**
 * 首页（新首页设计 5.4.4）：页头「11 月 7 日 周六」，从上到下是 等你（有才画）→ 各 Mission 的 Task → 输入框；区块之间 32，Mission 之间 16。
 * - 等你：一件两行（原话；来源 · 哪件 Task · 截止）。短的（批准、单选、合回、开工、岗位建议）在行尾就地答，推荐的那个是次按钮、另一个弱按钮；
 *   答完这一行变成状态词（「已批准」）停 2 秒再收走，不弹 toast。行首不放强调色点（组头已经写了「等你」）。
 * - 本月（16.4）：按 Mission 分组列这个月的 Task，行尾「11/20 验收」，再是项目名 chip（点了进项目）；没挂上的是「挂到…」（选现有项目或新建）。
 * - 输入框：InputBar（14.5）；框下面「发给」默认自动（打字停下 300ms 后问一次分发接口，只认最后一次），也能选伙伴或某个项目；发出去以后跳进那条对话。
 */
import { useEffect, useRef, useState } from "react";
import { Dropdown, Header } from "@heroui/react";
import { Check, ChevronDown, Plus } from "lucide-react";
import { PersonAvatar } from "@/components/avatar/PersonAvatar";
import type { Buddy } from "@/components/buddy/useBuddy";
import { HeroButton } from "@/components/HeroButton";
import { FailedLine, failureOf, type Failure } from "@/components/work/DecisionBox";
import { localOptions, oneTap } from "@/components/work/decisions";
import { InputBar } from "./InputBar";
import { acceptDrafts, acceptProjectDrafts, decideAutoRelay, planKey, type PlanTarget } from "@/lib/board/cloud";
import { useLocalRunner, type LocalRunnerState } from "@/lib/local/LocalRunnerProvider";
import { decideProposal } from "@/lib/team/roles";
import { canCommandHere, decide } from "@/lib/work/actions";
import { mergeCard } from "@/lib/work/merge";
import { missionHref, taskGateLabel, taskHref, waitingHref } from "@/lib/home/derive";
import { projectHref, type Project } from "@/lib/home/projects";
import type { ProjectsApi } from "./useProjects";
import { relativeDayTime } from "@/lib/companyTime";
import type { HomeMonthMission, RouteTarget, WaitingItem, WorkHomeData } from "@/lib/home/types";
import type { WorkHomeApi } from "@/lib/home/useWorkHome";
import { ICON } from "./StateIcon";
import { usePhone } from "./usePhone";
import h from "@/styles/home.module.css";
import x from "@/styles/decision-box.module.css";

export type SendTarget = "auto" | RouteTarget;

export function HomeView({ data, api, buddy, today, go, route, onSend, projects }: {
  data: WorkHomeData;
  api: WorkHomeApi;
  buddy: Buddy | null;
  /** 「11 月 7 日 周六」：页头和「今天」行一样。 */
  today: string;
  go: (href: string) => void;
  /** 「自动」会发去哪（打字时实时显示）。 */
  route: (text: string) => Promise<RouteTarget>;
  onSend: (text: string, target: SendTarget, files: File[]) => void;
  projects: ProjectsApi;
}) {
  // 「本月」（16.4）：这个月的 Task 按 Mission 分组；之前月份没了结的在各自的项目里，不在这里列。
  const missions = data.month.missions.filter((mission) => mission.tasks.length && mission.period === data.period);
  return (
    <div className={h.homeView} data-testid="home-view">
      <header className={h.viewHead}><h1 className={h.viewTitle} tabIndex={-1}>{today}</h1></header>
      <div className={h.homeScroll}>
        <div className={h.homeInner}>
          {data.waiting.length ? (
            <section aria-label="等你" className={h.section}>
              <p className={h.sectionTitle}>等你 <span>{data.waiting.length}</span></p>
              <WaitingList items={data.waiting} api={api} go={go} />
            </section>
          ) : null}
          {api.planFailed ? (
            <section aria-label="Task" className={h.section}>
              <p className={h.planFailed} data-testid="plan-read-failed">本体读取失败<HeroButton variant="ghost" size="sm" onPress={() => void api.retryPlan()}>重试</HeroButton></p>
            </section>
          ) : null}
          {missions.length ? (
            <section aria-label="本月" className={h.section}>
              <p className={h.sectionTitle}>本月</p>
              {missions.map((mission) => (
                <div key={mission.missionId} className={h.taskList}>
                  {/* Mission 名点了进只读的 Mission 详情（14.2）。 */}
                  <button type="button" className={h.missionTitle} onClick={() => go(missionHref(mission.missionId))} data-testid="month-mission">{mission.title}</button>
                  {mission.tasks.map((task) => <MonthRow key={task.taskId} task={task} gate={taskGateLabel(projects.all, api.work.plan, { taskId: task.taskId, missionId: mission.missionId })} projects={projects} go={go} />)}
                </div>
              ))}
            </section>
          ) : null}
        </div>
      </div>
      <HomeComposer buddy={buddy} projects={projects.projects} route={route} onSend={onSend} />
    </div>
  );
}

/**
 * 「本月」一行：Task 名（做完了小字「已完成」）、行尾验收截止（挂着的项目目标的截止日，没挂的退回这个 Mission 下一个验收时间点），再是项目名 chip；
 * 没挂上的「挂到…」：选现有项目（PUT 挂接）或用 Task 名新建一个挂上（POST 带 taskId）；没成在行尾写「失败 · 重试」。
 */
function MonthRow({ task, gate, projects, go }: { task: HomeMonthMission["tasks"][number]; gate: string | null; projects: ProjectsApi; go: (href: string) => void }) {
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
          {task.completedAt ? <span className={h.taskSub}>已完成</span> : null}
        </span>
        {gate ? <span className={h.taskGate}>{gate}</span> : null}
      </button>
      {failed ? <FailedLine inline {...failed} />
        : project ? <button type="button" className={h.statusChip} onClick={() => go(projectHref(project.projectId))} data-testid="task-project">{project.name}</button>
        : <AttachMenu taskName={task.name} projects={projects.projects} onPick={(projectId) => attempt(() => projects.actions.attach(task.taskId, projectId))}
          onCreate={() => attempt(() => projects.actions.create(task.name, task.taskId))} />}
    </div>
  );
}

type RunAction = { label: string; done: string; primary?: boolean; run: () => Promise<unknown> };
/** 行尾的一个按钮：就地办（run），或点了去那件事里（href，开工的「改一改」进项目对话）。 */
type Action = RunAction | { label: string; primary?: boolean; href: string };
/** away：这里答不了的 inline_local（手机、别的电脑、本机没就绪），行尾画「等你 · {电脑名}」chip。 */
export type WaitingRowAnswer = { actions: Action[]; away: string | null };

/**
 * 等你一行的行尾（5.4.4「就地答」、9.6，契约 WaitingAnswer）：
 * - inline_local（批准、回答、合回）要本机办：只在 deviceId 那台电脑上画按钮，答案直接回给那个子会话；单选、最多 2 个短选项才就地答（3 个的点进去答，不藏第三个）。
 *   批准旁边是「换个做法」（进那个子会话说）。
 *   别处（手机、别的电脑、本机没就绪）画「等你 · {deviceName}」，整行点进去看。
 * - inline（开工、岗位建议、自动接力）走云端，手机上也能：开工「开始」= 接受派活单并登记开工（配对的电脑上开着的网页认领后开，同 PlanDecision 开不了本机时），
 *   「改一改」进项目对话；岗位建议「采纳 / 不要」；自动接力到了上限（18.12）「继续 / 停下」。
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

/**
 * 等你的一行（5.4.4「等你行」）。第二行依次是对方（请你认可的：头像 16 和名字）、来源、截止；没有截止的不写时间，时间（5.6 相对时间）放在整行能点的那块的 title 里。
 * 额度那条的 dueAt 是恢复的时刻（原话里已经写了），不当截止写。
 * 答完先在原处写状态词，停 2 秒再刷新（收走）；失败在原处写「失败」加「重试」，不弹 toast。
 */
export function WaitingList({ items, api, go }: { items: WaitingItem[]; api: WorkHomeApi; go: (href: string) => void }) {
  const answer = useActions(api);
  const local = useLocalRunner();
  const [state, setState] = useState<Record<string, { busy?: boolean; done?: string; failed?: RunAction; reason?: string }>>({});
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
      await action.run();
      setState((current) => ({ ...current, [key]: { done: action.done } }));
      timers.current.push(window.setTimeout(() => { void Promise.all([local.refresh(), api.refresh()]).finally(() => forget(key)); }, 2000));
    } catch (error) {
      setState((current) => ({ ...current, [key]: { failed: action, reason: error instanceof Error ? error.message : undefined } }));
    }
  };
  const now = Date.now();
  return (
    <ul className={h.waiting} data-testid="waiting-list">
      {items.map((item) => {
        const { actions, away } = answer(item);
        const row = state[keyOf(item)];
        const due = item.dueAt && item.kind !== "quota" ? dueText(item.dueAt, now) : null;
        // 批准那一行：越界路径写在来源后面（9.6、契约 permission.outsidePaths）。
        const outside = item.permission?.outsidePaths.length ? `越界：${item.permission.outsidePaths.join("、")}` : null;
        const from = [item.person?.name, item.source, outside].filter(Boolean).join(" · ");
        return (
          <li key={item.id} className={h.wait} data-kind={item.kind} data-done={row?.done ? "" : undefined}>
            <button type="button" className={h.waitMain} onClick={() => go(waitingHref(item))} title={!due && item.at ? relativeDayTime(item.at, new Date(now)) : undefined}>
              <span className={h.waitTitle}>{item.title}</span>
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
                : actions.map((action) => (
                  <HeroButton key={action.label} variant={action.primary ? "tertiary" : "ghost"} size="sm" isDisabled={row?.busy}
                    onPress={() => { if ("href" in action) go(action.href); else void run(item, action); }}>{action.label}</HeroButton>
                ))}
            </span>
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
export function HomeComposer({ buddy, projects, route, onSend }: { buddy: Buddy | null; projects: Project[]; route: (text: string) => Promise<RouteTarget>; onSend: (text: string, target: SendTarget, files: File[]) => void }) {
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
  const send = async (value: string, files: File[]) => { onSend(value, target, files); return true; };
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
