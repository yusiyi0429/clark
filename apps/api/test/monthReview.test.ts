import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { THomePlanTask } from "@warmap/contracts";
import type { MonthReviewAgentInput } from "../src/monthReviewAgent.js";
import { BOARD_TASKS, boardFixture, THIRD } from "./boardFixture.js";
import { TEST_MEMBER } from "./helpers.js";

/**
 * 复盘第三版（monthReview.ts）。本人（MEMBER）负责 11 月的 Mission「mine」：task-open（本体没登记负责人，算本人的，两条标准）、
 * task-theirs（THIRD 负责）。THIRD 负责「other」：task-other，和本人负责的 task-help。11/29 在 11 月的复盘窗口里。
 * 不调模型（假评审员），不读本体（假事件），不发飞书。
 */
const MEMBER = TEST_MEMBER.personId;
const NOW = new Date("2026-11-29T02:00:00.000Z");
const HELP: THomePlanTask = { taskId: "task-help", missionId: "other", name: "帮别人评审", doneDefinition: null, criteria: ["有评审记录"], responsibleId: MEMBER };

async function fixture() {
  const tasks = [...BOARD_TASKS, HELP].map((task) => ({ ...task, criteria: [...task.criteria] }));
  const asked: MonthReviewAgentInput[] = [];
  const f = await boardFixture({ monthlyNow: () => NOW,
    planTasks: async (missions) => tasks.filter((task) => missions.some((mission) => mission.id === task.missionId)),
    monthReviewAgent: { async rate(input) {
      asked.push(input);
      return { criteria: input.criteria.map(({ index }) => ({ index, rating: "partial" as const, basis: "评审记录里只评了一半", vague: true, deliverable: false })) };
    } },
    monthReviewEvents: async ({ taskId }) => taskId === "task-help" ? [{ at: "2026-11-20T02:00:00Z", text: "评审过一次" }] : [],
  }, { boardCloudAgents: false });
  const login = await f.t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: f.t.publicOrigin }, payload: { loginId: THIRD.loginId, passcode: THIRD.passcode } });
  const third = (login.headers["set-cookie"] as string).split(";")[0];
  const prefill = (personId = MEMBER, period = "2026-11") => f.t.app.monthReviewJobs.handlers["month_review.prefill"]({ personId, period },
    { id: "j", kind: "month_review.prefill", dedupe_key: "j", attempts: 1, payload: {} });
  const review = async (cookie?: string) => {
    const res = await f.call("GET", "/api/me/months/2026-11/review", undefined, cookie);
    expect(res.statusCode).toBe(200);
    return res.json();
  };
  return { ...f, tasks, asked, third, prefill, review };
}

/** 本人对 task-open 第一条的卡验收过了（带一个链接证据），第二条的卡还在做。 */
async function cards(g: Awaited<ReturnType<typeof fixture>>) {
  const machine = await g.local();
  const passed = await g.card("打分");
  const doing = await g.card("录屏");
  await g.t.sql("UPDATE tasks SET criterion_index=1,criterion_text='有题库打分结果' WHERE id=$1", [passed]);
  await g.t.sql("UPDATE tasks SET criterion_index=2,criterion_text='有新人上手录屏' WHERE id=$1", [doing]);
  await g.t.sql(`INSERT INTO card_handbacks(id,task_id,owner_id,client_id,attempt,status,outcome,finished_at) VALUES($1,$2,$3,'h-1',1,'done','pass',now())`,
    [randomUUID(), passed, MEMBER]);
  const run = randomUUID();
  await g.t.sql("INSERT INTO local_runs(id,owner_id,device_id,kind,task_id,state,started_at) VALUES($1,$2,$3,'card',$4,'exited',now())", [run, MEMBER, machine.device, passed]);
  await g.t.sql(`INSERT INTO local_outputs(id,owner_id,device_id,run_id,task_id,kind,evidence_kind,title,url,client_id,created_at)
    VALUES($1,$2,$3,$4,$5,'evidence','link','打分结果','https://example.com/score','o-1',now())`, [randomUUID(), MEMBER, machine.device, run, passed]);
}

