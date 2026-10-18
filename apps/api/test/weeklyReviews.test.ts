import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { WeeklyReviewBoard, WeeklyReviewPayload, type TWeeklyReviewBody } from "@warmap/contracts";
import { signActionId } from "../src/actionToken.js";
import { weeklyGenerationDue } from "../src/weeklyReviewService.js";
import type { WeeklyReviewDraftInput } from "../src/weeklyReviewGeneration.js";
import { templateProblem, weeklyRecords } from "../src/weeklyReviewGeneration.js";
import { call, executionFixture, type Fixture } from "./executionFixture.js";
import { testEnv } from "./helpers.js";

const MEMBER = "person-fixture-002", THIRD = "person-fixture-003", CEO = "person-fixture-001";
const WEEK = "2026-10-12";
const FRIDAY_3PM = new Date("2026-10-16T07:00:00Z");
const link = (record: { label: string; cite: string }) => `[${record.label}](${record.cite})`;

/** 合格草稿（按公司模板）：每段挂第一条记录的出处，没有记录的句子写「缺少记录」；缺了哪类就在 overall 写一行「缺少记录」。 */
function cited(input: WeeklyReviewDraftInput, prefix = "按计划推进"): TWeeklyReviewBody {
  const first = weeklyRecords(input)[0];
  const line = (text: string) => first ? `${text}${link(first)}。` : `${text}，缺少记录。`;
  const missing = input.missingRecords.length && first ? `\n缺少记录：这一周没有${input.missingRecords.join("、")}。` : "";
  return {
    overall: { text: `${line(`状态：绿｜${prefix}`)}${missing}`, sources: [] }, progress: { text: line("采集器上线"), sources: [] },
    issues: { text: line("验收口径没定"), sources: [] }, implications: { text: line("「装机是瓶颈」仍待验证"), sources: [] },
    actions: { text: line("继续推进｜口径定了就能验收"), sources: [] }, nextWeek: { text: line("定验收口径"), sources: [] },
  };
}

async function fixture() {
  const calls: WeeklyReviewDraftInput[] = [];
  let generate: (input: WeeklyReviewDraftInput) => unknown = (input) => cited(input);
  const f = await executionFixture("confirmed", "2026-10", { weeklyReviewAgent: { async generate(input) { calls.push(input); return { candidate: generate(input) }; } } });
  const at = (iso: string | Date) => f.setNow(new Date(iso));
  const read = (id: string, cookie = f.member) => call(f, cookie, "GET", `/api/weekly-reviews/${id}`);
  const board = async (cookie = f.member, week?: string) => (await call(f, cookie, "GET", `/api/weekly-reviews/board${week ? `?week=${week}` : ""}`)).json().board;
  const act = async (id: string, type: string, input?: object, cookie = f.member) => {
    const row = (await f.t.sql("SELECT version FROM weekly_reviews WHERE id=$1", [id]))[0];
    return call(f, cookie, "POST", "/api/weekly-reviews/actions/execute", {
      actionId: signActionId(testEnv.sessionSecret, { actionType: `weekly-review.${type}`, objectType: "weekly-review", objectId: id, objectVersion: row.version as number }),
      ...(input ? { input } : {}),
    });
  };
  const scheduled = async () => { const result = await f.t.weeklyReviews!.runScheduled(); await f.t.weeklyReviews!.idle(); return result; };
  const idOf = async (personId: string, week = WEEK) => (await f.t.sql("SELECT id FROM weekly_reviews WHERE person_id=$1 AND week_start=$2", [personId, week]))[0]?.id as string;
  return { f, calls, at, read, board, act, scheduled, idOf, generate: (fn: typeof generate) => { generate = fn; } };
}

