import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { TMyOffPlanResponse, TProgressOverview } from "@warmap/contracts";
import {
  addWorkdays, coverageUntil, deadlineGap, missionDeadline, plainReviewText, remainingPlannedDays, slowReason, workdaysBetween, type PlanTask,
} from "../src/progress.js";
import { call, executionFixture, type Fixture } from "./executionFixture.js";
import { TEST_CEO, TEST_MEMBER } from "./helpers.js";

const MEMBER = TEST_MEMBER.personId, THIRD = "person-fixture-003";
const task = (extra: Partial<PlanTask> = {}): PlanTask => ({ status: "in_progress", startDate: "2026-10-12", dueDate: "2026-10-16", lastVerifiedAt: null, ...extra });

describe("全局进展的规则", () => {
  it("工作日：周一到周五，含首尾；跨周末不算周六日；倒过来为 0", () => {
    expect(workdaysBetween("2026-10-12", "2026-10-16")).toBe(5);
    expect(workdaysBetween("2026-10-16", "2026-10-19")).toBe(2);
    expect(workdaysBetween("2026-10-17", "2026-10-18")).toBe(0);
    expect(workdaysBetween("2026-10-16", "2026-10-16")).toBe(1);
    expect(workdaysBetween("2026-10-16", "2026-10-15")).toBe(0);
    expect(addWorkdays("2026-10-16", 1)).toBe("2026-10-19");
    expect(addWorkdays("2026-10-12", 3)).toBe("2026-10-15");
  });

  it("比预期慢·过了截止日：截止当天不算，第二天起算", () => {
    const verified = task({ lastVerifiedAt: new Date("2026-10-13T02:00:00Z") });
    expect(slowReason(verified, "2026-10-16")).toBeNull();
    expect(slowReason(verified, "2026-10-17")).toBe("overdue");
    // 又过期又没核实过的进展：记过期这一种。
    expect(slowReason(task(), "2026-10-19")).toBe("overdue");
  });

  it("比预期慢·开工 3 个工作日没有核实过的进展：开始日之后第 3 个工作日起算，周末不算", () => {
    const monday = task({ startDate: "2026-10-12", dueDate: "2026-10-23" });
    expect(slowReason(monday, "2026-10-14")).toBeNull();
    expect(slowReason(monday, "2026-10-15")).toBe("no_progress");
    expect(slowReason({ ...monday, lastVerifiedAt: new Date("2026-10-14T02:00:00Z") }, "2026-10-15")).toBeNull();
    const friday = task({ startDate: "2026-10-16", dueDate: "2026-10-30" });
    expect(slowReason(friday, "2026-10-20")).toBeNull();
    expect(slowReason(friday, "2026-10-21")).toBe("no_progress");
    // 还没到开始日。
    expect(slowReason(task({ startDate: "2026-10-26", dueDate: "2026-10-30" }), "2026-10-16")).toBeNull();
  });

  it("按截止日做不完：还需的计划工作日之和等于剩下的工作日不算，多一天才算", () => {
    // 没开始的按原计划；进行中的按今天到截止，至少 1 天。
    expect(remainingPlannedDays(task({ status: "not_started", startDate: "2026-10-19", dueDate: "2026-10-21" }), "2026-10-16")).toBe(3);
    expect(remainingPlannedDays(task({ startDate: "2026-10-12", dueDate: "2026-10-20" }), "2026-10-16")).toBe(3);
    expect(remainingPlannedDays(task({ startDate: "2026-10-12", dueDate: "2026-10-14" }), "2026-10-16")).toBe(1);
    const next = task({ status: "not_started", startDate: "2026-10-19", dueDate: "2026-10-20" });
    // 10/16（五）到 10/20（二）剩 3 个工作日。
    expect(deadlineGap([task({ startDate: "2026-10-12", dueDate: "2026-10-16" }), next], "2026-10-20", "2026-10-16")).toBeNull();
    expect(deadlineGap([task({ startDate: "2026-10-12", dueDate: "2026-10-14" }), task({ startDate: "2026-10-13", dueDate: "2026-10-20" })], "2026-10-20", "2026-10-16"))
      .toEqual({ neededDays: 4, leftDays: 3 });
    // 截止日已过：剩 0 天，没做完就算。
    expect(deadlineGap([task({ startDate: "2026-10-12", dueDate: "2026-10-14" })], "2026-10-15", "2026-10-16")).toEqual({ neededDays: 1, leftDays: 0 });
  });

  it("卡片截止日取里程碑里最晚的日期，没有日期取月底", () => {
    expect(missionDeadline(["10/12 交付", "2026-10-20 复盘", "待定"], "2026-10")).toBe("2026-10-20");
    expect(missionDeadline(["待定"], "2026-10")).toBe("2026-10-31");
    expect(missionDeadline([], "2026-02")).toBe("2026-02-28");
  });

  it("信息截至取各来源 coverage_until 的最小值；本机没有的来源、从没覆盖过的不算", () => {
    expect(coverageUntil([
      { status: "ok", coverageUntil: new Date("2026-10-16T01:00:00Z") },
      { status: "error", coverageUntil: new Date("2026-10-15T12:00:00Z") },
      { status: "not_found", coverageUntil: new Date("2026-10-01T00:00:00Z") },
      { status: "ok", coverageUntil: null },
    ])?.toISOString()).toBe("2026-10-15T12:00:00.000Z");
    expect(coverageUntil([{ status: "not_found", coverageUntil: null }])).toBeNull();
    expect(coverageUntil([])).toBeNull();
  });

  it("周复盘正文去掉出处标记", () => {
    expect(plainReviewText("上线了采集器[采集记录 10/14](cite:collector:abc)。看了 [PR](https://x.test/1)。")).toBe("上线了采集器。看了 PR。");
  });
});

