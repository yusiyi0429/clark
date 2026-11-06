"use client";

/**
 * 左栏只有四个锚点（新首页设计 9.1–9.4、5.4.2）：
 * 1. 伙伴台：正方形，伙伴居中；点了进总管线。伙伴不飞走：在总管线时台子铺选中底、伙伴换成「在听」；任何管线里伙伴在说话时是「在说」。
 *    鼠标移上去右上角出「⋯」，点开「伙伴」二级页。
 * 2. 「今天」行：House +「11 月 7 日 周六」，就是首页（Esc 也回这里）；不在首页时行尾是等你的计数。
 * 3. Mission → Task → 子会话：Mission 组头总是画（之前月份没了结的前面加「10 月 · 」）；Task 行 48 高两行，左边 16 宽的状态位，
 *    右边信息按钮；子会话行 32 高，状态图标对齐 Task 标题；做完的收进「已完成 N」；不归 Task 的进「其他」。
 * 4. 本人行：贴底，头像 24 + 名字，点开个人菜单。
 * 树的键盘：↑↓ 移动，回车打开，→ 展开折叠，← 收起。
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronRight, Ellipsis, House, Info } from "lucide-react";
import type { TWorkerQueueReason } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import type { Account } from "@/components/AccountMenu";
import { BuddyMark } from "@/components/buddy/BuddyMark";
import type { Buddy } from "@/components/buddy/useBuddy";
import { BUDDY_HREF, HOME_HREF, cardHref, infoHref, monthLabel, taskHref, topicHref } from "@/lib/home/derive";
import type { HomeTask, SubSession, WorkHomeData } from "@/lib/home/types";
import { PersonRow } from "./PersonMenu";
import { ICON, StateIcon } from "./StateIcon";
import { pageHref, type View } from "./view";
import h from "@/styles/home.module.css";

export const subHref = (sub: Pick<SubSession, "kind" | "id">) => (sub.kind === "card" ? cardHref(sub.id) : topicHref(sub.id));
const QUEUE_TEXT: Record<TWorkerQueueReason, string> = { not_dispatched: "等开工", slot: "等空位", device_offline: "等本机上线", prior_cards: "等前面的卡" };

export function LeftColumn({ data, view, buddy, speaking, go, phone, account, today, alert, trail, top }: {
  data: WorkHomeData;
  view: View;
  buddy: Buddy | null;
  /** 伙伴在说话（任何一条管线的回答进行中）。 */
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
}) {
  const name = buddy?.name?.trim() || "伙伴";
  const atHome = view.kind === "home" || view.kind === "month";
  const pipelineWaiting = new Set(data.waiting.filter((item) => item.open.kind === "task" && item.taskId).map((item) => item.taskId!));
  const tree = useRef<HTMLDivElement>(null);
  return (
    <nav className={h.leftInner} aria-label="导航">
      <div className={h.stage} data-current={view.kind === "buddy" ? "" : undefined}>
        <button type="button" className={h.stageHit} aria-label={name} aria-current={view.kind === "buddy" ? "page" : undefined} onClick={() => go(BUDDY_HREF)} data-testid="buddy-entry">
          <BuddyMark buddy={buddy} place="stage" active={speaking} listening={view.kind === "buddy" && !speaking} />
        </button>
        <span className={h.stageMore}>
          <HeroButton variant="ghost" size="sm" isIconOnly title="伙伴" aria-label="伙伴" onPress={() => go(pageHref("buddy"))}><Ellipsis {...ICON} /></HeroButton>
        </span>
      </div>
      {phone ? (
        <div className={h.today} data-phone="">
          <span className={h.todayIcon}><House {...ICON} /></span><span className={h.todayText}>{today}</span>
          {trail ? <span className={h.todayTrail}>{trail}</span> : null}
        </div>
      ) : (
        <button type="button" className={h.today} aria-current={atHome ? "page" : undefined} onClick={() => go(HOME_HREF)} data-testid="today-row">
          <span className={h.todayIcon}><House {...ICON} /></span><span className={h.todayText}>{today}</span>
          {!atHome && data.waiting.length ? <span className={h.count}><i aria-hidden />{data.waiting.length}</span> : null}
        </button>
      )}
      {top}
      <div className={h.tree} ref={tree} onKeyDown={(event) => treeKeys(event, tree.current)}>
        {data.missions.filter((mission) => mission.tasks.length).map((mission) => (
          <section key={mission.missionId} aria-label={mission.title} className={h.group}>
            <p className={h.groupTitle}>{mission.period !== data.period ? <span>{monthLabel(mission.period)} · </span> : null}{mission.title}</p>
            {mission.tasks.map((task) => <TaskNode key={task.taskId} task={task} view={view} go={go} waiting={pipelineWaiting.has(task.taskId)} />)}
          </section>
        ))}
        {data.other.subSessions.length ? (
          <section aria-label="其他" className={h.group}>
            <p className={h.groupTitle}>其他</p>
            <Subs subs={data.other.subSessions} view={view} go={go} flat />
          </section>
        ) : null}
      </div>
      <PersonRow account={account} view={view} alert={alert} go={go} />
    </nav>
  );
}

