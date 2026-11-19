"use client";

/**
 * 项目详情（新首页设计 16.3「详情」，替换 Task 详情的入口）。文档类页面（5.4.7）：
 * - 本月目标（20 条）：本月挂着的 Task 一件一行，写截止和标准进度，点开逐条看（同原来项目对话页头的目标条）；
 * - 往月目标：只放本月以前的月份，按月分组、近的在上，每行写结果（GET /api/me/projects/:projectId 的 goals：完成 / 延续到 X 月 / 到此为止 / 没完成）；没有往月整块不画；
 * - 文件夹（17.2 第 46 条）：这台电脑上绑的几个文件夹，一个一行，能添加、能移除，第一个是工作目录（本机程序 PUT /v1/projects/:projectId/folder）；
 *   没连上本机程序时不出这一节；
 * - 自动接力上限（18.12）：连续自动接力多少轮停下来问本人，缺省 20，可以不限（PATCH autoRelayLimit，不限是 null）；
 * - 转交（16.7）：「转给…」发起一份（POST /api/me/projects/:projectId/transfers），准备中、等接手时能撤回；
 * - 改名、归档（归档的能取消），调 PATCH /api/me/projects/:projectId，没成写「失败 · 重试」；
 * - 当前那件 Task 的验收截止日：日期选择（同其他地方的 DatePicker），本人改了存在天枢里（PUT …/goals/:taskId/due-date），改过的能清掉、退回记下的原验收时间点；
 * - 当前那件 Task 的预算、完成标准、约定、交付物：沿用原来 Task 详情的样子（TaskBudget、TaskDeliverable）。
 * 新首页桌面上项目对话页头的「详情」在右栏打开（side：没有页头，只有这几节）；/info 地址照旧是整页（左栏「转交给…」、手机）。
 */
import { useEffect, useState } from "react";
import type { TProjectGoalVerdict } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { readProject, updateProject } from "@/lib/board/cloud";
import { FailedLine, failureOf, type Failure } from "@/components/work/DecisionBox";
import type { Person } from "@/lib/home/transfer";
import { ArrowLeft } from "lucide-react";
import { Dropdown } from "@heroui/react";
import { HeroButton } from "@/components/HeroButton";
import { DatePicker } from "@/components/ui/DatePicker";
import { TaskDeliverable } from "@/components/member/home/deliverable/TaskDeliverable";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { mainGoal, projectHref, type FolderRef, type Project } from "@/lib/home/projects";
import { AddFolder, FolderList, firstOf } from "./NewProjectDialog";
import { useViewChrome } from "./view";
import { TaskBudget } from "./TaskBudget";
import { GoalBar } from "./ProjectParts";
import { ICON } from "./StateIcon";
import h from "@/styles/home.module.css";