const titles = (view: { missions: { missionId: string; tasks: { taskId: string }[] }[] }) =>
  view.missions.map((mission) => [mission.missionId, mission.tasks.map((task) => task.taskId)]);

describe("复盘第三版", () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  afterEach(async () => { await f?.close(); f = undefined; });

  it("复盘页和预评：本人的 Mission 放所有人的 Task，别人 Mission 下本人负责的单独一块；能机械判的直接判，判不了的交评审员；标准改了那一条重评", async () => {
    const g = f = await fixture();
    await cards(g);

    // 第一次打开：还没预评，排一次（同一批只排一次）。
    let view = await g.review();
    expect(view).toMatchObject({ period: "2026-11", deadline: "2026-12-01T10:00:00.000Z", prefill: { status: "pending", error: null }, toConfirm: 1, setAside: [] });
    expect(titles(view)).toEqual([["mine", ["task-theirs", "task-open"]], ["other", ["task-help"]]]);
    expect(view.missions[0].tasks[1].criteria[0]).toEqual({ index: 1, text: "有题库打分结果", agentRating: null, agentBasis: null, rating: null, ratedBy: null, note: null, links: [] });
    await g.review();
    expect(await g.t.sql("SELECT dedupe_key FROM jobs WHERE kind='month_review.prefill'")).toHaveLength(1);

    await g.prefill();
    view = await g.review();
    expect(view.prefill).toEqual({ status: "done", error: null });
    const [mine, other] = view.missions;
    expect(mine).toMatchObject({ code: "mine", title: "内部版上线", owner: { personId: MEMBER }, verdict: "partial", met: 1, total: 3, deferred: 0, cancelled: 0,
      confirmedAt: null, canConfirm: true });
    const [theirs, open] = mine.tasks;
    expect(theirs).toMatchObject({ responsible: { personId: THIRD.personId }, disposition: "current", deferredTo: null, dispositionBy: null, canChange: true });
    expect(theirs.criteria[0]).toMatchObject({ agentRating: "unmet", agentBasis: "没有读到交付、卡或本体事件" });
    expect(open.responsible).toBeNull();
    expect(open.criteria.map((c: { agentRating: string; agentBasis: string }) => [c.agentRating, c.agentBasis])).toEqual([
      ["met", "对这条的卡验收通过了"], ["partial", "对这条的卡还没验收通过"]]);
    expect(open.criteria[0].links).toEqual([{ id: expect.any(String), title: "打分结果", url: "https://example.com/score", source: "agent" }]);
    expect(other).toMatchObject({ owner: { personId: THIRD.personId }, canConfirm: false, verdict: "not_achieved", met: 0, total: 1 });
    expect(other.tasks[0].criteria[0]).toMatchObject({ agentRating: "partial", agentBasis: "评审记录里只评了一半" });
    // 只有 task-help 交给了评审员，带着本体事件；「标准含糊」只记在库里。
    expect(g.asked.map((input) => [input.taskName, input.criteria, input.events])).toEqual([["帮别人评审", [{ index: 1, text: "有评审记录" }],
      [{ at: "2026-11-20T02:00:00Z", text: "评审过一次" }]]]);
    expect(await g.t.sql("SELECT vague FROM month_review_criteria WHERE task_id='task-help'")).toEqual([{ vague: true }]);
    expect(JSON.stringify(view)).not.toContain("vague");

    // 本体里第二条的原文改了：那一条作废、重新排预评，第一条不动。
    g.tasks.find((task) => task.taskId === "task-open")!.criteria[1] = "有两个新人上手录屏";
    view = await g.review();
    expect(view.prefill.status).toBe("pending");
    expect(view.missions[0].tasks[1].criteria.map((c: { agentRating: string | null }) => c.agentRating)).toEqual(["met", null]);
    expect(view.missions[0].verdict).toBeNull();
    await g.prefill();
    expect((await g.review()).missions[0].tasks[1].criteria[1]).toMatchObject({ text: "有两个新人上手录屏", agentRating: "partial" });

    // 月份写错 400；不在 DRI 工作台的 403 由 requireMember 管（同月份页）。
    expect((await g.call("GET", "/api/me/months/2026-13/review")).statusCode).toBe(400);
  }, 120_000);

  it("改评定、挂交付、改去向、确认、顺延清单；谁能改、谁能确认", async () => {
    const g = f = await fixture();
    await cards(g);
    await g.prefill();
    await g.prefill(THIRD.personId);
    const put = (path: string, body: unknown, cookie?: string) => g.call("PUT", `/api/me/months/2026-11/review/${path}`, body, cookie);

    // 评定：改了预评要写备注；写了就记下是谁改的；改回和预评一样算没改。
    expect((await put("tasks/task-open/criteria/2", { rating: "met", note: null })).statusCode).toBe(400);
    let res = await put("tasks/task-open/criteria/2", { rating: "met", note: "11/28 录好了" });
    expect(res.statusCode).toBe(200);
    expect(res.json().missions[0].tasks[1].criteria[1]).toMatchObject({ agentRating: "partial", rating: "met", ratedBy: { personId: MEMBER }, note: "11/28 录好了" });
    expect(res.json().missions[0]).toMatchObject({ met: 2, total: 3, verdict: "partial" });
    res = await put("tasks/task-open/criteria/2", { rating: "partial", note: "还差一个" });
    expect(res.json().missions[0].tasks[1].criteria[1]).toMatchObject({ rating: null, note: "还差一个" });
    expect((await put("tasks/task-open/criteria/3", { rating: "met", note: "x" })).statusCode).toBe(404);

    // 交付：粘贴链接（只收 http / https，没标题用网址）；弹层里点天枢的交付物；删掉。
    const link = (index: number, body: unknown) => g.call("POST", `/api/me/months/2026-11/review/tasks/task-open/criteria/${index}/links`, body);
    expect((await link(2, { url: "javascript:alert(1)" })).statusCode).toBe(400);
    res = await link(2, { url: "https://feishu.cn/docx/abc" });
    expect(res.json().missions[0].tasks[1].criteria[1].links).toEqual([{ id: expect.any(String), title: "https://feishu.cn/docx/abc", url: "https://feishu.cn/docx/abc", source: "person" }]);
    const version = randomUUID(), item = randomUUID();
    await g.t.sql(`INSERT INTO deliverable_versions(id,task_id,mission_id,author_id,number,task_name,basis) VALUES($1,'task-open','mine',$2,1,'对话质量达标','acceptance')`, [version, MEMBER]);
    await g.t.sql(`INSERT INTO deliverable_items(id,version_id,position,kind,name,url) VALUES($1,$2,0,'link','PR #80','https://github.com/x/y/pull/80')`, [item, version]);
    const candidates = (await g.call("GET", "/api/me/months/2026-11/review/tasks/task-open/link-candidates")).json().candidates;
    expect(candidates.map((c: { kind: string; title: string }) => [c.kind, c.title])).toEqual([["deliverable", "PR #80"], ["output", "打分结果"]]);
    res = await link(2, { candidate: { kind: "deliverable", id: item } });
    const links = res.json().missions[0].tasks[1].criteria[1].links;
    expect(links.map((l: { title: string }) => l.title)).toEqual(["https://feishu.cn/docx/abc", "PR #80"]);
    expect((await link(2, { candidate: { kind: "output", id: randomUUID() } })).statusCode).toBe(404);
    res = await g.call("DELETE", `/api/me/months/2026-11/review/links/${links[0].id}`);
    expect(res.json().missions[0].tasks[1].criteria[1].links.map((l: { title: string }) => l.title)).toEqual(["PR #80"]);

    // 确认：只有 Mission 负责人；确认后再改就清掉确认。
    res = await g.call("POST", "/api/me/months/2026-11/review/missions/mine/confirm");
    expect(res.json().missions[0]).toMatchObject({ confirmedAt: NOW.toISOString(), confirmedBy: { personId: MEMBER } });
    expect(res.json().toConfirm).toBe(0);
    expect((await g.call("POST", "/api/me/months/2026-11/review/missions/other/confirm")).statusCode).toBe(403);
    expect((await g.call("POST", "/api/me/months/2026-11/review/missions/nope/confirm")).statusCode).toBe(404);
    res = await put("tasks/task-open/criteria/1", { rating: "met", note: "补一句" });
    expect(res.json().missions[0].confirmedAt).toBeNull();

    // 去向：延期（缺省下个月），放到最下面、不计入总评；不能延到本月；取消同时到此为止，改回本期验收就撤销。
    res = await put("tasks/task-theirs/disposition", { disposition: "deferred" });
    expect(res.json().missions[0]).toMatchObject({ met: 1, total: 2, deferred: 1, verdict: "partial" });
    expect(res.json().setAside).toEqual([expect.objectContaining({ taskId: "task-theirs", disposition: "deferred", deferredTo: "2026-12", dispositionBy: { personId: MEMBER, name: expect.any(String) },
      criteria: [] })]);
    expect((await put("tasks/task-theirs/disposition", { disposition: "deferred", deferredTo: "2026-11" })).statusCode).toBe(400);
    expect((await put("tasks/task-theirs/disposition", { disposition: "current", deferredTo: "2026-12" })).statusCode).toBe(400);
    expect((await put("tasks/task-theirs/criteria/1", { rating: "met", note: "x" })).statusCode).toBe(409);
    res = await put("tasks/task-theirs/disposition", { disposition: "cancelled" });
    expect([res.json().cancelled, res.json().deferred]).toEqual([1, 0]);
    expect(await g.t.sql("SELECT task_id,decided_by FROM task_stops")).toEqual([{ task_id: "task-theirs", decided_by: MEMBER }]);
    res = await put("tasks/task-theirs/disposition", { disposition: "current" });
    expect(res.json().missions[0].tasks.map((task: { taskId: string }) => task.taskId)).toEqual(["task-theirs", "task-open"]);
    expect(await g.t.sql("SELECT task_id FROM task_stops")).toEqual([]);

    // 别人：THIRD 看到自己的 Mission（所有 Task）和本人 Mission 下他负责的那件（不能确认）；改不了本人负责的 task-open（不在他的复盘里）。
    const theirs = await g.review(g.third);
    expect(titles(theirs)).toEqual([["other", ["task-help", "task-other"]], ["mine", ["task-theirs"]]]);
    expect(theirs.missions.map((mission: { canConfirm: boolean }) => mission.canConfirm)).toEqual([true, false]);
    expect(theirs.missions[0].tasks.map((task: { canChange: boolean }) => task.canChange)).toEqual([true, true]);
    expect((await put("tasks/task-open/disposition", { disposition: "cancelled" }, g.third)).statusCode).toBe(404);
    expect((await g.call("POST", "/api/me/months/2026-11/review/missions/mine/confirm", undefined, g.third)).statusCode).toBe(403);
    // 本人改不了别人 Mission 下别人负责的（不在本人的复盘里）。
    expect((await put("tasks/task-other/disposition", { disposition: "cancelled" })).statusCode).toBe(404);

    // 顺延清单：本人延到 12 月的，带原标准、做到哪了、已挂的交付；取消的不带；THIRD 的清单里没有本人的。
    await put("tasks/task-open/disposition", { disposition: "deferred", deferredTo: "2026-12" });
    await put("tasks/task-help/disposition", { disposition: "cancelled" });
    const carry = (await g.call("GET", "/api/me/months/2026-12/carryover")).json();
    expect(carry).toEqual({ period: "2026-12", tasks: [{ taskId: "task-open", name: "对话质量达标", missionId: "mine", missionTitle: "内部版上线", fromPeriod: "2026-11",
      deferredTo: "2026-12", criteria: [
        { index: 1, text: "有题库打分结果", rating: "met", note: "补一句", links: [expect.objectContaining({ title: "打分结果", source: "agent" })] },
        { index: 2, text: "有新人上手录屏", rating: "partial", note: "还差一个", links: [expect.objectContaining({ title: "PR #80", source: "person" })] }] }] });
    expect((await g.call("GET", "/api/me/months/2026-12/carryover", undefined, g.third)).json().tasks).toEqual([]);
    expect((await g.call("GET", "/api/me/months/2027-01/carryover")).json().tasks.map((task: { taskId: string }) => task.taskId)).toEqual(["task-open"]);
  }, 120_000);
});
