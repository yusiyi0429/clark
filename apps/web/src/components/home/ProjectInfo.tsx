"use client";

/**
 * 项目详情（新首页设计 16.3「详情」，替换 Task 详情的入口）。文档类页面（5.4.7）：
 * - 目标历史：每月一行，写月份、Task 名和判定（GET /api/me/projects/:projectId 的 goals：已完成、已停止、已延续；没了结的本月写「进行中」、之前月份写「未了结」）；
 * - 文件夹：这台电脑上的哪个文件夹（连接页加过的那些），能换、能不绑；
 * - 改名、归档（归档的能取消），调 PATCH /api/me/projects/:projectId，没成写「失败 · 重试」；
 * - 当前那件 Task 的预算、完成标准、约定、交付物：沿用原来 Task 详情的样子（TaskBudget、TaskDeliverable）。
 */
import { useEffect, useState } from "react";
import type { TProjectGoalVerdict } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { readProject } from "@/lib/board/cloud";
import { FailedLine, failureOf, type Failure } from "@/components/work/DecisionBox";
import type { Person, Transfer } from "@/lib/home/transfer";
import { ArrowLeft } from "lucide-react";
import { Dropdown } from "@heroui/react";
import { HeroButton } from "@/components/HeroButton";
import { TaskDeliverable } from "@/components/member/home/deliverable/TaskDeliverable";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { mainGoal, projectHref, type Project } from "@/lib/home/projects";
import { useViewChrome } from "./view";
import { TaskBudget } from "./TaskBudget";
import { ICON } from "./StateIcon";
import h from "@/styles/home.module.css";

export type ProjectActions = {
  rename: (id: string, name: string) => Promise<void>;
  archive: (id: string, archived: boolean) => Promise<void>;
  setFolder: (id: string, folder: string | null) => void;
  startTransfer: (project: Project, from: Person, to: Person) => void;
  updateTransfer: (projectId: string, patch: Partial<Transfer>) => void;
};

/** 人员目录（转给谁）：GET /api/people/directory，去掉自己。 */
function usePeople(me: string): Person[] {
  const [people, setPeople] = useState<Person[]>([]);
  useEffect(() => {
    let alive = true;
    void browserApi.GET("/api/people/directory").then(({ data }) => {
      if (alive && data) setPeople(data.people.filter((person) => person.personId !== me).map((person) => ({ personId: person.personId, name: person.displayName })));
    }, () => undefined);
    return () => { alive = false; };
  }, [me]);
  return people;
}

type HistoryRow = { taskId: string; period: string; name: string; verdict: TProjectGoalVerdict };
const VERDICT: Record<Exclude<TProjectGoalVerdict, "open">, string> = { completed: "已完成", stopped: "已停止", continued: "已延续" };

/** 目标历史：项目详情接口的（月份从近到远）；读不到（接口没上）时用首页数据里挂着的，做完了算已完成。 */
function useHistory(project: Project): HistoryRow[] {
  const [rows, setRows] = useState<{ id: string; rows: HistoryRow[] } | null>(null);
  useEffect(() => {
    let alive = true;
    void readProject(project.id).then((detail) => {
      if (alive && detail) setRows({ id: project.id, rows: detail.goals.map((goal) => ({ taskId: goal.taskId, period: goal.period, name: goal.taskName, verdict: goal.verdict })) });
    }, () => undefined);
    return () => { alive = false; };
  }, [project.id]);
  if (rows?.id === project.id) return rows.rows;
  return [...project.goals].sort((a, b) => b.period.localeCompare(a.period))
    .map((goal) => ({ taskId: goal.taskId, period: goal.period, name: goal.name, verdict: goal.completedAt ? "completed" : "open" }));
}

export function ProjectInfo({ project, period, go, actions, doneDefinitionOf, me }: {
  project: Project;
  /** 这个月（YYYY-MM）。 */
  period: string;
  go: (href: string) => void;
  actions: ProjectActions;
  doneDefinitionOf: (taskId: string) => string | null;
  /** 本人（转出时是「从谁」）。 */
  me: Person;
}) {
  const people = usePeople(me.personId);
  const transfer = project.transfer;
  const chrome = useViewChrome();
  const local = useLocalRunner();
  const [name, setName] = useState(project.name);
  const [failed, setFailed] = useState<Failure | null>(null);
  const history = useHistory(project);
  const goal = mainGoal(project);
  const verdict = (row: HistoryRow) => (row.verdict !== "open" ? VERDICT[row.verdict] : row.period === period ? "进行中" : "未了结");
  const attempt = (run: () => Promise<unknown>) => {
    const once = () => { setFailed(null); void run().catch((error) => setFailed(failureOf(error, once))); };
    once();
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
            {history.length ? (
              <ul className={h.history}>
                {history.map((entry) => (
                  <li key={entry.taskId}>
                    <span className={h.num}>{Number(entry.period.slice(5))} 月</span>
                    <span className={h.historyName}>{entry.name}</span>
                    <span className={h.statusChip} data-static="">{verdict(entry)}</span>
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
            <form className={h.infoRow} onSubmit={(event) => { event.preventDefault(); const next = name.trim(); if (next && next !== project.name) attempt(() => actions.rename(project.id, next)); }}>
              <input className={h.projectName} value={name} maxLength={60} aria-label="项目名" onChange={(event) => setName(event.target.value)} data-testid="project-rename" />
              <HeroButton variant="tertiary" size="sm" type="submit" isDisabled={!name.trim() || name.trim() === project.name}>改名</HeroButton>
              <HeroButton variant="ghost" size="sm" onPress={() => attempt(() => actions.archive(project.id, !project.archived))} data-testid="project-archive">{project.archived ? "取消归档" : "归档"}</HeroButton>
              {failed ? <FailedLine inline {...failed} /> : null}
            </form>
          </section>
          <section aria-label="转交" className={h.section}>
            <p className={h.sectionTitle}>转交</p>
            <div className={h.infoRow}>
              {transfer && transfer.status !== "accepted" ? (
                <>
                  <span className={h.line}>{transfer.status === "sent" ? `等 ${transfer.to.name} 接手` : `准备交接给 ${transfer.to.name}`}</span>
                  <HeroButton variant="ghost" size="sm" onPress={() => actions.updateTransfer(project.id, { status: "withdrawn", decidedAt: new Date().toISOString() })} data-testid="transfer-withdraw">撤回</HeroButton>
                </>
              ) : transfer ? <span className={h.line}>已交给 {transfer.to.name}</span> : (
                <Dropdown>
                  <Dropdown.Trigger className={h.sendTo} data-testid="transfer-to"><b>转给…</b></Dropdown.Trigger>
                  <Dropdown.Popover placement="bottom start" offset={8} className={h.pop}>
                    <Dropdown.Menu aria-label="转给" className={`${h.menuList} ${h.menuScroll}`} onAction={(key) => {
                      const person = people.find((entry) => entry.personId === key);
                      if (!person) return;
                      actions.startTransfer(project, me, person);
                      go(projectHref(project.id));
                    }}>
                      {people.map((person) => <Dropdown.Item key={person.personId} id={person.personId} textValue={person.name} className={h.menuItem}>{person.name}</Dropdown.Item>)}
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown>
              )}
            </div>
          </section>
          {goal ? (
            <section aria-label="当前目标" className={h.section}>
              <p className={h.sectionTitle}>{Number(goal.period.slice(5))} 月目标 · {goal.name}</p>
              {goal.missionTitle || doneDefinition ? (
                <div className={h.infoLead}>
                  <span>{[goal.missionTitle, `${goal.due} 验收`].filter(Boolean).join(" · ")}</span>
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
