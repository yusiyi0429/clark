"use client";

/**
 * 左栏（新首页设计 9.1–9.4、5.4.2；11/17 设计 4.1）：
 * 1. 伙伴名片：64 高，只放形象、居中；点了进伙伴主线（总管线），在主线时是选中底、形象变淡。鼠标移上去右边出「⋯」，点开「伙伴」二级页。
 * 2. 「今天」行：House +「11 月 7 日 周六」，就是首页（Esc 也回这里）；不在首页时行尾是等你的计数。下面「会议」（行尾是开会那一颗）、「本月」。
 * 3. 「项目」组头（右边「+」就地新建，左边一个归档图标「已归档 N」，点了在项目后面列出已归档的项目，本人 11/16）→ 项目行（16.2，有等你的在前、本月有目标的按截止、其余按最近活动）→「其他」。
 *    项目行只有项目自己：名字（转交中、预算 80% 时多一行小字），行尾一颗点、信息按钮、「…」；子会话在右边的会话面板。
 *    本人自己做的事项（9.10）列在项目下面，行首是本人 16 的头像，做完的变淡；待归位的事项进「其他」。
 * 4. 本人行：贴底，头像 24 + 名字，点开个人菜单。
 * 树的键盘：↑↓ 移动，回车打开。
 */
import { useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Archive, CalendarDays, Ellipsis, House, Info, Plus, Target } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import type { Account } from "@/components/AccountMenu";
import { BuddyMark } from "@/components/buddy/BuddyMark";
import type { Buddy } from "@/components/buddy/useBuddy";
import { BUDDY_HREF, HOME_HREF, MEETINGS_HREF } from "@/lib/home/derive";
import { projectHref, projectInfoHref, projectLine, type Project } from "@/lib/home/projects";
import type { THomeItem as HomeItem } from "@warmap/contracts";
import type { WorkHomeData } from "@/lib/home/types";
import { PersonAvatar } from "@/components/avatar/PersonAvatar";
import { PersonRow } from "./PersonMenu";
import { NewProjectDialog } from "./NewProjectDialog";
import { isTruncated, useNameTip } from "./NameTip";
import { LocalContext } from "@/lib/local/LocalRunnerProvider";
import { ICON } from "./StateIcon";
import { monthHref, pageHref, type View } from "./view";
import { showUnseen, type SeenKind, type SeenMarks } from "@/lib/home/seen";
import { LOCAL_PROJECT_FOLDER_LIMIT } from "@/lib/local/routes";
import { showWorkspaceToast } from "@/lib/toast";
import { RowMenu, conflictText, useLongPress, type RowMenuItem } from "./RowMenu";
import { ActionsContext, RenameInput, SeenContext, type RowActions } from "./SubRows";
import h from "@/styles/home.module.css";

/** 菜单里没成时就地写的话（B 契约 c3366f28 的 409）。 */
export const deleteProjectFail = (error: unknown) => conflictText(error, { PROJECT_BUSY: null, PROJECT_TRANSFERRING: "正在转交" }, "没删成");

/**
 * 伙伴门牌（设计 4.1；本人 11/18 方案 A：对话顶上为主，这里退成门牌）：一行 48 高，左边小形象、右边伙伴名字；
 * 形象永远不动（开会、听写时也不动），活的那颗只在主线页头。点了进伙伴主线，在主线时只是选中底；
 * 鼠标移上去右边出「⋯」进「伙伴」二级页（贴右浮着）。
 */
function BuddyCard({ buddy, name, view, go }: { buddy: Buddy | null; name: string; view: View; go: (href: string) => void }) {
  const current = view.kind === "buddy";
  return (
    <div className={h.buddyCard}>
      <button type="button" className={h.buddyHit} aria-label={name} aria-current={current ? "page" : undefined} onClick={() => go(BUDDY_HREF)} data-testid="buddy-entry">
        <BuddyMark buddy={buddy} place="card" still />
        <span className={h.buddyName}>{name}</span>
      </button>
      <span className={h.buddyMore}>
        <HeroButton variant="ghost" size="sm" isIconOnly title="伙伴" aria-label="伙伴" onPress={() => go(pageHref("buddy"))}><Ellipsis {...ICON} /></HeroButton>
      </span>
    </div>
  );
}

