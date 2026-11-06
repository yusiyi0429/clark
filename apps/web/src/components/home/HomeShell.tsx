"use client";

/**
 * 新首页 /me/work（新首页_伙伴总管线与Task管线_2026-11-07，替换 V2 设计第 20.4 节的三栏首页），按人打开：
 * - 左：伙伴形象（点了进总管线，进去后换成「回到首页」）+ Task 树（Task 下缩进是子会话）。
 * - 中：展示区，五种内容——首页、总管线、Task 管线、子会话、Task 详情（地址决定，见 view.ts）。
 * - 右：后台任务，跟着展示区走，可以收成细条。
 * 手机：首屏是左栏（伙伴、等你、Task 树），点进去全屏；后台任务从页头的图标打开，是底部抽屉。
 *
 * 伙伴的动效：在左上角和总管线页头之间用共享元素过渡（280ms 缓出），开了「减少动态效果」就直接切。
 * 切换展示区用 history.pushState（Next 会同步 usePathname），不等服务端，动效才连得上；每个地址也都有页面，刷新照样打开。
 *
 * 云端不指挥本机（第 4.4 条）：开子会话、开规划员都由这台电脑上开着的网页去拉起本机程序——
 * Task 管线里选「就按这个开始」马上开；在手机上开始、或网页没开时排成「等开工」的卡和拆卡登记，下次在电脑上打开就自己开，不用点。
 * 伙伴在这个标签页的回复里「登记拆卡」、本机又连着，就直接开规划员；验收没过的改法由这里自动对执行的会话说一句（useAutoReturn）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronLeft, ListTodo } from "lucide-react";
import type { THomePlanTask } from "@warmap/contracts";
import type { Account } from "@/components/AccountMenu";
import { useBuddy } from "@/components/buddy/useBuddy";
import { CardSession } from "@/components/cards/CardSession";
import { TopicSession } from "@/components/topics/TopicSession";
import { ShellToast } from "@/components/rail/V2Shell";
import { WorkspaceContext, type WorkspaceApi } from "@/components/shell/WorkspaceContext";
import { useHandheld } from "@/components/ui/useHandheld";
import { LocalRunnerProvider, useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { planStartRequest, readLast, startTopic } from "@/lib/local/start";
import { useAutoReturn } from "@/lib/board/useAutoReturn";
import { claimStarts, listSplits, registerSplit, releaseStart, removeSplit, routeMessage } from "@/lib/board/cloud";
import { gateOf, gateText } from "@/components/board/MonthLanes";
import { showWorkspaceToast } from "@/lib/toast";
import { modelForTier } from "@/lib/team/roles";
import { startBatch, startedText, type StartPlan } from "@/lib/work/queue";
import type { Worker } from "@/lib/work/workers";
import { HOME_HREF, routeText } from "@/lib/home/derive";
import type { BackgroundItem, RouteTarget } from "@/lib/home/types";
import { useBackground } from "@/lib/home/useBackground";
import { useWorkHome } from "@/lib/home/useWorkHome";
import { BackgroundPanel, BackgroundStrip } from "./BackgroundPanel";
import { BuddyView, PipelineView, type Outbox } from "./Conversations";
import { HomeView, WaitingList, type SendTarget } from "./HomeView";
import { LeftColumn } from "./LeftColumn";
import { TaskInfo } from "./TaskInfo";
import { ViewChrome, scopeOf, viewOf, type View } from "./view";
import h from "@/styles/home.module.css";

const PANEL_KEY = "tianshu-home-panel-v1";
/** 伙伴这一轮调了「登记拆卡」（useConversation 发出）。 */
const SPLIT_EVENT = "card-split-registered";
const FLIGHT_MS = 280;
/** 认领到了开不起来、放回去以后，隔一会再认领；树上一直挂着要开工的，也隔一会再看一次（别处认领了又没开、过期了）。 */
const CLAIM_RETRY_MS = 60_000;
const FLIGHT_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const ICON = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;

