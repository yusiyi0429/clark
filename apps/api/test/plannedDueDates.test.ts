import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanTask } from "../src/planTasks.js";
import { BOARD_TASKS, boardFixture } from "./boardFixture.js";

/**
 * 「原」验收时间点（本人 11/19 定，协调 11/19 裁定 I-1）：
 * - api 上线后在后台自动补记一次（定时任务 planned_due_dates.backfill）：完整读所有人当月、下月 Mission 下的本体 Task，
 *   按 Mission 进天枢的日子作基准，把最近的节点记成「原」（连 Mission 当时的月份）；补记成功留一个标记，本体读不到不留、下次再补。
 * - 补记之前读的地方一律不写「原」，照今天往后最近的节点现算。
 * - 补记之后，没记过的 Task 一律是新的，按第一次读到那天记；之后不往后滚；Mission 滚到下个月按新月份重记。
 * 本人负责 11 月的 Mission「mine」（11/01 进天枢，节点 11/18、11/30）。
 */
async function fixture(now: Date) {
  const clock = { now };
  const world = { down: false };
  const tasks: PlanTask[] = BOARD_TASKS.map((task) => ({ ...task, criteria: [...task.criteria] }));
  const f = await boardFixture({ monthlyNow: () => clock.now, planTasks: async (missions) => {
    if (world.down) throw new Error("本体读不到");
    return tasks.filter((task) => missions.some((mission) => mission.id === task.missionId));
  } }, { boardCloudAgents: false });
  await f.t.sql(`UPDATE missions SET milestones='["11/18 V1 上线","11/30 V2 上线"]',created_at='2026-11-01T02:00:00Z' WHERE id='mine'`);
  const task = async (taskId: string) => ((await f.call("GET", "/api/me/months/2026-11")).json().tasks as { taskId: string; dueDate: string | null; missionDueDate: string | null }[])
    .find((entry) => entry.taskId === taskId)!;
  const backfill = () => f.t.app.plannedDueDateJobs.handlers["planned_due_dates.backfill"]({},
    { id: randomUUID(), kind: "planned_due_dates.backfill", dedupe_key: "b", attempts: 1, payload: {} });
  const recorded = async () => await f.t.sql("SELECT task_id,mission_id,due_date,period FROM task_planned_due_dates ORDER BY task_id");
  const marked = async () => (await f.t.sql("SELECT 1 FROM task_planned_due_date_backfill")).length > 0;
  return { ...f, clock, world, tasks, task, backfill, recorded, marked };
}