/** 树的键盘：在树里的可聚焦行之间 ↑↓；→ / ← 展开、收起「已完成 N」（焦点在那一行时）。回车由按钮自己打开。 */
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

/** 完成的子会话（验收过、合回了）收进折叠的「已完成 N」（设计第 4.5 条）；本人确认 Task 完成以后全部收进去，Task 行打勾、变淡。 */
function TaskNode({ task, view, go, waiting }: { task: HomeTask; view: View; go: (href: string) => void; waiting: boolean }) {
  const here = (view.kind === "task" || view.kind === "info") && view.taskId === task.taskId;
  const [open, setOpen] = useState(false);
  const folded = task.subSessions.filter((sub) => task.completedAt || sub.state === "done");
  const live = task.subSessions.filter((sub) => !folded.includes(sub));
  const viewing = folded.some((sub) => (view.kind === "card" || view.kind === "topic") && view.kind === sub.kind && view.id === sub.id);
  const expanded = open || viewing;
  const info = view.kind === "info" && here;
  return (
    <div className={h.taskNode} data-testid="tree-task" data-done={task.completedAt ? "" : undefined}>
      <div className={h.taskRow} data-current={view.kind === "task" && here ? "" : undefined}>
        <button type="button" className={h.taskMain} onClick={() => go(taskHref(task.taskId))} aria-current={view.kind === "task" && here ? "page" : undefined} data-tree-row="">
          <span className={h.slotState}>{task.completedAt ? <StateIcon state="done" /> : waiting ? <StateIcon state="waiting" /> : null}</span>
          <span className={h.taskText}>
            <span className={h.taskName}>{task.name}</span>
            {task.subtitle ? <span className={h.taskSub}>{task.subtitle}</span> : null}
          </span>
        </button>
        <span className={h.info} data-on={info ? "" : undefined}>
          <HeroButton variant="ghost" size="sm" isIconOnly title="详情" aria-label={`${task.name} 详情`} aria-pressed={info}
            onPress={() => go(info ? taskHref(task.taskId) : infoHref(task.taskId))} data-testid="task-info"><Info {...ICON} /></HeroButton>
        </span>
      </div>
      {live.length || folded.length ? (
        <div className={h.branch}>
          {live.length ? <Subs subs={live} view={view} go={go} /> : null}
          {folded.length ? (
            <>
              <button type="button" className={h.foldToggle} aria-expanded={expanded} onClick={() => setOpen(!expanded)} data-tree-row="" data-testid="tree-done">
                <ChevronRight {...ICON} className={h.chevron} data-open={expanded ? "" : undefined} />已完成 {folded.length}
              </button>
              {expanded ? <Subs subs={folded} view={view} go={go} /> : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** flat：「其他」组里的，没有上一级，不缩进、不画竖线（状态位在 x=16，名字在 x=40）。 */
function Subs({ subs, view, go, flat = false }: { subs: SubSession[]; view: View; go: (href: string) => void; flat?: boolean }) {
  return (
    <ul className={h.subs} data-flat={flat ? "" : undefined}>
      {subs.map((sub) => {
        const current = (view.kind === "card" || view.kind === "topic") && view.kind === sub.kind && view.id === sub.id;
        const reason = sub.state === "queued" && sub.queueReason ? QUEUE_TEXT[sub.queueReason] : null;
        return (
          <li key={`${sub.kind}:${sub.id}`}>
            <button type="button" className={h.sub} data-state={sub.state} aria-current={current ? "page" : undefined} onClick={() => go(subHref(sub))} data-tree-row="" data-testid="tree-sub">
              <StateIcon state={sub.state} /><span className={h.subName}>{sub.title}</span>
              {reason ? <span className={h.subReason}>{reason}</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
