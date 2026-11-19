import { afterEach, describe, expect, it } from "vitest";
import { BOARD_TASKS, boardFixture, THIRD } from "./boardFixture.js";

/**
 * 本月页就地改（11/19 DRI 根据地第 2 步）：验收时间点按 Task 存（不要求挂项目，只有 Task 负责人能改），月中就能定去向。
 * 本人负责 11 月的 Mission「mine」（节点 11/18、11/30）：task-open（没登记负责人，算本人的）、task-theirs（THIRD 负责）。今天 11/06。
 */
async function fixture() {
  const f = await boardFixture({}, { boardCloudAgents: false });
  await f.t.sql(`UPDATE missions SET milestones='["11/18 V1 上线","11/30 V2 上线"]' WHERE id='mine'`);
  const login = await f.t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: f.t.publicOrigin }, payload: { loginId: THIRD.loginId, passcode: THIRD.passcode } });
  return { ...f, third: (login.headers["set-cookie"] as string).split(";")[0] };
}

describe("本月页就地改", () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  afterEach(async () => { await f?.close(); f = undefined; });

  it("没挂项目的 Task 也能改验收时间点", async () => {
    const g = f = await fixture();
    const open = async () => (await g.call("GET", "/api/me/months/2026-11")).json().tasks.find((task: { taskId: string }) => task.taskId === "task-open");
    expect(await open()).toMatchObject({ dueDate: "2026-11-18", missionDueDate: "2026-11-18" });

    const res = await g.call("PUT", "/api/me/tasks/task-open/due-date", { dueDate: "2026-11-25" });
    expect([res.statusCode, res.json()]).toEqual([200, { taskId: "task-open", name: "对话质量达标", dueDate: "2026-11-25" }]);
    expect(await g.t.sql("SELECT project_id FROM project_goals WHERE task_id='task-open'")).toEqual([]);
    // 月份页写改后的，原值（Mission 的节点）照旧给，网页写「原 11/18」。
    expect(await open()).toMatchObject({ dueDate: "2026-11-25", missionDueDate: "2026-11-18" });
    // 首页计划里的这件 Task 也带上（首页「本月」、Task 详情的验收时间点读它）。
    const plan = (await g.call("GET", "/api/me/home-plan")).json();
    expect(plan.tasks.find((task: { taskId: string }) => task.taskId === "task-open").dueDate).toBe("2026-11-25");

    // 日期不对 400；不是负责人 403（Mission 负责人也不行）；看不到的 404。
    expect((await g.call("PUT", "/api/me/tasks/task-open/due-date", { dueDate: "2026-02-30" })).statusCode).toBe(400);
    expect((await g.call("PUT", "/api/me/tasks/task-theirs/due-date", { dueDate: "2026-11-25" })).statusCode).toBe(403);
    expect((await g.call("PUT", "/api/me/tasks/task-open/due-date", { dueDate: "2026-11-25" }, g.third)).statusCode).toBe(404);
    expect((await g.call("PUT", "/api/me/tasks/task-other/due-date", { dueDate: "2026-11-25" })).statusCode).toBe(404);

    // 清掉：退回记下的原验收时间点。
    expect((await g.call("PUT", "/api/me/tasks/task-open/due-date", { dueDate: null })).json()).toEqual({ taskId: "task-open", name: "对话质量达标", dueDate: null });
    expect(await open()).toMatchObject({ dueDate: "2026-11-18", missionDueDate: "2026-11-18" });
  }, 120_000);

  it("项目页和本月页的验收时间点同一个口径：Mission 没节点又没存日子，两页都不写；存了日子两页一样", async () => {
    const g = f = await fixture();
    await g.t.sql(`UPDATE missions SET milestones='[]' WHERE id='mine'`);
    const project = (await g.call("POST", "/api/me/projects", { name: "对话质量", taskId: "task-open" })).json().projectId as string;
    const both = async () => {
      const month = (await g.call("GET", "/api/me/months/2026-11")).json().tasks.find((task: { taskId: string }) => task.taskId === "task-open");
      const goal = ((await g.call("GET", "/api/me/work-home")).json().projects as { projectId: string; goals: { taskId: string; dueDate: string | null }[] }[])
        .find((entry) => entry.projectId === project)!.goals.find((entry) => entry.taskId === "task-open")!;
      return [month.dueDate, goal.dueDate];
    };
    expect(await both()).toEqual([null, null]);
    expect((await g.call("PUT", "/api/me/tasks/task-open/due-date", { dueDate: "2026-11-25" })).statusCode).toBe(200);
    expect(await both()).toEqual(["2026-11-25", "2026-11-25"]);
  }, 120_000);

  it("首页项目排序：都有目标时按最早的验收时间点，没日子的排在有日子的后面", async () => {
    const g = f = await boardFixture({ planTasks: async (missions) => [...BOARD_TASKS,
      { taskId: "task-two", missionId: "mine", name: "第二件", doneDefinition: null, criteria: ["有方案"] }].filter((task) => missions.some((mission) => mission.id === task.missionId)) },
    { boardCloudAgents: false });
    const dated = (await g.call("POST", "/api/me/projects", { name: "有日子", taskId: "task-two" })).json().projectId as string;
    expect((await g.call("PUT", "/api/me/tasks/task-two/due-date", { dueDate: "2026-11-25" })).statusCode).toBe(200);
    const undated = (await g.call("POST", "/api/me/projects", { name: "没日子", taskId: "task-open" })).json().projectId as string;
    const order = ((await g.call("GET", "/api/me/work-home")).json().projects as { projectId: string; goals: { dueDate: string | null }[] }[])
      .filter((project) => [dated, undated].includes(project.projectId)).map((project) => [project.projectId, project.goals[0]!.dueDate]);
    expect(order).toEqual([[dated, "2026-11-25"], [undated, null]]);
  }, 120_000);

  it("月中能定去向，定了延期的挪到延期和取消", async () => {
    const g = f = await fixture();
    const put = (body: unknown) => g.call("PUT", "/api/me/months/2026-11/review/tasks/task-open/disposition", body);
    const open = async () => (await g.call("GET", "/api/me/months/2026-11")).json().tasks.find((task: { taskId: string }) => task.taskId === "task-open");
    expect(await open()).toMatchObject({ disposition: "current", deferredTo: null });

    expect((await put({ disposition: "deferred", deferredTo: "2026-12" })).statusCode).toBe(200);
    expect(await open()).toMatchObject({ disposition: "deferred", deferredTo: "2026-12" });
    // 月中不排预评。
    expect(await g.t.sql("SELECT 1 FROM jobs WHERE kind='month_review.prefill'")).toEqual([]);

    expect((await put({ disposition: "cancelled" })).statusCode).toBe(200);
    expect(await open()).toMatchObject({ disposition: "cancelled", deferredTo: null, settlement: { kind: "stopped" } });
    expect((await put({ disposition: "current" })).statusCode).toBe(200);
    expect(await open()).toMatchObject({ disposition: "current", settlement: null });
  }, 120_000);
});
