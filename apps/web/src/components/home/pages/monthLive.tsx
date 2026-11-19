"use client";

/**
 * 当月月份页上每件 Task 从首页数据（work-home）里取的几样（11/19 本月页改成 DRI 的根据地）：等你几件（行尾「等你 N」）、
 * 挂着的项目（展开里点项目名进这件 Task 的管线），没挂的「挂到…」。只有当月有，由外壳传进月份页。
 */
import { useMemo, useState, type ReactNode } from "react";
import { Dropdown } from "@heroui/react";
import { Plus } from "lucide-react";
import { FailedLine, failureOf, type Failure } from "@/components/work/DecisionBox";
import { monthTaskSubs } from "@/lib/home/derive";
import type { Project } from "@/lib/home/projects";
import type { HomeMonthMission, WorkHomeData } from "@/lib/home/types";
import type { WorkHomeApi } from "@/lib/home/useWorkHome";
import { ICON } from "../StateIcon";
import type { ProjectsApi } from "../useProjects";
import h from "@/styles/home.module.css";

export type MonthExtras = { waiting: number; project: { projectId: string; name: string } | null; attach: ReactNode | null };
type HomeTask = HomeMonthMission["tasks"][number];

/** 一件 Task 等你几件：「等你」里归这件 Task 的条数，和它的子会话自己在等的取大的（子会话按看板的卡和 worker 认）。 */
function useWaiting(data: WorkHomeData, api: WorkHomeApi) {
  const { workers, boards } = api.work;
  const subs = useMemo(() => [...data.projects.flatMap((project) => project.subSessions), ...data.other.subSessions], [data.projects, data.other.subSessions]);
  return (taskId: string) => Math.max(data.waiting.filter((item) => item.taskId === taskId).length,
    monthTaskSubs(taskId, subs, workers, boards[taskId]?.cards).filter((sub) => sub.state === "waiting" && !!sub.waiting).length);
}

/** 给月份页的 extras：按 taskId 取这件 Task 等你几件、挂着的项目，没挂的「挂到…」。 */
export function useMonthExtras({ data, api, projects }: { data: WorkHomeData; api: WorkHomeApi; projects: ProjectsApi }) {
  const waiting = useWaiting(data, api);
  const tasks = data.month.missions.filter((mission) => mission.period === data.period).flatMap((mission) => mission.tasks);
  return (key: { taskId: string; missionId: string }): MonthExtras => {
    const task = tasks.find((entry) => entry.taskId === key.taskId);
    return { waiting: waiting(key.taskId), project: task?.project ?? null, attach: task && !task.project ? <AttachSlot task={task} projects={projects} /> : null };
  };
}

/** 没挂上的「挂到…」：选现有项目（PUT 挂接）或用 Task 名新建一个挂上（POST 带 taskId）；没成写「失败 · 重试」。 */
function AttachSlot({ task, projects }: { task: HomeTask; projects: ProjectsApi }) {
  const [failed, setFailed] = useState<Failure | null>(null);
  const attempt = (run: () => Promise<unknown>) => {
    const once = () => { setFailed(null); void run().catch((error) => setFailed(failureOf(error, once))); };
    once();
  };
  if (failed) return <FailedLine inline {...failed} />;
  return <AttachMenu taskName={task.name} projects={projects.projects} onPick={(projectId) => attempt(() => projects.actions.attach(task.taskId, projectId))}
    onCreate={() => attempt(() => projects.actions.create(task.name, task.taskId))} />;
}

/** 没挂项目的 Task 后面「挂到…」（16.4）：点开选现有项目（「随手」不列，本人 11/19），或者用 Task 名新建一个挂上。 */
function AttachMenu({ taskName, projects, onPick, onCreate }: { taskName: string; projects: Project[]; onPick: (projectId: string) => void; onCreate: () => void }) {
  return (
    <Dropdown>
      <Dropdown.Trigger className={h.statusChip} data-testid="task-attach">挂到</Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end" offset={8} className={h.pop}>
        <Dropdown.Menu aria-label="挂到" className={h.menuList} onAction={(key) => (key === "new" ? onCreate() : onPick(String(key)))}>
          <Dropdown.Section className={h.menuSection}>
            {projects.filter((project) => !project.scratch).map((project) => <Dropdown.Item key={project.id} id={project.id} textValue={project.name} className={h.menuItem}>{project.name}</Dropdown.Item>)}
          </Dropdown.Section>
          <Dropdown.Section className={h.menuSection}>
            <Dropdown.Item key="new" id="new" textValue={`新建「${taskName}」`} className={h.menuItem}><Plus {...ICON} />新建「{taskName}」</Dropdown.Item>
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
