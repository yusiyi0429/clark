"use client";

/**
 * 新首页 /me/work（V2 设计第 20.4 节，样子照 .scratch/next-phase/prototype-home），按人打开。三栏：
 * - 左：现有的通知栏原样放进来，最上面加一组「worker 等你」（等你批准、等你回复、验收没过、受阻、岗位修改建议，每条带按钮）。
 * - 中：和伙伴的主对话；派活单和三种小卡（验收结果、岗位修改建议、一单全部完成）由网页按时间插进对话；
 *   输入框上方是「关于：某 Task」；右栏收起时页头有「本机 ▮▮▯ · 进行中 2 · 已排队 1」；有等开工的卡时页头有「开工 N 件」。
 * - 右：worker / 本月两个标签和详情（可收起；960–1279 宽默认收起）。
 * 手机（≤959）底部三个标签：伙伴、worker、本月；「等你」在伙伴页顶部；详情全屏；本机上的事写「到电脑上处理」。
 * 对话锚到一个 Task 时地址是 /me/work/tasks/<id>（发消息时 pagePath 带着它）。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { X } from "lucide-react";
import type { Account } from "@/components/AccountMenu";
import { ActionNoticeCard, type ActionNotice } from "@/components/ActionNoticeCard";
import { HeroButton } from "@/components/HeroButton";
import type { NoticeOutcome } from "@/components/NoticeActions";
import { useBuddy } from "@/components/buddy/useBuddy";
import { MemberNoticeRail } from "@/components/member/MemberNoticeRail";
import { useHomePlan } from "@/components/member/home/useHomePlan";
import { useMemberHome } from "@/components/member/useMemberHome";
import { ChatPane } from "@/components/rail/ChatPane";
import { ShellToast } from "@/components/rail/V2Shell";
import { WorkspaceContext, type WorkspaceApi } from "@/components/shell/WorkspaceContext";
import { useHandheld } from "@/components/ui/useHandheld";
import { LocalRunnerProvider, useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { readLast } from "@/lib/local/start";
import { showWorkspaceToast } from "@/lib/toast";
import { FIELD_LABEL, decideProposal, modelForTier, type RoleProposalView } from "@/lib/team/roles";
import { canCommandHere, decide, overruleWorker, reply } from "@/lib/work/actions";
import { startBatch, startedText, type StartPlan } from "@/lib/work/queue";
import { useWork } from "@/lib/work/useWork";
import { MARK_LABEL, isWaiting, workerName, type Worker } from "@/lib/work/workers";
import { DispatchBlock, countsText } from "./DispatchBlock";
import { Slots, WorkPanel, type PanelTab, type PanelView } from "./WorkPanel";
import { AskText, RoleAvatar } from "./WorkerRow";
import { workNotes } from "./WorkNotes";
import { WorkTimeline, type TimedBlock } from "./WorkTimeline";
import w from "@/styles/v2-work.module.css";

const PANEL_KEY = "tianshu-work-panel-v1";
export const taskOfPath = (pathname: string) => {
  const match = /^\/me\/work\/tasks\/([^/]+)/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
};

export function WorkHome({ account, children }: { account: Account; children?: ReactNode }) {
  return (
    <LocalRunnerProvider>
      <WorkFrame account={account} />
      {children}
      <ShellToast />
    </LocalRunnerProvider>
  );
}

type PhoneTab = "buddy" | "worker" | "month";
const PANEL_ICON = <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><rect x="2" y="2.5" width="12" height="11" rx="2.5" /><path d="M10 2.5v11" /></svg>;
const TAB_ICONS: Record<PhoneTab, ReactNode> = {
  buddy: <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden><circle cx="10" cy="10" r="7.5" /><path d="M7.3 9v.6M12.7 9v.6" /></svg>,
  worker: <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden><rect x="3" y="3" width="14" height="14" rx="4" /><path d="M7 9v.6M13 9v.6M7.5 12.6c1.5 1 3.5 1 5 0" /></svg>,
  month: <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden><rect x="3" y="4" width="14" height="13" rx="3" /><path d="M3 8h14M7 2.5v3M13 2.5v3" /></svg>,
};

function WorkFrame({ account }: { account: Account }) {
  const router = useRouter();
  const pathname = usePathname();
  const handheld = useHandheld();
  const local = useLocalRunner();
  const { buddy } = useBuddy();
  const planHook = useHomePlan();
  const home = useMemberHome();
  const work = useWork({ planHook });
  const anchorTaskId = taskOfPath(pathname);
  const [panelOpen, setPanelOpen] = useState(true);
  const [tab, setTab] = useState<PanelTab>("worker");
  const [stack, setStack] = useState<PanelView[]>([]);
  const [phone, setPhone] = useState<PhoneTab>("buddy");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 15_000); return () => window.clearInterval(timer); }, []);
  // 右栏：记住本人上次开没开；没记过时 960–1279 宽默认收起。
  useEffect(() => {
    try { const saved = localStorage.getItem(PANEL_KEY); setPanelOpen(saved ? saved === "open" : window.innerWidth >= 1280); } catch { setPanelOpen(window.innerWidth >= 1280); }
  }, []);
  const togglePanel = (open: boolean) => { setPanelOpen(open); try { localStorage.setItem(PANEL_KEY, open ? "open" : "closed"); } catch { /* 下次按宽度 */ } };

  const anchor = useCallback((taskId: string | null) => router.replace(taskId ? `/me/work/tasks/${encodeURIComponent(taskId)}` : "/me/work", { scroll: false }), [router]);
  const open = useCallback((view: PanelView) => {
    setStack((current) => [...current, view]);
    setPanelOpen(true);
    if (view.kind === "task") anchor(view.taskId);
    if (handheld) setPhone(view.kind === "task" ? "month" : "worker");
  }, [anchor, handheld]);
  const openWorker = useCallback((key: string) => open({ kind: "worker", key }), [open]);
  const refresh = work.refresh;
  const changed = useCallback(() => { void refresh(); }, [refresh]);

  const api: WorkspaceApi = useMemo(() => ({
    navigate: (href: string) => router.push(href), close: () => undefined, detailOpen: false, closing: false, registerDetail: () => undefined,
    showToast: (text: string) => showWorkspaceToast({ text }), homeCards: [], quote: () => undefined, compose: () => undefined, viewerId: account.personId ?? null,
  }), [router, account.personId]);

  const tasks = useMemo(() => work.plan?.tasks ?? [], [work.plan]);
  const current = stack[stack.length - 1] ?? null;
  const currentCard = current?.kind === "worker" ? current.key : null;
  const blocks = useMemo<TimedBlock[]>(() => {
    const dispatch = tasks.flatMap((task) => {
      const board = work.boards[task.taskId];
      const mine = work.workers.filter((worker) => worker.taskId === task.taskId);
      if (!board || (!board.plan && !board.drafts.length && !mine.length)) return [];
      const at = board.plan?.finishedAt ?? board.plan?.createdAt ?? mine.map((worker) => worker.startedAt ?? worker.item?.createdAt ?? "").filter(Boolean).sort()[0];
      return at ? [{ task, board, mine, at }] : [];
    });
    const newest = dispatch.map((entry) => entry.at).sort().pop();
    return [
      ...dispatch.map(({ task, board, mine, at }) => ({ key: `dispatch:${task.taskId}`, at, node: (
        <DispatchBlock task={task} board={board} workers={mine} roles={work.roles?.roles ?? []} now={now} handheld={handheld} current={currentCard} newest={at === newest} onOpenWorker={openWorker} onChanged={changed} />
      ) })),
      ...workNotes({ workers: work.workers, tasks, boards: work.boards, proposals: work.proposals, now, on: { openWorker, openTask: (taskId) => open({ kind: "task", taskId }), changed } }),
    ];
  }, [tasks, work.boards, work.workers, work.roles, work.proposals, now, handheld, currentCard, openWorker, open, changed]);

  const active = work.workers.filter((worker) => worker.state !== "done");
  const toStart = work.workers.filter((worker) => worker.reason === "start" && worker.item);
  const waiting = work.workers.filter((worker) => isWaiting(worker.mark));
  const startAll = async () => {
    const cwd = local.folders.find((folder) => folder.id === readLast().folderId)?.path ?? local.folders[0]?.path;
    if (!cwd) { showWorkspaceToast({ text: "先在插件页加一个文件夹" }); return; }
    const plans: StartPlan[] = toStart.flatMap((worker) => {
      const role = work.roles?.roles.find((entry) => entry.id === worker.role.id) ?? null;
      const model = local.models.find((entry) => entry.id === worker.item?.card?.model?.id) ?? modelForTier(local.models, role?.modelTier ?? "normal");
      return model && worker.item ? [{ item: worker.item, model, cwd, role }] : [];
    });
    try {
      const result = await startBatch(local.runner, plans);
      await local.refresh();
      showWorkspaceToast({ text: startedText(result) });
      changed();
    } catch (error) { showWorkspaceToast({ text: error instanceof Error ? error.message : "没开起来，请重试" }); }
  };
  const anchored = tasks.find((task) => task.taskId === anchorTaskId) ?? null;
  const previous = stack[stack.length - 2] ?? null;
  const backLabel = previous ? (previous.kind === "task" ? tasks.find((task) => task.taskId === previous.taskId)?.name ?? "返回"
    : (() => { const worker = work.workers.find((entry) => entry.key === previous.key); return worker ? workerName(worker) : "返回"; })())
    : (handheld ? phone === "month" : tab === "month" || current?.kind === "task") ? "本月" : "worker";
  const showChip = !panelOpen || handheld;

  const chat = (
    <main className={w.centre} aria-label="伙伴">
      <header className={w.head}>
        <b>{buddy?.name?.trim() || "伙伴"}</b>
        {showChip ? (
          <button type="button" className={w.hchip} data-testid="resource-chip" onClick={() => (handheld ? setPhone("worker") : togglePanel(true))}>
            本机 <Slots used={work.resources.local.used} cap={work.resources.local.cap} off={!work.resources.local.online} />{active.length ? ` · ${countsText(active)}` : ""}
          </button>
        ) : <span className={w.grow} />}
        {toStart.length && local.phase === "ready" && !handheld ? <HeroButton variant="primary" size="sm" onPress={() => void startAll()}>开工 {toStart.length} 件</HeroButton> : null}
        {!panelOpen && !handheld ? <button type="button" className={w.iconBtn} aria-label="打开右栏" title="打开右栏" onClick={() => togglePanel(true)}>{PANEL_ICON}</button> : null}
      </header>
      <ChatPane buddy={buddy} variant="page"
        timeline={(data) => <>{handheld ? <PhoneWaiting workers={waiting} proposals={work.proposals} onChanged={changed} /> : null}<WorkTimeline data={data} blocks={blocks} /></>}
        above={anchored ? <span className={w.anchor} data-testid="task-anchor"><span>关于：{anchored.name}</span><button type="button" aria-label="去掉" onClick={() => anchor(null)}><X size={12} aria-hidden /></button></span> : null} />
    </main>
  );
  const panel = (
    <aside className={w.panel} aria-label="worker 和本月">
      <WorkPanel tab={handheld ? (phone === "month" ? "month" : "worker") : tab} onTab={(next) => { setTab(next); setStack([]); }} view={current} backLabel={backLabel} onOpen={open}
        onBack={() => setStack((list) => list.slice(0, -1))} onDispatch={(taskId) => { anchor(taskId); if (handheld) setPhone("buddy"); }}
        onCollapse={handheld ? undefined : () => { togglePanel(false); setStack([]); }} handheld={handheld} plan={work.plan} boards={work.boards} workers={work.workers}
        resources={work.resources} roles={work.roles} proposals={work.proposals} now={now} anchorTaskId={anchorTaskId} onChanged={changed} />
    </aside>
  );

  return (
    <WorkspaceContext.Provider value={api}>
      <div className={w.app} data-panel={panelOpen || handheld ? "open" : "closed"} data-phone={phone} data-testid="work-home">
        {handheld ? null : (
          <div className={w.left}>
            <MemberNoticeRail api={api} currentHref={pathname} home={home} plan={planHook} account={account} homeHref="/me/work"
              lead={<WaitingGroup workers={waiting} proposals={work.proposals} onOpen={openWorker} onChanged={changed} />}
              leadCount={waiting.length + work.proposals.length} />
          </div>
        )}
        {chat}
        {panelOpen || handheld ? panel : null}
        <nav className={w.phoneTabs} aria-label="切换">
          {([["buddy", "伙伴"], ["worker", "worker"], ["month", "本月"]] as const).map(([id, label]) => (
            <button key={id} type="button" aria-current={phone === id ? "page" : undefined} onClick={() => { setPhone(id); setStack([]); }}>
              {TAB_ICONS[id]}{label}{id === "buddy" && waiting.length + work.proposals.length ? <em>{waiting.length + work.proposals.length}</em> : null}
            </button>
          ))}
        </nav>
      </div>
    </WorkspaceContext.Provider>
  );
}