// ---------- 接口 ----------

const NOW = new Date("2026-10-16T02:00:00.000Z"); // 周五 10:00（上海）

async function seedTask(f: Fixture, title: string, missionId: string, status: string, start: string, due: string, owner = MEMBER) {
  const id = randomUUID();
  await f.t.sql(`INSERT INTO tasks(id,title,status,owner_id,created_by,mission_id,step_order,start_date,due_date)
    VALUES($1,$2,$3,$4,'plan',$5,(SELECT COALESCE(max(step_order),0)+1 FROM tasks WHERE mission_id=$5),$6,$7)`, [id, title, status, owner, missionId, start, due]);
  await f.t.sql("INSERT INTO task_members(task_id,person_id,role,added_by) VALUES($1,$2,'owner',$2)", [id, owner]);
  return id;
}
async function seedOffPlan(f: Fixture, personId: string, placement: string, text: string, opts: { taskId?: string; minutes?: number[]; endedAt?: string; resolution?: string } = {}) {
  const token = randomUUID();
  await f.t.sql("INSERT INTO personal_tokens(id,person_id,name,client,secret_hash,created_at) VALUES($1,$2,'collector','collector',$3,$4)", [token, personId, randomUUID(), NOW]);
  const ended = new Date(opts.endedAt ?? "2026-10-15T08:00:00Z");
  const items: string[] = [];
  for (const minutes of opts.minutes ?? [60]) {
    const id = randomUUID();
    items.push(id);
    // 原文已清空（14 天后），只剩出处：时间段照样能算出花了多久。
    await f.t.sql(`INSERT INTO collector_items(id,person_id,device_id,token_id,report_kind,client_event_id,source,started_at,ended_at,summary,links,task_hint,received_at,distill_status,raw_purged_at)
      VALUES($1,$2,'device-01',$3,'digest',$4,'claude',$5,$6,NULL,'[]','Tianshu-MVP',$6,'done',$6)`,
    [id, personId, token, randomUUID(), new Date(ended.getTime() - minutes * 60_000), ended]);
  }
  const id = randomUUID();
  await f.t.sql(`INSERT INTO collector_progress(id,person_id,source,repo,started_at,ended_at,text,placement,confidence,task_id,item_ids,links,created_at,resolution,resolved_at,resolved_by)
    VALUES($1,$2,'claude','Tianshu-MVP',$3,$4,$5,$6,0.6,$7,$8::uuid[],'[{"url":"https://github.com/TokenkingOS/Tianshu-MVP/pull/30","title":"PR 30"}]',$4,$9,$10,$11)`,
  [id, personId, new Date(ended.getTime() - 3 * 3_600_000), ended, text, placement, opts.taskId ?? null, items,
    opts.resolution ?? null, opts.resolution ? NOW : null, opts.resolution ? personId : null]);
  return id;
}