async function seedWeek(f: Fixture) {
  const task = randomUUID();
  await f.t.sql("INSERT INTO tasks(id,title,status,owner_id,created_by,mission_id,step_order) VALUES($1,'采集器上线','in_progress',$2,$2,'execution-one',1)", [task, MEMBER]);
  await f.t.sql("INSERT INTO task_progress(id,task_id,author_id,source,body,links,created_at) VALUES($1,$2,$3,'web','装好了三台机器','[{\"url\":\"https://github.com/x/pull/1\"}]','2026-10-13T03:00:00Z')", [randomUUID(), task, MEMBER]);
  await f.t.sql("INSERT INTO task_progress(id,task_id,author_id,source,body,created_at) VALUES($1,$2,$3,'web','上一周的进展','2026-10-08T03:00:00Z')", [randomUUID(), task, MEMBER]);
  await f.t.sql(`INSERT INTO meetings(id,version,title,status,scheduled_at,lead_dri_id,ceo_participant_id,participants,issue_ids,preflight,draft,materials,origin_ref,ends_at,outcome)
    VALUES($1,1,'采集器评审','reviewed','2026-10-14T06:00:00Z',$2,$2,$3::jsonb,'[]','{}','{}','[]','{}','2026-10-14T07:00:00Z',$4::jsonb)`,
  [randomUUID(), CEO, JSON.stringify([{ personId: MEMBER, displayName: "测试乙", roles: ["dri"], sourceRef: "test", updatedAt: "2026-10-01" }]),
    JSON.stringify({ status: "ready", summary: "评审了采集器", items: [
      { id: "d1", kind: "decision", text: "原文保留 14 天", review: { status: "confirmed" } },
      { id: "d2", kind: "decision", text: "没确认的结论", review: null }] })]);
  await f.t.sql(`INSERT INTO collector_progress(id,person_id,source,repo,started_at,ended_at,text,placement,confidence,task_id,item_ids,created_at)
    VALUES($1,$2,'codex','Tianshu-MVP','2026-10-15T02:00:00Z','2026-10-15T03:00:00Z','整理服务写完','task',0.9,$3,ARRAY[$4::uuid],now())`, [randomUUID(), MEMBER, task, randomUUID()]);
  const previous = randomUUID();
  await f.t.sql(`INSERT INTO weekly_reviews(id,person_id,week_start,status,origin,body,submitted_at,created_at,updated_at)
    VALUES($1,$2,'2026-10-05','submitted','import',$3::jsonb,now(),now(),now())`, [previous, MEMBER, JSON.stringify({
    overall: { text: "状态：黄｜采集器还没装", sources: [] }, progress: { text: "写完安装包", sources: [] }, issues: { text: "无", sources: [] },
    implications: { text: "无", sources: [] }, actions: { text: "继续推进", sources: [] }, nextWeek: { text: "下周装机", sources: [] } })]);
  return { task, previous };
}

