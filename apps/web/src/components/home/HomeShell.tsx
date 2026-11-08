"use client";

/**
 * 新首页 /me/work（新首页_伙伴总管线与Task管线_2026-11-07，替换 V2 设计第 20.4 节的三栏首页），按人打开：
 * - 左：四个锚点——伙伴台（总管线）、「今天」行（首页）、Mission → Task → 子会话、本人行（个人菜单），见 LeftColumn。
 * - 中：展示区——首页、总管线、Task 管线、Task 详情、子会话、二级页、月份页（地址决定，见 view.ts）。
 * - 右：资源和后台任务，跟着展示区走，可以收成细条。
 * 手机：首屏兼首页（伙伴台、今天、等你、树、本人），点进去全屏；后台任务从「今天」行和页头的按钮打开，是底部抽屉。
 * 深色按「偏好 · 外观」（跟随系统 / 浅色 / 深色，17.2）：外壳带 data-scheme="auto"，深色变量挂在根上（app/scheme-dark.css）；
 * 外观存在服务端，进首页、切回这个标签页时读一次（useAppearance）。伙伴不飞走，一直在台上（设计 9.2）。
 * 切换展示区用 history.pushState（Next 会同步 usePathname），不等服务端；每个地址也都有页面，刷新照样打开。
 *
 * 云端不指挥本机（第 4.4 条）：开子会话、开规划员都由这台电脑上开着的网页去拉起本机程序——
 * Task 管线里选「就按这个开始」马上开；在手机上开始、或网页没开时排成「等开工」的卡和拆卡登记，下次在电脑上打开就自己开，不用点。
 * 伙伴在这个标签页的回复里「登记拆卡」、本机又连着，就直接开规划员；验收没过的改法由这里自动对执行的会话说一句（useAutoReturn）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft, ListChecks, LoaderCircle } from "lucide-react";
import type { THomePlanTask, TLocalPermissionMode } from "@warmap/contracts";
import type { Account } from "@/components/AccountMenu";
import { useBuddy } from "@/components/buddy/useBuddy";
import { CardSession } from "@/components/cards/CardSession";
import { TopicSession } from "@/components/topics/TopicSession";
import { ShellToast } from "@/components/rail/V2Shell";
import { WorkspaceContext, type WorkspaceApi } from "@/components/shell/WorkspaceContext";
import { LocalRunnerProvider, useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { planStartRequest, readLast, startTopic } from "@/lib/local/start";
import { useAutoReturn } from "@/lib/board/useAutoReturn";
import { cancelStart, claimStarts, listSplits, planKey, registerPlan, releaseStart, removeSplit, routeMessage, type PlanTarget } from "@/lib/board/cloud";
import { gateOf, gateText } from "@/components/board/MonthLanes";
import { showWorkspaceToast } from "@/lib/toast";
import { modelForTier } from "@/lib/team/roles";
import { startBatch, type StartPlan } from "@/lib/work/queue";
import type { Worker } from "@/lib/work/workers";
import { HOME_HREF, buddyTargetHref, emptyMonth, monthLabel, routeText, todayLabel } from "@/lib/home/derive";
import { HeroButton } from "@/components/HeroButton";
import type { BackgroundItem, RouteTarget } from "@/lib/home/types";
import { useBackground } from "@/lib/home/useBackground";
import { useWorkHome } from "@/lib/home/useWorkHome";
import { BackgroundPanel, BackgroundStrip, useMachine } from "./BackgroundPanel";
import { BuddyView, PipelineView, type Outbox, type OutboxEntry } from "./Conversations";
import { HomeComposer, HomeView, WaitingList, type SendTarget } from "./HomeView";
import { LeftColumn, SubLetter, subKey, subLetters } from "./LeftColumn";
import { ForeignTaskInfo, TaskInfo } from "./TaskInfo";
import { MissionInfo } from "./MissionInfo";
import { ProjectInfo } from "./ProjectInfo";
import { GoalBar, ProjectTrail } from "./ProjectParts";
import { TransferFlow, TransferView } from "./Transfer";
import type { TimedBlock } from "@/components/work/WorkTimeline";
import { useProjects } from "./useProjects";
import { projectHref, projectWorking, type Project } from "@/lib/home/projects";
import { usePhone } from "./usePhone";
import { ViewChrome, PAGE_TITLE, monthHref, scopeOf, viewOf, type View } from "./view";
import { MONTH_PAGE, SECONDARY_PAGES, type SecondaryPageProps } from "./pages";
import { useHomeArrival } from "@/components/onboarding/useHomeArrival";
import { ICON } from "./StateIcon";
import { useTabTitle } from "./useTabTitle";
import h from "@/styles/home.module.css";
import { linkPerson } from "@/lib/local/link";
import { useAppearance } from "@/lib/appearance";
import { useBuddyUi } from "@/lib/buddy/uiEvent";
import { useSessionStops } from "@/lib/buddy/sessionStops";

/** 要开的规划员：拆哪个，登记的 id 和存下的原话（登记回去时用）。 */
type PlanJob = PlanTarget & { splitId?: string; sourceWords?: string[] };

