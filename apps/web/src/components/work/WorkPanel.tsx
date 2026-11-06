"use client";

/**
 * 右栏（V2 设计第 20.4 节，样子照 prototype-home）：两个标签「worker」「本月」，整栏可以收起；点一个 worker 或 Task，右栏换成它的详情，左上角返回。
 * - worker：顶上「资源」（本机、模型、花费、岗位），下面进行中、已排队、已完成（今天），跨所有 Task；规划员、验收员也在里面。
 * - 本月：Mission 下列 Task，一行写交付、链路小点（一个点一个 worker）；点 Task 打开 Task 视图并把对话锚到它。
 * - worker 详情：在干什么、等你、资源和岗位、计划、最近、产出、逐条验收（仍然通过、推翻）、打开完整会话。
 * 手机上没有标签头（底部标签切），详情的正文放进白卡。
 */
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import type { THomePlanResponse, THomePlanTask } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { TaskDeliverable } from "@/components/member/home/deliverable/TaskDeliverable";
import { useCardDetail } from "@/components/cards/useCardDetail";
import { Acceptance } from "@/components/cards/CardSession";
import { gateOf } from "@/components/board/MonthLanes";
import type { TaskBoard } from "@/lib/board/useTaskBoard";
import { deliverableLabel } from "@/lib/board/cards";
import type { RoleListResponse, RoleProposalView } from "@/lib/team/roles";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { useSessionEvents } from "@/lib/local/useSessionEvents";
import { commitText, placeText } from "@/lib/work/merge";
import { MergeAction } from "./MergeAction";
import type { Resources } from "@/lib/work/useWork";
import { CHAIN_LABEL, groupWorkers, resourceText, type ChainState, type Worker } from "@/lib/work/workers";
import { AskRow, Chain, RoleAvatar, WorkerRow, marker, waitingText } from "./WorkerRow";
import d from "@/styles/task-deliverable.module.css";
import w from "@/styles/v2-work.module.css";

export type PanelView = { kind: "worker"; key: string } | { kind: "task"; taskId: string };
export type PanelTab = "worker" | "month";

const money = (usd: number | null) => (usd === null ? "—" : `$${usd.toFixed(usd < 1 ? 3 : 2)}`);
const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
/** 「11/18 验收 · 还有 12 天」 */
export function dueText(plan: THomePlanResponse, missionId: string): string | null {
  const gate = gateOf(plan, missionId);
  if (!gate) return null;
  return `${md(gate.date)} 验收 · ${gate.left > 0 ? `还有 ${gate.left} 天` : gate.left === 0 ? "就是今天" : `过了 ${-gate.left} 天`}`;
}

/** 本机 ▮▮▯：一格一个位置，在跑的涂满。 */
export function Slots({ used, cap, off }: { used: number; cap: number; off?: boolean }) {
  return <span className={w.slots} role="img" aria-label={`本机 ${used}/${cap}`}>{Array.from({ length: cap }, (_, i) => <span key={i} className={w.slot} data-on={!off && i < used ? true : undefined} />)}</span>;
}

/** 链路小点：一个点一个 worker，按已完成、进行中、已排队。 */
export function ChainDots({ workers }: { workers: Worker[] }) {
  const order: ChainState[] = ["done", "doing", "queued"];
  if (!workers.length) return null;
  const sorted = [...workers].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
  return <span className={w.dots} role="img" aria-label={order.map((state) => `${CHAIN_LABEL[state]} ${workers.filter((worker) => worker.state === state).length}`).join(" · ")}>{sorted.map((worker) => <span key={worker.key} className={w.cd} data-state={worker.state} />)}</span>;
}