describe("周复盘：周五 15:00 生成", () => {
  it("上海时间周五 15:00 起（含周末）才到点", () => {
    expect(weeklyGenerationDue(new Date("2026-10-16T06:59:00Z"))).toBe(false);
    expect(weeklyGenerationDue(FRIDAY_3PM)).toBe(true);
    expect(weeklyGenerationDue(new Date("2026-10-18T15:59:00Z"))).toBe(true);
    expect(weeklyGenerationDue(new Date("2026-10-18T16:00:00Z"))).toBe(false);
  });

  it("到点给成员工作台里的每个人建草稿；五类依据各带出处，六步带结果；只认输入里的出处", async () => {
    const t = await fixture();
    try {
      const { previous } = await seedWeek(t.f);
      t.at("2026-10-16T06:59:00Z");
      expect(await t.scheduled()).toEqual({ weekStart: WEEK, created: 0 });
      t.at(FRIDAY_3PM);
      expect(await t.scheduled()).toEqual({ weekStart: WEEK, created: 2 });
      expect(await t.scheduled()).toEqual({ weekStart: WEEK, created: 0 });
      expect((await t.f.t.sql("SELECT person_id FROM weekly_reviews WHERE week_start=$1 ORDER BY person_id", [WEEK])).map((row) => row.person_id)).toEqual([MEMBER, THIRD]);

      const input = t.calls.find((item) => item.personId === MEMBER)!;
      expect(input.missions.map((mission) => mission.label)).toEqual(["Mission execution-one 上线", "Mission execution-two 验证"]);
      expect(input.tasks.map((task) => task.label)).toEqual(["执行事项 · 采集器上线"]);
      expect(input.progress.map((item) => [item.label, item.body])).toEqual([["10/13 进展 · 采集器上线", "装好了三台机器"]]);
      expect(input.meetings).toEqual([expect.objectContaining({ label: "10/14 会议 · 采集器评审", conclusions: ["原文保留 14 天"], summary: "评审了采集器", cite: expect.stringMatching(/^cite:meeting:/) })]);
      expect(input.collectorRecords).toEqual([expect.objectContaining({ label: "10/15 Codex 记录", text: "整理服务写完", placement: "task", taskTitle: "采集器上线" })]);
      expect(input.previousReview).toMatchObject({ cite: `cite:weekly-review:${previous}`, label: "10/05 周复盘", text: expect.stringContaining("状态：黄｜采集器还没装") });
      expect(input.missingRecords).toEqual([]);
      expect(t.calls.find((item) => item.personId === THIRD)!.missingRecords).toEqual(["Mission 卡", "Mission 与 Task 进展", "会议结论", "采集记录", "上周复盘"]);

      const id = await t.idOf(MEMBER);
      const view = (await t.read(id)).json().review;
      expect(Value.Check(WeeklyReviewPayload, view)).toBe(true);
      expect(view).toMatchObject({ status: "draft", weekStart: WEEK, weekEnd: "2026-10-18", origin: "tianshu" });
      expect(view.generationSteps.map((step: any) => [step.label, step.status, step.result])).toEqual([
        ["读 Mission 卡", "done", "2 张"], ["读 Mission 与 Task 进展", "done", "1 条进展，1 件执行事项"], ["读会议结论", "done", "1 场"],
        ["读采集记录", "done", "1 条"], ["读上周复盘", "done", "10/05"], ["起草", "done", undefined]]);
      expect(view.body.overall.sources).toEqual(["mission:execution-one"]);
      expect(view.revisions).toEqual([{ at: FRIDAY_3PM.toISOString(), kind: "generate", byName: "Co-Agent", fields: ["overall", "progress", "issues", "implications", "actions", "nextWeek"] }]);
      expect((await t.read(await t.idOf(THIRD), t.f.third)).json().review.body.overall.text).toBe("状态：绿｜按计划推进，缺少记录。");

      // 编造出处、有一句没出处、该写「缺少记录」没写：都不收，三次后失败可见。
      t.generate((input) => ({ ...cited(input), issues: { text: `有依据[编造](cite:progress:${randomUUID()})。`, sources: [] } }));
      expect((await t.act(id, "generate")).statusCode).toBe(200);
      await t.f.t.weeklyReviews!.idle();
      expect((await t.read(id)).json().review).toMatchObject({ status: "draft_failed", draftError: { code: "invalid_weekly_review_candidate", message: expect.stringContaining("引用了输入里没有的出处") } });
    } finally { await t.f.t.close(); }
  });
});

