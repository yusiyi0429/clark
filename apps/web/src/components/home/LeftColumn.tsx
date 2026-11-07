"use client";

/**
 * 左栏只有四个锚点（新首页设计 9.1–9.4、5.4.2）：
 * 1. 伙伴台：正方形，伙伴居中；点了进总管线。伙伴不飞走：在总管线时台子铺选中底、伙伴换成「在听」；任何管线里伙伴在说话时是「在说」。
 *    鼠标移上去右上角出「⋯」，点开「伙伴」二级页。
 * 2. 「今天」行：House +「11 月 7 日 周六」，就是首页（Esc 也回这里）；不在首页时行尾是等你的计数。
 * 3. 「项目」组头（右边「+」就地新建）→ 项目行（16.2，有等你的在前、本月有目标的按截止、其余按最近活动）→「已归档 N」（折起）→「其他」。
 *    项目行 48 高两行，左边 16 宽的状态位，右边信息按钮（进项目详情）；会话默认收成一行「会话 N」加一排小方块（一格一个、按状态上色），
 *    点开才一行一行列出来（28 高、12 字），会话上不画蓝点；本人自己做的事项（9.10）排在后面，行首是本人 16 的头像，做完的变淡；
 *    待归位的事项（和以前留下的、不归项目的会话）进「其他」。
 * 4. 本人行：贴底，头像 24 + 名字，点开个人菜单。
 * 树的键盘：↑↓ 移动，回车打开，→ 展开折叠，← 收起。
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronRight, Ellipsis, House, Info, Plus } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { FailedLine, failureOf, type Failure } from "@/components/work/DecisionBox";
import type { Account } from "@/components/AccountMenu";
import { BuddyMark } from "@/components/buddy/BuddyMark";
import type { Buddy } from "@/components/buddy/useBuddy";
import { BUDDY_HREF, HOME_HREF, cardHref, queueText, topicHref } from "@/lib/home/derive";
import { projectHref, projectInfoHref, projectLine, type Project } from "@/lib/home/projects";
import type { THomeItem as HomeItem } from "@warmap/contracts";
import type { SubSession, WorkHomeData } from "@/lib/home/types";
import { PersonAvatar } from "@/components/avatar/PersonAvatar";
import { useDictationSignal } from "@/conversation/dictationSignal";
import { PersonRow } from "./PersonMenu";
import { ICON, StateIcon, type IconState } from "./StateIcon";
import { pageHref, type View } from "./view";
import h from "@/styles/home.module.css";

export const subHref = (sub: Pick<SubSession, "kind" | "id">) => (sub.kind === "card" ? cardHref(sub.id) : topicHref(sub.id));

export function LeftColumn({ data, view, buddy, speaking, go, phone, account, today, alert, trail, top, month, onRetryPlan, projects, archived, onCreate, cardAt }: {
  data: WorkHomeData;
  view: View;
  buddy: Buddy | null;
  /** 伙伴在说话（任何一条对话的回答进行中）。 */
  speaking: boolean;
  go: (href: string) => void;
  phone: boolean;
  account: Account;
  /** 「11 月 7 日 周六」。 */
  today: string;
  /** 连接要处理：本人行的琥珀点。 */
  alert: boolean;
  /** 手机：「今天」行行尾的后台任务按钮。 */
  trail?: ReactNode;
  /** 手机首屏：「今天」行下面先放「等你」。 */
  top?: ReactNode;
  /** 月份 chip（「11 月待敲定」）：点了进月份页。 */
  month?: { href: string; label: string } | null;
  /** 计划读不到：树最上面一行「本体读取失败」加「重试」。 */
  onRetryPlan?: (() => void) | null;
  /** 项目（已排好序，16.2）和已归档的。 */
  projects: Project[];
  archived: Project[];
  /** 新建一个项目（POST /api/me/projects），回它的 id（建好直接进项目页）；没建成在组头下写「失败 · 重试」。 */
  onCreate: (name: string) => Promise<string>;
  /** 卡建出来的时间（看板里的）：一个项目下的会话照派活单的先后排（和对话里「开了哪几个子会话」一样）。 */
  cardAt?: ReadonlyMap<string, string>;
}) {
  const name = buddy?.name?.trim() || "伙伴";
  const atHome = view.kind === "home" || view.kind === "month";
  // 等你的计数只在首页不写（首页下面就是等你那一块）；月份页上照写。
  const showCount = view.kind !== "home";
  const tree = useRef<HTMLDivElement>(null);
  const [naming, setNaming] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  // 听写时台上的伙伴跟着声音动（5.4.2、9.2），哪个输入框在听都算。
  const dictation = useDictationSignal();
  const [createFailed, setCreateFailed] = useState<Failure | null>(null);
  const create = (value: string) => {
    setNaming(false);
    const trimmed = value.trim();
    if (!trimmed) return;
    const run = () => { setCreateFailed(null); void onCreate(trimmed).then((id) => go(projectHref(id)), (error) => setCreateFailed(failureOf(error, run))); };
    run();
  };
  return (
    <nav className={h.leftInner} aria-label="导航">
      <div className={h.stage} data-current={view.kind === "buddy" ? "" : undefined}>
        <button type="button" className={h.stageHit} aria-label={name} aria-current={view.kind === "buddy" ? "page" : undefined} onClick={() => go(BUDDY_HREF)} data-testid="buddy-entry">
          <BuddyMark buddy={buddy} place="stage" active={speaking} listening={!!dictation || (view.kind === "buddy" && !speaking)} level={dictation?.level ?? 0} />
        </button>
        <span className={h.stageMore}>
          <HeroButton variant="ghost" size="sm" isIconOnly title="伙伴" aria-label="伙伴" onPress={() => go(pageHref("buddy"))}><Ellipsis {...ICON} /></HeroButton>
        </span>
      </div>
      {phone ? (
        <div className={h.today} data-phone="">
          <span className={h.todayIcon}><House {...ICON} /></span><span className={h.todayText}>{today}</span>
          {month ? <button type="button" className={h.statusChip} onClick={() => go(month.href)}>{month.label}</button> : null}
          {trail ? <span className={h.todayTrail}>{trail}</span> : null}
        </div>
      ) : (
        <button type="button" className={h.today} aria-current={atHome ? "page" : undefined} onClick={() => go(HOME_HREF)} data-testid="today-row">
          <span className={h.todayIcon}><House {...ICON} /></span><span className={h.todayText}>{today}</span>
          {/* 行尾的月份 chip：整行是一个按钮，chip 点了单独进月份页（键盘从「等你」那一行进）。 */}
          {month ? <span className={h.statusChip} data-testid="month-chip" onClick={(event) => { event.stopPropagation(); go(month.href); }}>{month.label}</span> : null}
          {showCount && data.waiting.length ? <span className={h.count}><i aria-hidden />{data.waiting.length}</span> : null}
        </button>
      )}
      {top}
      <div className={h.tree} ref={tree} onKeyDown={(event) => treeKeys(event, tree.current)}>
        {onRetryPlan ? <p className={h.planFailed} data-testid="plan-read-failed">本体读取失败<HeroButton variant="ghost" size="sm" onPress={onRetryPlan}>重试</HeroButton></p> : null}
        <section aria-label="项目" className={h.group}>
          <div className={h.groupHead}>
            <span>项目</span>
            <button type="button" className={h.groupAdd} title="新建项目" aria-label="新建项目" onClick={() => setNaming(true)} data-testid="project-add"><Plus size={14} strokeWidth={1.8} aria-hidden /></button>
          </div>
          {naming ? (
            <input className={h.projectName} autoFocus aria-label="项目名" placeholder="项目名" maxLength={60} data-testid="project-name"
              onBlur={(event) => create(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") { event.preventDefault(); create(event.currentTarget.value); }
                if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setNaming(false); }
              }} />
          ) : null}
          {createFailed ? <FailedLine {...createFailed} /> : null}
          {projects.map((project) => <ProjectNode key={project.id} project={project} view={view} go={go} personId={account.personId} cardAt={cardAt} />)}
          {archived.length ? (
            <>
              <button type="button" className={h.foldToggle} data-flat="" aria-expanded={archivedOpen} onClick={() => setArchivedOpen(!archivedOpen)} data-tree-row="" data-testid="tree-archived">
                <ChevronRight size={14} strokeWidth={1.8} aria-hidden className={h.chevron} data-open={archivedOpen ? "" : undefined} />已归档 {archived.length}
              </button>
              {archivedOpen ? archived.map((project) => <ProjectNode key={project.id} project={project} view={view} go={go} personId={account.personId} cardAt={cardAt} />) : null}
            </>
          ) : null}
        </section>
        {data.other.subSessions.length || data.other.items.length ? (
          <section aria-label="其他" className={h.group}>
            <p className={h.groupTitle}>其他</p>
            {data.other.subSessions.length ? <Subs subs={data.other.subSessions} view={view} go={go} flat /> : null}
            {data.other.items.length ? <Items items={data.other.items} personId={account.personId} go={go} /> : null}
          </section>
        ) : null}
      </div>
      <PersonRow account={account} view={view} alert={alert} go={go} />
    </nav>
  );
}

