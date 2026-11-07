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

describe("看得见的 Mission：本月没有就退回这个人最近一个月，加之前月份还有没了结 Task 的", () => {
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

  it("本月没有的人退回自己最近一个月；本月有的人只看本月；之前月份还挂着没做完的事项的 Mission 也看得见", async () => {
    await seed();
    await item("m-sep-a", "T-sep-a");
    await item("m-sep-b", "T-sep-b", "done");
    const all = await visibleMissions(q(), NOW);
    expect(all.map(({ id, period, carried }) => [id, period, carried])).toEqual([
      ["m-nov-ceo", "2026-11", false],
      ["m-oct-a", "2026-10", false], ["m-oct-b", "2026-10", false],
      ["m-sep-a", "2026-09", true],
    ]);
    expect(ids(await visibleMissions(q(), NOW, MEMBER))).toEqual(["m-oct-a", "m-oct-b", "m-sep-a"]);
    expect(ids(await visibleMissions(q(), NOW, CEO))).toEqual(["m-nov-ceo"]);

    // 事项做完了，那件 Task 不再算没了结。
    await t.sql("UPDATE tasks SET status='done' WHERE plan_task_id='T-sep-a'");
    expect(ids(await visibleMissions(q(), NOW, MEMBER))).toEqual(["m-oct-a", "m-oct-b"]);
  }, 30_000);

  it("本月已经从本体载入过：本月没有的人不退回（斯一 10/24），只剩还有没了结 Task 的", async () => {
    await seed();
    await item("m-oct-b", "T-oct-b");
    await fromWorld("m-nov-ceo", "w-nov");
    expect((await visibleMissions(q(), NOW, MEMBER)).map(({ id, carried }) => [id, carried])).toEqual([["m-oct-b", true]]);
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