export function WorkPanel({ tab, onTab, view, backLabel, onOpen, onBack, onDispatch, onSplit, onCollapse, handheld, plan, boards, workers, resources, roles, proposals, now, anchorTaskId, onChanged }: {
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  view: PanelView | null;
  backLabel: string;
  onOpen: (view: PanelView) => void;
  onBack: () => void;
  /** Task 视图的「派活」：把对话锚到这个 Task。 */
  onDispatch: (taskId: string) => void;
  /** 「拆一下」：这台电脑连着本机就开规划员，否则登记成「拆卡 · 等开工」。 */
  onSplit: (taskId: string) => void;
  onCollapse?: () => void;
  handheld: boolean;
  plan: THomePlanResponse | null;
  boards: Record<string, TaskBoard>;
  workers: Worker[];
  resources: Resources;
  roles: RoleListResponse | null;
  proposals: RoleProposalView[];
  now: number;
  anchorTaskId: string | null;
  onChanged: () => void;
}) {
  const worker = view?.kind === "worker" ? workers.find((entry) => entry.key === view.key) ?? null : null;
  const task = view?.kind === "task" ? plan?.tasks.find((entry) => entry.taskId === view.taskId) ?? null : null;
  const wrap = (children: React.ReactNode) => (handheld ? <div className={w.card}>{children}</div> : <>{children}</>);
  return (
    <>
      <div className={w.sideHead}>
        <div role="tablist" aria-label="右栏" className={w.tablist}>
          <button type="button" role="tab" className={w.tab} aria-selected={tab === "worker" && view?.kind !== "task"} onClick={() => onTab("worker")}>worker</button>
          <button type="button" role="tab" className={w.tab} aria-selected={tab === "month" || view?.kind === "task"} onClick={() => onTab("month")}>本月</button>
        </div>
        <span className={w.grow} />
        {onCollapse ? (
          <button type="button" className={w.iconBtn} aria-label="收起右栏" title="收起" onClick={onCollapse}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><rect x="2" y="2.5" width="12" height="11" rx="2.5" /><path d="M10 2.5v11" /></svg>
          </button>
        ) : null}
      </div>
      <div className={w.sideBody} data-testid={view ? `panel-${view.kind}` : `panel-${tab}`}>
        {view ? <button type="button" className={w.back} onClick={onBack}><ChevronLeft size={14} aria-hidden />{backLabel}</button> : null}
        {view?.kind === "worker" ? (worker ? <WorkerDetail worker={worker} roles={roles} now={now} wrap={wrap} onChanged={onChanged} /> : <p className={w.emp}>这个 worker 已经不在了</p>)
          : view?.kind === "task" ? (task && plan ? <TaskView plan={plan} task={task} board={boards[task.taskId] ?? null} workers={workers.filter((entry) => entry.taskId === task.taskId)} now={now} wrap={wrap}
            onOpenWorker={(key) => onOpen({ kind: "worker", key })} onDispatch={() => onDispatch(task.taskId)} onSplit={() => onSplit(task.taskId)} onChanged={onChanged} /> : <p className={w.emp}>没有这个 Task</p>)
          : tab === "worker" ? <WorkerTab workers={workers} resources={resources} roles={roles} proposals={proposals} now={now} onOpen={(key) => onOpen({ kind: "worker", key })} onChanged={onChanged} />
          : <MonthTab plan={plan} workers={workers} anchorTaskId={anchorTaskId} onOpen={(taskId) => onOpen({ kind: "task", taskId })} />}
      </div>
    </>
  );
}

function Group({ title, sub, workers, now, onOpen, onChanged }: { title: string; sub?: string; workers: Worker[]; now: number; onOpen: (key: string) => void; onChanged: () => void }) {
  return (
    <section className={w.grp} aria-label={title}>
      <p className={w.h2}>{title} <span className={w.c}>{workers.length}</span>{sub ? <span className={w.sub2}>{sub}</span> : null}</p>
      <div className={w.list}>
        {workers.length ? workers.map((worker) => <WorkerRow key={worker.key} worker={worker} now={now} task={worker.taskName} onOpen={() => onOpen(worker.key)} onChanged={onChanged} />) : <div className={w.emp}>—</div>}
      </div>
    </section>
  );
}