describe("「原」验收时间点", () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  afterEach(async () => { await f?.close(); f = undefined; });

  it("补记之前读的地方不写「原」，照今天往后最近的节点现算", async () => {
    const g = f = await fixture(new Date("2026-11-19T02:00:00.000Z"));
    expect(await g.task("task-open")).toMatchObject({ dueDate: "2026-11-30", missionDueDate: "2026-11-30" });
    expect((await g.call("GET", "/api/me/work-home")).statusCode).toBe(200);
    expect((await g.call("GET", "/api/me/home-plan")).statusCode).toBe(200);
    expect(await g.recorded()).toEqual([]);
    expect(await g.marked()).toBe(false);
  }, 180_000);

  it("补记把上线前就有的件按 Mission 进天枢的日子记：11/19 补记，过了的 11/18 留在原段；项目目标、首页计划读的也是它", async () => {
    const g = f = await fixture(new Date("2026-11-19T02:00:00.000Z"));
    await g.backfill();
    expect(await g.marked()).toBe(true);
    // 补记是完整读，不只是本人的、挂了项目的：别人负责的、别人 Mission 下的都记。
    expect(await g.recorded()).toEqual([
      { task_id: "task-open", mission_id: "mine", due_date: "2026-11-18", period: "2026-11" },
      { task_id: "task-theirs", mission_id: "mine", due_date: "2026-11-18", period: "2026-11" },
    ]);
    expect(await g.task("task-open")).toMatchObject({ dueDate: "2026-11-18", missionDueDate: "2026-11-18" });
    const project = (await g.call("POST", "/api/me/projects", { name: "对话质量", taskId: "task-open" })).json().projectId as string;
    const goal = ((await g.call("GET", "/api/me/work-home")).json().projects as { projectId: string; goals: { taskId: string; dueDate: string; dueDateSource: string }[] }[])
      .find((entry) => entry.projectId === project)!.goals[0];
    expect(goal).toMatchObject({ taskId: "task-open", dueDate: "2026-11-18", dueDateSource: "mission" });
    expect((await g.call("GET", "/api/me/home-plan")).json().tasks.find((entry: { taskId: string }) => entry.taskId === "task-open").dueDate).toBe("2026-11-18");
  }, 180_000);

  it("补记之后 11/20 才在本体出现的件按 11/20 记，不会一出现就标橙", async () => {
    const g = f = await fixture(new Date("2026-11-06T02:00:00.000Z"));
    await g.backfill();
    g.clock.now = new Date("2026-11-20T02:00:00.000Z");
    g.tasks.push({ taskId: "task-late", missionId: "mine", name: "后来加的", doneDefinition: null, criteria: ["有方案"] });
    expect(await g.task("task-late")).toMatchObject({ dueDate: "2026-11-30", missionDueDate: "2026-11-30" });
    expect(await g.task("task-open")).toMatchObject({ dueDate: "2026-11-18", missionDueDate: "2026-11-18" });
  }, 180_000);

  it("上线前已经存着日子的件（迁移 290 从项目目标搬来的），补记把存着的日子记成「原」：页面不出「原」；之后本人再改才出「原 旧值」", async () => {
    const g = f = await fixture(new Date("2026-11-19T02:00:00.000Z"));
    await g.t.sql("INSERT INTO task_due_dates(task_id,due_date) VALUES('task-open','2026-11-25')");
    await g.backfill();
    expect(await g.recorded()).toEqual([
      { task_id: "task-open", mission_id: "mine", due_date: "2026-11-25", period: "2026-11" },
      { task_id: "task-theirs", mission_id: "mine", due_date: "2026-11-18", period: "2026-11" },
    ]);
    expect(await g.task("task-open")).toMatchObject({ dueDate: "2026-11-25", missionDueDate: "2026-11-25" });
    expect((await g.call("PUT", "/api/me/tasks/task-open/due-date", { dueDate: "2026-11-28" })).statusCode).toBe(200);
    expect(await g.task("task-open")).toMatchObject({ dueDate: "2026-11-28", missionDueDate: "2026-11-25" });
  }, 180_000);

  it("补记时 Mission 还没写节点的不记；后来补了节点，按第一次读到那天记", async () => {
    const g = f = await fixture(new Date("2026-11-06T02:00:00.000Z"));
    await g.t.sql(`UPDATE missions SET milestones='[]' WHERE id='mine'`);
    await g.backfill();
    expect(await g.marked()).toBe(true);
    expect(await g.recorded()).toEqual([]);
    await g.t.sql(`UPDATE missions SET milestones='["11/18 V1 上线","11/30 V2 上线"]' WHERE id='mine'`);
    g.clock.now = new Date("2026-11-20T02:00:00.000Z");
    expect(await g.task("task-open")).toMatchObject({ dueDate: "2026-11-30", missionDueDate: "2026-11-30" });
  }, 180_000);

  it("本体读不到时不留标记、什么都不记；下次能补", async () => {
    const g = f = await fixture(new Date("2026-11-19T02:00:00.000Z"));
    g.world.down = true;
    await g.backfill().catch(() => undefined);
    expect(await g.marked()).toBe(false);
    expect(await g.recorded()).toEqual([]);
    g.world.down = false;
    await g.backfill();
    expect(await g.marked()).toBe(true);
    expect((await g.recorded()).map((row) => row.due_date)).toEqual(["2026-11-18", "2026-11-18"]);
  }, 180_000);

  it("补记跑两次不重复、不改已记的", async () => {
    const g = f = await fixture(new Date("2026-11-06T02:00:00.000Z"));
    await g.backfill();
    const first = await g.recorded();
    await g.t.sql(`UPDATE missions SET milestones='["11/20 V1 上线","11/30 V2 上线"]' WHERE id='mine'`);
    await g.backfill();
    expect(await g.recorded()).toEqual(first);
    expect(await g.t.sql("SELECT count(*)::int AS n FROM task_planned_due_date_backfill")).toEqual([{ n: 1 }]);
  }, 180_000);

  it("记下以后 Mission 节点再变，「原」不变；本人改了以改的为准，「原」照旧是记下的", async () => {
    const g = f = await fixture(new Date("2026-11-06T02:00:00.000Z"));
    await g.backfill();
    await g.t.sql(`UPDATE missions SET milestones='["11/20 V1 上线","11/30 V2 上线"]' WHERE id='mine'`);
    g.clock.now = new Date("2026-11-19T02:00:00.000Z");
    expect(await g.task("task-open")).toMatchObject({ dueDate: "2026-11-18", missionDueDate: "2026-11-18" });
    expect((await g.call("PUT", "/api/me/tasks/task-open/due-date", { dueDate: "2026-11-25" })).statusCode).toBe(200);
    expect(await g.task("task-open")).toMatchObject({ dueDate: "2026-11-25", missionDueDate: "2026-11-18" });
    // 「原」不算本人改过：唯一一份的 task_due_dates 里只有本人改的那一条。
    expect(await g.t.sql("SELECT task_id,due_date FROM task_due_dates")).toEqual([{ task_id: "task-open", due_date: "2026-11-25" }]);
  }, 180_000);

  it("Mission 原地滚到下个月（Task id 不变）：10 月记下的「原」不再用，按 11 月的节点重新记", async () => {
    const g = f = await fixture(new Date("2026-10-06T02:00:00.000Z"));
    await g.t.sql(`UPDATE missions SET period='2026-10',milestones='["10/20 V0 上线","10/30 复核"]',created_at='2026-10-01T02:00:00Z' WHERE id='mine'`);
    await g.backfill();
    const october = ((await g.call("GET", "/api/me/months/2026-10")).json().tasks as { taskId: string; missionDueDate: string | null }[])
      .find((entry) => entry.taskId === "task-open")!;
    expect(october.missionDueDate).toBe("2026-10-20");
    // 本体每天载入时把这个 Mission 改到 11 月（worldMissionLoad 原地改 period 和节点）。
    await g.t.sql(`UPDATE missions SET period='2026-11',milestones='["11/18 V1 上线","11/30 V2 上线"]' WHERE id='mine'`);
    g.clock.now = new Date("2026-11-02T02:00:00.000Z");
    expect(await g.task("task-open")).toMatchObject({ dueDate: "2026-11-18", missionDueDate: "2026-11-18" });
  }, 180_000);
});
