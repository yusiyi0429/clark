import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { boardFixture, THIRD } from "./boardFixture.js";

/**
 * 本月页「+ 添一件」（11/19 DRI 根据地第 4 步）：本人在自己的 Mission 下新建一件天枢里的 Task（天枢自己的 id，不写本体，标「未进本体」）。
 * 它和本体读回来的 Task 走同一个来源（taskGoalEdits.ts 那一层），所以能挂项目、拆卡、进复盘。
 */
async function fixture(now = new Date("2026-11-06T02:00:00.000Z")) {
  const f = await boardFixture({ monthlyNow: () => now,
    monthReviewAgent: { async rate(input) { return { criteria: input.criteria.map(({ index }) => ({ index, rating: "partial" as const, basis: "看过", vague: false, deliverable: false })) }; } },
    monthReviewEvents: async () => [] }, { boardCloudAgents: false });
  const login = await f.t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: f.t.publicOrigin }, payload: { loginId: THIRD.loginId, passcode: THIRD.passcode } });
  const add = (body: unknown, cookie?: string) => f.call("POST", "/api/me/months/2026-11/tasks", body, cookie);
  const month = async () => (await f.call("GET", "/api/me/months/2026-11")).json().tasks as { taskId: string; name: string; added: boolean; edited: unknown; criteria: { text: string }[] }[];
  return { ...f, add, month, third: (login.headers["set-cookie"] as string).split(";")[0] };
}

describe("本月页添一件", () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  afterEach(async () => { await f?.close(); f = undefined; });

  it("天枢里新建的 Task 能挂项目、拆卡；月份页标未进本体，名字和标准照样就地改", async () => {
    const g = f = await fixture();
    const res = await g.add({ missionId: "mine", name: "  新人上手手册  " });
    expect(res.statusCode).toBe(201);
    const taskId = res.json().taskId as string;
    const added = (await g.month()).find((task) => task.taskId === taskId)!;
    // 刚加的还没有标准（复盘时按名字算一条）；天枢里新加的，没有本体原文。
    expect(added).toMatchObject({ name: "新人上手手册", added: true, edited: null, criteria: [] });
    expect((await g.call("GET", "/api/me/home-plan")).json().tasks.map((task: { taskId: string }) => task.taskId)).toContain(taskId);

    // 名字、标准就地改：直接改它自己，不出「恢复」。
    expect((await g.call("PUT", `/api/me/tasks/${taskId}/goal`, { name: "新人上手手册 V1", criteria: ["写完 10 页"] })).statusCode).toBe(200);
    expect((await g.month()).find((task) => task.taskId === taskId)).toMatchObject({ name: "新人上手手册 V1", added: true, edited: null,
      criteria: [{ text: "写完 10 页", changed: false, original: null }] });
    expect(await g.t.sql("SELECT task_id FROM task_goal_edits")).toEqual([]);

    // 挂项目、在它下面开卡。
    const project = await g.call("POST", "/api/me/projects", { name: "上手手册", taskId });
    expect(project.statusCode).toBe(201);
    const card = await g.call("POST", "/api/me/tasks", { clientId: randomUUID(), title: "写第一章", missionId: "mine", planTaskId: taskId, doneDefinition: "写完第一章" });
    expect(card.statusCode, card.body).toBe(200);
    expect((await g.call("GET", `/api/me/projects/${project.json().projectId}`)).json().goals.map((goal: { taskId: string; taskName: string }) => [goal.taskId, goal.taskName]))
      .toEqual([[taskId, "新人上手手册 V1"]]);
    expect((await g.call("GET", `/api/plan-tasks/${encodeURIComponent(taskId)}/agreement`)).json().criteria.map((item: { text: string }) => item.text)).toEqual(["写完 10 页"]);

    // 名字空 400；不是本人的 Mission 403；没有这个 Mission 404；别的月份的 Mission 404。
    expect((await g.add({ missionId: "mine", name: " " })).statusCode).toBe(400);
    expect((await g.add({ missionId: "other", name: "x" })).statusCode).toBe(403);
    expect((await g.add({ missionId: "nope", name: "x" })).statusCode).toBe(404);
    expect((await g.call("POST", "/api/me/months/2026-12/tasks", { missionId: "mine", name: "x" })).statusCode).toBe(404);
    // 别人看不到这件。
    expect((await g.call("GET", `/api/plan-tasks/${encodeURIComponent(taskId)}/agreement`, undefined, g.third)).statusCode).toBe(404);
  }, 180_000);

  it("天枢里新建的 Task 进复盘：本期验收逐条评，不要了选已取消", async () => {
    const g = f = await fixture(new Date("2026-11-29T02:00:00.000Z"));
    const taskId = (await g.add({ missionId: "mine", name: "新人上手手册" })).json().taskId as string;
    const review = async () => (await g.call("GET", "/api/me/months/2026-11/review")).json();
    const mine = (await review()).missions.find((mission: { missionId: string }) => mission.missionId === "mine");
    expect(mine.tasks.find((task: { taskId: string }) => task.taskId === taskId)).toMatchObject({ name: "新人上手手册", disposition: "current", canChange: true,
      criteria: [{ index: 1, text: "新人上手手册" }] });
    expect((await g.call("PUT", `/api/me/months/2026-11/review/tasks/${taskId}/disposition`, { disposition: "cancelled" })).statusCode).toBe(200);
    expect((await review()).setAside.map((task: { taskId: string }) => task.taskId)).toContain(taskId);
    expect((await g.month()).find((task) => task.taskId === taskId)).toMatchObject({ added: true });
  }, 180_000);
});