describe("周复盘：公司现行模板（《DRI 周复盘使用说明》）", () => {
  const section = (text: string) => ({ text, sources: [] });
  const good: TWeeklyReviewBody = {
    overall: section("状态：黄｜功能可用，稳定独立运行仍未被证明[R](cite:r)。"), progress: section("- 4 次真实运行 1 次独立完成[R](cite:r)。"),
    issues: section("瓶颈在 Context 准备[R](cite:r)。"), implications: section("「功能 Ready 即可独立运行」被削弱[R](cite:r)。"),
    actions: section("责任范围内调整｜先验证 Context × Workflow[R](cite:r)。"), nextWeek: section("跑通一条完整运行链[R](cite:r)。"),
  };
  it("状态行、进展 1–3 条、问题 1–2 条、判断变化的说法、当前处理三选一、篇幅", () => {
    expect(templateProblem(good)).toBeNull();
    expect(templateProblem({ ...good, overall: section("功能可用[R](cite:r)。") })).toContain("状态：绿 / 黄 / 红");
    expect(templateProblem({ ...good, progress: section("a\nb\nc\nd") })).toBe("关键进展与 Evidence 最多 3 条");
    expect(templateProblem({ ...good, progress: section("a\nb\nc\n缺少记录：没有验收证据") })).toBeNull();
    expect(templateProblem({ ...good, issues: section("a\nb\nc") })).toBe("最重要的问题及 Why 最多 2 条");
    expect(templateProblem({ ...good, implications: section("判断有变化") })).toContain("被验证 / 被削弱");
    expect(templateProblem({ ...good, actions: section("先验证 Context，继续推进") })).toContain("当前处理只选一个");
    expect(templateProblem({ ...good, actions: section("继续推进，必要时需要升级处理") })).toContain("当前处理只选一个");
    expect(templateProblem({ ...good, nextWeek: section("长".repeat(2200)) })).toMatch(/^篇幅 \d+ 字，超过 2200 字$/);
  });
});