function WorkerTab({ workers, resources, roles, proposals, now, onOpen, onChanged }: {
  workers: Worker[]; resources: Resources; roles: RoleListResponse | null; proposals: RoleProposalView[]; now: number;
  onOpen: (key: string) => void; onChanged: () => void;
}) {
  const groups = groupWorkers(workers);
  const running = (roleId: string) => workers.filter((worker) => worker.state === "doing" && worker.role.id === roleId).length;
  return (
    <>
      <section className={w.grp} aria-label="资源">
        <p className={w.h2}>资源</p>
        <div className={w.res} data-testid="resources">
          <span className={w.k}>本机</span>
          <span className={w.v}><span className={w.live} data-off={!resources.local.online || undefined} aria-hidden />{resources.local.online ? "在线" : "没连上"}
            <Slots used={resources.local.used} cap={resources.local.cap} off={!resources.local.online} /><span className={w.num}>{resources.local.used}/{resources.local.cap}</span>
            {resources.local.name ? <span className={w.dim}>{resources.local.name}</span> : null}</span>
          <span className={w.k}>模型</span>
          <span className={w.v}>{resources.models.map((model) => <span key={model.key} className={w.mt} data-off={!model.on || undefined}>{model.label}</span>)}</span>
          <span className={w.k}>花费</span>
          <span className={w.v}>今天 <span className={w.num}>{money(resources.todayUsd)}</span></span>
          <span className={w.k}>岗位</span>
          <span className={w.v}>
            {roles?.roles.length ? roles.roles.map((role) => {
              const count = running(role.id);
              return (
                <Link key={role.id} href="/me/team" className={w.rc} data-testid="role-chip">
                  <RoleAvatar name={role.name} kind={role.kind} size="s" /><span>{role.name}</span>
                  {count ? <em>{count}</em> : null}
                  {proposals.some((proposal) => proposal.role.id === role.id) ? <i className={w.pdot} aria-label="有修改建议" /> : null}
                </Link>
              );
            }) : <Link href="/me/team" className={w.link}>加岗位</Link>}
          </span>
        </div>
      </section>
      <Group title="进行中" workers={groups.doing} now={now} onOpen={onOpen} onChanged={onChanged} />
      <Group title="已排队" workers={groups.queued} now={now} onOpen={onOpen} onChanged={onChanged} />
      <Group title="已完成" sub="今天" workers={groups.done} now={now} onOpen={onOpen} onChanged={onChanged} />
    </>
  );
}

function MonthTab({ plan, workers, anchorTaskId, onOpen }: { plan: THomePlanResponse | null; workers: Worker[]; anchorTaskId: string | null; onOpen: (taskId: string) => void }) {
  if (!plan) return <p className={w.emp}>正在读…</p>;
  const missions = plan.missions.filter((mission) => plan.tasks.some((task) => task.missionId === mission.missionId));
  const workdaysLeft = plan.days.filter((day) => day.workday && day.date >= plan.today).length;
  return (
    <>
      <p className={w.mtop}><b>{Number(plan.period.slice(5, 7))} 月</b><span className={w.dim}>还剩 {workdaysLeft} 个工作日</span></p>
      {missions.length ? missions.map((mission) => (
        <section key={mission.missionId} className={w.grp} aria-label={mission.title}>
          <div className={w.mh}><span className={w.nm}>{mission.title}</span>{dueText(plan, mission.missionId) ? <span className={w.due}>{dueText(plan, mission.missionId)}</span> : null}</div>
          <div className={w.list}>
            {plan.tasks.filter((task) => task.missionId === mission.missionId).map((task) => (
              <button key={task.taskId} type="button" className={w.tr} aria-current={task.taskId === anchorTaskId || undefined} data-testid="month-task" onClick={() => onOpen(task.taskId)}>
                <span className={w.trMain}>
                  <span className={w.nm}>{task.name}</span>
                  <span className={w.sub3}>{task.deliverable?.version ? `交付 v${task.deliverable.version}` : "还没交付"}</span>
                </span>
                <ChainDots workers={workers.filter((worker) => worker.taskId === task.taskId)} />
                <span className={w.chev} aria-hidden>›</span>
              </button>
            ))}
          </div>
        </section>
      )) : <p className={w.emp}>本月还没有 Task</p>}
    </>
  );
}