const outcome = async (action: () => Promise<void>, settled: string): Promise<NoticeOutcome> => {
  try { await action(); return { ok: true, settled }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : "没成功，请重试" }; }
};

/** 等你批准的那一行写成「开发 #1 要运行测试」那样：要做的事放标题，命令放下面。 */
const askTitle = (worker: Worker) => worker.mark === "approval" ? `${workerName(worker)} ${worker.ask ? `要${worker.ask.command ? "运行命令" : worker.ask.text}` : MARK_LABEL.approval}` : `${workerName(worker)} ${MARK_LABEL[worker.mark!]}`;

/** 左栏最上面一组「worker 等你」：等你批准、等你回复、验收没过、受阻，加岗位修改建议。每条带按钮。 */
function WaitingGroup({ workers, proposals, onOpen, onChanged }: { workers: Worker[]; proposals: RoleProposalView[]; onOpen: (key: string) => void; onChanged: () => void }) {
  const local = useLocalRunner();
  const handheld = useHandheld();
  const ready = local.phase === "ready";
  const notices: ActionNotice[] = workers.map((worker): ActionNotice => {
    const here = canCommandHere(worker, ready, handheld);
    const remote = (worker.mark === "approval" || worker.mark === "reply") && !here;
    return {
      id: `worker:${worker.key}`,
      title: askTitle(worker),
      detail: [worker.mark === "approval" && worker.ask?.command ? worker.ask.command : null, worker.title, remote ? "到电脑上处理" : null].filter(Boolean).join(" · "),
      tone: worker.mark === "approval" || worker.mark === "reply" ? "red" : "amber",
      onOpen: () => onOpen(worker.key),
      buttons: worker.mark === "approval" && here ? [
        { label: "批准", emphasis: true, run: () => outcome(() => decide(local.runner, worker, "allow"), "已批准") },
        { label: "拒绝", run: () => outcome(() => decide(local.runner, worker, "deny"), "已拒绝") },
      ] : [],
      reason: worker.mark === "reply" && here ? { label: "回复", fieldLabel: "回复", placeholder: "回复", submitLabel: "发送", run: (text) => outcome(() => reply(local.runner, worker, text), "已回复") }
        : worker.mark === "review_failed" ? { label: "仍然通过", fieldLabel: "原因", placeholder: "原因", submitLabel: "仍然通过", run: (text) => outcome(() => overruleWorker(worker, text), "已算通过") }
        : undefined,
    };
  }).concat(proposals.map((proposal): ActionNotice => ({
    id: `proposal:${proposal.id}`,
    title: `${proposal.role.name}的${FIELD_LABEL[proposal.field]}改一句`,
    detail: `岗位修改建议 · ${proposal.sourceKind === "overrule" ? "因为一次推翻" : "因为第二次没过"}`,
    tone: "neutral",
    onOpen: () => { window.location.assign("/me/team"); },
    buttons: [
      { label: "采纳", emphasis: true, run: () => outcome(() => decideProposal(proposal.id, "accept"), "已采纳") },
      { label: "不要", run: () => outcome(() => decideProposal(proposal.id, "dismiss"), "已丢掉") },
    ],
  })));
  return <ActionNoticeCard id="worker-wait" title="worker 等你" mark="decision" notices={notices} onSettled={() => { void local.refresh(); onChanged(); }} />;
}