/** 甲是 CEO（growth 战场负责人），乙有 Task 基线，丙不在任何战场、只有周复盘和采集记录。 */
async function scenario() {
  const f = await executionFixture();
  f.setNow(NOW);
  // execution-one：卡片截止 10/20（里程碑里最晚的日期），今天（10/16 周五）到截止剩 3 个工作日。
  const overdue = await seedTask(f, "写回协议", "execution-one", "in_progress", "2026-10-12", "2026-10-14");
  const verified = await seedTask(f, "读回校验", "execution-one", "in_progress", "2026-10-13", "2026-10-20");
  await f.t.sql(`INSERT INTO task_progress(id,task_id,author_id,source,body,links,created_at) VALUES($1,$2,$3,'web','样例跑通','[{"url":"https://docs.test/readback","title":"读回样例"}]',$4)`,
    [randomUUID(), verified, MEMBER, new Date("2026-10-14T02:00:00Z")]);
  // 只是自述（没有链接、不是采集整理来的）不算核实过的进展。
  const stalled = await seedTask(f, "整理验证口径", "execution-two", "in_progress", "2026-10-12", "2026-10-16");
  await f.t.sql("INSERT INTO task_progress(id,task_id,author_id,source,body,links,created_at) VALUES($1,$2,$3,'web','在弄','[]',$4)", [randomUUID(), stalled, MEMBER, new Date("2026-10-14T02:00:00Z")]);
  const onTrack = await seedTask(f, "验证复盘", "execution-two", "not_started", "2026-10-19", "2026-10-20");
  await f.t.sql(`INSERT INTO collector_health(person_id,device_id,source,device_name,platform,collector_version,first_seen_at,last_attempt_at,last_success_at,coverage_until,source_status)
    VALUES ($1,'d1','codex','mac','darwin','1',$2,$2,$2,'2026-10-16T01:00:00Z','ok'), ($1,'d1','claude','mac','darwin','1',$2,$2,$2,'2026-10-15T12:00:00Z','ok'),
           ($1,'d1','cursor','mac','darwin','1',$2,$2,NULL,NULL,'not_found'), ($3,'d2','codex','pc','win32','1',$2,$2,$2,'2026-10-14T09:00:00Z','ok')`,
  [MEMBER, NOW, THIRD]);
  await f.t.sql(`INSERT INTO weekly_reviews(id,person_id,week_start,status,body,submitted_at,created_at,updated_at)
    VALUES($1,$2,'2026-10-12','submitted',$3::jsonb,$4,$4,$4)`, [randomUUID(), THIRD, JSON.stringify({
    overall: { text: "本周把采集器装上了[采集记录](cite:collector:1)。", sources: ["collector:1"] }, progress: { text: "装好两台机器。", sources: [] },
    issues: { text: "", sources: [] }, implications: { text: "", sources: [] }, actions: { text: "", sources: [] } }), new Date("2026-10-16T01:00:00Z")]);
  const attach = await seedOffPlan(f, MEMBER, "pending_attach", "调研读回校验的写法", { taskId: verified, minutes: [60, 30] });
  const replan = await seedOffPlan(f, MEMBER, "pending_replan", "重写上手流程的体验构想", { minutes: [120] });
  const thirdItem = await seedOffPlan(f, THIRD, "pending_replan", "给方法部门搭表格");
  await seedOffPlan(f, MEMBER, "pending_attach", "已经挂上的", { taskId: verified, resolution: "attached" });
  await seedOffPlan(f, MEMBER, "pending_replan", "一个多月前的", { endedAt: "2026-09-10T08:00:00Z" });
  return { f, overdue, verified, stalled, onTrack, attach, replan, thirdItem };
}
const overview = async (f: Fixture, cookie: string) => {
  const res = await call(f, cookie, "GET", "/api/progress");
  expect(res.statusCode).toBe(200);
  return res.json().progress as TProgressOverview;
};