export function LeftColumn({ data, view, buddy, go, phone, account, today, machine = null, trail, top, month, onRetryPlan, projects, archived, actions = null, onCreate, folderLimit = LOCAL_PROJECT_FOLDER_LIMIT, working, seen, onOpen, meetingSlot = null, waitingCount = data.waiting.length, meetingsTrail = null, monthTrail = null }: {
  data: WorkHomeData;
  /** 「今天」行行尾等你的件数：和首页同一份清单（focusList）的全部件数，不是露出来的 5 件。 */
  waitingCount?: number;
  /** 开会：「会议」行行尾那一颗（MeetingControl）；不给就没有。 */
  meetingSlot?: ReactNode;
  view: View;
  buddy: Buddy | null;
  go: (href: string) => void;
  phone: boolean;
  account: Account;
  /** 「11 月 7 日 周六」。 */
  today: string;
  /** 这台电脑（本人行尾的点，第 73 条）；手机上不给。 */
  machine?: { alert: boolean; word: string } | null;
  /** 手机：「今天」行行尾的后台任务按钮。 */
  trail?: ReactNode;
  /** 手机首屏：「今天」行下面先放「等你」。 */
  top?: ReactNode;
  /** 月份 chip（「复盘」「11 月待敲定」）：画在「本月」行行尾，点了进那个月份页。 */
  month?: { href: string; label: string } | null;
  /** 「会议」行行尾：下一场还没进等你的会（「14:30」「明天 09:30」「11/18」）。 */
  meetingsTrail?: string | null;
  /** 「本月」行行尾：下一个验收时间点（「11/18 验收」）；有 chip 时不画。 */
  monthTrail?: string | null;
  /** 计划读不到：树最上面一行「本体读取失败」加「重试」。 */
  onRetryPlan?: (() => void) | null;
  /** 项目（已排好序，16.2）和已归档的。 */
  projects: Project[];
  archived: Project[];
  /** 行尾「…」菜单（35 条）；不给就不画。 */
  actions?: RowActions | null;
  /** 新建一个项目（POST /api/me/projects，选了文件夹的建好后绑上），回它的 id（建好直接进项目页）；没建成在弹窗里写「失败 · 重试」。 */
  onCreate: (name: string, folderIds: string[]) => Promise<string>;
  /** 一个项目最多绑几个文件夹（老的本机程序是 1）。 */
  folderLimit?: number;
  /** 蓝点「点了就藏」（25 条）：这一页里刚看过的（见 lib/home/seen），和点行时在跳页之前记一下。 */
  seen?: SeenMarks;
  onOpen?: (kind: SeenKind, id: string, marker: string | null) => void;
  /** 正在后台干活的项目（projectWorking）：标题右边一颗闪的灰点。 */
  working?: ReadonlySet<string>;
}) {
  const name = buddy?.name?.trim() || "伙伴";
  const atHome = view.kind === "home";
  // 等你的计数只在首页不写（首页下面就是等你那一块）；月份页上照写。
  const showCount = view.kind !== "home";
  const tree = useRef<HTMLDivElement>(null);
  const [naming, setNaming] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const archivedCount = archived.length;
  // 新建项目的弹窗里有没有文件夹那一块：这台电脑连着本机程序才有（手机、没装的没有）。
  const localReady = useContext(LocalContext)?.phase === "ready";
  return (
    <SeenContext.Provider value={{ seen, onOpen }}>
    <ActionsContext.Provider value={actions}>
    <nav className={h.leftInner} aria-label="导航">
      <BuddyCard buddy={buddy} name={name} view={view} go={go} />
      {phone ? (
        <div className={h.today} data-phone="" data-testid="today-row">
          <span className={h.todayIcon}><House {...ICON} /></span><span className={h.todayText}>{today}</span>
          {trail ? <span className={h.todayTrail}>{trail}</span> : null}
        </div>
      ) : (
        <button type="button" className={h.today} aria-current={atHome ? "page" : undefined} onClick={() => go(HOME_HREF)} data-testid="today-row">
          <span className={h.todayIcon}><House {...ICON} /></span><span className={h.todayText}>{today}</span>
          {showCount && waitingCount ? <span className={h.count}><i aria-hidden />{waitingCount}</span> : null}
        </button>
      )}
      {top}
      {/* 会议、本月（11/16 重新设计第 3 节）：和「今天」行同一种行；行尾是下一场会、下一个验收时间点。手机上接在「等你」下面。 */}
      {/* 开会那一颗（设计 4.1）和行按钮并排、定位到行尾（按钮里不能再套按钮）。 */}
      <div className={h.meetRow}>
        <button type="button" className={h.today} aria-current={view.kind === "meetings" ? "page" : undefined} onClick={() => go(MEETINGS_HREF)} data-testid="meetings-row">
          <span className={h.todayIcon}><CalendarDays {...ICON} /></span><span className={h.todayText}>会议</span>
          {meetingsTrail ? <span className={h.rowTrail}>{meetingsTrail}</span> : null}
        </button>
        {meetingSlot}
      </div>
      <button type="button" className={h.today} aria-current={view.kind === "month" ? "page" : undefined} onClick={() => go(monthHref(data.period))} data-testid="month-row">
        <span className={h.todayIcon}><Target {...ICON} /></span><span className={h.todayText}>本月</span>
        {/* 月份的事（复盘、敲定）有 chip 时只画 chip；chip 点了单独进那个月份（整行进当月）。 */}
        {month ? <span className={h.statusChip} data-testid="month-chip" onClick={(event) => { event.stopPropagation(); go(month.href); }}>{month.label}</span>
          : monthTrail ? <span className={h.rowTrail}>{monthTrail}</span> : null}
      </button>
      <div className={h.tree} ref={tree} onKeyDown={(event) => treeKeys(event, tree.current)}>
        {onRetryPlan ? <p className={h.planFailed} data-testid="plan-read-failed">本体读取失败<HeroButton variant="ghost" size="sm" onPress={onRetryPlan}>重试</HeroButton></p> : null}
        <section aria-label="项目" className={h.group}>
          <div className={h.groupHead}>
            <span>项目</span>
            {archivedCount ? (
              <button type="button" className={h.groupAdd} title={`已归档 ${archivedCount}`} aria-label={`已归档 ${archivedCount}`} aria-pressed={archivedOpen}
                onClick={() => setArchivedOpen(!archivedOpen)} data-testid="tree-archived"><Archive size={14} strokeWidth={1.8} aria-hidden /></button>
            ) : null}
            <button type="button" className={h.groupAdd} title="新建项目" aria-label="新建项目" onClick={() => setNaming(true)} data-testid="project-add"><Plus size={14} strokeWidth={1.8} aria-hidden /></button>
          </div>
          {naming ? (
            <NewProjectDialog withFolders={!phone && localReady} limit={folderLimit} onClose={() => setNaming(false)}
              onCreate={(name, folderIds) => onCreate(name, folderIds).then((id) => go(projectHref(id)))} />
          ) : null}
          {projects.map((project) => <ProjectNode key={project.id} project={project} view={view} go={go} personId={account.personId} working={!!working?.has(project.id)} />)}
        </section>
        {archivedOpen && archivedCount ? (
          <section aria-label="已归档" className={h.group}>
            <p className={h.groupTitle}>已归档</p>
            {archived.map((project) => <ProjectNode key={project.id} project={project} view={view} go={go} personId={account.personId} />)}
          </section>
        ) : null}
        {data.other.items.length ? (
          <section aria-label="其他" className={h.group}>
            <p className={h.groupTitle}>其他</p>
            <Items items={data.other.items} personId={account.personId} go={go} />
          </section>
        ) : null}
      </div>
      <PersonRow account={account} view={view} machine={machine} go={go} />
    </nav>
    </ActionsContext.Provider>
    </SeenContext.Provider>
  );
}

