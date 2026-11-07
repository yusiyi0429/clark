import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { globalConversationContext } from "../src/conversationContext.js";
import { meetingInterpretationContext } from "../src/meetingContext.js";
import { listAvailableMissions } from "../src/tasks.js";
import { visibleMissions } from "../src/visibleMissions.js";
import { createTestApp, TEST_CEO, TEST_MEMBER, type TestApp } from "./helpers.js";

/** 11 月 7 日（公司时区）：本体里还没有 11 月的 Mission，生产上 missions 只有 9 月和 10 月的。 */
const NOW = new Date("2026-11-07T04:00:00.000Z");
const MEMBER = TEST_MEMBER.personId;
const CEO = TEST_CEO.personId;

describe("看得见的 Mission：本月没有就退回这个人最近一个月，加之前月份还有没了结、动过的 Task 的", () => {
  let t: TestApp;
  afterEach(async () => { await t?.close(); });
  const q = () => t.pool.query.bind(t.pool);
  const mission = (id: string, owner: string, period: string) => t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,
      capability_id,battlefield_ids,outcome,milestones,source_ref,source_document_id,source_revision,source_title)
    VALUES($1,1,$1,$2,$3,$4,'method','["growth"]','目标','[]','fixture://v','fixture',1,'fixture')`, [id, period, `${id} 标题`, owner]);
  /** 当成从本体载入的 Mission。 */
  const fromWorld = (id: string, objectId: string) => t.sql(`UPDATE missions SET world_object_id=$2,world_scope_id='scope-x',world_domain_id='d-1',
    world_status='进行中',world_read_at=now() WHERE id=$1`, [id, objectId]);
  /** 挂在本体 Task 下的执行事项（天枢里动过这件 Task）。 */
  const item = async (missionId: string, planTaskId: string, status = "in_progress") => {
    const id = randomUUID();
    await t.sql(`INSERT INTO tasks(id,title,status,owner_id,created_by,mission_id,plan_task_id,step_order) VALUES($1,'接着做的事',$2,$3,'self',$4,$5,1)`,
      [id, status, MEMBER, missionId, planTaskId]);
    return id;
  };
  const seed = async () => {
    t = await createTestApp({}, undefined, { monthlyNow: () => NOW });
    await mission("m-oct-a", MEMBER, "2026-10");
    await mission("m-oct-b", MEMBER, "2026-10");
    await mission("m-sep-a", MEMBER, "2026-09");
    await mission("m-sep-b", MEMBER, "2026-09");
    await mission("m-nov-ceo", CEO, "2026-11");
    await mission("m-oct-ceo", CEO, "2026-10");
  };
  const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();

  it("本月没有的人退回自己最近一个月；本月有的人只看本月；之前月份还有没了结、动过的 Task 的 Mission 也看得见", async () => {
    await seed();
    await item("m-sep-a", "T-sep-a");
    await item("m-sep-b", "T-sep-b", "returned");
    const all = await visibleMissions(q(), NOW);
    expect(all.map(({ id, period, carried, openTaskIds }) => [id, period, carried, openTaskIds])).toEqual([
      ["m-nov-ceo", "2026-11", false, []],
      ["m-oct-a", "2026-10", false, []], ["m-oct-b", "2026-10", false, []],
      ["m-sep-a", "2026-09", true, ["T-sep-a"]],
    ]);
    expect(ids(await visibleMissions(q(), NOW, { ownerId: MEMBER }))).toEqual(["m-oct-a", "m-oct-b", "m-sep-a"]);
    expect(ids(await visibleMissions(q(), NOW, { ownerId: CEO }))).toEqual(["m-nov-ceo"]);
  }, 30_000);

  it("了结只有三种：确认完成（之后开了返工又算没了结）、到此为止、已延续；事项做完了不算", async () => {
    await seed();
    const card = await item("m-sep-a", "T-sep-a");
    const shown = async () => ids(await visibleMissions(q(), NOW, { ownerId: MEMBER }));
    await t.sql("UPDATE tasks SET status='done' WHERE id=$1", [card]);
    expect(await shown()).toContain("m-sep-a");

    await t.sql("INSERT INTO task_stops(task_id,decided_by,decided_at,note) VALUES('T-sep-a',$1,now(),'不做了')", [MEMBER]);
    expect(await shown()).not.toContain("m-sep-a");
    await t.sql("DELETE FROM task_stops");

    await t.sql(`INSERT INTO deliverable_versions(id,task_id,mission_id,author_id,number,task_name,basis,delivered_at)
      VALUES($1,'T-sep-a','m-sep-a',$2,1,'9 月的事','none','2026-10-01T00:00:00Z')`, [randomUUID(), MEMBER]);
    expect(await shown()).not.toContain("m-sep-a");
    const rework = await item("m-sep-a", "T-sep-a");
    await t.sql("UPDATE tasks SET rework_of_card_id=$2 WHERE id=$1", [rework, card]);
    expect(await shown()).toContain("m-sep-a");

    await t.sql(`INSERT INTO task_continuations(from_task_id,to_task_id,source,decided_by,decided_at,from_mission_id,from_task_name,to_mission_id,to_task_name)
      VALUES('T-sep-a','T-nov','owner',$1,now(),'m-sep-a','9 月的事','m-nov-ceo','11 月接着做')`, [MEMBER]);
    expect(await shown()).not.toContain("m-sep-a");
  }, 30_000);

  it("只开过 Task 管线的也算动过（按记下的 Task 所在 Mission）；{ personId } 带出本人动过的、别人负责的 Mission", async () => {
    await seed();
    await t.sql("INSERT INTO plan_task_missions(task_id,mission_id,seen_at) VALUES('T-oct-ceo','m-oct-ceo',now())");
    await t.sql("INSERT INTO conversations(id,scope,owner_id,pi_session_id) VALUES($1,'plan-task:T-oct-ceo',$2,$3)", [randomUUID(), CEO, randomUUID()]);
    expect((await visibleMissions(q(), NOW, { ownerId: CEO })).map(({ id, carried, openTaskIds }) => [id, carried, openTaskIds]))
      .toEqual([["m-nov-ceo", false, []], ["m-oct-ceo", true, ["T-oct-ceo"]]]);
    // 本人在别人负责的 Mission 下动过一件：本人的左栏带出那个 Mission，openTaskIds 只算本人动过的。
    expect(ids(await visibleMissions(q(), NOW, { personId: MEMBER }))).toEqual(["m-oct-a", "m-oct-b"]);
    await item("m-oct-ceo", "T-oct-member");
    expect((await visibleMissions(q(), NOW, { personId: MEMBER })).map(({ id, openTaskIds }) => [id, openTaskIds]))
      .toEqual([["m-oct-ceo", ["T-oct-member"]], ["m-oct-a", []], ["m-oct-b", []]]);
  }, 30_000);

  it("本月已经从本体载入过：本月没有的人不退回（斯一 10/24），只剩还有没了结 Task 的", async () => {
    await seed();
    await item("m-oct-b", "T-oct-b");
    await fromWorld("m-nov-ceo", "w-nov");
    expect((await visibleMissions(q(), NOW, { ownerId: MEMBER })).map(({ id, carried }) => [id, carried])).toEqual([["m-oct-b", true]]);
  }, 30_000);

  it("能挂执行事项的 Mission：退回的那个月和还有没了结 Task 的都能挂；之后月份的照旧能挂", async () => {
    await seed();
    await item("m-sep-a", "T-sep-a");
    await mission("m-dec-a", MEMBER, "2026-12");
    expect((await listAvailableMissions(q(), MEMBER, NOW)).map((row) => [row.id, row.period])).toEqual([
      ["m-sep-a", "2026-09"], ["m-oct-a", "2026-10"], ["m-oct-b", "2026-10"], ["m-dec-a", "2026-12"],
    ]);
    const cookie = await t.memberCookie();
    const create = (missionId: string) => t.app.inject({ method: "POST", url: "/api/me/tasks", headers: { cookie, origin: t.publicOrigin },
      payload: { clientId: randomUUID(), title: "补一份方案", missionId } });
    expect((await create("m-oct-a")).statusCode).toBe(200);
    // 9 月没有没了结的 Task 的那个还是挂不上。
    const stale = await create("m-sep-b");
    expect([stale.statusCode, stale.json().code]).toEqual([404, "MISSION_NOT_AVAILABLE"]);
  }, 30_000);

  it("伙伴的全局上下文和会议解读看得见退回的、带出没了结 Task 的 Mission，带月份", async () => {
    await seed();
    await item("m-sep-a", "T-sep-a");
    const context = await globalConversationContext(q(), NOW);
    expect(context).toMatchObject({ period: "2026-11", missionCount: 4, missionPeriods: ["2026-11", "2026-10", "2026-09"] });

    const meeting = await meetingInterpretationContext(q(), NOW, new Map([[MEMBER, "乙"], [CEO, "甲"]]));
    const member = meeting.people.find((person) => person.personId === MEMBER)!;
    expect(member.missions.map(({ id, period }) => [id, period])).toEqual([["m-oct-a", "2026-10"], ["m-oct-b", "2026-10"], ["m-sep-a", "2026-09"]]);
    expect(meeting.people.find((person) => person.personId === CEO)!.missions.map(({ id }) => id)).toEqual(["m-nov-ceo"]);
  }, 30_000);
});
