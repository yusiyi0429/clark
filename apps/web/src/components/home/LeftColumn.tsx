"use client";

/**
 * 左栏（新首页设计第 3 节）：最上面是伙伴形象，点了进总管线；进去以后这个位置换成「回到首页」。
 * 在 Task 管线、详情、子会话里，伙伴形象右边多一个回首页的小图标。手机首屏这一行右端是后台任务的图标（和对话页头同一个）。
 * 下面按 Mission 分组（之前月份没了结的 Mission 标出「10 月」，不按月份硬切）列 Task：标题加一行小字，标题右边的信息图标鼠标移上去才显示（手机上一直显示）。
 * Task 下面缩进一条竖线，是子会话，一行一个，状态用图标。不归任何 Task 的子会话放在最下面一组「其他」，没有就不显示。
 * 最底下一行是本人：头像加名字，点开是原来的个人菜单（设置、伙伴形象、换头像、退出登录…），旁边是插件页。
 */
import { useState, type ReactNode } from "react";
import { House, Info, Puzzle } from "lucide-react";
import { AccountMenu, type Account } from "@/components/AccountMenu";
import { BuddyMark } from "@/components/buddy/BuddyMark";
import type { Buddy } from "@/components/buddy/useBuddy";
import { BUDDY_HREF, HOME_HREF, cardHref, infoHref, monthLabel, taskHref, topicHref } from "@/lib/home/derive";
import type { HomeTask, SubSession, WorkHomeData } from "@/lib/home/types";
import { StateIcon } from "./StateIcon";
import { useViewChrome, type View } from "./view";
import h from "@/styles/home.module.css";

const ICON = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;
export const subHref = (sub: Pick<SubSession, "kind" | "id">) => (sub.kind === "card" ? cardHref(sub.id) : topicHref(sub.id));

export function LeftColumn({ data, view, buddy, speaking, go, phone, account, top }: {
  data: WorkHomeData;
  view: View;
  buddy: Buddy | null;
  /** 伙伴在说话（总管线的回答进行中）。 */
  speaking: boolean;
  go: (href: string) => void;
  phone: boolean;
  account: Account;
  /** 手机首屏：伙伴下面先放「等你」。 */
  top?: ReactNode;
}) {
  const name = buddy?.name?.trim() || "伙伴";
  const chrome = useViewChrome();
  return (
    <nav className={h.leftInner} aria-label="Task">
      <div className={h.slot}>
        {view.kind === "buddy" && !phone ? (
          <button type="button" className={h.homeBack} onClick={() => go(HOME_HREF)} data-testid="back-home"><House {...ICON} />回到首页</button>
        ) : (
          <>
            <button type="button" className={h.buddy} aria-label={name} title={name} onClick={() => go(BUDDY_HREF)} data-testid="buddy-entry">
              <span className={h.buddyFigure} data-buddy-figure="left"><BuddyMark buddy={buddy} place="sheet" active={speaking} /></span>
            </button>
            {view.kind !== "home" && !phone ? <button type="button" className={h.icon} aria-label="回到首页" title="回到首页" onClick={() => go(HOME_HREF)}><House {...ICON} /></button> : null}
            {phone ? <span className={h.slotTrail}>{chrome.trail}</span> : null}
          </>
        )}
      </div>
      {top}
      <div className={h.tree}>
        {data.missions.filter((mission) => mission.tasks.length).map((mission) => (
          <section key={mission.missionId} aria-label={mission.title} className={h.group}>
            <p className={h.groupTitle}>{mission.title}{mission.period !== data.period ? <span>{monthLabel(mission.period)}</span> : null}</p>
            {mission.tasks.map((task) => <TaskNode key={task.taskId} task={task} view={view} go={go} />)}
          </section>
        ))}
        {data.other.subSessions.length ? (
          <section aria-label="其他" className={h.group}>
            <p className={h.groupTitle}>其他</p>
            <Subs subs={data.other.subSessions} view={view} go={go} />
          </section>
        ) : null}
      </div>
      <div className={h.me}>
        <AccountMenu account={account} onNavigate={go} />
        <button type="button" className={h.icon} aria-label="插件" title="插件" onClick={() => go("/me/plugins")}><Puzzle {...ICON} /></button>
      </div>
    </nav>
  );
}

/** 完成的子会话（验收过、合回了）收进折叠的「已完成 N」（设计第 4.5 条），不删，点开还能看；本人确认 Task 完成以后全部收进去，Task 行打勾。 */
function TaskNode({ task, view, go }: { task: HomeTask; view: View; go: (href: string) => void }) {
  const here = (view.kind === "task" || view.kind === "info") && view.taskId === task.taskId;
  const [open, setOpen] = useState(false);
  const folded = task.subSessions.filter((sub) => task.completedAt || sub.state === "done");
  const live = task.subSessions.filter((sub) => !folded.includes(sub));
  const viewing = folded.some((sub) => (view.kind === "card" || view.kind === "topic") && view.kind === sub.kind && view.id === sub.id);
  const expanded = open || viewing;
  return (
    <div className={h.taskNode} data-testid="tree-task">
      <div className={h.taskRow} data-current={view.kind === "task" && here ? "" : undefined}>
        <button type="button" className={h.taskMain} onClick={() => go(taskHref(task.taskId))} aria-current={view.kind === "task" && here ? "page" : undefined}>
          <span className={h.taskName}>{task.name}{task.completedAt ? <StateIcon state="done" /> : null}</span>
          {task.subtitle ? <span className={h.taskSub}>{task.subtitle}</span> : null}
        </button>
        <button type="button" className={h.info} aria-label={`${task.name} 详情`} title="详情" aria-pressed={view.kind === "info" && here}
          onClick={() => go(view.kind === "info" && here ? taskHref(task.taskId) : infoHref(task.taskId))} data-testid="task-info"><Info {...ICON} /></button>
      </div>
      {live.length ? <Subs subs={live} view={view} go={go} /> : null}
      {folded.length ? (
        <div className={h.fold}>
          <button type="button" className={h.foldToggle} aria-expanded={expanded} onClick={() => setOpen(!expanded)} data-testid="tree-done">已完成 {folded.length}</button>
          {expanded ? <Subs subs={folded} view={view} go={go} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function Subs({ subs, view, go }: { subs: SubSession[]; view: View; go: (href: string) => void }) {
  return (
    <ul className={h.subs}>
      {subs.map((sub) => {
        const current = (view.kind === "card" || view.kind === "topic") && view.kind === sub.kind && view.id === sub.id;
        return (
          <li key={`${sub.kind}:${sub.id}`}>
            <button type="button" className={h.sub} data-state={sub.state} aria-current={current ? "page" : undefined} onClick={() => go(subHref(sub))} data-testid="tree-sub">
              <StateIcon state={sub.state} /><span>{sub.title}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
