"use client";

/**
 * 项目详情（新首页设计 16.3「详情」，替换 Task 详情的入口）。文档类页面（5.4.7）：
 * - 目标历史：每月一行，写月份、Task 名和判定（做完了「已完成」、本月的「进行中」、之前月份没了结的「未了结」）；
 * - 文件夹：这台电脑上的哪个文件夹（连接页加过的那些），能换、能不绑；
 * - 改名、归档（归档的能取消）；
 * - 当前那件 Task 的预算、完成标准、约定、交付物：沿用原来 Task 详情的样子（TaskBudget、TaskDeliverable）。
 */
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Dropdown } from "@heroui/react";
import { HeroButton } from "@/components/HeroButton";
import { TaskDeliverable } from "@/components/member/home/deliverable/TaskDeliverable";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { conversationTask, projectHref, type Project } from "@/lib/home/projects";
import { useViewChrome } from "./view";
import { TaskBudget } from "./TaskBudget";
import { ICON } from "./StateIcon";
import h from "@/styles/home.module.css";

export type ProjectActions = {
  rename: (id: string, name: string) => void;
  archive: (id: string, archived: boolean) => void;
  setFolder: (id: string, folder: string | null) => void;
};

export function ProjectInfo({ project, period, go, actions, doneDefinitionOf }: {
  project: Project;
  /** 这个月（YYYY-MM）。 */
  period: string;
  go: (href: string) => void;
  actions: ProjectActions;
  doneDefinitionOf: (taskId: string) => string | null;
}) {
  const chrome = useViewChrome();
  const local = useLocalRunner();
  const [name, setName] = useState(project.name);
  const goal = conversationTask(project);
  const verdict = (taskId: string, goalPeriod: string) => {
    if (project.tasks.find((task) => task.taskId === taskId)?.completedAt) return "已完成";
    return goalPeriod === period ? "进行中" : "未了结";
  };
  const doneDefinition = goal ? doneDefinitionOf(goal.taskId) : null;
  return (
    <div className={h.infoView} data-type-scale="doc" data-testid="project-info-view">
      <header className={h.viewHead}>
        {chrome.lead ?? <button type="button" className={h.icon} aria-label="返回" title="返回" onClick={() => go(projectHref(project.id))}><ArrowLeft {...ICON} /></button>}
        <h1 className={h.viewTitle} tabIndex={-1}><button type="button" className={h.crumb} onClick={() => go(projectHref(project.id))}>{project.name} / </button>详情</h1>
        {chrome.trail}
      </header>
      <div className={h.infoScroll}>
        <div className={h.infoInner}>
          <section aria-label="目标历史" className={h.section}>
            <p className={h.sectionTitle}>目标历史</p>
            {project.goals.length ? (
              <ul className={h.history}>
                {project.goals.map((entry) => (
                  <li key={entry.taskId}>
                    <span className={h.num}>{Number(entry.period.slice(5))} 月</span>
                    <span className={h.historyName}>{entry.name}</span>
                    <span className={h.statusChip} data-static="">{verdict(entry.taskId, entry.period)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className={h.line}>还没有挂过目标</p>}
          </section>
          <section aria-label="文件夹" className={h.section}>
            <p className={h.sectionTitle}>文件夹</p>
            <div className={h.infoRow}>
              <Dropdown>
                <Dropdown.Trigger className={h.sendTo} data-testid="project-folder"><b>{project.folder ?? "不绑"}</b></Dropdown.Trigger>
                <Dropdown.Popover placement="bottom start" offset={8} className={h.pop}>
                  <Dropdown.Menu aria-label="文件夹" className={h.menuList} onAction={(key) => actions.setFolder(project.id, key === "none" ? null : String(key))}>
                    {[...local.folders.map((folder) => <Dropdown.Item key={folder.id} id={folder.label} textValue={folder.label} className={h.menuItem}>{folder.label}</Dropdown.Item>),
                      <Dropdown.Item key="none" id="none" textValue="不绑" className={h.menuItem}>不绑</Dropdown.Item>]}
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown>
            </div>
          </section>
          <section aria-label="名字" className={h.section}>
            <p className={h.sectionTitle}>名字</p>
            <form className={h.infoRow} onSubmit={(event) => { event.preventDefault(); if (name.trim() && name.trim() !== project.name) actions.rename(project.id, name.trim()); }}>
              <input className={h.projectName} value={name} maxLength={60} aria-label="项目名" onChange={(event) => setName(event.target.value)} data-testid="project-rename" />
              <HeroButton variant="tertiary" size="sm" type="submit" isDisabled={!name.trim() || name.trim() === project.name}>改名</HeroButton>
              <HeroButton variant="ghost" size="sm" onPress={() => actions.archive(project.id, !project.archived)} data-testid="project-archive">{project.archived ? "取消归档" : "归档"}</HeroButton>
            </form>
          </section>
          {goal ? (
            <section aria-label="当前目标" className={h.section}>
              <p className={h.sectionTitle}>{Number(goal.period.slice(5))} 月目标 · {goal.name}</p>
              {goal.missionTitle || doneDefinition ? (
                <div className={h.infoLead}>
                  <span>{[goal.missionTitle, goal.due ? `${goal.due} 验收` : null].filter(Boolean).join(" · ")}</span>
                  {doneDefinition ? <p>{doneDefinition}</p> : null}
                </div>
              ) : null}
              <TaskBudget key={`budget:${goal.taskId}`} taskId={goal.taskId} />
              <TaskDeliverable key={goal.taskId} task={{ taskId: goal.taskId }} checkOnOpen />
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