export type ProjectActions = {
  rename: (id: string, name: string) => Promise<void>;
  archive: (id: string, archived: boolean) => Promise<void>;
  setFolders: (id: string, folderIds: string[], name?: string) => Promise<void>;
  setDue: (projectId: string, taskId: string, dueDate: string | null) => Promise<void>;
  transfer: (projectId: string, toPersonId: string) => Promise<void>;
  withdraw: (transferId: string) => Promise<void>;
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
/** 下一个月（YYYY-MM）：延续的那件挂到了下个月。 */
const nextPeriod = (period: string) => {
  const [year, month] = period.split("-").map(Number) as [number, number];
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
};
/** 往月目标一行的结果。 */
export const pastVerdict = (row: Pick<HistoryRow, "period" | "verdict">) => (row.verdict === "completed" ? "完成"
  : row.verdict === "continued" ? `延续到 ${Number(nextPeriod(row.period).slice(5))} 月` : row.verdict === "stopped" ? "到此为止" : "没完成");

/** 自动接力上限的几档（18.12）：缺省 20，null 是不限。 */
const RELAY_LIMITS = [10, 20, 50, 100, null] as const;
const DEFAULT_RELAY_LIMIT = 20;
const relayText = (limit: number | null) => (limit === null ? "不限" : `${limit} 轮`);

/**
 * 项目详情接口读一次：目标历史（月份从近到远；读不到时用首页数据里挂着的，做完了算已完成）和自动接力上限（读不到时当缺省 20）。
 * 改上限先改界面，没改成退回去。
 */
function useDetail(project: Project) {
  const [detail, setDetail] = useState<{ id: string; rows: HistoryRow[]; limit: number | null } | null>(null);
  useEffect(() => {
    let alive = true;
    void readProject(project.id).then((data) => {
      if (alive && data) setDetail({ id: project.id, limit: data.project.autoRelayLimit,
        rows: data.goals.map((goal) => ({ taskId: goal.taskId, period: goal.period, name: goal.taskName, verdict: goal.verdict })) });
    }, () => undefined);
    return () => { alive = false; };
  }, [project.id]);
  const mine = detail?.id === project.id ? detail : null;
  const history: HistoryRow[] = mine ? mine.rows : [...project.goals].sort((a, b) => b.period.localeCompare(a.period))
    .map((goal) => ({ taskId: goal.taskId, period: goal.period, name: goal.name, verdict: goal.completedAt ? "completed" : "open" }));
  const limit = mine ? mine.limit : DEFAULT_RELAY_LIMIT;
  const setLimit = async (next: number | null) => {
    setDetail((prev) => (prev?.id === project.id ? { ...prev, limit: next } : prev));
    try { await updateProject(project.id, { autoRelayLimit: next }); }
    catch (error) { setDetail((prev) => (prev?.id === project.id ? { ...prev, limit } : prev)); throw error; }
  };
  return { history, limit, setLimit };
}

export function ProjectInfo({ project, period, go, actions, folders = [], folderLimit = 1, doneDefinitionOf, me, side = false }: {
  project: Project;
  /** 这台电脑上绑的文件夹（有顺序，第一个是工作目录）和最多能绑几个。 */
  folders?: readonly FolderRef[];
  folderLimit?: number;
  /** 这个月（YYYY-MM）。 */
  period: string;
  go: (href: string) => void;
  actions: ProjectActions;
  doneDefinitionOf: (taskId: string) => string | null;
  /** 本人（转出时是「从谁」）。 */
  me: Person;
  /** 放在右栏里（没有页头）。 */
  side?: boolean;
}) {
  const people = usePeople(me.personId);
  const transfer = project.transfer;
  const chrome = useViewChrome();
  const local = useLocalRunner();
  const [name, setName] = useState(project.name);
  const [failed, setFailed] = useState<Failure | null>(null);
  const [relayFailed, setRelayFailed] = useState<Failure | null>(null);
  const [dueFailed, setDueFailed] = useState<Failure | null>(null);
  const { history, limit, setLimit } = useDetail(project);
  const goal = mainGoal(project);
  // 往月：本月以前的，近的月在上；同一个月只在第一行写月份。
  const past = history.filter((row) => row.period < period).sort((a, b) => b.period.localeCompare(a.period));
  const attempt = (run: () => Promise<unknown>) => {
    const once = () => { setFailed(null); void run().catch((error) => setFailed(failureOf(error, once))); };
    once();
  };
  const doneDefinition = goal ? doneDefinitionOf(goal.taskId) : null;
  const putFolders = (next: readonly FolderRef[]) => attempt(() => actions.setFolders(project.id, next.map((folder) => folder.id), project.name));
  const sections = (
    <>
    {project.current.length ? (
      <section aria-label="本月目标" className={h.section}>
        <p className={h.sectionTitle}>本月目标</p>
        <GoalBar project={project} />
      </section>
    ) : null}
    {past.length ? (
      <section aria-label="往月目标" className={h.section}>
        <p className={h.sectionTitle}>往月目标</p>
        <ul className={h.history} data-testid="past-goals">
          {past.map((entry, index) => (
            <li key={`${entry.period}:${entry.taskId}`}>
              <span className={h.num}>{past[index - 1]?.period === entry.period ? null : `${Number(entry.period.slice(5))} 月`}</span>
              <span className={h.historyName}>{entry.name}</span>
              <span className={h.statusChip} data-static="">{pastVerdict(entry)}</span>
            </li>
          ))}
        </ul>
      </section>
    ) : null}
    {local.phase === "ready" ? (
      <section aria-label="文件夹" className={h.section} data-testid="project-folders">
        <p className={h.sectionTitle}>文件夹</p>
        <FolderList folders={folders} onRemove={(id) => putFolders(folders.filter((folder) => folder.id !== id))} onFirst={(id) => putFolders(firstOf(folders, id))} />
        {folders.length < folderLimit ? (
          <div className={h.infoRow}><AddFolder onPicked={(folder) => { if (!folders.some((entry) => entry.id === folder.id)) putFolders([...folders, folder]); }} /></div>
        ) : null}
      </section>
    ) : null}
    <section aria-label="自动接力上限" className={h.section}>
      <p className={h.sectionTitle}>自动接力上限</p>
      <div className={h.infoRow}>
        <Dropdown>
          <Dropdown.Trigger className={h.sendTo} data-testid="project-relay-limit"><b>{relayText(limit)}</b></Dropdown.Trigger>
          <Dropdown.Popover placement="bottom start" offset={8} className={h.pop}>
            <Dropdown.Menu aria-label="自动接力上限" className={h.menuList} onAction={(key) => {
              const once = () => { setRelayFailed(null); void setLimit(key === "none" ? null : Number(key)).catch((error) => setRelayFailed(failureOf(error, once))); };
              once();
            }}>
              {RELAY_LIMITS.map((entry) => (
                <Dropdown.Item key={entry ?? "none"} id={entry === null ? "none" : String(entry)} textValue={relayText(entry)} className={h.menuItem}>{relayText(entry)}</Dropdown.Item>
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
        {relayFailed ? <FailedLine inline {...relayFailed} /> : null}
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
            <HeroButton variant="ghost" size="sm" onPress={() => attempt(() => actions.withdraw(transfer.id))} data-testid="transfer-withdraw">撤回</HeroButton>
          </>
        ) : transfer ? <span className={h.line}>已交给 {transfer.to.name}</span> : project.archived ? <span className={h.line}>已归档</span> : (
          <Dropdown>
            <Dropdown.Trigger className={h.sendTo} data-testid="transfer-to"><b>转给</b></Dropdown.Trigger>
            <Dropdown.Popover placement="bottom start" offset={8} className={h.pop}>
              <Dropdown.Menu aria-label="转给" className={`${h.menuList} ${h.menuScroll}`} onAction={(key) => {
                const person = people.find((entry) => entry.personId === key);
                if (person) attempt(async () => { await actions.transfer(project.id, person.personId); go(projectHref(project.id)); });
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
            <span>{[goal.missionTitle, goal.due ? `${goal.due} 验收` : null].filter(Boolean).join(" · ")}</span>
            {doneDefinition ? <p>{doneDefinition}</p> : null}
          </div>
        ) : null}
        <div className={h.infoRow} data-testid="goal-due">
          <span className={h.line}>验收截止</span>
          <DatePicker label="验收截止" size="compact" value={goal.dueDate ?? ""} clearable={goal.dueSet} onChange={(value) => {
            const once = () => { setDueFailed(null); void actions.setDue(project.id, goal.taskId, value || null).catch((error) => setDueFailed(failureOf(error, once))); };
            once();
          }} />
          {dueFailed ? <FailedLine inline {...dueFailed} /> : null}
        </div>
        <TaskBudget key={`budget:${goal.taskId}`} taskId={goal.taskId} />
        <TaskDeliverable key={goal.taskId} task={{ taskId: goal.taskId }} checkOnOpen />
      </section>
    ) : null}
    </>
  );
  if (side) return <div className={h.sideInfo} data-type-scale="doc" data-testid="project-info-side">{sections}</div>;
  return (
    <div className={h.infoView} data-type-scale="doc" data-testid="project-info-view">
      <header className={h.viewHead}>
        {chrome.lead ?? <button type="button" className={h.icon} aria-label="返回" title="返回" onClick={() => go(projectHref(project.id))}><ArrowLeft {...ICON} /></button>}
        <h1 className={h.viewTitle} tabIndex={-1}><button type="button" className={h.crumb} onClick={() => go(projectHref(project.id))}>{project.name} / </button><span className={h.ellipsis}>详情</span></h1>
        {chrome.trail}
      </header>
      <div className={h.infoScroll}>
        <div className={h.infoInner}>{sections}</div>
      </div>
    </div>
  );
}
