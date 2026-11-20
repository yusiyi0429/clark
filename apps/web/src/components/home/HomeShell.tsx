"use client";

/**
 * 新首页 /me/work（新首页_伙伴总管线与Task管线_2026-11-07，替换 V2 设计第 20.4 节的三栏首页），按人打开：
 * - 左：伙伴名片（总管线）、「今天」「会议」「本月」、项目、本人行（个人菜单），见 LeftColumn；电脑上能收起（中间左上角的按钮）。
 * - 中：展示区——首页、总管线、Task 管线、Task 详情、子会话、二级页、月份页（地址决定，见 view.ts）。
 * - 右：平时没有（第 73 条）。要看时出一个面板，同一时间只放一样：会话详情（页头的信息按钮）、文件预览（含「改动」）、会话（页头右上角的按钮，设计 4.3：子会话、这台电脑、后台任务）、
 *   一个子会话的 thread（设计 6.6：项目对话里的小条、会话面板里的行点开，宽同文件预览）；
 *   再开一样就替掉前一样，关掉就完全没有；左边缘能拖宽。放大时面板占满中间和右边。
 * 手机：首屏兼首页（伙伴名片、今天、等你、树、本人），点进去全屏；会话从「今天」行和页头的按钮打开，是底部抽屉（会话列表，下面是这台电脑、后台任务）。
 * 深色按「偏好 · 外观」（跟随系统 / 浅色 / 深色，17.2）：外壳带 data-scheme="auto"，深色变量挂在根上（app/scheme-dark.css）；
 * 外观存在服务端，进首页、切回这个标签页时读一次（useAppearance）。
 * 切换展示区用 history.pushState（Next 会同步 usePathname），不等服务端；每个地址也都有页面，刷新照样打开。
 *
 * 云端不指挥本机（第 4.4 条）：开子会话、开规划员都由这台电脑上开着的网页去拉起本机程序——
 * Task 管线里选「就按这个开始」马上开；在手机上开始、或网页没开时排成「等开工」的卡和拆卡登记，下次在电脑上打开就自己开，不用点。
 * 伙伴在这个标签页的回复里「登记拆卡」、本机又连着，就直接开规划员；验收没过的改法由这里自动对执行的会话说一句（useAutoReturn）。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft, X } from "lucide-react";
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
import { cancelStart, claimStarts, createTopic, listSplits, markWorkSeen, planKey, registerPlan, releaseStart, removeSplit, routeMessage, type PlanTarget } from "@/lib/board/cloud";
import { dateGate, gateOf, gateText } from "@/components/board/MonthLanes";
import { showWorkspaceToast } from "@/lib/toast";
import { modelForTier } from "@/lib/team/roles";
import { startBatch, type StartPlan } from "@/lib/work/queue";
import type { Worker } from "@/lib/work/workers";
import { HOME_HREF, buddyTargetHref, emptyMonth, goalDueDate, monthLabel, routeText, subQueueText, taskGateLabel, todayLabel, topicHref } from "@/lib/home/derive";
import { NewSubView } from "./NewSub";
import { HeroButton } from "@/components/HeroButton";
import type { BackgroundItem, RouteTarget } from "@/lib/home/types";
import { useBackground } from "@/lib/home/useBackground";
import { useWorkHome } from "@/lib/home/useWorkHome";
import { useMachine } from "./BackgroundPanel";
import { SessionsButton, SessionsPanel, panelProject } from "./SessionsPanel";
import { BuddyView, PipelineView, type Outbox, type OutboxEntry } from "./Conversations";
import { HomeComposer, HomeView, HomeWaiting, type SendTarget } from "./HomeView";
import { PartnerMeetingsProvider } from "./PartnerMeetings";
import { usePartnerMeetings } from "@/lib/home/partnerMeetingFeed";
import { focusList } from "@/lib/home/focus";
import { isTeamDraft } from "./PartnerTeam";
import { TEAM_DELIVERY_CHANGED } from "@/lib/home/teamDelivery";
import { LeftColumn } from "./LeftColumn";
import { SeenContext, subIcon, type RowActions } from "./SubRows";
import { ThreadPane } from "./ThreadPane";
import { inCenter, threadOpener } from "./ThreadChip";
import { ForeignTaskInfo, TaskInfo } from "./TaskInfo";
import { MissionInfo } from "./MissionInfo";
import { MeetingView } from "./MeetingView";
import { ChatView } from "./ChatView";
import { MeetingsPage, meetingSections, nextMeetingTrail } from "./MeetingsPage";
import { ProjectInfo } from "./ProjectInfo";
import { ProjectTrail } from "./ProjectParts";
import { LeftResize, LeftToggle, RightResize, useFileWidth, useLeftCollapsed, useLeftDot, useLeftWidth, useRightWidth } from "./LeftResize";
import { SideDetailContext, type PanelKind, type SideDetail } from "./SideDetail";
import { seenKey, withSeen, type SeenKind, type SeenMarks } from "@/lib/home/seen";
import { seenSequence } from "@/lib/home/transfer";
import { claimTopic, projectIdOf, startFolder } from "@/lib/home/startFolder";
import { FolderAsk, ScratchFolders } from "./FolderAsk";
import { TransferFlow, TransferView } from "./Transfer";
import type { TimedBlock } from "@/components/work/WorkTimeline";
import { useProjects } from "./useProjects";
import { crumbProject, projectHref, projectWorking, type Project } from "@/lib/home/projects";
import { usePhone } from "./usePhone";
import { ViewChrome, PAGE_TITLE, monthHref, scopeOf, viewOf, type View } from "./view";
import { MONTH_PAGE, SECONDARY_PAGES, type MonthHead, type SecondaryPageProps } from "./pages";
import { useMonthExtras } from "./pages/monthLive";
import { useHomeArrival } from "@/components/onboarding/useHomeArrival";
import { NoEllipsis } from "@/lib/home/noEllipsis";
import { ICON } from "./StateIcon";
import { useTabTitle } from "./useTabTitle";
import { HomeMeetingProvider, MeetingControl, useHomeMeeting } from "./MeetingControl";
import h from "@/styles/home.module.css";
import { linkPerson } from "@/lib/local/link";
import { useAppearance } from "@/lib/appearance";
import { useBuddyUi } from "@/lib/buddy/uiEvent";
import { useSessionStops } from "@/lib/buddy/sessionStops";
import { useSessionCommands } from "@/lib/buddy/sessionCommands";

/** 要开的规划员：拆哪个，登记的 id 和存下的原话（登记回去时用）。 */
type PlanJob = PlanTarget & { splitId?: string; sourceWords?: string[] };