export function HomeShell({ account }: { account: Account }) {
  return (
    <LocalRunnerProvider>
      <HomeFrame account={account} />
      <ShellToast />
    </LocalRunnerProvider>
  );
}

function HomeFrame({ account }: { account: Account }) {
  const router = useRouter();
  const pathname = usePathname();
  const view = viewOf(pathname);
  const handheld = useHandheld();
  const local = useLocalRunner();
  const { buddy } = useBuddy();
  const api = useWorkHome();
  const { data, work } = api;
  const [panelOpen, setPanelOpen] = useState(true);
  const [sheet, setSheet] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [outbox, setOutbox] = useState<Outbox>(null);
  const outboxId = useRef(0);

  // 右栏：记住本人上次开没开；没记过时 1280 以下默认收起。
  useEffect(() => {
    try { const saved = localStorage.getItem(PANEL_KEY); setPanelOpen(saved ? saved === "open" : window.innerWidth >= 1280); } catch { setPanelOpen(window.innerWidth >= 1280); }
  }, []);
  const togglePanel = (open: boolean) => { setPanelOpen(open); try { localStorage.setItem(PANEL_KEY, open ? "open" : "closed"); } catch { /* 下次按宽度 */ } };
  useEffect(() => { setSheet(false); }, [pathname]);
  useEffect(() => {
    if (!sheet) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setSheet(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [sheet]);

  // ---- 切展示区和伙伴的飞行 ----
  const flight = useRef<DOMRect | null>(null);
  const go = useCallback((href: string) => {
    if (!href.startsWith("/me/work")) { router.push(href); return; }
    if (href === window.location.pathname) return;
    const into = viewOf(href).kind === "buddy";
    if (into !== (viewOf(window.location.pathname).kind === "buddy")) {
      flight.current = document.querySelector(`[data-buddy-figure="${into ? "left" : "head"}"]`)?.getBoundingClientRect() ?? null;
    }
    window.history.pushState(null, "", href);
  }, [router]);
  useLayoutEffect(() => {
    const from = flight.current;
    flight.current = null;
    if (!from || handheld || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const target = document.querySelector<HTMLElement>(`[data-buddy-figure="${view.kind === "buddy" ? "head" : "left"}"]`);
    if (!target) return;
    const to = target.getBoundingClientRect();
    if (!to.width || !from.width) return;
    const scale = from.width / to.width;
    target.animate([
      { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${scale})`, transformOrigin: "0 0" },
      { transform: "none", transformOrigin: "0 0" },
    ], { duration: FLIGHT_MS, easing: FLIGHT_EASE });
  }, [view.kind, handheld]);

  // ---- 首页输入框：自动（只在管线之间选：伙伴或某件 Task）、伙伴、某件 Task；跳进那条对话，那边发出去 ----
  // 自动走 B 的 POST /api/me/route（只按关键词）；接口没上时网页按同样的规则自己分。
  const tasks = useMemo(() => work.plan?.tasks ?? [], [work.plan]);
  const route = useCallback(async (text: string): Promise<RouteTarget> => {
    if (api.live) { const answer = await routeMessage(text).catch(() => null); if (answer) return answer.target; }
    return routeText(text, tasks);
  }, [api.live, tasks]);
  const send = useCallback(async (text: string, target: SendTarget) => {
    const resolved = target === "auto" ? await route(text) : target;
    outboxId.current += 1;
    setOutbox({ id: outboxId.current, target: resolved === "main" ? "main" : resolved.taskId, text });
    go(resolved === "main" ? "/me/work/buddy" : `/me/work/tasks/${encodeURIComponent(resolved.taskId)}`);
  }, [route, go]);
  const consume = useCallback((id: number) => setOutbox((current) => (current?.id === id ? null : current)), []);

  // ---- 开规划员、开卡（一次交给本机）----
  const here = local.phase === "ready" && !handheld;
  const changed = useCallback(() => { void api.refresh(); }, [api]);
  /** 一批交给本机：开了哪几张卡（卡 id）。 */
  const start = useCallback(async (cards: Worker[], planners: { taskId: string; splitId?: string }[]): Promise<Set<string>> => {
    const opened = new Set<string>();
    const cwd = local.folders.find((folder) => folder.id === readLast().folderId)?.path ?? local.folders[0]?.path;
    if (!cwd && cards.length) { showWorkspaceToast({ text: "先在插件页加一个文件夹" }); return opened; }
    const roles = work.roles?.roles ?? [];
    const plans: StartPlan[] = cards.flatMap((worker) => {
      const role = roles.find((entry) => entry.id === worker.role.id) ?? null;
      const model = local.models.find((entry) => entry.id === worker.item?.card?.model?.id) ?? modelForTier(local.models, role?.modelTier ?? "normal");
      return model && worker.item && cwd ? [{ item: worker.item, model, cwd, role }] : [];
    });
    // 拆卡登记先认领再开（B 的契约）：删成了才算这个标签页的，别的标签页、别的电脑删不成就不开；开不起来（含整批出错）再登记回去。
    const claimed = (await Promise.all(planners.map(async (job) => {
      if (!job.splitId) return job;
      try { await removeSplit(job.splitId); return job; } catch { return null; }
    }))).filter((job): job is NonNullable<typeof job> => !!job);
    const giveBack = (jobs: { taskId: string; splitId?: string }[]) => Promise.all(jobs.map((job) => (job.splitId ? registerSplit(job.taskId).catch(() => undefined) : undefined)));
    try {
      const jobs = (await Promise.all(claimed.map(async (job) => {
        try { return { ...job, request: await planStartRequest(job.taskId, local.models, cwd) }; } catch { return { ...job, request: null }; }
      })));
      const ready = jobs.filter((job): job is typeof job & { request: NonNullable<typeof job.request> } => !!job.request);
      const result = await startBatch(local.runner, plans, ready.map((job) => job.request));
      plans.forEach((plan, index) => { if (result.opened[index]) opened.add(plan.item.id); });
      const missed = [...jobs.filter((job) => !job.request), ...ready.filter((_, index) => !result.opened[plans.length + index])];
      await giveBack(missed);
      await local.refresh();
      if (plans.length || claimed.length) showWorkspaceToast({ text: startedText({ ...result, failed: result.failed + jobs.length - ready.length }) });
      changed();
    } catch (error) {
      await giveBack(claimed);
      showWorkspaceToast({ text: error instanceof Error ? error.message : "没开起来，请重试" });
      changed();
    }
    return opened;
  }, [local, work.roles, changed]);
  const split = useCallback(async (taskId: string) => {
    if (here) { await start([], [{ taskId }]); return; }
    try { await registerSplit(taskId); showWorkspaceToast({ text: "拆卡 · 等开工" }); changed(); }
    catch (error) { showWorkspaceToast({ text: error instanceof Error ? error.message : "没成功，请重试" }); }
  }, [here, start, changed]);

  // 等开工的卡和拆卡登记：这台电脑连着本机时自己开（每件只试一次，没开成的照旧等开工）。
  // 同一台电脑开着几个标签页时排着来（Web Locks），轮到时先读本机现在的会话，已经有会话的卡不再开。
  // B 的「登记 + 认领」在时（live），登记了要开工的卡和专题走下面的认领；这里开拆卡登记（照旧：先删登记，删成了才开），
  // 和没登记、等开工的卡（派活单在这台电脑上马上开、有几张没开起来的，再试一次）。
  const subs = useMemo(() => [...data.missions.flatMap((mission) => mission.tasks.flatMap((task) => task.subSessions)), ...data.other.subSessions], [data]);
  const autoStartKey = subs.filter((sub) => sub.autoStart).map((sub) => sub.id).sort().join(",");
  const tried = useRef(new Set<string>());
  useEffect(() => {
    if (!here) return;
    const claimable = new Set(autoStartKey ? autoStartKey.split(",") : []);
    const waiting = work.workers.filter((worker) => worker.reason === "start" && !tried.current.has(worker.key)
      && ((worker.kind === "card" && worker.item && !(api.live && worker.cardId && claimable.has(worker.cardId))) || worker.splitId));
    if (!waiting.length) return;
    waiting.forEach((worker) => tried.current.add(worker.key));
    const run = async () => {
      const sessions = await local.runner.listSessions().catch(() => local.sessions);
      const busy = new Set(sessions.flatMap((session) => (session.subject.kind === "card" && session.subject.cardId ? [session.subject.cardId] : [])));
      const cards = waiting.filter((worker) => worker.item && !busy.has(worker.item.id));
      const planners = waiting.flatMap((worker) => (worker.splitId && worker.taskId ? [{ taskId: worker.taskId, splitId: worker.splitId }] : []));
      if (cards.length || planners.length) await start(cards, planners);
    };
    void (typeof navigator !== "undefined" && navigator.locks ? navigator.locks.request("tianshu-auto-start", run) : run());
  }, [here, api.live, autoStartKey, work.workers, start, local.runner, local.sessions]);

  // 自动开工（第 4.4 节，B 的契约）：树上有登记了要开工的子会话，就在这台配对的电脑上认领（一条只给一处），认领到的交给本机；
  // 开不起来的放回去（release），隔一会再认领。已经在这台电脑上跑着的不再开。没加文件夹、没有模型时开不起来，先不认领。
  // 只在要开工的那几个变了、或隔一会时再看（不跟着每次刷新）。
  const claiming = useRef(false);
  const latest = useRef({ workers: work.workers, subs, start, local, changed });
  useEffect(() => { latest.current = { workers: work.workers, subs, start, local, changed }; });
  const [claimTick, setClaimTick] = useState(0);
  const canOpen = local.folders.length > 0 && local.models.length > 0;
  useEffect(() => {
    const deviceId = api.deviceId;
    if (!here || !api.live || !deviceId || !canOpen || !autoStartKey || claiming.current) return;
    claiming.current = true;
    const run = async () => {
      const { workers, subs, start, local, changed } = latest.current;
      const claimed = (await claimStarts(deviceId).catch(() => null))?.starts ?? [];
      if (!claimed.length) return;
      const sessions = await local.runner.listSessions().catch(() => local.sessions);
      const busy = new Set(sessions.flatMap((session) => [session.subject.cardId, session.subject.topicId].filter((id): id is string => !!id)));
      const cards = claimed.flatMap((entry) => {
        const worker = entry.kind === "card" && entry.cardId && !busy.has(entry.cardId) ? workers.find((candidate) => candidate.cardId === entry.cardId && candidate.item) : undefined;
        return worker ? [worker] : [];
      });
      const opened = cards.length ? await start(cards, []) : new Set<string>();
      const model = local.models.find((entry) => entry.isDefault) ?? local.models[0];
      for (const entry of claimed) {
        if (entry.kind !== "topic" || !entry.topicId || busy.has(entry.topicId) || !model) continue;
        const title = subs.find((sub) => sub.id === entry.topicId)?.title ?? "";
        try { await startTopic(local.runner, { id: entry.topicId, title }, model); opened.add(entry.topicId); } catch { /* 放回去 */ }
      }
      const done = (id: string | null) => !!id && (opened.has(id) || busy.has(id));
      await Promise.all(claimed.filter((entry) => !done(entry.cardId ?? entry.topicId)).map((entry) => releaseStart(entry.id).catch(() => undefined)));
      if (opened.size) { await local.refresh(); changed(); }
    };
    let retry = 0;
    void (typeof navigator !== "undefined" && navigator.locks ? navigator.locks.request("tianshu-auto-start", run) : run())
      .finally(() => { claiming.current = false; retry = window.setTimeout(() => setClaimTick((n) => n + 1), CLAIM_RETRY_MS); });
    return () => window.clearTimeout(retry);
  }, [here, api.live, api.deviceId, canOpen, autoStartKey, claimTick]);

  // 伙伴在这个标签页的回复里登记了拆卡：这一轮之前没见过的登记，本机连着就直接开规划员。
  const knownSplits = useRef(new Set<string>());
  useEffect(() => { work.splits.forEach((request) => knownSplits.current.add(request.id)); }, [work.splits]);
  const onSplitEvent = useRef<() => Promise<void>>(async () => undefined);
  useEffect(() => {
    onSplitEvent.current = async () => {
      const fresh = (await listSplits().catch(() => [])).filter((request) => !knownSplits.current.has(request.id));
      fresh.forEach((request) => { knownSplits.current.add(request.id); tried.current.add(`split:${request.id}`); });
      if (here && fresh.length) await start([], fresh.map((request) => ({ taskId: request.taskId, splitId: request.id })));
      else changed();
    };
  });
  useEffect(() => {
    const handler = () => { void onSplitEvent.current(); };
    window.addEventListener(SPLIT_EVENT, handler);
    return () => window.removeEventListener(SPLIT_EVENT, handler);
  }, []);
  const allCards = useMemo(() => Object.values(work.boards).flatMap((board) => board.cards), [work.boards]);
  useAutoReturn(local.runner, here, allCards, local.sessions, changed);

  // ---- 后台任务 ----
  const [stopped, setStopped] = useState<ReadonlySet<string>>(() => new Set());
  const items = useBackground(scopeOf(view), api, stopped);
  const running = items.filter((item) => item.state === "running" || item.state === "queued").length;
  const model = local.models.find((entry) => entry.isDefault)?.label ?? local.models[0]?.label ?? null;
  // 规划员、验收员停会话；子 agent、后台命令只停那一项，会话接着做。
  const stop = async (item: BackgroundItem) => {
    if (!item.sessionId) return;
    try {
      if ((item.kind === "subagent" || item.kind === "command") && item.itemId) await local.runner.stopBackground(item.sessionId, item.itemId);
      else { await local.runner.kill(item.sessionId); setStopped((current) => new Set(current).add(item.sessionId!)); }
      await local.refresh();
      changed();
    }
    catch (error) { showWorkspaceToast({ text: error instanceof Error ? error.message : "没停下，请重试" }); }
  };
  const panel = (extra: { onCollapse?: () => void; onClose?: () => void }) => (
    <BackgroundPanel items={items} resources={work.resources} model={model} onStop={stop} {...extra} />
  );

  const workspace: WorkspaceApi = useMemo(() => ({
    navigate: (href: string) => go(href), close: () => undefined, detailOpen: false, closing: false, registerDetail: () => undefined,
    showToast: (text: string) => showWorkspaceToast({ text }), homeCards: [], quote: () => undefined, compose: () => undefined, viewerId: account.personId ?? null,
  }), [go, account.personId]);

  // ---- 展示区 ----
  const homeTask = (taskId: string) => data.missions.flatMap((mission) => mission.tasks).find((task) => task.taskId === taskId) ?? null;
  // 本月计划里的 Task 带标准；之前月份没了结、留在树上的（B 的 work-home 才有）只有名字和一行小字。
  const planTask = (taskId: string): THomePlanTask | null => {
    const found = tasks.find((task) => task.taskId === taskId);
    if (found) return found;
    const home = homeTask(taskId);
    return home ? { taskId, missionId: home.missionId, name: home.name, doneDefinition: home.subtitle, criteria: [] } : null;
  };
  const chrome = useMemo(() => (handheld ? {
    lead: <button type="button" className={h.icon} aria-label="返回" onClick={() => go(HOME_HREF)} data-testid="phone-back"><ChevronLeft {...ICON} /></button>,
    trail: <button type="button" className={h.icon} aria-label="后台任务" onClick={() => setSheet(true)} data-testid="phone-background"><ListTodo {...ICON} />{running ? <em className={h.badge}>{running}</em> : null}</button>,
  } : { lead: null, trail: null }), [handheld, go, running]);
  const display = (current: View) => {
    switch (current.kind) {
      case "home": return <HomeView data={data} api={api} buddy={buddy} loading={!api.ready} go={go} route={route} onSend={send} />;
      case "buddy": return <BuddyView buddy={buddy} outbox={outbox} consume={consume} onSpeaking={setSpeaking} />;
      case "task": {
        const task = planTask(current.taskId);
        return task ? <PipelineView key={task.taskId} task={task} home={homeTask(task.taskId)} api={api} buddy={buddy} outbox={outbox} consume={consume} go={go} onSplit={(taskId) => void split(taskId)} />
          : <Missing loading={!api.ready} onGone={() => { if (outbox?.target === current.taskId) consume(outbox.id); }} />;
      }
      case "info": {
        const task = planTask(current.taskId);
        if (!task) return <Missing loading={!api.ready} />;
        const mission = data.missions.find((entry) => entry.missionId === task.missionId)?.title ?? null;
        return <TaskInfo task={task} mission={mission} gate={work.plan ? gateText(gateOf(work.plan, task.missionId)) : null} go={go} />;
      }
      case "card": return <CardSession key={current.id} cardId={current.id} embedded />;
      case "topic": return <TopicSession key={current.id} topicId={current.id} embedded />;
    }
  };

  const left = (
    <LeftColumn data={data} view={view} buddy={buddy} speaking={speaking} go={go} phone={handheld} account={account}
      top={handheld && data.waiting.length ? (
        <section aria-label="等你" className={h.phoneWaiting}>
          <p className={h.sectionTitle}>等你 <span>{data.waiting.length}</span></p>
          <WaitingList items={data.waiting} api={api} go={go} />
        </section>
      ) : null} />
  );

  if (handheld) {
    return (
      <WorkspaceContext.Provider value={workspace}>
        <ViewChrome.Provider value={chrome}>
          <div className={h.app} data-phone="" data-view={view.kind} data-testid="work-home">
            {view.kind === "home" ? <aside className={h.left}>{left}</aside> : <main className={h.display}>{display(view)}</main>}
            {sheet ? (
              <div className={h.sheetBackdrop} onClick={() => setSheet(false)}>
                <div className={h.sheet} role="dialog" aria-modal="true" aria-label="后台任务" onClick={(event) => event.stopPropagation()}>
                  <span className={h.grabber} aria-hidden />
                  {panel({})}
                </div>
              </div>
            ) : null}
          </div>
        </ViewChrome.Provider>
      </WorkspaceContext.Provider>
    );
  }
  return (
    <WorkspaceContext.Provider value={workspace}>
      <ViewChrome.Provider value={chrome}>
        <div className={h.app} data-panel={panelOpen ? "open" : "closed"} data-view={view.kind} data-testid="work-home">
          <aside className={h.left}>{left}</aside>
          <main className={h.display}>{display(view)}</main>
          <aside className={h.right} aria-label="后台任务">
            {panelOpen ? panel({ onCollapse: () => togglePanel(false) }) : <BackgroundStrip running={running} onExpand={() => togglePanel(true)} />}
          </aside>
        </div>
      </ViewChrome.Provider>
    </WorkspaceContext.Provider>
  );
}

function Missing({ loading, onGone }: { loading: boolean; onGone?: () => void }) {
  useEffect(() => { if (!loading) onGone?.(); }, [loading, onGone]);
  return <div className={h.missing} aria-busy={loading || undefined}>{loading ? null : <p>没有这件 Task</p>}</div>;
}
