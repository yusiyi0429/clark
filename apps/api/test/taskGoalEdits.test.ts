import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanTask } from "../src/planTasks.js";
import { BOARD_TASKS, boardFixture, THIRD } from "./boardFixture.js";
import { TEST_MEMBER } from "./helpers.js";

/**
 * 本月页就地改 Task 的名字和完成标准（11/19 DRI 根据地第 3 步，设计稿路 A）：天枢里先生效、标「未进本体」，天枢不写本体。
 * 改动按 taskId 另存（task_goal_edits），在读 Task 的那一个来源外面包一层，首页、项目、约定、复盘读到的都是改后的。
 * 本人负责 11 月的 Mission「mine」：task-open（没登记负责人，算本人的；本体里带约定）、task-theirs（THIRD 负责）。
 */
const MEMBER = TEST_MEMBER.personId;
const WORLD_CRITERIA = ["有题库打分结果", "有新人上手录屏"];

async function fixture(now = new Date("2026-11-06T02:00:00.000Z"), withAgreement = false) {
  const tasks: PlanTask[] = BOARD_TASKS.map((task) => ({ ...task, criteria: [...task.criteria],
    ...(withAgreement && task.taskId === "task-open" ? { agreement: { proofs: ["打分表", "录屏"], acceptorIds: [THIRD.personId, null], exclusions: [] } } : {}) }));
  const f = await boardFixture({ monthlyNow: () => now, planTasks: async (missions) => tasks.filter((task) => missions.some((mission) => mission.id === task.missionId)),
    monthReviewAgent: { async rate(input) { return { criteria: input.criteria.map(({ index }) => ({ index, rating: "partial" as const, basis: "看过", vague: false, deliverable: false })) }; } },
    monthReviewEvents: async () => [] }, { boardCloudAgents: false });
  const login = await f.t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: f.t.publicOrigin }, payload: { loginId: THIRD.loginId, passcode: THIRD.passcode } });
  const goal = (taskId: string, body: unknown, cookie?: string) => f.call("PUT", `/api/me/tasks/${taskId}/goal`, body, cookie);
  const month = async () => (await f.call("GET", "/api/me/months/2026-11")).json().tasks.find((task: { taskId: string }) => task.taskId === "task-open");
  return { ...f, tasks, goal, month, third: (login.headers["set-cookie"] as string).split(";")[0] };
}