describe("周复盘：本人逐段修改、重新生成保留改过的段、提交", () => {
  it("修改记修改记录；重新生成只换没改过的段；提交要写总体判断和关键进展；提交后只读、排队写本体", async () => {
    const t = await fixture();
    try {
      await seedWeek(t.f);
      t.at(FRIDAY_3PM); await t.scheduled();
      const id = await t.idOf(MEMBER);
      const first = (await t.read(id)).json().review;
      expect(first.actions.map((action: any) => action.actionType)).toEqual(["weekly-review.update", "weekly-review.submit", "weekly-review.generate"]);
      t.at("2026-10-16T08:00:00Z");
      const saved = await t.act(id, "update", { fields: [{ field: "issues", text: "我自己写的问题" }, { field: "overall", text: first.body.overall.text }] });
      expect(saved.json().review).toMatchObject({ editedFields: ["issues"], body: { issues: { text: "我自己写的问题" } } });
      expect(saved.json().review.revisions[0]).toEqual({ at: "2026-10-16T08:00:00.000Z", kind: "edit", byName: "测试乙", fields: ["issues"] });
      const stored = (await t.f.t.sql("SELECT revisions FROM weekly_reviews WHERE id=$1", [id]))[0].revisions as any[];
      expect(stored.at(-1).previous).toEqual({ issues: first.body.issues.text });

      t.generate((input) => cited(input, "第二版"));
      expect((await t.act(id, "generate")).statusCode).toBe(200);
      await t.f.t.weeklyReviews!.idle();
      const second = (await t.read(id)).json().review;
      expect(second.body.issues.text).toBe("我自己写的问题");
      expect(second.body.overall.text).toMatch(/^状态：绿｜第二版\[/);
      expect(second.generationSteps.at(-1)).toEqual({ id: "draft", label: "起草", status: "done", result: "保留你改过的 1 段" });
      expect(second.revisions[0]).toMatchObject({ kind: "generate", fields: ["overall", "progress", "implications", "actions", "nextWeek"] });

      await t.act(id, "update", { fields: [{ field: "progress", text: "" }] });
      const incomplete = await t.act(id, "submit");
      expect(incomplete.statusCode).toBe(400);
      expect(incomplete.json()).toMatchObject({ code: "WEEKLY_REVIEW_INCOMPLETE", fieldErrors: { progress: "required" } });
      await t.act(id, "update", { fields: [{ field: "progress", text: second.body.progress.text }] });
      const submitted = await t.act(id, "submit");
      expect(submitted.json().review).toMatchObject({ status: "submitted", actions: [] });
      expect((await t.f.t.sql("SELECT world_sync_status FROM weekly_reviews WHERE id=$1", [id]))[0].world_sync_status).toBe("pending");
      expect((await t.act(id, "update", { fields: [{ field: "issues", text: "提交后再改" }] })).statusCode).toBe(409);
      expect((await t.act(await t.idOf(THIRD), "update", { fields: [{ field: "issues", text: "改别人的" }] })).statusCode).toBe(403);
    } finally { await t.f.t.close(); }
  });
});

describe("周复盘：可见范围（本人、同战场、CEO）", () => {
  it("同战场的人看得到名单，提交后才看得到正文；不同战场的人看不到；CEO 看全部", async () => {
    const t = await fixture();
    try {
      t.at(FRIDAY_3PM); await t.scheduled();
      const mine = await t.idOf(MEMBER), theirs = await t.idOf(THIRD);
      expect((await t.read(mine, t.f.third)).statusCode).toBe(404);
      const thirdBoard = await t.board(t.f.third);
      expect(Value.Check(WeeklyReviewBoard, thirdBoard)).toBe(true);
      expect(thirdBoard.rows.map((row: any) => row.personId)).toEqual([THIRD]);

      await t.f.t.sql("UPDATE battlefield_config SET participant_ids=$1::jsonb WHERE id='growth'", [JSON.stringify([THIRD])]);
      const peerView = (await t.read(mine, t.f.third)).json().review;
      expect(peerView).toMatchObject({ status: "draft", body: null, generationSteps: [], actions: [], viewer: { isSelf: false, isCeo: false } });
      const memberBoard = await t.board();
      expect(memberBoard).toMatchObject({ weekStart: WEEK, weekEnd: "2026-10-18", isCurrentWeek: true, counts: { total: 2, submitted: 0 } });
      expect(memberBoard.rows.map((row: any) => [row.personName, row.isSelf, row.href])).toEqual([["测试乙", true, `/me/weekly-reviews/${mine}`], ["测试丙", false, `/me/weekly-reviews/${theirs}`]]);

      await t.act(mine, "submit");
      expect((await t.read(mine, t.f.third)).json().review.body.overall.text).toContain("状态：绿");
      const ceo = (await t.read(theirs, t.f.ceo)).json().review;
      expect(ceo).toMatchObject({ body: null, viewer: { isSelf: false, isCeo: true } });
      expect((await t.board(t.f.ceo)).rows.map((row: any) => row.href)).toEqual([`/weekly-reviews/${theirs}`, `/weekly-reviews/${mine}`]);
      expect((await call(t.f, t.f.member, "GET", "/api/weekly-reviews/board?week=2026-10-13")).statusCode).toBe(400);
      expect(await t.board(t.f.member, "2026-10-05")).toMatchObject({ rows: [], nextWeek: WEEK, previousWeek: null });
    } finally { await t.f.t.close(); }
  });
});

describe("周复盘：对话入口的服务函数", () => {
  it("generateFor 没有就建、onStep 收到每一步；已提交的不重新生成", async () => {
    const t = await fixture();
    try {
      t.at("2026-10-14T02:00:00Z");
      const events: string[] = [];
      const started = await t.f.t.weeklyReviews!.generateFor(MEMBER, { onStep: (steps) => events.push(steps.map((step) => step.status[0]).join("")) });
      expect(started.status).toBe("drafting");
      await started.done;
      expect(events.at(0)).toBe("pppppp");
      expect(events.at(-1)).toBe("dddddd");
      expect((await t.read(started.weeklyReviewId)).json().review).toMatchObject({ status: "draft", weekStart: WEEK });
      await t.act(started.weeklyReviewId, "submit");
      const again = await t.f.t.weeklyReviews!.generateFor(MEMBER);
      expect(again).toMatchObject({ weeklyReviewId: started.weeklyReviewId, status: "submitted" });
    } finally { await t.f.t.close(); }
  });
});