/** Task 视图：约定（这个 Task 的标准）、交付物（V1 的面板原样嵌进来，「我的事项」那一折不出）、它的 worker，「派活」把对话锚到它。 */
function TaskView({ plan, task, board, workers, now, wrap, onOpenWorker, onDispatch, onSplit, onChanged }: {
  plan: THomePlanResponse; task: THomePlanTask; board: TaskBoard | null; workers: Worker[]; now: number; wrap: (children: React.ReactNode) => React.ReactNode;
  onOpenWorker: (key: string) => void; onDispatch: () => void; onSplit: () => void; onChanged: () => void;
}) {
  const mission = plan.missions.find((entry) => entry.missionId === task.missionId) ?? null;
  const order = { done: 0, doing: 1, queued: 2 } as const;
  const sorted = [...workers].sort((a, b) => order[a.state] - order[b.state]);
  const criteria = board?.criteria ?? task.criteria.map((text, index) => ({ index: index + 1, text }));
  return (
    <>
      <div className={w.dtHead}>
        {mission ? <span className={w.crumb}>{mission.title}</span> : null}
        <h2 className={w.h1}>{task.name}</h2>
        {dueText(plan, task.missionId) ? <span className={w.dim}>{dueText(plan, task.missionId)}</span> : null}
      </div>
      {wrap(<>
        {criteria.length ? (
          <section className={w.grp} aria-label="约定">
            <p className={w.h2}>约定</p>
            <ol className={w.crits}>{criteria.map((criterion) => <li key={criterion.index}><span className={w.crit}>{criterion.index}</span><span>{criterion.text}</span></li>)}</ol>
          </section>
        ) : null}
        <section className={w.grp} aria-label="交付物">
          <p className={w.h2}>交付物{board?.pending.length ? <span className={w.sub2}>v{board.nextVersion} 在攒 {board.pending.length} 样</span> : null}</p>
          <div className={w.embed} data-board-deliverable>
            <style>{`[data-board-deliverable] .${d.fold}{display:none}`}</style>
            <TaskDeliverable task={task} activities={null} activityCount={0} />
          </div>
        </section>
        <section className={w.grp} aria-label="worker">
          <p className={w.h2}>worker <span className={w.c}>{workers.length}</span></p>
          <div className={w.list}>{sorted.length ? sorted.map((worker) => <WorkerRow key={worker.key} worker={worker} now={now} onOpen={() => onOpenWorker(worker.key)} onChanged={onChanged} />) : <div className={w.emp}>—</div>}</div>
        </section>
        <div className={w.rowActs}>
          {workers.some((worker) => worker.kind === "plan") ? null : <HeroButton variant="secondary" size="sm" onPress={onSplit}>拆一下</HeroButton>}
          <HeroButton variant="primary" size="sm" onPress={onDispatch}>派活</HeroButton>
        </div>
      </>)}
    </>
  );
}