describe("本月页改名字和完成标准", () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  afterEach(async () => { await f?.close(); f = undefined; });

  it("天枢里先生效、标未进本体：月份页、首页、约定都按改后的读；改回原文就撤掉，恢复就是把原文存回去", async () => {
    const g = f = await fixture();
    expect(await g.month()).toMatchObject({ name: "对话质量达标", criteria: [{ text: "有题库打分结果", original: null }, { text: "有新人上手录屏", original: null }], edited: null });

    const res = await g.goal("task-open", { name: "对话质量达标（V2）", criteria: ["有题库打分结果", "有三个新人上手录屏", "过 80 分"] });
    expect(res.statusCode).toBe(200);
    // 改过的那条带上本体里的原文；新加的没有原文；行上「未进本体」看 edited（本体里的原名字、原标准）。
    expect(await g.month()).toMatchObject({ name: "对话质量达标（V2）",
      criteria: [{ text: "有题库打分结果", changed: false, original: null }, { text: "有三个新人上手录屏", changed: true, original: "有新人上手录屏" },
        { text: "过 80 分", changed: true, original: null }],
      edited: { name: "对话质量达标", criteria: WORLD_CRITERIA } });
    // 读 Task 的那一个来源外面包了一层：首页计划、约定读到的也是改后的。
    const plan = (await g.call("GET", "/api/me/home-plan")).json();
    expect(plan.tasks.find((task: { taskId: string }) => task.taskId === "task-open")).toMatchObject({ name: "对话质量达标（V2）",
      criteria: ["有题库打分结果", "有三个新人上手录屏", "过 80 分"] });
    expect((await g.call("GET", "/api/plan-tasks/task-open/agreement")).json().criteria.map((item: { text: string }) => item.text))
      .toEqual(["有题库打分结果", "有三个新人上手录屏", "过 80 分"]);
    // 天枢不写本体：本体那份（假来源）原样。
    expect(g.tasks[0]).toMatchObject({ name: "对话质量达标", criteria: WORLD_CRITERIA });

    // 只改名字：标准照旧是改后的。名字改回原文、标准还改着：只剩标准那一处。
    expect((await g.goal("task-open", { name: "对话质量达标" })).statusCode).toBe(200);
    expect(await g.month()).toMatchObject({ name: "对话质量达标", edited: { name: null, criteria: WORLD_CRITERIA } });
    // 恢复：原文存回去，改动整条撤掉。
    expect((await g.goal("task-open", { criteria: WORLD_CRITERIA })).statusCode).toBe(200);
    expect(await g.month()).toMatchObject({ name: "对话质量达标", criteria: [{ text: "有题库打分结果" }, { text: "有新人上手录屏" }], edited: null });
    expect(await g.t.sql("SELECT task_id FROM task_goal_edits")).toEqual([]);

    // 名字不能空、标准不能有空的 400；不是负责人 403（Mission 负责人也不行）；看不到的 404。
    expect((await g.goal("task-open", { name: "  " })).statusCode).toBe(400);
    expect((await g.goal("task-open", { criteria: ["有题库打分结果", " "] })).statusCode).toBe(400);
    expect((await g.goal("task-theirs", { name: "别人的" })).statusCode).toBe(403);
    expect((await g.goal("task-open", { name: "x" }, g.third)).statusCode).toBe(404);
    expect((await g.goal("task-other", { name: "x" })).statusCode).toBe(404);
  }, 180_000);

  it("改标准触发已有的「目标改了」：挂在项目上、有没做完的子会话时出「停掉 / 留着」；天枢的约定补充要重新对", async () => {
    const g = f = await fixture();
    const project = (await g.call("POST", "/api/me/projects", { name: "对话质量", taskId: "task-open" })).json().projectId as string;
    await g.card("跑题库打分");
    // 天枢里的约定补充（本体没带约定）按当时的标准存。
    expect((await g.call("PUT", "/api/plan-tasks/task-open/agreement", { criteria: [{ index: 1, proof: "打分表", acceptorId: null }, { index: 2, proof: "录屏", acceptorId: null }],
      exclusions: [] })).statusCode).toBe(200);
    expect((await g.call("GET", "/api/me/work-home")).statusCode).toBe(200);
    const changes = async () => (await g.call("GET", `/api/me/projects/${project}/feed`)).json().items.filter((item: { kind: string }) => item.kind === "goal_changed");
    expect(await changes()).toEqual([]);

    expect((await g.goal("task-open", { criteria: ["有新人上手录屏", "有题库打分结果"] })).statusCode).toBe(200);
    expect((await g.call("GET", "/api/me/work-home")).statusCode).toBe(200);
    expect(await changes()).toEqual([expect.objectContaining({ taskId: "task-open", change: "changed", answer: null })]);
    // 约定补充按原文对上（不按序号）：换了顺序，每条的证明跟着原文走；标准改过，提示要重新对。
    const agreement = (await g.call("GET", "/api/plan-tasks/task-open/agreement")).json();
    expect(agreement.criteria.map((item: { text: string; proof: string | null }) => [item.text, item.proof])).toEqual([["有新人上手录屏", "录屏"], ["有题库打分结果", "打分表"]]);
    expect(agreement.basisChanged).toBe(true);
  }, 180_000);

  it("本体里已带约定的 Task，标准增删以后约定按原文对，不按序号对", async () => {
    const g = f = await fixture(undefined, true);
    const proofs = async () => ((await g.call("GET", "/api/plan-tasks/task-open/agreement")).json().criteria as { text: string; proof: string | null; acceptor: { personId: string } | null }[])
      .map((item) => [item.text, item.proof, item.acceptor?.personId ?? null]);
    expect(await proofs()).toEqual([["有题库打分结果", "打分表", THIRD.personId], ["有新人上手录屏", "录屏", null]]);
    // 删了第一条、前面加一条新的：录屏那条的证明跟着原文走，新加的那条没有证明。
    expect((await g.goal("task-open", { criteria: ["先列题库", "有新人上手录屏"] })).statusCode).toBe(200);
    expect(await proofs()).toEqual([["先列题库", null, null], ["有新人上手录屏", "录屏", null]]);
  }, 180_000);

  it("改标准以后复盘预评按改后的标准重算", async () => {
    const g = f = await fixture(new Date("2026-11-29T02:00:00.000Z"));
    const review = async () => (await g.call("GET", "/api/me/months/2026-11/review")).json();
    const prefill = () => g.t.app.monthReviewJobs.handlers["month_review.prefill"]({ personId: MEMBER, period: "2026-11" },
      { id: randomUUID(), kind: "month_review.prefill", dedupe_key: "j", attempts: 1, payload: {} });
    await review();
    await prefill();
    const open = (view: { missions: { tasks: { taskId: string; criteria: { text: string; agentRating: string | null }[] }[] }[] }) =>
      view.missions[0]!.tasks.find((task) => task.taskId === "task-open")!.criteria.map((criterion) => [criterion.text, criterion.agentRating !== null]);
    expect(open(await review())).toEqual([["有题库打分结果", true], ["有新人上手录屏", true]]);

    expect((await g.goal("task-open", { criteria: ["有题库打分结果", "有三个新人上手录屏"] })).statusCode).toBe(200);
    const changed = await review();
    expect(changed.prefill.status).toBe("pending");
    expect(open(changed)).toEqual([["有题库打分结果", true], ["有三个新人上手录屏", false]]);
    await prefill();
    expect(open(await review())).toEqual([["有题库打分结果", true], ["有三个新人上手录屏", true]]);
  }, 180_000);
});