/** 手机上「等你」放在伙伴页顶部：本机上的事写「到电脑上处理」；岗位修改建议在云端，能采纳、不要。 */
function PhoneWaiting({ workers, proposals, onChanged }: { workers: Worker[]; proposals: RoleProposalView[]; onChanged: () => void }) {
  if (!workers.length && !proposals.length) return null;
  return (
    <div className={w.pwait} data-testid="phone-waiting">
      <p className={w.h2}>等你 <span className={w.c}>{workers.length + proposals.length}</span></p>
      <div className={w.pcard}>
        {workers.map((worker) => (
          <div key={worker.key} className={w.ri}>
            <div className={w.t}><RoleAvatar name={worker.role.name} kind={worker.role.kind} size="s" /><span>{workerName(worker)} {worker.mark === "approval" ? <AskText worker={worker} /> : MARK_LABEL[worker.mark!]}</span></div>
            <div className={w.m}>{worker.title}</div>
            {worker.mark === "approval" || worker.mark === "reply" ? <div className={w.m}>到电脑上处理</div> : null}
          </div>
        ))}
        {proposals.map((proposal) => <PhoneProposal key={proposal.id} proposal={proposal} onChanged={onChanged} />)}
      </div>
    </div>
  );
}

function PhoneProposal({ proposal, onChanged }: { proposal: RoleProposalView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const decideIt = async (decision: "accept" | "dismiss") => {
    setBusy(true);
    try { await decideProposal(proposal.id, decision); showWorkspaceToast({ text: decision === "accept" ? "已采纳" : "已丢掉" }); onChanged(); }
    catch (error) { showWorkspaceToast({ text: error instanceof Error ? error.message : "没成功，请重试" }); }
    finally { setBusy(false); }
  };
  return (
    <div className={w.ri}>
      <div className={w.t}><RoleAvatar name={proposal.role.name} kind={proposal.role.kind} size="s" /><span>{proposal.role.name}的{FIELD_LABEL[proposal.field]}改一句</span></div>
      <div className={w.acts}>
        <HeroButton variant="primary" size="sm" isDisabled={busy} onPress={() => void decideIt("accept")}>采纳</HeroButton>
        <HeroButton variant="secondary" size="sm" isDisabled={busy} onPress={() => void decideIt("dismiss")}>不要</HeroButton>
      </div>
    </div>
  );
}
