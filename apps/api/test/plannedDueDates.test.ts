import { afterEach, describe, expect, it } from "vitest";
import type { PlanTask } from "../src/planTasks.js";
import { BOARD_TASKS, boardFixture } from "./boardFixture.js";

/**
 * 「原」验收时间点固定下来（本人 11/19 定）：没单独定日子的 Task，天枢第一次读到它时把当时最近的 Mission 节点记下来，之后不往后滚；
 * 过了没交就留在那一段显示「已过 N 天」。上线前就有的 Task 基准日取它所在 Mission 进天枢的日子（missions 建行时间），上线后才出现的用第一次读到的那天。
 * 本人改过日子的以改的为准，「原」是记下的那个。本人负责 11 月的 Mission「mine」（11/01 进天枢，节点 11/18、11/30）。
 */
async function fixture(now: Date) {
  const clock = { now };
  const tasks: PlanTask[] = BOARD_TASKS.map((task) => ({ ...task, criteria: [...task.criteria] }));
  const f = await boardFixture({ monthlyNow: () => clock.now,
    planTasks: async (missions) => tasks.filter((task) => missions.some((mission) => mission.id === task.missionId)) }, { boardCloudAgents: false });
  await f.t.sql(`UPDATE missions SET milestones='["11/18 V1 上线","11/30 V2 上线"]',created_at='2026-11-01T02:00:00Z' WHERE id='mine'`);
  const task = async (taskId: string) => ((await f.call("GET", "/api/me/months/2026-11")).json().tasks as { taskId: string; dueDate: string | null; missionDueDate: string | null }[])
    .find((entry) => entry.taskId === taskId)!;
  return { ...f, clock, tasks, task };
}

describe("「原」验收时间点", () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  afterEach(async () => { await f?.close(); f = undefined; });

  it("过了节点没交的件留在原段：11/19 第一次读到，上线前就有的件按 Mission 进天枢的日子记成 11/18，不是 11/30", async () => {
    const g = f = await fixture(new Date("2026-11-19T02:00:00.000Z"));
    expect(await g.task("task-open")).toMatchObject({ dueDate: "2026-11-18", missionDueDate: "2026-11-18" });
    // 项目目标条、首页计划读的也是这一个。
    const project = (await g.call("POST", "/api/me/projects", { name: "对话质量", taskId: "task-open" })).json().projectId as string;
    const goal = ((await g.call("GET", "/api/me/work-home")).json().projects as { projectId: string; goals: { taskId: string; dueDate: string; dueDateSource: string }[] }[])
      .find((entry) => entry.projectId === project)!.goals[0];
    expect(goal).toMatchObject({ taskId: "task-open", dueDate: "2026-11-18", dueDateSource: "mission" });
    expect((await g.call("GET", "/api/me/home-plan")).json().tasks.find((entry: { taskId: string }) => entry.taskId === "task-open").dueDate).toBe("2026-11-18");
  }, 180_000);

  it("第一次读到以后 Mission 节点再变，「原」不变；本人改了以改的为准，「原」照旧是记下的", async () => {
    const g = f = await fixture(new Date("2026-11-06T02:00:00.000Z"));
    expect(await g.task("task-open")).toMatchObject({ dueDate: "2026-11-18", missionDueDate: "2026-11-18" });
    await g.t.sql(`UPDATE missions SET milestones='["11/20 V1 上线","11/30 V2 上线"]' WHERE id='mine'`);
    g.clock.now = new Date("2026-11-19T02:00:00.000Z");
    expect(await g.task("task-open")).toMatchObject({ dueDate: "2026-11-18", missionDueDate: "2026-11-18" });
    expect((await g.call("PUT", "/api/me/tasks/task-open/due-date", { dueDate: "2026-11-25" })).statusCode).toBe(200);
    expect(await g.task("task-open")).toMatchObject({ dueDate: "2026-11-25", missionDueDate: "2026-11-18" });
    // 「原」不算本人改过：唯一一份的 task_due_dates 里只有本人改的那一条。
    expect(await g.t.sql("SELECT task_id,due_date FROM task_due_dates")).toEqual([{ task_id: "task-open", due_date: "2026-11-25" }]);
  }, 180_000);

  it("上线后才在本体出现的 Task 用第一次读到的那天定「原」", async () => {
    const g = f = await fixture(new Date("2026-11-06T02:00:00.000Z"));
    expect((await g.task("task-open")).missionDueDate).toBe("2026-11-18");
    g.clock.now = new Date("2026-11-19T02:00:00.000Z");
    g.tasks.push({ taskId: "task-late", missionId: "mine", name: "后来加的", doneDefinition: null, criteria: ["有方案"] });
    expect(await g.task("task-late")).toMatchObject({ dueDate: "2026-11-30", missionDueDate: "2026-11-30" });
    expect(await g.task("task-open")).toMatchObject({ dueDate: "2026-11-18", missionDueDate: "2026-11-18" });
  }, 180_000);
});
