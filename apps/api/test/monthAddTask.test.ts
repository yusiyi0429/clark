import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanTaskSource } from "../src/planTasks.js";
import { BOARD_TASKS, boardFixture, THIRD } from "./boardFixture.js";
import { TEST_MEMBER } from "./helpers.js";

/**
 * 本月页「+ 添一件」（11/19 DRI 根据地第 4 步）：本人在自己的 Mission 下新建一件天枢里的 Task（天枢自己的 id，不写本体，标「未进本体」）。
 * 它和本体读回来的 Task 走同一个来源（taskGoalEdits.ts 那一层），所以能挂项目、拆卡、进复盘。
 */
type World = { down: boolean };
/**
 * 时钟能往前拨（clock.now）；假本体按 Mission 列 Task，也能按 id 读一件（父引用是 Mission 的本体对象）；world.down 时这次一件都没读到（不抛错）。
 * 本人的 Mission「mine」对应本体对象 w-mine。
 */
async function fixture(now = new Date("2026-11-06T02:00:00.000Z"), world: World = { down: false }) {
  const clock = { now };
  const planTasks: PlanTaskSource = Object.assign(async (missions: { id: string }[]) => (world.down ? [] : BOARD_TASKS.filter((task) => missions.some((mission) => mission.id === task.missionId))), {
    byId: async (taskId: string) => {
      const found = BOARD_TASKS.find((task) => task.taskId === taskId);
      if (!found || world.down) return null;
      const { missionId, ...task } = found;
      return { parents: [`w-${missionId}`], task };
    },
  });
  const f = await boardFixture({ monthlyNow: () => clock.now, planTasks,
    monthReviewAgent: { async rate(input) { return { criteria: input.criteria.map(({ index }) => ({ index, rating: "partial" as const, basis: "看过", vague: false, deliverable: false })) }; } },
    monthReviewEvents: async () => [] }, { boardCloudAgents: false });
  await f.t.sql("UPDATE missions SET world_object_id='w-'||id,world_scope_id='scope-x',world_domain_id='d-1',world_status='进行中',world_read_at=now()");
  const login = await f.t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: f.t.publicOrigin }, payload: { loginId: THIRD.loginId, passcode: THIRD.passcode } });
  const add = (body: unknown, cookie?: string) => f.call("POST", "/api/me/months/2026-11/tasks", body, cookie);
  const month = async () => (await f.call("GET", "/api/me/months/2026-11")).json().tasks as { taskId: string; name: string; added: boolean; edited: unknown; criteria: { text: string }[] }[];
  return { ...f, clock, world, add, month, third: (login.headers["set-cookie"] as string).split(";")[0] };
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

  it("本体这次没读到这个 Mission，就算它下面有天枢里新加的，也不算取消", async () => {
    const g = f = await fixture();
    const project = (await g.call("POST", "/api/me/projects", { name: "对话质量", taskId: "task-open" })).json().projectId as string;
    await g.card("跑题库打分");
    expect((await g.call("GET", "/api/me/work-home")).statusCode).toBe(200);
    expect((await g.add({ missionId: "mine", name: "新人上手手册" })).statusCode).toBe(201);
    // 本体这次一件都没读到（读出问题）：只有天枢里新加的那件在，不能把挂在项目上的 task-open 当成取消了。
    g.world.down = true;
    expect((await g.call("GET", "/api/me/work-home")).statusCode).toBe(200);
    expect(await g.t.sql("SELECT task_id,change FROM project_goal_changes")).toEqual([]);
    expect((await g.call("GET", `/api/me/projects/${project}/feed`)).json().items.filter((item: { kind: string }) => item.kind === "goal_changed")).toEqual([]);
  }, 180_000);

  it("天枢里新加的 Task 按 id 读用它自己的 Mission，不跟着本体对象找到最新月份", async () => {
    const g = f = await fixture();
    // 12 月的 Mission 指向同一个本体对象（另一个 scope 读进来的），按对象找会找到最新月份的这个。
    await g.t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,milestones,source_ref,source_document_id,source_revision,source_title,
      world_object_id,world_scope_id,world_domain_id,world_status,world_read_at)
      VALUES('mine-dec',1,'mine-dec','2026-12','12 月的 Mission',$1,'method','["growth"]','目标','[]','fixture://b','fixture',1,'fixture','w-mine','scope-dec','d-1','进行中',now())`,
    [TEST_MEMBER.personId]);
    const taskId = (await g.add({ missionId: "mine", name: "新人上手手册" })).json().taskId as string;
    g.clock.now = new Date("2026-12-03T02:00:00.000Z");
    const agreement = await g.call("GET", `/api/plan-tasks/${encodeURIComponent(taskId)}/agreement`);
    expect([agreement.statusCode, agreement.json().missionId]).toEqual([200, "mine"]);
  }, 180_000);

  it("已经过去的月份不能改日期、名字、标准，也不能添一件（409）；复盘的去向照旧能定", async () => {
    const g = f = await fixture();
    const taskId = (await g.add({ missionId: "mine", name: "新人上手手册" })).json().taskId as string;
    const project = (await g.call("POST", "/api/me/projects", { name: "对话质量", taskId: "task-open" })).json().projectId as string;
    g.clock.now = new Date("2026-12-03T02:00:00.000Z");
    // 老的项目目标接口写的是同一份，一样拦。
    expect((await g.call("PUT", `/api/me/projects/${project}/goals/task-open/due-date`, { dueDate: "2026-11-25" })).statusCode).toBe(409);
    for (const id of ["task-open", taskId]) {
      expect((await g.call("PUT", `/api/me/tasks/${encodeURIComponent(id)}/due-date`, { dueDate: "2026-11-25" })).statusCode).toBe(409);
      expect((await g.call("PUT", `/api/me/tasks/${encodeURIComponent(id)}/goal`, { name: "改个名字" })).statusCode).toBe(409);
    }
    expect((await g.add({ missionId: "mine", name: "再添一件" })).statusCode).toBe(409);
    // 11 月的复盘在 12 月做，去向还要能改（复盘页同一个接口）。
    expect((await g.call("PUT", "/api/me/months/2026-11/review/tasks/task-open/disposition", { disposition: "cancelled" })).statusCode).toBe(200);
  }, 180_000);
});