/** 树的键盘：在树里的可聚焦行之间 ↑↓；回车由按钮自己打开。 */
function treeKeys(event: KeyboardEvent<HTMLDivElement>, root: HTMLDivElement | null) {
  if (!root || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
  const active = document.activeElement instanceof HTMLElement && root.contains(document.activeElement) ? document.activeElement : null;
  const rows = [...root.querySelectorAll<HTMLElement>("[data-tree-row]")];
  const index = active ? rows.indexOf(active) : -1;
  if (index < 0) return;
  event.preventDefault();
  rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
}

/**
 * 项目行（16.2、47 条；设计 4.1 只留项目自己）：名字一行（转交中、交出去了、预算 80% 时多一行小字）；行尾一颗点、信息按钮、「…」。
 * 本人事项列在下面。
 */
function ProjectNode({ project, view, go, personId, working = false }: {
  project: Project; view: View; go: (href: string) => void; personId?: string | null; working?: boolean;
}) {
  // 老地址 /me/work/tasks/<id>（等你那一行、14.3 的定位）画的也是这个项目：那件 Task 挂在这里就算在看它。
  const here = ((view.kind === "project" || view.kind === "projectInfo") && view.id === project.id)
    || ((view.kind === "task" || view.kind === "info") && project.goals.some((goal) => goal.taskId === view.taskId));
  const page = here && (view.kind === "project" || view.kind === "task");
  const items = [...project.items].sort((a, b) => Number(a.status === "done") - Number(b.status === "done"));
  const info = view.kind === "projectInfo" && here;
  const opened = useContext(SeenContext);
  const line = projectLine(project);
  // 名字被截断时悬停、键盘聚焦出完整名字。
  const nameTip = useNameTip(project.name);
  const actions = useContext(ActionsContext);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // 名字放不下时才在右端淡出：淡出只在真被截断时加，不然最后几个字会被淡掉。
  const [cut, setCut] = useState(false);
  useEffect(() => {
    const text = nameTip.textRef.current;
    if (!text || typeof ResizeObserver === "undefined") return;
    const check = () => setCut(isTruncated(text));
    check();
    const observer = new ResizeObserver(check);
    observer.observe(text);
    return () => observer.disconnect();
  }, [nameTip.textRef, project.name, renaming]);
  const press = useLongPress(() => setMenu(true));
  const unseen = showUnseen(project.unseen, opened.seen, "project", project.id, project.lastActivity);
  // 行尾「…」（35 条）：重命名、标为已读、转交给…（进项目详情里那一处）、归档 / 恢复、删除（撤不回，删成了回首页）。
  const menuItems: RowMenuItem[] = actions ? [
    { id: "rename", label: "重命名", run: () => setRenaming(true) },
    { id: "read", label: "标为已读", disabled: !unseen, run: () => opened.onOpen?.("project", project.id, project.lastActivity) },
    ...(project.archived ? [] : [{ id: "transfer", label: "转交给…", run: () => go(projectInfoHref(project.id)) }]),
    { id: "archive", label: project.archived ? "恢复" : "归档", run: () => actions.archiveProject(project.id, !project.archived), failText: () => "没改成" },
    { id: "delete", label: "删除", danger: true, run: async () => { await actions.deleteProject(project.id); go(HOME_HREF); }, failText: deleteProjectFail },
  ] : [];
  const rename = (name: string | null) => {
    setRenaming(false);
    if (name && actions) void actions.renameProject(project.id, name).catch(() => showWorkspaceToast({ text: "没改成" }));
  };
  return (
    <div className={h.taskNode} data-testid="tree-project" data-done={project.archived ? "" : undefined}>
      {renaming ? <RenameInput value={project.name} maxLength={60} onDone={rename} /> : (
      <div className={h.taskRow} data-current={page ? "" : undefined} {...press}>
        {/* 名字按钮按字宽排，点的范围用 ::after 铺满整行（信息按钮、「…」盖在上面各管各的）。 */}
        <button type="button" className={`${h.taskMain} ${h.projectMain}`} onClick={() => { opened.onOpen?.("project", project.id, project.lastActivity); go(projectHref(project.id)); }} aria-current={page ? "page" : undefined} data-tree-row="" {...nameTip.rowProps}>
          <span className={`${h.taskText} ${h.projectText}`}>
            <span ref={nameTip.textRef} className={h.taskName} data-cut={cut ? "" : undefined}>{project.name}</span>
            {line ? <span className={h.taskSub} data-warning={line.warning ? "" : undefined}>{line.text}</span> : null}
          </span>
        </button>
        {/* 行尾一颗点（34、47 条，和子会话行同一个位置、同样大小）：等你黄点 → 在后台干活闪的灰点（读屏读「在后台工作」）→ 没看过的新回复蓝点。 */}
        {project.waiting ? <span className={`${h.subDot} ${h.projectDot}`} data-tone="attention" role="img" aria-label="等你" data-testid="project-waiting"><i aria-hidden /></span>
          : working ? <span className={`${h.subDot} ${h.projectDot}`} data-tone="running" data-testid="project-working"><i aria-hidden /><span className={h.srOnly}>在后台工作</span></span>
          : unseen ? <span className={`${h.subDot} ${h.projectDot}`} data-tone="stopped" role="img" aria-label="有新回复" data-testid="project-unseen"><i aria-hidden /></span> : null}
        {nameTip.tip}
        <span className={h.info} data-on={info ? "" : undefined} data-menu={actions ? "" : undefined}>
          <HeroButton variant="ghost" size="sm" isIconOnly title="详情" aria-label={`${project.name} 详情`} aria-pressed={info}
            onPress={() => go(info ? projectHref(project.id) : projectInfoHref(project.id))} data-testid="project-info"><Info {...ICON} /></HeroButton>
        </span>
        {actions ? <RowMenu label={project.name} items={menuItems} open={menu} onOpenChange={setMenu} /> : null}
      </div>
      )}
      {items.length ? <div className={h.branch}><Items items={items} personId={personId} go={go} /></div> : null}
    </div>
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
