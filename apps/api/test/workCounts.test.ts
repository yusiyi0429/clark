import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { TWorkCountsResponse } from "@warmap/contracts";
import { recordTurnModel } from "../src/chatTurnModels.js";
import type { Query } from "../src/meetingStore.js";
import { createTestApp, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";

/** 三人名单：测试甲（CEO，管理员）、乙（DRI）、丙（参与人）。2026-10-19 是周一：数上一周 10/12–10/18（北京时间）。 */
const PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
const THIRD = "person-fixture-003";
const NOW = new Date("2026-10-19T02:00:00.000Z");
const WEEK = "2026-10-12";
const IN = (day: number, hour = 2) => new Date(Date.UTC(2026, 9, day, hour));
const BEFORE = new Date("2026-10-05T02:00:00Z");
const ME = TEST_MEMBER.personId;

let t: TestApp | undefined;
afterEach(async () => { await t?.close(); t = undefined; });

async function seed(app: TestApp) {
  const q = (sql: string, params: unknown[] = []) => app.sql(sql, params);
  // 对话：甲两轮伙伴对话（还有一轮是上上周的、一轮没记是哪种的老数据），乙一轮项目对话走 Chat、一轮在本机跑完、一轮本机没跑成。
  const qq = app.sql as unknown as Query;
  await recordTurnModel(qq, TEST_CEO.personId, "r1", { provider: "p", model: "m" }, IN(13), "buddy");
  await recordTurnModel(qq, TEST_CEO.personId, "r2", { provider: "p", model: "m" }, IN(14), "buddy");
  await recordTurnModel(qq, TEST_CEO.personId, "r2", { provider: "p", model: "m2" }, IN(14));
  await recordTurnModel(qq, TEST_CEO.personId, "r0", { provider: "p", model: "m" }, BEFORE, "buddy");
  await recordTurnModel(qq, TEST_CEO.personId, "old", { provider: "p", model: "m" }, IN(13));
  await recordTurnModel(qq, ME, "r3", { provider: "p", model: "m" }, IN(15), "project");
  const project = randomUUID();
  await q("INSERT INTO projects(id,owner_id,name,created_at,updated_at) VALUES($1,$2,'项目',now(),now())", [project, ME]);
  const localTurn = (status: string) => q(`INSERT INTO project_local_turns(id,owner_id,project_id,device_id,client_turn_id,request_hash,conversation_id,message,agent,model_label,
    status,started_at,heartbeat_at) VALUES($1,$2,$3,$4,$5,'h','c','问','claude_code','m',$6,$7,$7)`, [randomUUID(), ME, project, randomUUID(), randomUUID(), status, IN(15)]);
  await localTurn("completed");
  await localTurn("released");

  // 派活单：一份改过一次、放进看板两张；一份点了不要。
  const plan = async (revision: number) => {
    const id = randomUUID();
    await q(`INSERT INTO card_plans(id,plan_task_id,mission_id,owner_id,status,source,revision,created_at,finished_at) VALUES($1,$2,'m',$3,'done','local',$4,$5,$5)`,
      [id, `task-${id}`, ME, revision, IN(13)]);
    return id;
  };
  const draft = (planId: string, position: number, status: string) => q(`INSERT INTO card_drafts(id,plan_id,plan_task_id,owner_id,position,title,done_definition,executor,model_tier,status,decided_at)
    VALUES($1,$2,'p',$3,$4,'卡','做完','claude_code','normal',$5,$6)`, [randomUUID(), planId, ME, position, status, IN(14)]);
  const revised = await plan(2);
  await draft(revised, 0, "accepted");
  await draft(revised, 1, "accepted");
  await draft(await plan(1), 0, "dismissed");

  // 卡：一张这周第一次开（开了两次，第二次全部放行）；一张上上周就开过、这周又开一次。
  const task = async () => {
    const id = randomUUID();
    await q("INSERT INTO tasks(id,title,owner_id,created_by,status) VALUES($1,'卡',$2,'self','in_progress')", [id, ME]);
    return id;
  };
  const run = (taskId: string, started: Date, mode: string | null = null) => q(`INSERT INTO local_runs(id,owner_id,device_id,kind,task_id,state,started_at,updated_at,permission_mode)
    VALUES($1,$2,$3,'card',$4,'exited',$5,$5,$6)`, [randomUUID(), ME, randomUUID(), taskId, started, mode]);
  const fresh = await task(), older = await task();
  await run(fresh, IN(13));
  await run(fresh, IN(14), "bypassPermissions");
  await run(older, BEFORE);
  await run(older, IN(14));

  // 交回：fresh 没过 → 等你补 → 没过（连续第二次，受阻），最后那次本人推翻（就到这里）；older 过了。
  const handback = (taskId: string, attempt: number, outcome: string, overruled: Date | null = null) => q(`INSERT INTO card_handbacks(id,task_id,owner_id,client_id,attempt,status,outcome,
    created_at,finished_at,overruled_at) VALUES($1,$2,$3,$4,$5,'done',$6,$7,$7,$8)`, [randomUUID(), taskId, ME, `c${attempt}`, attempt, outcome, IN(14 + attempt), overruled]);
  await handback(fresh, 1, "fail");
  await handback(fresh, 2, "needs_person");
  await handback(fresh, 3, "fail", IN(18, 3));
  await handback(older, 1, "pass");

  // 用过的天：乙这周两天、上上周一天。
  const active = (when: Date) => q(`INSERT INTO usage_events(person_id,kind,day,created_at) VALUES($1,'active',($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,$2)`, [ME, when]);
  await active(IN(13));
  await active(IN(16));
  await active(BEFORE);
}

describe("使用计数（第 70 条）", () => {
  it("只给管理员；按北京时间的一周现算，没用过的人也列出来", async () => {
    t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED, adminPersonIds: [TEST_CEO.personId] }, undefined, { monthlyNow: () => NOW });
    const admin = await t.loginCookie(), member = await t.memberCookie();
    const get = (cookie: string, url: string) => t!.app.inject({ method: "GET", url, headers: { cookie } });
    expect((await get(member, "/api/admin/work-counts")).statusCode).toBe(404);
    expect((await get(admin, "/api/admin/work-counts?week=2026-10-13")).statusCode).toBe(400);
    await seed(t);

    const response = await get(admin, `/api/admin/work-counts?week=${WEEK}`);
    expect(response.statusCode).toBe(200);
    const view = response.json() as TWorkCountsResponse;
    expect(view.weekStart).toBe(WEEK);
    expect(view.weekEnd).toBe("2026-10-18");
    expect(view.notCounted).toHaveLength(2);
    const row = (personId: string) => view.rows.find((item) => item.personId === personId);
    expect(view.rows).toHaveLength(3);
    expect(row(TEST_CEO.personId)).toMatchObject({ name: "测试甲", buddyTurns: 2, projectTurns: 0 });
    expect(row(ME)).toEqual({
      personId: ME, name: "测试乙", buddyTurns: 0, projectTurns: 2,
      plans: { started: 1, revised: 1, dropped: 1 },
      cards: { started: 1, handedBack: 4, passed: 1, failed: 2, blocked: 1, needsPerson: 1, closedWithGap: 1 },
      bypassSessions: 1, activeDays: 2,
    });
    expect(row(THIRD)).toMatchObject({ buddyTurns: 0, projectTurns: 0, bypassSessions: 0, activeDays: 0, cards: { started: 0, handedBack: 0 } });
  });
});