const PANEL_KEY = "tianshu-home-panel-v1";
/** 伙伴这一轮调了「登记拆卡」（useConversation 发出）。 */
const SPLIT_EVENT = "card-split-registered";
/** 认领到了开不起来、放回去以后，隔一会再认领；树上一直挂着要开工的，也隔一会再看一次（别处认领了又没开、过期了）。 */
const CLAIM_RETRY_MS = 60_000;
/** 认领到了、但看板和 worker 还没刷新到这张卡（放回去了）：很快再认领一次，不等一分钟。 */
const CLAIM_SOON_MS = 3_000;

export function HomeShell({ account }: { account: Account }) {
  return (
    <LocalRunnerProvider person={linkPerson(account)}>
      <HomeFrame account={account} />
      <ShellToast />
    </LocalRunnerProvider>
  );
}

function HomeFrame({ account }: { account: Account }) {
  const router = useRouter();
  const pathname = usePathname();
  const view = viewOf(pathname);
  // 手机排布只看宽度（≤959）；平板横放、触屏电脑照样三栏，也照样能开本机程序（5.4.1、5.7）。
  const handheld = usePhone();
  const local = useLocalRunner();
  const { buddy } = useBuddy();
  const api = useWorkHome();
  useAppearance();
  // 进门的那一下（19.4）：从登录页进来（?_entry=unlock）整页淡入；平时直接打开不淡入。
  const entering = useHomeArrival();
  const { data, work } = api;
  const [panelOpen, setPanelOpen] = useState(true);
  const [sheet, setSheet] = useState(false);
  // 抽屉收起有 160ms 的出场（5.7），放完再拿掉。
  const [sheetClosing, setSheetClosing] = useState(false);
  const closeSheet = useCallback(() => {
    setSheetClosing(true);
    window.setTimeout(() => { setSheet(false); setSheetClosing(false); }, 160);
  }, []);
  const [speaking, setSpeaking] = useState(false);
  const [outbox, setOutbox] = useState<Outbox>([]);
  /** 从 Mission 详情点「问伙伴」带进总管线的上下文（输入框左上角「关于：{Mission}」胶囊，14.2、14.5）。 */
  const [buddyContext, setBuddyContext] = useState<string | null>(null);
  const outboxId = useRef(0);

  // 右栏：记住本人上次开没开；没记过时 1280 以下默认收起。
  useEffect(() => {
    try { const saved = localStorage.getItem(PANEL_KEY); setPanelOpen(saved ? saved === "open" : window.innerWidth >= 1280); } catch { setPanelOpen(window.innerWidth >= 1280); }
  }, []);
  const togglePanel = (open: boolean) => { setPanelOpen(open); try { localStorage.setItem(PANEL_KEY, open ? "open" : "closed"); } catch { /* 下次按宽度 */ } };
  useEffect(() => { setSheet(false); }, [pathname]);
  // 换了展示区的内容：焦点落到页头上（5.2 交互状态）。新内容自己抢了焦点（选项框、输入框）就不动；第一次打开页面不动。
  const firstPath = useRef(true);
  useEffect(() => {
    if (firstPath.current) { firstPath.current = false; return; }
    const frame = window.requestAnimationFrame(() => {
      const main = document.querySelector("main");
      if (main?.contains(document.activeElement) && document.activeElement !== main) return;
      main?.querySelector<HTMLElement>('h1[tabindex="-1"]')?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);
  useEffect(() => {
    if (!sheet) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") closeSheet(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [sheet, closeSheet]);

  // ---- 切展示区：新首页里的地址 pushState，离开新首页（老页面、M2）整页跳 ----
  const go = useCallback((href: string) => {
    if (!href.startsWith("/me/work")) { router.push(href); return; }
    // 带锚点的（Task 管线里某个框，14.3）：同一件 Task 换个框也要换地址，管线据此定位。
    if (href === window.location.pathname + window.location.hash) return;
    window.history.pushState(null, "", href);
    if (href.includes("#")) window.dispatchEvent(new HashChangeEvent("hashchange"));
  }, [router]);
  // Esc 回首页（「今天」行）：菜单、弹层、抽屉、输入框里的 Esc 由它们自己处理，这里只接没人要的。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || handheld) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=\"true\"], [role=dialog], [role=menu], [role=listbox]")) return;
      go(HOME_HREF);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, handheld]);

  // ---- 项目（第 16 节）：首页 v2 的 projects，增改调项目接口（useProjects）----
  const projects = useProjects(data, api.refresh);
  const projectOfTask = (taskId: string) => projects.all.find((project) => project.goals.some((goal) => goal.taskId === taskId)) ?? null;
  // ---- 首页输入框：自动（只在伙伴和各项目之间选，16.4）、伙伴、某个项目；跳进那条对话，那边发出去 ----
  // 自动走 B 的 POST /api/me/route（只按关键词：项目名、挂着的 Task 名和标准）；接口没上时网页按同样的规则自己分。
  const tasks = useMemo(() => work.plan?.tasks ?? [], [work.plan]);
  const route = useCallback(async (text: string): Promise<RouteTarget> => {
    if (api.live) { const answer = await routeMessage(text).catch(() => null); if (answer) return answer.target; }
    return routeText(text, data.projects);
  }, [api.live, data.projects]);
  const send = useCallback(async (text: string, target: SendTarget, files: File[]) => {
    const resolved = target === "auto" ? await route(text) : target;
    outboxId.current += 1;
    // 每句排在队里，按对话各发各的：连着发、或那条对话正在回话时，前一句不会被后一句顶掉。
    const entry: OutboxEntry = { id: outboxId.current, target: resolved === "main" ? "main" : resolved.projectId, text, files };
    setOutbox((queue) => [...queue, entry]);
    go(resolved === "main" ? "/me/work/buddy" : projectHref(resolved.projectId));
  }, [route, go]);
  const consume = useCallback((id: number) => setOutbox((queue) => queue.filter((entry) => entry.id !== id)), []);

  // ---- 开规划员、开卡（一次交给本机）----
  const here = local.phase === "ready" && !handheld;
  // 伙伴代本人做事（17.4）：界面上的效果——打开某一处、首页那几块重读（外观由 useAppearance 接）；「请这台电脑停掉」由这台电脑认领。
  useBuddyUi((effect) => {
    if (effect.kind === "open") go(buddyTargetHref(effect.target));
    if (effect.kind === "refresh" && effect.what.some((what) => what === "work_home" || what === "project" || what === "sub_session")) void api.refresh();
  });
  useSessionStops(local, here);
  const changed = useCallback(() => { void api.refresh(); }, [api]);
  /**
   * 这个标签页里自动开工没开起来的子会话（卡 id、专题 id）：Task 管线里那一行出「失败」加「手动开始」（5.4.3、9.8，手动开始只有这一处），
   * 不弹提示。开起来了、或换了文件夹和模型（自动再试）就去掉。
   */
  const [startFailed, setStartFailed] = useState<ReadonlySet<string>>(() => new Set());
  const markStart = useCallback((ids: string[], failed: boolean) => {
    if (!ids.length) return;
    setStartFailed((current) => {
      const next = new Set(current);
      ids.forEach((id) => (failed ? next.add(id) : next.delete(id)));
      return next.size === current.size && ids.every((id) => current.has(id) === failed) ? current : next;
    });
  }, []);
  /**
   * 一批交给本机：开了哪几张卡（卡 id）。没开起来时 onError 接着（拆卡写在管线里「拆卡失败 · 重试」）；
   * 没给 onError 的（自动开工）记进 startFailed，在管线里那一行写「失败 · 手动开始」。
   */
  const start = useCallback(async (cards: Worker[], planners: PlanJob[], onError?: () => void, modes?: Map<string, TLocalPermissionMode>): Promise<Set<string>> => {
    const opened = new Set<string>();
    const cardIds = cards.flatMap((worker) => (worker.item ? [worker.item.id] : []));
    const cwd = local.folders.find((folder) => folder.id === readLast().folderId)?.path ?? local.folders[0]?.path;
    if (!cwd && cards.length) { if (onError) onError(); else markStart(cardIds, true); if (!planners.length) return opened; cards = []; }
    const tryIds = cards.flatMap((worker) => (worker.item ? [worker.item.id] : []));
    const roles = work.roles?.roles ?? [];
    const plans: StartPlan[] = cards.flatMap((worker) => {
      const role = roles.find((entry) => entry.id === worker.role.id) ?? null;
      const model = local.models.find((entry) => entry.id === worker.item?.card?.model?.id) ?? modelForTier(local.models, role?.modelTier ?? "normal");
      return model && worker.item && cwd ? [{ item: worker.item, model, cwd, role, permissionMode: modes?.get(worker.item.id) }] : [];
    });
    // 拆卡登记先认领再开（B 的契约）：删成了才算这个标签页的，别的标签页、别的电脑删不成就不开；开不起来（含整批出错）再登记回去。
    const claimed = (await Promise.all(planners.map(async (job) => {
      if (!job.splitId) return job;
      try { await removeSplit(job.splitId); return job; } catch { return null; }
    }))).filter((job): job is NonNullable<typeof job> => !!job);
    // 登记回去时带上原来存的原话（16.8），不然新登记的原话是空的。
    const giveBack = (jobs: PlanJob[]) => Promise.all(jobs.map((job) => (job.splitId ? registerPlan(job, job.sourceWords?.join("\n\n")).catch(() => undefined) : undefined)));
    try {
      const jobs = (await Promise.all(claimed.map(async (job) => {
        try { return { ...job, request: await planStartRequest(job, local.models, cwd) }; } catch { return { ...job, request: null }; }
      })));
      const ready = jobs.filter((job): job is typeof job & { request: NonNullable<typeof job.request> } => !!job.request);
      const result = await startBatch(local.runner, plans, ready.map((job) => job.request));
      plans.forEach((plan, index) => { if (result.opened[index]) opened.add(plan.item.id); });
      const missed = [...jobs.filter((job) => !job.request), ...ready.filter((_, index) => !result.opened[plans.length + index])];
      await giveBack(missed);
      markStart([...opened], false);
      const notOpened = tryIds.filter((id) => !opened.has(id));
      if (notOpened.length) { if (onError) onError(); else markStart(notOpened, true); }
      await local.refresh();
      changed();
    } catch {
      await giveBack(claimed);
      if (onError) onError();
      else markStart(tryIds, true);
      changed();
    }
    return opened;
  }, [local, work.roles, changed, markStart]);
  /** 拆卡登记没成的那件 Task（或没挂 Task 的项目，planKey）：项目对话里出「拆卡失败 · 重试」（不弹 toast）。 */
  const [splitFailed, setSplitFailed] = useState<string | null>(null);
  const split = useCallback(async (target: PlanTarget) => {
    setSplitFailed(null);
    if (here) { await start([], [target], () => setSplitFailed(planKey(target))); return; }
    try { await registerPlan(target); changed(); }
    catch { setSplitFailed(planKey(target)); }
  }, [here, start, changed]);

  // 等开工的卡和拆卡登记：这台电脑连着本机时自己开（每件只试一次，没开成的写在管线里「失败 · 手动开始」）。
  // 同一台电脑开着几个标签页时排着来（Web Locks），轮到时先读本机现在的会话，已经有会话的卡不再开。
  // 云端接口在不在还不知道时不开（不知道该不该认领）。B 的「登记 + 认领」在时（live），卡和专题只走下面的认领（一条只给一处：
  // 别的电脑认领了、还没报上来的卡在这里也是「等开工」，不能不认领就开）；这里只开拆卡登记（照旧：先删登记，删成了才开）。
  // 接口没上（404）时照旧：没登记、等开工的卡也在这里开。
  const subs = useMemo(() => [...data.projects.flatMap((project) => project.subSessions), ...data.other.subSessions], [data]);
  const autoStartKey = subs.filter((sub) => sub.autoStart).map((sub) => sub.id).sort().join(",");
  const tried = useRef(new Set<string>());
  useEffect(() => {
    if (!here || !api.known) return;
    const waiting = work.workers.filter((worker) => worker.reason === "start" && !tried.current.has(worker.key)
      && ((!api.live && worker.kind === "card" && worker.item) || worker.splitId));
    if (!waiting.length) return;
    waiting.forEach((worker) => tried.current.add(worker.key));
    const run = async () => {
      const sessions = await local.runner.listSessions().catch(() => local.sessions);
      const busy = new Set(sessions.flatMap((session) => (session.subject.kind === "card" && session.subject.cardId ? [session.subject.cardId] : [])));
      const cards = waiting.filter((worker) => worker.item && !busy.has(worker.item.id));
      const planners = waiting.flatMap((worker): PlanJob[] => (!worker.splitId ? [] : worker.taskId ? [{ taskId: worker.taskId, splitId: worker.splitId, sourceWords: worker.sourceWords }]
        : worker.projectId ? [{ projectId: worker.projectId, splitId: worker.splitId, sourceWords: worker.sourceWords }] : []));
      if (cards.length || planners.length) await start(cards, planners);
    };
    void (typeof navigator !== "undefined" && navigator.locks ? navigator.locks.request("tianshu-auto-start", run) : run());
  }, [here, api.known, api.live, work.workers, start, local.runner, local.sessions]);

  // 自动开工（第 4.4 节，B 的契约）：树上有登记了要开工的子会话，就在这台配对的电脑上认领（一条只给一处），认领到的交给本机；
  // 开不起来的放回去（release），隔一会再认领。已经在这台电脑上跑着的不再开。没有模型时开不起来，先不认领；
  // 专题不要文件夹（本机给它建专用目录）：没加文件夹时卡开不起来（记成「失败 · 手动开始」），专题照开。
  // 认领到的卡在看板、worker 里还没刷新到（首页接口比看板先报）：放回去，3 秒后再认领，不等一分钟。
  // 只在要开工的那几个变了、或隔一会时再看（不跟着每次刷新）；认领进行中要开工的又变了，认领完马上再看一次。
  const claiming = useRef(false);
  const latest = useRef({ workers: work.workers, subs, start, local, changed, autoStartKey, reload: api.refresh });
  useEffect(() => { latest.current = { workers: work.workers, subs, start, local, changed, autoStartKey, reload: api.refresh }; });
  const [claimTick, setClaimTick] = useState(0);
  const canOpen = local.models.length > 0;
  useEffect(() => {
    const deviceId = api.deviceId;
    if (!here || !api.live || !deviceId || !canOpen || !autoStartKey || claiming.current) return;
    claiming.current = true;
    let soon = false;
    const run = async () => {
      const claimed = (await claimStarts(deviceId).catch(() => null))?.starts ?? [];
      if (!claimed.length) return;
      const sessions = await latest.current.local.runner.listSessions().catch(() => latest.current.local.sessions);
      const busy = new Set(sessions.flatMap((session) => [session.subject.cardId, session.subject.topicId].filter((id): id is string => !!id)));
      const find = (cardId: string) => latest.current.workers.find((candidate) => candidate.cardId === cardId && candidate.item);
      const wanted = claimed.flatMap((entry) => (entry.kind === "card" && entry.cardId && !busy.has(entry.cardId) ? [entry.cardId] : []));
      // 认领到的卡还没在读到的看板里（首页接口比看板先报、或是之前月份的 Task）：当场把看板和 worker 读来再开，不先放掉。
      if (wanted.some((cardId) => !find(cardId))) {
        await latest.current.reload();
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
      const { subs, start, local, changed } = latest.current;
      const cards = wanted.flatMap((cardId) => {
        const worker = find(cardId);
        if (!worker) soon = true;
        return worker ? [worker] : [];
      });
      // 认领到的带着所在项目新开子会话的默认档（Project.permissionMode），原样给本机。
      const modes = new Map(claimed.flatMap((entry) => (entry.cardId ? [[entry.cardId, entry.permissionMode] as const] : [])));
      const opened = cards.length ? await start(cards, [], undefined, modes) : new Set<string>();
      const model = local.models.find((entry) => entry.isDefault) ?? local.models[0];
      for (const entry of claimed) {
        if (entry.kind !== "topic" || !entry.topicId || busy.has(entry.topicId) || !model) continue;
        const title = subs.find((sub) => sub.id === entry.topicId)?.title ?? "";
        try { await startTopic(local.runner, { id: entry.topicId, title }, model, undefined, entry.permissionMode); opened.add(entry.topicId); markStart([entry.topicId], false); }
        catch { markStart([entry.topicId], true); }
      }
      const done = (id: string | null) => !!id && (opened.has(id) || busy.has(id));
      await Promise.all(claimed.filter((entry) => !done(entry.cardId ?? entry.topicId)).map((entry) => releaseStart(entry.id, deviceId).catch(() => undefined)));
      if (opened.size) { await local.refresh(); changed(); }
      else if (soon) changed();
    };
    const key = autoStartKey;
    let retry = 0;
    void (typeof navigator !== "undefined" && navigator.locks ? navigator.locks.request("tianshu-auto-start", run) : run())
      .finally(() => {
        claiming.current = false;
        const delay = latest.current.autoStartKey !== key ? 0 : soon ? CLAIM_SOON_MS : CLAIM_RETRY_MS;
        retry = window.setTimeout(() => setClaimTick((n) => n + 1), delay);
      });
    return () => window.clearTimeout(retry);
  }, [here, api.live, api.deviceId, canOpen, autoStartKey, claimTick, markStart]);
  // 换了文件夹或模型（比如没开成以后去连接页加了文件夹）：没开成的再自动试一次。
  const setupKey = `${local.folders.map((folder) => folder.id).join(",")}|${local.models.map((entry) => entry.id).join(",")}`;
  const lastSetup = useRef(setupKey);
  useEffect(() => {
    if (lastSetup.current === setupKey) return;
    lastSetup.current = setupKey;
    tried.current.clear();
    setStartFailed(new Set());
    setClaimTick((n) => n + 1);
  }, [setupKey]);
  /** 「手动开始」：只开这一个（卡交给本机、专题照专题开），没开起来照旧写「失败」。 */
  const manualStart = useCallback(async (subId: string) => {
    const { workers, subs } = latest.current;
    const worker = workers.find((candidate) => candidate.cardId === subId && candidate.item);
    if (worker) { await start([worker], []); return; }
    const sub = subs.find((entry) => entry.id === subId && entry.kind === "topic");
    const model = local.models.find((entry) => entry.isDefault) ?? local.models[0];
    if (!sub || !model) { markStart([subId], true); return; }
    try { await startTopic(local.runner, { id: sub.id, title: sub.title }, model); markStart([subId], false); await local.refresh(); changed(); }
    catch { markStart([subId], true); }
  }, [start, markStart, changed, local]);

  // 伙伴在这个标签页的回复里登记了拆卡：这一轮之前没见过的登记，本机连着就直接开规划员。
  const knownSplits = useRef(new Set<string>());
  useEffect(() => { work.splits.forEach((request) => knownSplits.current.add(request.id)); }, [work.splits]);
  const onSplitEvent = useRef<() => Promise<void>>(async () => undefined);
  useEffect(() => {
    onSplitEvent.current = async () => {
      const fresh = (await listSplits().catch(() => [])).filter((request) => !knownSplits.current.has(request.id));
      fresh.forEach((request) => { knownSplits.current.add(request.id); tried.current.add(`split:${request.id}`); });
      const planners = fresh.flatMap((request): PlanJob[] => (request.taskId ? [{ taskId: request.taskId, splitId: request.id, sourceWords: request.sourceWords }]
        : request.projectId ? [{ projectId: request.projectId, splitId: request.id, sourceWords: request.sourceWords }] : []));
      if (here && planners.length) await start([], planners);
      else changed();
    };
  });
  useEffect(() => {
    const handler = () => { void onSplitEvent.current(); };
    window.addEventListener(SPLIT_EVENT, handler);
    return () => window.removeEventListener(SPLIT_EVENT, handler);
  }, []);
  const allCards = useMemo(() => Object.values(work.boards).flatMap((board) => board.cards), [work.boards]);
  const cardAt = useMemo(() => new Map(allCards.map((card) => [card.id, card.createdAt])), [allCards]);
  useAutoReturn(local.runner, here, allCards, local.sessions, changed);

  // ---- 后台任务 ----
  const items = useBackground(scopeOf(view), api);
  const machine = useMachine(work.resources.quota);
  const running = items.filter((item) => item.state === "running" || item.state === "queued").length;
  // 规划员、验收员停会话；子 agent、后台命令只停那一项，会话接着做。
  const stop = async (item: BackgroundItem) => {
    if (!item.sessionId) return;
    if ((item.kind === "subagent" || item.kind === "command") && item.itemId) await local.runner.stopBackground(item.sessionId, item.itemId);
    else await local.runner.kill(item.sessionId);
    await local.refresh();
    changed();
  };
  const panel = (extra: { onCollapse?: () => void; onClose?: () => void }) => (
    <BackgroundPanel items={items} resources={work.resources} onStop={stop} handheld={handheld} {...extra} />
  );

  const workspace: WorkspaceApi = useMemo(() => ({
    navigate: (href: string) => go(href), close: () => undefined, detailOpen: false, closing: false, registerDetail: () => undefined,
    showToast: (text: string) => showWorkspaceToast({ text }), homeCards: [], quote: () => undefined, compose: () => undefined, viewerId: account.personId ?? null,
  }), [go, account.personId]);

  // 「今天」行行尾的月份 chip（5.4.2）：云端等你里月份那一条优先——复盘窗口里写「复盘」，新月份的草稿到了写「12 月待敲定」（「延续到哪」只在等你里）；
  // 没有时，树上没有本月的 Mission 就写「11 月待敲定」（网页按本月比较推出来）。点了进月份页。
  const monthItem = data.waiting.find((item) => item.kind === "month" && item.month && item.month.step !== "continue")?.month ?? null;
  const empty = monthItem ? null : emptyMonth(work.plan?.today ?? null, data.month.missions);
  const month = monthItem ? { href: monthHref(monthItem.period), label: monthItem.step === "review" ? "复盘" : `${monthLabel(monthItem.period)}待敲定` }
    : empty ? { href: monthHref(empty), label: `${monthLabel(empty)}待敲定` } : null;

  // ---- 展示区 ----
  // 本月计划里的 Task 带完成定义；之前月份没了结、挂在项目上的（B 的 work-home 才有）照项目上的目标拼。
  const planTask = (taskId: string): THomePlanTask | null => {
    const found = tasks.find((task) => task.taskId === taskId);
    if (found) return found;
    const goal = data.projects.flatMap((project) => project.goals).find((entry) => entry.taskId === taskId);
    return goal ? { taskId, missionId: goal.missionId, name: goal.name, doneDefinition: null, criteria: goal.criteria } : null;
  };
  // 手机的后台任务按钮（5.7）：没有在跑的是 ListChecks；有在跑的是转圈加数字。
  const backgroundButton = useMemo(() => (
    <button type="button" className={h.icon} aria-label="后台任务" title="后台任务" onClick={() => setSheet(true)} data-testid="phone-background">
      {running ? <span className={h.runningCount}><LoaderCircle {...ICON} />{running}</span> : <ListChecks {...ICON} />}
      {/* 这个按钮只在手机上：这台电脑没连上不亮点，额度（云端各设备报的）快用完照样亮（11.2）。 */}
      {machine.quotaAlert ? <i className={h.cornerDot} data-tone={machine.quotaAlert === "danger" ? "danger" : undefined} aria-hidden /> : null}
    </button>
  ), [running, machine.quotaAlert]);
  // 子会话页头的上一级：它在哪个项目里，点了回到项目对话。
  const subId = view.kind === "card" || view.kind === "topic" ? view.id : null;
  const owner = subId ? projects.all.find((project) => project.subSessions.some((sub) => sub.id === subId)) ?? null : null;
  const parent = useMemo(() => (owner ? (
    <button type="button" className={h.crumb} onClick={() => go(projectHref(owner.id))}>{owner.name} / </button>
  ) : null), [owner, go]);
  // 标题前面的字母方块（18.10），和左栏那一行同一个字母；「其他」里的在那一组里排。
  const siblings = subId ? owner?.subSessions ?? (data.other.subSessions.some((sub) => sub.id === subId) ? data.other.subSessions : null) : null;
  const letterText = siblings && (view.kind === "card" || view.kind === "topic") ? subLetters(siblings, cardAt).get(subKey({ kind: view.kind, id: view.id })) ?? null : null;
  const letter = useMemo(() => (letterText ? <SubLetter letter={letterText} inline /> : null), [letterText]);
  const chrome = useMemo(() => (handheld ? {
    lead: <button type="button" className={h.icon} aria-label="返回" title="返回" onClick={() => go(HOME_HREF)} data-testid="phone-back"><ArrowLeft {...ICON} /></button>,
    trail: backgroundButton, parent, letter,
  } : { lead: null, trail: null, parent, letter }), [handheld, go, backgroundButton, parent, letter]);
  useTabTitle(data.waiting.length);
  /** 转交时选了「停掉」：这台电脑上在跑的经本机程序停，云端还排着、没有电脑接下的撤掉登记（别的电脑上在跑的只能在那台电脑上停）。 */
  const stopForTransfer = async (subs: Project["subSessions"]) => {
    const here = new Set(local.sessions.map((session) => session.id));
    for (const sub of subs) {
      if (sub.sessionId && here.has(sub.sessionId)) await local.runner.kill(sub.sessionId);
      else if (sub.state === "queued" && !sub.sessionId) await cancelStart(sub.kind, sub.id);
    }
    await local.refresh();
  };
  /** 项目对话里项目自己的几块：转交（16.7）从「准备交接」那一刻起，到发出、等接手。 */
  const projectBlocks = (project: Project): TimedBlock[] => (project.transfer && (project.transfer.status === "preparing" || project.transfer.status === "sent") ? [{
    key: `transfer:${project.transfer.id}`, at: project.transfer.startedAt, afterSequence: project.transfer.afterSequence,
    node: <TransferFlow project={project} transfer={project.transfer} onChanged={api.refresh} onStop={stopForTransfer} />,
  }] : []);
  /** 项目对话（16.3）：页头项目名、文件夹 chip、「详情」，下面目标条。没挂 Task 的项目也在自己的对话里拆卡、开工。 */
  const projectView = (project: Project) => {
    const goalTasks = project.goals.flatMap((goal) => { const task = planTask(goal.taskId); return task ? [task] : []; });
    const trail = <ProjectTrail project={project} go={go} />;
    return <PipelineView key={project.id} project={project} tasks={goalTasks} api={api} buddy={buddy} outbox={outbox} consume={consume} go={go} onSplit={(target) => void split(target)} splitFailed={splitFailed}
      startFailed={startFailed} onManualStart={(id) => void manualStart(id)} onSpeaking={setSpeaking} trail={trail} bar={<GoalBar project={project} />} blocks={projectBlocks(project)}
      onPulled={() => void projects.actions.reloadFolders()} />;
  };
  const display = (current: View) => {
    switch (current.kind) {
      case "home": return <HomeView data={data} api={api} buddy={buddy} today={todayLabel(work.plan?.today ?? null)} go={go} route={route} onSend={send} projects={projects} />;
      case "project": {
        const project = projects.all.find((entry) => entry.id === current.id);
        if (!project) return <Missing loading={!api.ready} onRetry={api.planFailed ? () => void api.retryPlan() : undefined} />;
        return projectView(project);
      }
      case "projectInfo": {
        const project = projects.all.find((entry) => entry.id === current.id);
        if (!project) return <Missing loading={!api.ready} onRetry={api.planFailed ? () => void api.retryPlan() : undefined} />;
        return <ProjectInfo key={project.id} project={project} period={data.period} go={go} actions={projects.actions} doneDefinitionOf={(taskId) => planTask(taskId)?.doneDefinition ?? null}
          me={{ personId: account.personId ?? "", name: account.displayName }} />;
      }
      case "transfer": return <TransferView key={current.id} id={current.id} go={go} onChanged={api.refresh} />;
      case "buddy": return <BuddyView buddy={buddy} outbox={outbox} consume={consume} onSpeaking={setSpeaking} context={buddyContext} onClearContext={() => setBuddyContext(null)} />;
      case "mission": {
        const mission = data.month.missions.find((entry) => entry.missionId === current.id);
        if (!mission) return <Missing loading={!api.ready} onRetry={api.planFailed ? () => void api.retryPlan() : undefined} />;
        const cardId = work.plan?.missions.find((entry) => entry.missionId === current.id)?.cardId ?? null;
        return <MissionInfo key={mission.missionId} mission={mission} cardId={cardId} api={api} go={go} onAsk={() => { setBuddyContext(`关于：${mission.title}`); go("/me/work/buddy"); }} />;
      }
      case "task": {
        // 老地址（等你、飞书链接）：Task 挂在哪个项目上就画那个项目的对话。
        const project = projectOfTask(current.taskId);
        if (project) return projectView(project);
        const task = planTask(current.taskId);
        if (task) return <TaskInfo task={task} mission={data.month.missions.find((entry) => entry.missionId === task.missionId)?.title ?? null} gate={work.plan ? gateText(gateOf(work.plan, task.missionId)) : null} go={go} />;
        if (!api.ready) return <Missing loading={!api.planFailed} onRetry={api.planFailed ? () => void api.retryPlan() : undefined} />;
        // 不在本人的计划和项目上（别人的 Task：请你认可、飞书「请 X 看」；之前月份了结了的）：没有对话可看，去只读的详情（9.8、9.10）。
        return <ForeignTaskInfo key={current.taskId} taskId={current.taskId} go={go} redirect />;
      }
      case "info": {
        const task = planTask(current.taskId);
        if (!task && !api.ready) return <Missing loading={!api.planFailed} onRetry={api.planFailed ? () => void api.retryPlan() : undefined} />;
        if (!task) return <ForeignTaskInfo key={current.taskId} taskId={current.taskId} go={go} />;
        const mission = data.month.missions.find((entry) => entry.missionId === task.missionId)?.title ?? null;
        return <TaskInfo task={task} mission={mission} gate={work.plan ? gateText(gateOf(work.plan, task.missionId)) : null} go={go} />;
      }
      case "card": return <CardSession key={current.id} cardId={current.id} embedded />;
      case "topic": return <TopicSession key={current.id} topicId={current.id} embedded />;
      case "page": {
        // 二级页：组件挂在 components/home/pages。
        const Page = SECONDARY_PAGES[current.page];
        return <SecondaryFrame key={current.page} title={PAGE_TITLE[current.page]} go={go}><Page go={go} /></SecondaryFrame>;
      }
      case "month": {
        const Month = MONTH_PAGE;
        return <SecondaryFrame key={current.period} title={`${Number(current.period.slice(5))} 月`} go={go}>{Month ? <Month go={go} period={current.period} /> : null}</SecondaryFrame>;
      }
    }
  };
  // 连接要处理（本人行的琥珀点，设计 9.4）：这台电脑没就绪，或额度用完（≤10%）。飞书授权失效等 B 的字段到了再加。
  const alert = (!handheld && machine.alert) || machine.quotaAlert === "danger";
  // 正在后台干活的项目（左栏标题右边闪的灰点）：子会话在跑、规划员或验收员在做，或正开着的这个项目对话在回复。
  const working = useMemo(() => new Set(projects.projects
    .filter((project) => projectWorking(project, work.workers, speaking && view.kind === "project" && view.id === project.id))
    .map((project) => project.id)), [projects.projects, work.workers, speaking, view]);

  const left = (
    <LeftColumn data={data} view={view} buddy={buddy} speaking={speaking} go={go} phone={handheld} account={account} month={month} onRetryPlan={api.planFailed ? () => void api.retryPlan() : null}
      projects={projects.projects} archived={projects.archived} onCreate={(name) => projects.actions.create(name)} cardAt={cardAt} working={working}
      today={todayLabel(work.plan?.today ?? null)} alert={alert} trail={handheld ? backgroundButton : null}
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
          <div className={h.app} data-phone="" data-view={view.kind} data-scheme="auto" data-entering={entering ? "" : undefined} data-testid="work-home">
            {/* 首屏兼首页（5.7）：左栏那几样，底部固定首页的输入框（带「发给」）。 */}
            {view.kind === "home" ? <>
              <aside className={h.left}>{left}</aside>
              <div className={h.phoneComposer}><HomeComposer buddy={buddy} projects={projects.projects} route={route} onSend={send} /></div>
            </> : <main className={h.display}>{display(view)}</main>}
            {sheet ? (
              <div className={h.sheetBackdrop} data-closing={sheetClosing ? "" : undefined} onClick={closeSheet}>
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
        <div className={h.app} data-panel={panelOpen ? "open" : "closed"} data-view={view.kind} data-scheme="auto" data-entering={entering ? "" : undefined} data-testid="work-home">
          <aside className={h.left}>{left}</aside>
          <main className={h.display}>{display(view)}</main>
          <aside className={h.right} aria-label="后台任务">
            {panelOpen ? panel({ onCollapse: () => togglePanel(false) }) : <BackgroundStrip running={running} quota={work.resources.quota} onExpand={() => togglePanel(true)} />}
          </aside>
        </div>
      </ViewChrome.Provider>
    </WorkspaceContext.Provider>
  );
}

/** 二级页、月份页的壳（5.4.7）：页头（返回、标题）+ 文档类阅读尺，内容是挂进来的组件。 */
function SecondaryFrame({ title, go, children }: { title: string; go: (href: string) => void; children: React.ReactNode }) {
  return (
    <div className={h.page} data-type-scale="doc" data-testid="secondary-page">
      <header className={h.viewHead}>
        <button type="button" className={h.icon} aria-label="返回" title="返回" onClick={() => (window.history.length > 1 ? window.history.back() : go(HOME_HREF))}><ArrowLeft {...ICON} /></button>
        <h1 className={h.viewTitle} tabIndex={-1}>{title}</h1>
      </header>
      <div className={h.pageScroll}><div className={h.pageInner}>{children}</div></div>
    </div>
  );
}

/** 还在读（空着、aria-busy）；计划（本体）读不到时是「本体读取失败」加「重试」，和树上同一行（5.4.2、5.4.4）。 */
function Missing({ loading, onRetry }: { loading: boolean; onRetry?: () => void }) {
  return (
    <div className={h.missing} aria-busy={loading || undefined}>
      {onRetry ? <p className={h.planFailed}>本体读取失败<HeroButton variant="ghost" size="sm" onPress={onRetry}>重试</HeroButton></p> : null}
    </div>
  );
}
