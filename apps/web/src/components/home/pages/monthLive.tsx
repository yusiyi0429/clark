"use client";

/**
 * 当月月份页上每件 Task 的「现在怎样了」（11/16 重新设计第 6 节：首页的「本月」并进月份页）：
 * 验收时间点（挂着的项目目标的截止日，没挂的退回这个 Mission 下一个验收时间点）、行尾现状（monthStatus，有等你的前面一个橙点）、
 * 本月不止一个项目时的项目名 chip、没挂上的「挂到…」。数据都来自首页数据（work-home），只有当月有，由外壳传进月份页。
 */
import { useMemo, useState, type ReactNode } from "react";
import { Dropdown } from "@heroui/react";
import { Plus } from "lucide-react";
import { FailedLine, failureOf, type Failure } from "@/components/work/DecisionBox";
import { monthStatus, monthTaskSubs, taskGateLabel } from "@/lib/home/derive";
import { projectHref, type Project } from "@/lib/home/projects";
import type { HomeMonthMission, WorkHomeData } from "@/lib/home/types";
import type { WorkHomeApi } from "@/lib/home/useWorkHome";
import { ICON } from "../StateIcon";
import type { ProjectsApi } from "../useProjects";
import h from "@/styles/home.module.css";

export type MonthExtras = { gate: string | null; status: ReturnType<typeof monthStatus> | null; project: ReactNode | null };
type HomeTask = HomeMonthMission["tasks"][number];

/** 「本月」每件 Task 的现状（monthStatus）：子会话从首页数据里取，按看板的卡和 worker 认是哪件 Task 的；做完了的为 null，不写。 */
function useMonthStatus(data: WorkHomeData, api: WorkHomeApi) {
  const { workers, boards } = api.work;
  const subs = useMemo(() => [...data.projects.flatMap((project) => project.subSessions), ...data.other.subSessions], [data.projects, data.other.subSessions]);
  return useMemo(() => {
    const cache = new Map<string, ReturnType<typeof monthStatus> | null>();
    return (task: HomeTask) => {
      if (!cache.has(task.taskId)) {
        const board = boards[task.taskId];
        const planning = workers.some((worker) => worker.kind === "plan" && worker.taskId === task.taskId && worker.state !== "done")
          || board?.plan?.status === "queued" || board?.plan?.status === "running";
        cache.set(task.taskId, task.completedAt ? null
          : monthStatus(monthTaskSubs(task.taskId, subs, workers, board?.cards), data.waiting.filter((item) => item.taskId === task.taskId).length, planning));
      }
      return cache.get(task.taskId)!;
    };
  }, [subs, workers, boards, data.waiting]);
}

/** 给月份页的 extras：按 taskId 取这件 Task 的验收时间点、现状和项目那一格。 */
export function useMonthExtras({ data, api, projects, go }: { data: WorkHomeData; api: WorkHomeApi; projects: ProjectsApi; go: (href: string) => void }) {
  const status = useMonthStatus(data, api);
  const tasks = data.month.missions.filter((mission) => mission.period === data.period).flatMap((mission) => mission.tasks);
  const manyProjects = new Set(tasks.flatMap((task) => (task.project ? [task.project.projectId] : []))).size > 1;
  return (key: { taskId: string; missionId: string }): MonthExtras => {
    const task = tasks.find((entry) => entry.taskId === key.taskId);
    return {
      gate: taskGateLabel(projects.all, api.work.plan, key),
      status: task ? status(task) : null,
      project: task ? <ProjectSlot task={task} showProject={manyProjects} projects={projects} go={go} /> : null,
    };
  };
}

/** 行尾项目那一格：本月不止一个项目时是项目名 chip；没挂上的「挂到…」：选现有项目（PUT 挂接）或用 Task 名新建一个挂上（POST 带 taskId）；没成写「失败 · 重试」。 */
function ProjectSlot({ task, showProject, projects, go }: { task: HomeTask; showProject: boolean; projects: ProjectsApi; go: (href: string) => void }) {
  const [failed, setFailed] = useState<Failure | null>(null);
  const attempt = (run: () => Promise<unknown>) => {
    const once = () => { setFailed(null); void run().catch((error) => setFailed(failureOf(error, once))); };
    once();
  };
  const { project } = task;
  if (failed) return <FailedLine inline {...failed} />;
  if (project) return showProject
    ? <button type="button" className={h.statusChip} onClick={() => go(projectHref(project.projectId))} data-testid="task-project" title={project.name}><span className={h.ellipsis}>{project.name}</span></button>
    : null;
  return <AttachMenu taskName={task.name} projects={projects.projects} onPick={(projectId) => attempt(() => projects.actions.attach(task.taskId, projectId))}
    onCreate={() => attempt(() => projects.actions.create(task.name, task.taskId))} />;
}

/** 没挂项目的 Task 后面「挂到…」（16.4）：点开选现有项目，或者用 Task 名新建一个挂上。 */
function AttachMenu({ taskName, projects, onPick, onCreate }: { taskName: string; projects: Project[]; onPick: (projectId: string) => void; onCreate: () => void }) {
  return (
    <Dropdown>
      <Dropdown.Trigger className={h.statusChip} data-testid="task-attach">挂到</Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end" offset={8} className={h.pop}>
        <Dropdown.Menu aria-label="挂到" className={h.menuList} onAction={(key) => (key === "new" ? onCreate() : onPick(String(key)))}>
          <Dropdown.Section className={h.menuSection}>
            {projects.map((project) => <Dropdown.Item key={project.id} id={project.id} textValue={project.name} className={h.menuItem}>{project.name}</Dropdown.Item>)}
          </Dropdown.Section>
          <Dropdown.Section className={h.menuSection}>
            <Dropdown.Item key="new" id="new" textValue={`新建「${taskName}」`} className={h.menuItem}><Plus {...ICON} />新建「{taskName}」</Dropdown.Item>
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