/** 伙伴这一轮调了「登记拆卡」（useConversation 发出）。 */
const SPLIT_EVENT = "card-split-registered";
/** 认领到了开不起来、放回去以后，隔一会再认领；树上一直挂着要开工的，也隔一会再看一次（别处认领了又没开、过期了）。 */
const CLAIM_RETRY_MS = 60_000;
/** 认领到了、但看板和 worker 还没刷新到这张卡（放回去了）：很快再认领一次，不等一分钟。 */
const CLAIM_SOON_MS = 3_000;

export function HomeShell({ account }: { account: Account }) {
  return (
    <LocalRunnerProvider person={linkPerson(account)}>
      <PartnerMeetingsProvider key={account.personId ?? account.loginId ?? account.displayName}>
        <HomeFrame account={account} />
      </PartnerMeetingsProvider>
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
  /** 月份页在复盘期间换的页头（「11 月复盘」和右边那几样）。 */
  const [monthHead, setMonthHead] = useState<MonthHead | null>(null);
  const outboxId = useRef(0);

  // 右边的面板位（第 73 条）：平时没有；详情、文件、会话、thread 同一时间只放一样，再开一样就替掉前一样，关掉就完全没有。
  // 详情跟着展示区走（换着看别的子会话、项目接着看那一个的详情，到了没有详情的页面就收起）；文件、thread 是那一页里点开的，换页就关；会话一直跟着。
  const [shown, setShown] = useState<PanelKind | null>(null);
  const [wide, setWide] = useState(false);
  const [sideNode, setSideNode] = useState<HTMLElement | null>(null);
  // from：从主线开的会话所在的项目名（伙伴主线上 thread 页头写「项目名 · 从主线开的」）。
  const [thread, setThread] = useState<{ kind: "card" | "topic"; id: string; from?: string } | null>(null);
  const sideView = view.kind === "card" || view.kind === "topic" || view.kind === "project";
  const slot = handheld || (shown === "detail" && !sideView) ? null : shown;
  const show = useCallback((kind: PanelKind | null) => { setShown(kind); setWide(false); }, []);
  useEffect(() => { setShown((current) => (current === "file" || current === "thread" ? null : current)); setWide(false); }, [pathname]);
  const side = useMemo<SideDetail | null>(() => (handheld ? null : {
    open: slot === "detail", node: slot === "detail" || slot === "file" ? sideNode : null, shown: slot, show, wide: slot === "file" && wide, setWide,
    toggle: (open) => { const next = open ?? slot !== "detail"; if (next) show("detail"); else if (slot === "detail") show(null); },
    openThread: (subject, from) => { if (inCenter(viewOf(pathname), subject)) return; setThread({ ...subject, from }); show("thread"); },
  }), [handheld, slot, sideNode, show, wide, pathname]);
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
  // 左栏行尾「…」菜单（35 条）。
  const { rename, archive, hide, remove, renameSub, archiveSub, removeSub } = projects.actions;
  const rowActions = useMemo<RowActions>(() => ({ renameProject: rename, archiveProject: archive, deleteProject: remove, hideProject: hide, renameSub, archiveSub, deleteSub: removeSub }),
    [rename, archive, hide, remove, renameSub, archiveSub, removeSub]);
  const projectOfTask = (taskId: string) => projects.all.find((project) => project.goals.some((goal) => goal.taskId === taskId)) ?? null;
  // ---- 首页输入框：自动（只在伙伴和各项目之间选，16.4）、伙伴、某个项目；跳进那条对话，那边发出去 ----
  // 自动走 B 的 POST /api/me/route（只按关键词：项目名、挂着的 Task 名和标准）；接口没上时网页按同样的规则自己分。
  const tasks = useMemo(() => work.plan?.tasks ?? [], [work.plan]);
  const route = useCallback(async (text: string): Promise<RouteTarget> => {
    if (api.live) { const answer = await routeMessage(text).catch(() => null); if (answer) return answer.target; }
    return routeText(text, data.projects);
  }, [api.live, data.projects]);
  const send = useCallback(async (text: string, target: SendTarget, files: File[]) => {
    const toTeam = target === "auto" || target === "main" ? isTeamDraft(text, files) : false;
    const resolved = toTeam ? "main" : target === "auto" ? await route(text) : target;
    // 每句排在本页的外送箱里，进了对应的对话就直接发出去（团队草稿交给伙伴收件人选择器）。
    const entry: OutboxEntry = { id: ++outboxId.current, target: resolved === "main" ? "main" : resolved.projectId, text, files, team: toTeam };
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
  useSessionCommands(local, here);
  // 左栏宽度（24 条）：本人拖过的写在根上的 --home-left，没拖过照 CSS 的 clamp。右边的面板同理（--home-right），放文件时另记一个宽（--home-file）。
  const leftWidth = useLeftWidth();
  const rightWidth = useRightWidth();
  const fileWidth = useFileWidth();
  // 蓝点「点了就藏」（25 条）：打开子会话、项目对话的那一刻记成「刚看过」（带那一刻的停下时间），左栏马上不画；work-seen 在后台发，失败不提示。
  // 左栏点行时在跳页之前记；别处打开的（等你、链接、改地址）在换页后、画出来之前记（layout effect），效果一样。开着时又来了更新的停下，也再记一次。
  const [seenMarks, setSeenMarks] = useState<SeenMarks>(() => new Map());
  const marksRef = useRef<SeenMarks>(seenMarks);
  const markSeen = useCallback((kind: SeenKind, id: string, marker: string | null) => {
    // 同一个、同一次停下记过了就不再记（点行时记过，换页后那一下就不重复发）。
    if (marksRef.current.get(seenKey(kind, id)) === (marker ?? "")) return;
    marksRef.current = withSeen(marksRef.current, kind, id, marker);
    setSeenMarks(marksRef.current);
    void markWorkSeen(kind, id).catch(() => undefined);
  }, []);
  const seenKind: SeenKind | null = view.kind === "card" || view.kind === "topic" ? "sub" : view.kind === "project" ? "project" : null;
  const seenId = seenKind ? (view as { id: string }).id : null;
  const seenMarker = seenKind === "project" ? projects.all.find((project) => project.id === seenId)?.lastActivity ?? null
    : seenKind === "sub" ? [...projects.all.flatMap((project) => project.subSessions), ...data.other.subSessions].find((sub) => sub.id === seenId)?.updatedAt ?? null : null;
  useLayoutEffect(() => {
    if (seenKind && seenId) markSeen(seenKind, seenId, seenMarker);
  }, [seenKind, seenId, seenMarker, markSeen]);
  const changed = useCallback(() => { void api.refresh(); }, [api]);
  useEffect(() => {
    window.addEventListener(TEAM_DELIVERY_CHANGED, changed);
    return () => window.removeEventListener(TEAM_DELIVERY_CHANGED, changed);
  }, [changed]);
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
  /** 项目没在这台电脑上绑文件夹、卡没开（17.2 第 32 条）：这几个项目的对话里出「在哪个文件夹开工？」，选完绑上再开。 */
  const [needFolder, setNeedFolder] = useState<ReadonlySet<string>>(() => new Set());
  const start = useCallback(async (cards: Worker[], planners: PlanJob[], onError?: () => void, modes?: Map<string, TLocalPermissionMode>): Promise<Set<string>> => {
    const opened = new Set<string>();
    // 在所属项目绑的文件夹里开（17.2 第 32 条）；项目没绑的卡不开、去问；不属于项目的才用上次用过的。
    const fallback = local.folders.find((folder) => folder.id === readLast().folderId)?.path ?? local.folders[0]?.path ?? null;
    const asks = new Set<string>();
    const placed = cards.flatMap((worker) => {
      const projectId = projectIdOf(worker, projects.all);
      const where = startFolder(projectId, projects.bound, fallback);
      if (where.ask && projectId) { asks.add(projectId); return []; }
      return [{ worker, cwd: where.cwd }];
    });
    if (asks.size) setNeedFolder((current) => ([...asks].every((id) => current.has(id)) ? current : new Set([...current, ...asks])));
    const homeless = placed.flatMap(({ worker, cwd }) => (!cwd && worker.item ? [worker.item.id] : []));
    if (homeless.length) { if (onError) onError(); else markStart(homeless, true); }
    const tryIds = placed.flatMap(({ worker, cwd }) => (cwd && worker.item ? [worker.item.id] : []));
    const roles = work.roles?.roles ?? [];
    const plans: StartPlan[] = placed.flatMap(({ worker, cwd }) => {
      const role = roles.find((entry) => entry.id === worker.role.id) ?? null;
      const model = local.models.find((entry) => entry.id === worker.item?.card?.model?.id) ?? modelForTier(local.models, role?.modelTier ?? "normal");
      return model && worker.item && cwd ? [{ item: worker.item, model, cwd, role, permissionMode: modes?.get(worker.item.id) }] : [];
    });
    // 规划员：项目绑了就在那个文件夹里拆，没绑不给目录（本机给它专用目录，规划员会先问清在哪做）。
    const planCwd = (job: PlanJob) => startFolder(projectIdOf({ projectId: "projectId" in job ? job.projectId : null, taskId: "taskId" in job ? job.taskId : null }, projects.all),
      projects.bound, fallback).cwd ?? undefined;
    // 拆卡登记先认领再开（B 的契约）：删成了才算这个标签页的，别的标签页、别的电脑删不成就不开；开不起来（含整批出错）再登记回去。
    const claimed = (await Promise.all(planners.map(async (job) => {
      if (!job.splitId) return job;
      try { await removeSplit(job.splitId); return job; } catch { return null; }
    }))).filter((job): job is NonNullable<typeof job> => !!job);
    // 登记回去时带上原来存的原话（16.8），不然新登记的原话是空的。
    const giveBack = (jobs: PlanJob[]) => Promise.all(jobs.map((job) => (job.splitId ? registerPlan(job, job.sourceWords?.join("\n\n")).catch(() => undefined) : undefined)));
    try {
      const jobs = (await Promise.all(claimed.map(async (job) => {
        try { return { ...job, request: await planStartRequest(job, local.models, planCwd(job)) }; } catch { return { ...job, request: null }; }
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
  }, [local, work.roles, changed, markStart, projects.all, projects.bound]);
  /** 拆卡登记没成的那件 Task（或没挂 Task 的项目，planKey）：项目对话里出「拆卡失败 · 重试」（不弹 toast）。 */
  const [splitFailed, setSplitFailed] = useState<string | null>(null);
  // afterSequence（17.2 第 29 条）：项目对话里本人看到的最后一条，登记时带上，拆卡那几块插在它后面。
  const split = useCallback(async (target: PlanTarget, afterSequence?: number) => {
    setSplitFailed(null);
    if (here) { await start([], [target], () => setSplitFailed(planKey(target))); return; }
    try { await registerPlan(target, undefined, afterSequence); changed(); }
    catch { setSplitFailed(planKey(target)); }
  }, [here, start, changed]);

  // 等开工的卡和拆卡登记：这台电脑连着本机时自己开（每件只试一次，没开成的写在管线里「失败 · 手动开始」）。
  // 同一台电脑开着几个标签页时排着来（Web Locks），轮到时先读本机现在的会话，已经有会话的卡不再开。
  // 云端接口在不在还不知道时不开（不知道该不该认领）。B 的「登记 + 认领」在时（live），卡和专题只走下面的认领（一条只给一处：
  // 别的电脑认领了、还没报上来的卡在这里也是「等开工」，不能不认领就开）；这里只开拆卡登记（照旧：先删登记，删成了才开）。
  // 接口没上（404）时照旧：没登记、等开工的卡也在这里开。
  const subs = useMemo(() => [...data.projects.flatMap((project) => project.subSessions), ...data.other.subSessions], [data]);
  const autoStartKey = subs.filter((sub) => sub.autoStart).map((sub) => sub.id).sort().join(",");
  /** 认领到的专题怎么开（claimTopic，第 68 条）：开工、先问文件夹，或不开。 */
  const topicClaim = useCallback((topicId: string, busy: ReadonlySet<string>) =>
    claimTopic(topicId, { subs, projects: projects.all, bound: projects.bound, freeSessions: !!local.runner.freeSessions, busy }), [subs, projects.all, projects.bound, local.runner]);
  /** 自由子会话等着项目绑文件夹：同卡，记进 needFolder，项目对话和这个子会话页都出「在哪个文件夹开工？」。 */
  const askFolderFor = useCallback((projectId: string) => setNeedFolder((current) => (current.has(projectId) ? current : new Set([...current, projectId]))), []);
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
  const latest = useRef({ workers: work.workers, subs, start, local, changed, autoStartKey, reload: api.refresh, topicClaim });
  useEffect(() => { latest.current = { workers: work.workers, subs, start, local, changed, autoStartKey, reload: api.refresh, topicClaim }; });
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
      const { start, local, changed, topicClaim } = latest.current;
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
        if (entry.kind !== "topic" || !entry.topicId || !model) continue;
        const claim = topicClaim(entry.topicId, busy);
        if (claim.kind === "skip") { if (claim.failed) markStart([entry.topicId], true); continue; }
        if (claim.kind === "ask") { askFolderFor(claim.projectId); continue; }
        try { await startTopic(local.runner, claim.topic, model, undefined, entry.permissionMode); opened.add(entry.topicId); markStart([entry.topicId], false); }
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
  }, [here, api.live, api.deviceId, canOpen, autoStartKey, claimTick, markStart, askFolderFor]);
  // 换了文件夹或模型（比如没开成以后去连接页加了文件夹）：没开成的再自动试一次。
  // 项目绑了文件夹（「在哪个文件夹开工？」选完）也算：等文件夹的卡马上再认领。
  const setupKey = `${local.folders.map((folder) => folder.id).join(",")}|${local.models.map((entry) => entry.id).join(",")}|${[...projects.bound].map(([projectId, folder]) => `${projectId}:${folder.id}`).join(",")}`;
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
    const claim = topicClaim(subId, new Set());
    if (!sub || !model || claim.kind === "skip") { markStart([subId], true); return; }
    if (claim.kind === "ask") { askFolderFor(claim.projectId); return; }
    try { await startTopic(local.runner, claim.topic, model); markStart([subId], false); await local.refresh(); changed(); }
    catch { markStart([subId], true); }
  }, [start, markStart, changed, local, topicClaim, askFolderFor]);
  /** 项目下的「+」（第 68 条）：建自由子会话（云端同时登记开工），读回首页数据、马上认领一次，换到这个子会话。 */
  const createFree = useCallback(async (projectId: string, firstMessage: string) => {
    const topic = await createTopic({ free: true, projectId, firstMessage });
    await api.refresh();
    setClaimTick((n) => n + 1);
    go(topicHref(topic.id));
  }, [api, go]);

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
  // 规划员、验收员停会话；子 agent、后台命令只停那一项，会话接着做。
  const stop = async (item: BackgroundItem) => {
    if (!item.sessionId) return;
    if ((item.kind === "subagent" || item.kind === "command") && item.itemId) await local.runner.stopBackground(item.sessionId, item.itemId);
    else await local.runner.kill(item.sessionId);
    await local.refresh();
    changed();
  };

  const workspace: WorkspaceApi = useMemo(() => ({
    navigate: (href: string) => go(href), close: () => undefined, detailOpen: false, closing: false, registerDetail: () => undefined,
    showToast: (text: string) => showWorkspaceToast({ text }), homeCards: [], quote: () => undefined, compose: () => undefined, viewerId: account.personId ?? null,
  }), [go, account.personId]);

  // 「今天」行行尾的月份 chip（5.4.2）：云端等你里月份那一条优先——复盘窗口里写「复盘」，新月份的草稿到了写「12 月待敲定」（「延续到哪」只在等你里）；
  // 没有时，树上没有本月的 Mission 就写「11 月待敲定」（网页按本月比较推出来）；云端首页还没问到时本月是空的，不算。点了进月份页。
  const monthItem = data.waiting.find((item) => item.kind === "month" && item.month && item.month.step !== "continue")?.month ?? null;
  const empty = monthItem || !api.known ? null : emptyMonth(work.plan?.today ?? null, data.month.missions);
  const month = monthItem ? { href: monthHref(monthItem.period), label: monthItem.step === "review" ? "复盘" : `${monthLabel(monthItem.period)}待敲定` }
    : empty ? { href: monthHref(empty), label: `${monthLabel(empty)}待敲定` } : null;

  // ---- 展示区 ----
  // Task 详情里的验收时间点：挂着的项目目标的截止日（天枢里存的或 Mission 节点），没挂的退回 Mission 下一个验收时间点。
  const taskGate = (task: { taskId: string; missionId: string }) => {
    if (!work.plan) return null;
    const due = goalDueDate(data.projects, task.taskId);
    return gateText(due ? dateGate(work.plan, due) : gateOf(work.plan, task.missionId));
  };
  // 本月计划里的 Task 带完成定义；之前月份没了结、挂在项目上的（B 的 work-home 才有）照项目上的目标拼。
  const planTask = (taskId: string): THomePlanTask | null => {
    const found = tasks.find((task) => task.taskId === taskId);
    if (found) return found;
    const goal = data.projects.flatMap((project) => project.goals).find((entry) => entry.taskId === taskId);
    return goal ? { taskId, missionId: goal.missionId, name: goal.name, doneDefinition: null, criteria: goal.criteria } : null;
  };
  // 会话按钮（设计 4.2、4.3，取代后台任务按钮）：面板范围里有子会话在跑、或后台任务在跑在排时外面一圈慢转的细环。手机上点了出底部抽屉；电脑上在右边的面板位开关「会话」。
  const sessionsOpen = slot === "sessions";
  const scopedSubs = panelProject(view, projects.all)?.subSessions ?? subs;
  const running = items.some((item) => item.state === "running" || item.state === "queued") || scopedSubs.some((sub) => subIcon(sub).state === "running");
  const backgroundButton = useMemo(() => (
    <SessionsButton running={running} open={sessionsOpen} handheld={handheld} alert={machine.quotaAlert}
      onPress={() => (handheld ? setSheet(true) : show(sessionsOpen ? null : "sessions"))} />
  ), [running, machine.quotaAlert, handheld, sessionsOpen, show]);
  // 子会话页头的上一级：它在哪个项目里，点了回到项目对话。
  const subId = view.kind === "card" || view.kind === "topic" ? view.id : null;
  const owner = crumbProject(projects.all, subId);
  const parent = useMemo(() => (owner ? (
    <button type="button" className={h.crumb} onClick={() => go(projectHref(owner.id))}>{owner.name} / </button>
  ) : null), [owner, go]);
  // 伙伴主线（本人 11/18）：页头不放「会话」按钮，「会话」面板当作关着（slot 不动，切回项目对话照旧开着）；主线小条、事件行点开的 thread 照常出。
  const buddyMain = view.kind === "buddy";
  const trail = buddyMain ? null : backgroundButton;
  const chrome = useMemo(() => (handheld ? {
    lead: <button type="button" className={h.icon} aria-label="返回" title="返回" onClick={() => go(HOME_HREF)} data-testid="phone-back"><ArrowLeft {...ICON} /></button>,
    // 手机上页头不写上一级（左边已经有返回），只留子会话标题（排查清单第 3 条）。
    trail, parent: null,
  } : { lead: null, trail, parent }), [handheld, go, trail, parent]);
  // 开会（设计 2026-11-12）：录音挂在外壳上，切项目、切子会话、开设置都不断。在项目页里新的一场默认挂这个项目本月目标的 Mission。
  const meeting = useHomeMeeting({ account, go });
  // 首页「等你」的件数（11/16 重新设计 4.5）：和首页同一份 focusList，左栏「今天」行、标签页标题写全部件数。
  const recordingMeetingId = meeting.phase.kind === "live" ? meeting.phase.meeting.id : null;
  const { items: meetingItems, loaded: meetingsLoaded } = usePartnerMeetings();
  const monthExtras = useMonthExtras({ data, api, projects });
  const focusNow = Date.now();
  const focus = focusList({ waiting: data.waiting, meetings: meetingItems, offline: machine.disconnected, recordingMeetingId, now: focusNow, ignoredMeetings: data.ignoredMeetings });
  const waitingCount = focus.length;
  useTabTitle(waitingCount, meeting.live);
  // 左栏「会议」「本月」两行的行尾（设计第 3 节）：下一场还没进等你的会；这个月还没完成的 Task 里最早的验收时间点。
  const focusMeetingIds = new Set(focus.flatMap((row) => (row.kind === "meeting" ? [row.item.id] : [])));
  const meetingsTrail = nextMeetingTrail(meetingSections(meetingItems, focusNow), focusMeetingIds, focusNow);
  const monthTrail = data.month.missions.filter((mission) => mission.period === data.period)
    .flatMap((mission) => mission.tasks.filter((task) => !task.completedAt).map((task) => taskGateLabel(projects.all, work.plan, { taskId: task.taskId, missionId: mission.missionId })))
    .filter((label): label is string => Boolean(label)).sort()[0] ?? null;
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
  /** 这个项目的卡或自由子会话在等它在这台电脑上绑文件夹（这台电脑连着本机程序、还没绑）。 */
  const waitingFolder = useCallback((projectId: string) => here && needFolder.has(projectId) && !projects.bound.has(projectId), [here, needFolder, projects.bound]);
  // 「随手」项目在这台电脑上绑的文件夹（工作目录）完整路径：主线里随手会话做完一轮那行带上（本人 11/19）；取不到为 null。
  const scratchId = projects.all.find((project) => project.scratch)?.id;
  const scratchFolder = (scratchId && projects.bound.get(scratchId)?.path) || null;
  // 随手项目绑的文件夹：选文件夹的几处不列（ScratchFolders）。
  const scratchFolders = useMemo(() => new Set((scratchId && projects.boundAll.get(scratchId)?.map((folder) => folder.id)) || []), [scratchId, projects.boundAll]);
  /** 「在哪个文件夹开工？」（17.2 第 32 条）：卡或自由子会话等着这个项目在这台电脑上绑文件夹时才有，选完绑上就收起、接着开。 */
  const folderAsk = (project: Project) => (waitingFolder(project.id)
    ? <FolderAsk folders={local.folders} onBind={(folder) => projects.actions.setFolder(project.id, folder.id, project.name)} onPickOther={() => local.pickFolder()} /> : null);
  const projectBlocks = (project: Project): TimedBlock[] => [
    ...(project.transfer && (project.transfer.status === "preparing" || project.transfer.status === "sent") ? [{
      key: `transfer:${project.transfer.id}`, at: project.transfer.startedAt, afterSequence: project.transfer.afterSequence,
      node: <TransferFlow project={project} transfer={project.transfer} onChanged={api.refresh} onStop={stopForTransfer} />,
    }] : []),
    // 卡等着项目绑文件夹（17.2 第 32 条）：放在最后，选完绑上就收起，卡接着开。
    ...(folderAsk(project) ? [{ key: `folder-ask:${project.id}`, at: new Date().toISOString(), afterSequence: null, node: folderAsk(project) }] : []),
  ];
  /** 项目对话（16.3）：页头只有项目名和「详情」（文件夹在输入框下面）。没挂 Task 的项目也在自己的对话里拆卡、开工。 */
  const projectView = (project: Project) => {
    const goalTasks = project.goals.flatMap((goal) => { const task = planTask(goal.taskId); return task ? [task] : []; });
    const trail = <ProjectTrail project={project} go={go} />;
    return <PipelineView key={project.id} project={project} tasks={goalTasks} api={api} buddy={buddy} outbox={outbox} consume={consume} go={go} onSplit={(target) => void split(target, seenSequence(project.id))} splitFailed={splitFailed}
      startFailed={startFailed} onManualStart={(id) => void manualStart(id)} onSpeaking={setSpeaking} trail={trail} blocks={projectBlocks(project)}
      onPulled={() => void projects.actions.reloadFolders()} onSetFolder={(folderId) => projects.actions.setFolder(project.id, folderId, project.name)}
      onPickFolder={() => projects.actions.pickFolder(project.id, project.name)} onCreateFolder={(name) => projects.actions.createFolder(project.id, project.name, name)}
      onAddFolder={(projects.boundAll.get(project.id)?.length ?? 0) < projects.folderLimit ? () => projects.actions.addFolder(project.id, project.name) : undefined}
      bound={projects.bound.get(project.id) ?? null} />;
  };
  const projectInfo = (project: Project, inSide = false) => (
    <ProjectInfo key={project.id} project={project} period={data.period} go={go} actions={projects.actions} folders={projects.boundAll.get(project.id) ?? []} folderLimit={projects.folderLimit} doneDefinitionOf={(taskId) => planTask(taskId)?.doneDefinition ?? null}
      me={{ personId: account.personId ?? "", name: account.displayName }} side={inSide} />
  );
  const display = (current: View) => {
    switch (current.kind) {
      case "home": return <HomeView data={data} api={api} buddy={buddy} today={todayLabel(work.plan?.today ?? null)} go={go} route={route} onSend={send} projects={projects} meeting={meeting} trail={backgroundButton} offline={machine.disconnected} recordingMeetingId={recordingMeetingId} />;
      case "project": {
        const project = projects.all.find((entry) => entry.id === current.id);
        if (!project) return <Missing loading={!api.ready} onRetry={api.planFailed ? () => void api.retryPlan() : undefined} />;
        return projectView(project);
      }
      case "projectInfo": {
        const project = projects.all.find((entry) => entry.id === current.id);
        if (!project) return <Missing loading={!api.ready} onRetry={api.planFailed ? () => void api.retryPlan() : undefined} />;
        return projectInfo(project);
      }
      case "newSub": {
        const project = projects.all.find((entry) => entry.id === current.projectId);
        if (!project) return <Missing loading={!api.ready} onRetry={api.planFailed ? () => void api.retryPlan() : undefined} />;
        return <NewSubView key={project.id} project={project} onCreate={(text) => createFree(project.id, text)} />;
      }
      case "transfer": return <TransferView key={current.id} id={current.id} go={go} onChanged={api.refresh} />;
      case "meetings": return <MeetingsPage meeting={meeting} go={go} />;
      case "meeting": return <MeetingView key={current.id} id={current.id} go={go} />;
      case "chat": return <ChatView key={`${current.side}:${current.personId}`} side={current.side} personId={current.personId} buddy={buddy} go={go} />;
      case "buddy": return <BuddyView buddy={buddy} outbox={outbox} consume={consume} onSpeaking={setSpeaking} waiting={data.waiting} go={go} context={buddyContext} onClearContext={() => setBuddyContext(null)}
        subs={subs} projects={projects.all} waitingFolder={waitingFolder} scratchFolder={scratchFolder} />;
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
        if (task) return <TaskInfo task={task} mission={data.month.missions.find((entry) => entry.missionId === task.missionId)?.title ?? null} gate={taskGate(task)} go={go} />;
        if (!api.ready) return <Missing loading={!api.planFailed} onRetry={api.planFailed ? () => void api.retryPlan() : undefined} />;
        // 不在本人的计划和项目上（别人的 Task：请你认可、飞书「请 X 看」；之前月份了结了的）：没有对话可看，去只读的详情（9.8、9.10）。
        return <ForeignTaskInfo key={current.taskId} taskId={current.taskId} go={go} redirect />;
      }
      case "info": {
        const task = planTask(current.taskId);
        if (!task && !api.ready) return <Missing loading={!api.planFailed} onRetry={api.planFailed ? () => void api.retryPlan() : undefined} />;
        if (!task) return <ForeignTaskInfo key={current.taskId} taskId={current.taskId} go={go} />;
        const mission = data.month.missions.find((entry) => entry.missionId === task.missionId)?.title ?? null;
        return <TaskInfo task={task} mission={mission} gate={taskGate(task)} go={go} />;
      }
      // 等本人处理的框和左栏的点同一个来源（第 54 条）：首页数据里这个子会话在等什么。
      case "card": {
        const sub = subs.find((entry) => entry.id === current.id);
        return <CardSession key={current.id} cardId={current.id} embedded waiting={sub?.waiting} queued={sub ? subQueueText(sub, handheld) : null} />;
      }
      case "topic": {
        const sub = subs.find((entry) => entry.id === current.id);
        // 自由子会话等着项目绑文件夹：问的框钉在这个子会话的输入框上方（和项目对话里那份是同一个）。
        const owner = sub?.free ? projects.all.find((project) => project.subSessions.some((entry) => entry.id === current.id)) : undefined;
        return <TopicSession key={current.id} topicId={current.id} embedded waiting={sub?.waiting ?? null} queued={sub ? subQueueText(sub, handheld) : null} ask={owner ? folderAsk(owner) : null} />;
      }
      case "page": {
        // 二级页：组件挂在 components/home/pages。
        const Page = SECONDARY_PAGES[current.page];
        return <SecondaryFrame key={current.page} title={PAGE_TITLE[current.page]} go={go}><Page go={go} /></SecondaryFrame>;
      }
      case "month": {
        const Month = MONTH_PAGE;
        // 当月就是「本月」（11/16 重新设计第 6 节）：带上首页数据里的现状；桌面上和首页、会议并列，不画返回。
        const thisMonth = current.period === data.period;
        return <SecondaryFrame key={current.period} title={monthHead?.title ?? `${Number(current.period.slice(5))} 月`} trail={monthHead?.trail} go={go} back={handheld || !thisMonth}>
          {Month ? <Month go={go} period={current.period} today={work.plan?.today ?? null} onHead={setMonthHead} extras={thisMonth ? monthExtras : undefined} onChanged={api.refresh} /> : null}
        </SecondaryFrame>;
      }
    }
  };
  // 本人行的点（第 73 条）：只管这台电脑就不就绪，就绪时不显眼，不对时琥珀色；额度看模型旁边的圆环。手机上不画。
  const machineDot = handheld ? null : { alert: machine.alert, word: machine.word };
  // 正在后台干活的项目（左栏标题右边闪的灰点）：子会话在跑、规划员或验收员在做，或正开着的这个项目对话在回复。
  const working = useMemo(() => new Set(projects.projects
    .filter((project) => !project.scratch && projectWorking(project, work.workers, speaking && view.kind === "project" && view.id === project.id))
    .map((project) => project.id)), [projects.projects, work.workers, speaking, view]);

  // 名片上的「在听」和走秒由名片自己读外壳给的开会状态（HomeMeetingProvider）：走秒时只有名片跟着重画。
  const left = (
    <LeftColumn data={data} view={view} buddy={buddy} go={go} phone={handheld} account={account} month={month} onRetryPlan={api.planFailed ? () => void api.retryPlan() : null}
      projects={projects.projects} archived={projects.archived} actions={rowActions} folderLimit={projects.folderLimit}
      onCreate={async (name, folderIds) => {
        const id = await projects.actions.create(name);
        // 项目建好了、文件夹没绑上：照样进项目页，提示一句，文件夹在详情里再加。
        if (folderIds.length) await projects.actions.setFolders(id, folderIds, name).catch(() => showWorkspaceToast({ text: "文件夹没绑上" }));
        return id;
      }} working={working} seen={seenMarks} onOpen={markSeen}
      meetingSlot={<MeetingControl meeting={meeting} />}
      today={todayLabel(work.plan?.today ?? null)} machine={machineDot} trail={handheld ? backgroundButton : null}
      waitingCount={waitingCount} meetingsTrail={meetingsTrail} monthTrail={monthTrail}
      top={handheld ? <HomeWaiting data={data} api={api} go={go} phone offline={machine.disconnected} recordingMeetingId={recordingMeetingId} meeting={meeting} /> : null} />
  );
  // 左栏收起（设计 4.1，只电脑）：收起期间有新东西时按钮上一颗蓝点——收起那一刻以后项目出了没看过的蓝点，或等你比那一刻多了。
  // 那一刻记在这一页的内存里；收着刷新时等等你的几样来源都到齐了再记（useLeftDot）。
  const leftFold = useLeftCollapsed();
  const collapsed = leftFold.collapsed && !handheld;
  const leftDot = useLeftDot({ collapsed, homeReady: api.ready, meetingsLoaded, localPhase: local.phase, projects: projects.projects, seen: seenMarks, waitingCount });

  // 会话面板（设计 4.3）：电脑上在右边的面板位，点行在右边开 thread（6.6）；手机上在底部抽屉，点行去那个子会话。
  // 点行、「…」里的「标为已读」、小条上的蓝点、thread 打开时照左栏的「刚看过」记（seen，挂在外壳上）。
  const sessionsPanel = (phone: boolean) => (
    <SessionsPanel view={view} projects={projects.all} other={data.other.subSessions} archivedSubs={projects.archivedSubs} actions={rowActions} go={go}
      items={items} onStop={stop} resources={work.resources} handheld={phone} onOpenSub={phone ? undefined : threadOpener(side, go)} cardAt={cardAt} />
  );
  const seen = useMemo(() => ({ seen: seenMarks, onOpen: markSeen }), [seenMarks, markSeen]);
  const threadSub = slot === "thread" && thread ? subs.find((sub) => sub.kind === thread.kind && sub.id === thread.id) ?? null : null;
  // thread 里那个子会话不在了（开着时被归档、删了）：面板当作关着，不留一块空的。
  const panel = (slot === "thread" && !threadSub) || (buddyMain && slot === "sessions") ? null : slot;
  // thread 里的自由子会话等着项目绑文件夹：同中间那一页，问的框钉在它的输入框上方。
  const threadOwner = threadSub?.free ? projects.all.find((project) => project.subSessions.some((entry) => entry.id === threadSub.id)) : undefined;
  if (handheld) {
    return (
      <NoEllipsis.Provider value>
      <WorkspaceContext.Provider value={workspace}>
        <ViewChrome.Provider value={chrome}>
          <SeenContext.Provider value={seen}>
          <ScratchFolders.Provider value={scratchFolders}>
          <HomeMeetingProvider meeting={meeting}>
          <div className={h.app} data-phone="" data-view={view.kind} data-scheme="auto" data-type-scale="one" data-entering={entering ? "" : undefined} data-testid="work-home">
            {/* 首屏兼首页（5.7）：左栏那几样，底部固定首页的输入框（带「发给」）。 */}
            {view.kind === "home" ? <>
              <aside className={h.left}>{left}</aside>
              <div className={h.phoneComposer}><HomeComposer buddy={buddy} projects={projects.projects} route={route} onSend={send} /></div>
            </> : <main className={h.display}>{display(view)}</main>}
            {sheet ? (
              <div className={h.sheetBackdrop} data-closing={sheetClosing ? "" : undefined} onClick={closeSheet}>
                <div className={h.sheet} role="dialog" aria-modal="true" aria-label="会话" onClick={(event) => event.stopPropagation()}>
                  <span className={h.grabber} aria-hidden />
                  {sessionsPanel(true)}
                </div>
              </div>
            ) : null}
          </div>
          </HomeMeetingProvider>
          </ScratchFolders.Provider>
          </SeenContext.Provider>
        </ViewChrome.Provider>
      </WorkspaceContext.Provider>
      </NoEllipsis.Provider>
    );
  }
  return (
    <NoEllipsis.Provider value>
    <WorkspaceContext.Provider value={workspace}>
      <ViewChrome.Provider value={chrome}>
        <SideDetailContext.Provider value={side}>
          <SeenContext.Provider value={seen}>
          <ScratchFolders.Provider value={scratchFolders}>
          <HomeMeetingProvider meeting={meeting}>
          <div className={h.app} data-panel={panel === "file" || panel === "thread" ? "file" : panel ? "open" : "closed"} data-left={collapsed ? "closed" : undefined} data-wide={slot === "file" && wide ? "" : undefined} data-view={view.kind} data-scheme="auto" data-type-scale="one" data-entering={entering ? "" : undefined} data-testid="work-home"
            data-resizing={leftWidth.dragging || rightWidth.dragging || fileWidth.dragging ? "" : undefined} style={{
              ...(leftWidth.width && !collapsed ? { "--home-left": `${leftWidth.width}px` } : {}),
              ...(rightWidth.width ? { "--home-right": `${rightWidth.width}px` } : {}),
              ...(fileWidth.width ? { "--home-file": `${fileWidth.width}px` } : {}),
            } as CSSProperties}>
            <aside className={h.left}>{left}{collapsed ? null : <LeftResize control={leftWidth} />}</aside>
            <main className={h.display}><LeftToggle collapsed={collapsed} unseen={leftDot} onToggle={leftFold.toggle} />{display(view)}</main>
            {panel ? (
              <aside className={h.right} aria-label={PANEL_LABEL[panel]} data-testid="side-panel">
                {/* 文件预览自己有页头（名字、改动、放大、关闭），这里只给它一块地方；thread 也自己画页头（名字、放大、关闭）。 */}
                {panel === "file" ? <div ref={setSideNode} className={h.sideFile} />
                  : panel === "thread" && threadSub ? <ThreadPane key={`${threadSub.kind}:${threadSub.id}`} sub={threadSub} go={go} onClose={() => show(null)}
                    from={buddyMain ? thread?.from ?? null : null} ask={threadOwner ? folderAsk(threadOwner) : null} /> : (
                  <div className={h.side} data-testid={panel === "detail" ? "side-detail" : "side-sessions"}>
                    <div className={h.sideHead}>
                      <span className={h.resName}>{PANEL_LABEL[panel]}</span><span className={h.grow} />
                      <HeroButton variant="ghost" size="sm" isIconOnly title="关闭" aria-label={`关闭${PANEL_LABEL[panel]}`} onPress={() => show(null)} data-testid="side-close"><X {...ICON} /></HeroButton>
                    </div>
                    <div className={h.sideScroll}>
                      {panel === "sessions" ? sessionsPanel(false)
                        : view.kind === "project" ? (() => { const project = projects.all.find((entry) => entry.id === view.id); return project ? projectInfo(project, true) : null; })()
                        : <div ref={setSideNode} />}
                    </div>
                  </div>
                )}
                {panel === "file" && wide ? null : <RightResize control={panel === "file" || panel === "thread" ? fileWidth : rightWidth} />}
              </aside>
            ) : null}
          </div>
          </HomeMeetingProvider>
          </ScratchFolders.Provider>
          </SeenContext.Provider>
        </SideDetailContext.Provider>
      </ViewChrome.Provider>
    </WorkspaceContext.Provider>
    </NoEllipsis.Provider>
  );
}

const PANEL_LABEL: Record<PanelKind, string> = { detail: "详情", file: "文件", sessions: "会话", thread: "会话" };

/** 二级页、月份页的壳（5.4.7）：页头（返回、标题）+ 文档类阅读尺，内容是挂进来的组件。 */
function SecondaryFrame({ title, trail, go, back = true, children }: { title: string; trail?: React.ReactNode; go: (href: string) => void; back?: boolean; children: React.ReactNode }) {
  return (
    <div className={h.page} data-type-scale="doc" data-testid="secondary-page">
      <header className={h.viewHead}>
        {back ? <button type="button" className={h.icon} aria-label="返回" title="返回" onClick={() => (window.history.length > 1 ? window.history.back() : go(HOME_HREF))}><ArrowLeft {...ICON} /></button> : null}
        <h1 className={h.viewTitle} tabIndex={-1}>{title}</h1>
        {trail}
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