describe("全局进展接口", () => {
  it("一号位：先看红线（Task 级两种），按计划的单列；没有 Task 基线的人退回周复盘与采集摘要；计划外分待挂靠、待改计划", async () => {
    const { f, overdue, stalled, onTrack, attach, replan, thirdItem } = await scenario();
    try {
      const view = await overview(f, f.ceo);
      expect(view.today).toBe("2026-10-16");
      const lines = view.redLines.map((line) => line.kind === "slow" ? `slow:${line.reason}:${line.task.title}` : `deadline:${line.mission.title}:${line.neededDays}/${line.leftDays}`);
      expect(lines.sort()).toEqual(["deadline:上线:4/3", "slow:no_progress:整理验证口径", "slow:overdue:写回协议"]);
      const late = view.redLines.find((line) => line.kind === "slow" && line.task.taskId === overdue)!;
      expect(late).toMatchObject({ person: { personId: MEMBER, name: "测试乙" }, mission: { missionId: "execution-one", deadline: "2026-10-20" },
        task: { plannedDays: 3, usedDays: 5 }, coverageUntil: "2026-10-15T12:00:00.000Z" });
      const deadline = view.redLines.find((line) => line.kind === "deadline")!;
      expect(deadline.kind === "deadline" && deadline.artifacts).toEqual([{ url: "https://docs.test/readback", title: "读回样例" }]);
      expect(view.redLines.find((line) => line.kind === "slow" && line.task.taskId === stalled)).toBeTruthy();
      // 按计划在走：只剩 execution-two 里还没开工的那件（execution-one 整组已在「做不完」里）。
      expect(view.onTrack.map((row) => row.task.taskId)).toEqual([onTrack]);

      expect(view.summaries.map((row) => row.person.personId)).toEqual([THIRD]);
      expect(view.summaries[0]).toMatchObject({ coverageUntil: "2026-10-14T09:00:00.000Z",
        weeklyReview: { weekStart: "2026-10-12", weekEnd: "2026-10-18", overall: "本周把采集器装上了。", progress: "装好两台机器。" } });
      expect(view.summaries[0].weeklyReview!.href).toMatch(/^\/weekly-reviews\//);
      expect(view.summaries[0].recent.map((row) => row.text)).toEqual(["给方法部门搭表格"]);

      expect(view.offPlan.map((item) => item.id).sort()).toEqual([attach, replan, thirdItem].sort());
      expect(view.offPlan.find((item) => item.id === attach)).toMatchObject({ kind: "attach", text: "调研读回校验的写法", spentMinutes: 90,
        candidateTask: { title: "读回校验" }, evidence: { source: "claude", repo: "Tianshu-MVP", links: [{ url: "https://github.com/TokenkingOS/Tianshu-MVP/pull/30", title: "PR 30" }] },
        replanProposedAt: null });
      expect(view.offPlan.find((item) => item.id === replan)).toMatchObject({ kind: "replan", spentMinutes: 120, candidateTask: null });
    } finally { await f.t.close(); }
  });

  it("可见范围：二号位看自己和同一战场的人；不在同一战场的看不到；加进战场后看得到", async () => {
    const { f, thirdItem } = await scenario();
    try {
      const member = await overview(f, f.member);
      expect(member.redLines.length).toBe(3);
      expect(member.summaries).toEqual([]);
      expect(member.offPlan.map((item) => item.person.personId)).not.toContain(THIRD);

      const third = await overview(f, f.third);
      expect(third.redLines).toEqual([]);
      expect(third.onTrack).toEqual([]);
      expect(third.summaries.map((row) => row.person.personId)).toEqual([THIRD]);
      expect(third.summaries[0].weeklyReview!.href).toMatch(/^\/me\/weekly-reviews\//);
      expect(third.offPlan.map((item) => item.id)).toEqual([thirdItem]);

      await f.t.sql(`UPDATE battlefield_config SET participant_ids=$1::jsonb WHERE id='growth'`, [JSON.stringify([MEMBER, THIRD])]);
      const peers = await overview(f, f.third);
      expect(peers.redLines.length).toBe(3);
      expect((await overview(f, f.member)).offPlan.map((item) => item.id)).toContain(thirdItem);
    } finally { await f.t.close(); }
  });

  it("二号位处理计划外：挂到自己的执行事项上（记成进展、从计划外消失），或提出改计划（只记下来，一号位看得到）", async () => {
    const { f, verified, attach, replan, thirdItem } = await scenario();
    try {
      const mine = (await call(f, f.member, "GET", "/api/me/off-plan")).json() as TMyOffPlanResponse;
      expect(mine.items.map((item) => item.id).sort()).toEqual([attach, replan].sort());
      expect(mine.tasks.map((item) => item.title)).toContain("读回校验");

      const ceoTask = await seedTask(f, "甲的事", "execution-one", "in_progress", "2026-10-12", "2026-10-30", TEST_CEO.personId);
      expect((await call(f, f.member, "POST", `/api/me/off-plan/${attach}/attach`, { taskId: ceoTask })).statusCode).toBe(400);
      expect((await call(f, f.member, "POST", `/api/me/off-plan/${thirdItem}/attach`, { taskId: verified })).statusCode).toBe(404);

      const attached = await call(f, f.member, "POST", `/api/me/off-plan/${attach}/attach`, { taskId: verified });
      expect(attached.statusCode).toBe(200);
      expect((attached.json() as TMyOffPlanResponse).items.map((item) => item.id)).toEqual([replan]);
      expect(await f.t.sql("SELECT body, source, links FROM task_progress WHERE client_event_id=$1", [attach]))
        .toEqual([{ body: "调研读回校验的写法", source: "claude", links: [{ url: "https://github.com/TokenkingOS/Tianshu-MVP/pull/30", title: "PR 30" }] }]);
      expect((await call(f, f.member, "POST", `/api/me/off-plan/${attach}/attach`, { taskId: verified })).statusCode).toBe(409);
      expect((await call(f, f.member, "POST", `/api/me/off-plan/${attach}/replan`)).statusCode).toBe(409);

      const proposed = await call(f, f.member, "POST", `/api/me/off-plan/${replan}/replan`);
      expect(proposed.statusCode).toBe(200);
      expect((proposed.json() as TMyOffPlanResponse).items[0].replanProposedAt).toBe(NOW.toISOString());
      expect((await call(f, f.member, "POST", `/api/me/off-plan/${replan}/replan`)).statusCode).toBe(200);
      const ceo = await overview(f, f.ceo);
      expect(ceo.offPlan.find((item) => item.id === replan)?.replanProposedAt).toBe(NOW.toISOString());
      expect(ceo.offPlan.find((item) => item.id === attach)).toBeUndefined();
      // 改了计划之后照样能挂上。
      expect((await call(f, f.member, "POST", `/api/me/off-plan/${replan}/attach`, { taskId: verified })).statusCode).toBe(200);
    } finally { await f.t.close(); }
  });
});
