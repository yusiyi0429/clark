import { afterEach, describe, expect, it } from "vitest";
import { boardFixture, THIRD } from "./boardFixture.js";

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
    expect([res.statusCode, res.json()]).toEqual([200, { taskId: "task-open", dueDate: "2026-11-25" }]);
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

    // 清掉：退回 Mission 的节点。
    expect((await g.call("PUT", "/api/me/tasks/task-open/due-date", { dueDate: null })).json()).toEqual({ taskId: "task-open", dueDate: null });
    expect(await open()).toMatchObject({ dueDate: "2026-11-18", missionDueDate: "2026-11-18" });
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