/** 树的键盘：在树里的可聚焦行之间 ↑↓；→ / ← 展开、收起「会话 N」「已归档 N」（焦点在那一行时）。回车由按钮自己打开。 */
function treeKeys(event: KeyboardEvent<HTMLDivElement>, root: HTMLDivElement | null) {
  if (!root) return;
  const rows = [...root.querySelectorAll<HTMLElement>("[data-tree-row]")];
  const index = rows.indexOf(document.activeElement as HTMLElement);
  if (index < 0) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
    return;
  }
  const row = rows[index]!;
  if (row.hasAttribute("aria-expanded") && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
    const open = row.getAttribute("aria-expanded") === "true";
    if ((event.key === "ArrowRight") !== open) { event.preventDefault(); row.click(); }
  }
}

/**
 * 项目行（16.2）：48 高两行，第一行项目名 14/600，第二行 12 淡色（预算 80% → 本月目标 · 截止 → 本月没有目标 · 最近活动）；
 * 状态位、蓝点、信息按钮同原来的 Task 行。下面一行「会话 N」加小格子（默认收起，正在看其中一个时自动展开一次），再是本人的事项。
 */
function ProjectNode({ project, view, go, personId, cardAt }: { project: Project; view: View; go: (href: string) => void; personId?: string | null; cardAt?: ReadonlyMap<string, string> }) {
  // 老地址 /me/work/tasks/<id>（等你那一行、14.3 的定位）画的也是这个项目：那件 Task 挂在这里就算在看它。
  const here = ((view.kind === "project" || view.kind === "projectInfo") && view.id === project.id)
    || ((view.kind === "task" || view.kind === "info") && project.goals.some((goal) => goal.taskId === view.taskId));
  const page = here && (view.kind === "project" || view.kind === "task");
  const [open, setOpen] = useState(false);
  const subs = planOrder(project.subSessions, cardAt);
  const items = [...project.items].sort((a, b) => Number(a.status === "done") - Number(b.status === "done"));
  const viewing = subs.some((sub) => (view.kind === "card" || view.kind === "topic") && view.kind === sub.kind && view.id === sub.id);
  // 正在看其中一个会话时自动展开一次；之后本人收起就收起（不强开着）。
  useEffect(() => { if (viewing) setOpen(true); }, [viewing]);
  const info = view.kind === "projectInfo" && here;
  const line = projectLine(project);
  return (
    <div className={h.taskNode} data-testid="tree-project" data-done={project.archived ? "" : undefined}>
      <div className={h.taskRow} data-current={page ? "" : undefined}>
        <button type="button" className={h.taskMain} onClick={() => go(projectHref(project.id))} aria-current={page ? "page" : undefined} data-tree-row="">
          <span className={h.slotState}>{project.waiting ? <StateIcon state="waiting" /> : null}</span>
          <span className={h.taskText}>
            <span className={h.taskName}>{project.name}</span>
            <span className={h.taskSub} data-warning={line.warning ? "" : undefined}>{line.text}</span>
          </span>
        </button>
        <span className={h.info} data-on={info ? "" : undefined}>
          <HeroButton variant="ghost" size="sm" isIconOnly title="详情" aria-label={`${project.name} 详情`} aria-pressed={info}
            onPress={() => go(info ? projectHref(project.id) : projectInfoHref(project.id))} data-testid="project-info"><Info {...ICON} /></HeroButton>
        </span>
      </div>
      {subs.length || items.length ? (
        <div className={h.branch}>
          {subs.length ? (
            <>
              <button type="button" className={h.foldToggle} aria-expanded={open} onClick={() => setOpen(!open)} data-tree-row="" data-testid="tree-subs">
                <ChevronRight size={14} strokeWidth={1.8} aria-hidden className={h.chevron} data-open={open ? "" : undefined} />会话 {subs.length}
                {open ? null : <span className={h.cells} aria-hidden>{subs.map((sub) => <i key={`${sub.kind}:${sub.id}`} data-state={subIcon(sub).state} />)}</span>}
              </button>
              {open ? <Subs subs={subs} view={view} go={go} /> : null}
            </>
          ) : null}
          {items.length ? <Items items={items} personId={personId} go={go} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** 派活单的先后：卡按看板里建出来的时间（一次开工建的几张按派活单的顺序建），没读到的和专题排在后面、按最近动静。 */
export function planOrder(subs: SubSession[], cardAt?: ReadonlyMap<string, string>): SubSession[] {
  const at = (sub: SubSession) => (sub.kind === "card" ? cardAt?.get(sub.id) : undefined);
  return [...subs].sort((a, b) => {
    const x = at(a), y = at(b);
    if (x && y) return x.localeCompare(y);
    if (x || y) return x ? -1 : 1;
    return a.updatedAt.localeCompare(b.updatedAt);
  });
}

/**
 * 树上的状态图标：契约的 failed 是「验收没过、改法还没送回」，第一次没过照 5.4.2 仍是进行中（不画叉；第二次没过是受阻，走等你）。
 * 叉只给程序层面的失败（后台任务那边）。
 */
export const treeState = (state: SubSession["state"]): SubSession["state"] => (state === "failed" ? "running" : state);

/**
 * 一个子会话的图标和读法（树、事件行共用）：第一次验收没过画进行中；停下了、没在问你（waiting 没有具体等什么）是「已停下」——
 * Square、--ink-faint，不是等你（契约 aa6aba9e：一轮做完停下的不进等你）。
 */
export function subIcon(sub: Pick<SubSession, "state" | "waiting">): { state: IconState; label?: string } {
  if (sub.state === "waiting" && !sub.waiting) return { state: "stopped", label: "已停下" };
  return { state: treeState(sub.state) };
}

/** flat：「其他」组里的，没有上一级，不缩进、不画竖线（状态位在 x=16，名字在 x=40）。 */
function Subs({ subs, view, go, flat = false }: { subs: SubSession[]; view: View; go: (href: string) => void; flat?: boolean }) {
  return (
    <ul className={h.subs} data-flat={flat ? "" : undefined}>
      {subs.map((sub) => {
        const current = (view.kind === "card" || view.kind === "topic") && view.kind === sub.kind && view.id === sub.id;
        const reason = sub.state === "queued" && sub.queueReason ? queueText(sub.queueReason, sub.holdUntil) : null;
        return (
          <li key={`${sub.kind}:${sub.id}`}>
            <button type="button" className={h.sub} data-state={sub.state} aria-current={current ? "page" : undefined} onClick={() => go(subHref(sub))} data-tree-row="" data-testid="tree-sub">
              <StateIcon {...subIcon(sub)} /><span className={h.subName}>{sub.title}</span>
              {reason ? <span className={h.subReason}>{reason}</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** 本人事项的行尾（12 淡色）：交了在等验收写「待验收」，否则写截止日「11/12」（过了期也照样写，不另上色），都没有不写。 */
function itemMeta(item: Pick<HomeItem, "awaitingAcceptance" | "dueDate">): string | null {
  if (item.awaitingAcceptance) return "待验收";
  return item.dueDate ? item.dueDate.slice(5).replace("-", "/") : null;
}

/**
 * 本人自己做的执行事项（设计 9.10、5.4.2「子会话行」最后一条）：和子会话行同一种行，状态位换成本人 16 的头像（没照片是纯色圆、不写字），
 * 做完的变淡。事项不是对话：点开是事项详情（老页面，离开新首页）。
 */
function Items({ items, personId, go }: { items: HomeItem[]; personId?: string | null; go: (href: string) => void }) {
  return (
    <ul className={h.subs}>
      {items.map((item) => {
        const meta = itemMeta(item);
        return (
          <li key={item.id}>
            <button type="button" className={h.sub} data-state={item.status === "done" ? "done" : undefined} onClick={() => go(`/me/tasks/${encodeURIComponent(item.id)}`)} data-tree-row="" data-testid="tree-item">
              <PersonAvatar personId={personId} className={h.itemAvatar}>{null}</PersonAvatar><span className={h.subName}>{item.title}</span>
              {meta ? <span className={`${h.subReason} ${h.num}`}>{meta}</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