function WorkerDetail({ worker, roles, now, wrap, onChanged }: { worker: Worker; roles: RoleListResponse | null; now: number; wrap: (children: React.ReactNode) => React.ReactNode; onChanged: () => void }) {
  const role = roles?.roles.find((entry) => entry.id === worker.role.id) ?? null;
  const mark = marker(worker);
  const minutes = worker.startedAt ? `${Math.max(0, Math.round(((worker.endedAt ? Date.parse(worker.endedAt) : now) - Date.parse(worker.startedAt)) / 60_000))} 分` : null;
  const resource = worker.state === "queued" ? ["本机", worker.model, worker.queuePos ? `排第 ${worker.queuePos}` : null]
    : [resourceText(worker), worker.device, minutes, worker.costUsd !== null ? money(worker.costUsd) : null];
  const href = worker.cardId ? `/me/cards/${encodeURIComponent(worker.cardId)}` : worker.topicId ? `/me/topics/${encodeURIComponent(worker.topicId)}` : null;
  const local = useLocalRunner();
  // 这台电脑上的会话：开工时说的在哪做、排队的原因。
  const { view } = useSessionEvents(local.runner, worker.session?.id ?? null);
  return (
    <>
      <div className={w.dtHead}>
        {worker.taskName ? <span className={w.crumb}>{worker.taskName}</span> : null}
        <h2 className={w.h1}>{worker.title}</h2>
        <div className={w.st}><Chain state={worker.state} /><span>{worker.role.name} #{worker.seq} · {CHAIN_LABEL[worker.state]}</span>{mark ? <span className={w.mk} data-tone={mark.tone}>{mark.text}</span> : null}</div>
      </div>
      {wrap(<>
        <AskRow worker={worker} onChanged={onChanged} boxed={false} />
        <dl className={w.kv}>
          <dt>在干</dt><dd>{worker.doing ?? (worker.state === "queued" ? (worker.waitingFor ? waitingText(worker.waitingFor) : view.queuedBecause ?? "还没开始") : "—")}</dd>
          <dt>资源</dt><dd>{resource.filter(Boolean).join(" · ") || "—"}</dd>
          {worker.workspace ? <><dt>在哪</dt><dd>{view.place ?? placeText(worker.workspace)}</dd></>
            : worker.git ? <><dt>在哪</dt><dd>分支 {worker.git.branch}</dd></> : null}
          {worker.git ? <><dt>提交</dt><dd>{commitText(worker.git)}</dd></> : null}
          <dt>岗位</dt><dd>{role ? `${role.name} · 第 ${role.version} 版` : worker.role.name}</dd>
        </dl>
        {worker.cardId ? <CardExtras cardId={worker.cardId} worker={worker} onChanged={onChanged} /> : null}
        <MergeAction session={worker.session} title={worker.title} accepted={worker.state === "done"} onChanged={onChanged} />
        {href ? <div className={w.rowActs}><Link href={href} className={w.mchip}>打开完整会话</Link></div> : null}
      </>)}
    </>
  );
}

/** 卡的计划、最近的动静、产出、逐条验收（仍然通过、推翻在云端，手机上也能做）。 */
function CardExtras({ cardId, worker, onChanged }: { cardId: string; worker: Worker; onChanged: () => void }) {
  const { detail, refresh } = useCardDetail(cardId);
  const run = detail?.runs[0] ?? null;
  const handback = detail?.handbacks[0] ?? null;
  const changed = () => { void refresh(); onChanged(); };
  const plan = run?.planEntries ?? [];
  const timeline = run?.timeline.slice(-5).reverse() ?? [];
  return (
    <>
      {plan.length ? (
        <section className={w.grp} aria-label="计划">
          <p className={w.h2}>计划{worker.step ? <span className={w.sub2}>第 {worker.step.n}/{worker.step.total} 步</span> : null}</p>
          <ul className={w.plan}>{plan.map((entry, index) => <li key={index} data-status={entry.status}><Chain state={entry.status === "completed" ? "done" : entry.status === "in_progress" ? "doing" : "queued"} size="xs" />{entry.content}</li>)}</ul>
        </section>
      ) : null}
      {timeline.length ? (
        <section className={w.grp} aria-label="最近">
          <p className={w.h2}>最近</p>
          <ul className={w.evs}>{timeline.map((entry, index) => <li key={index}><time>{new Date(entry.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}</time>{entry.text}</li>)}</ul>
        </section>
      ) : null}
      {detail?.outputs.length ? (
        <section className={w.grp} aria-label="产出">
          <p className={w.h2}>产出</p>
          {detail.outputs.map((output) => (
            <div key={output.id} className={w.output}>
              <span>{output.title}</span>
              {output.kind === "artifact" ? <a href={`/api/me/local-outputs/${encodeURIComponent(output.id)}`} target="_blank" rel="noopener" className={w.link}>打开</a>
                : output.url ? <a href={output.url} target="_blank" rel="noopener noreferrer" className={w.link}>打开</a> : null}
            </div>
          ))}
        </section>
      ) : null}
      {handback && detail ? <Acceptance cardId={cardId} handback={handback} canOverrule deliverable={deliverableLabel(detail.task)} onChanged={changed} /> : null}
    </>
  );
}
