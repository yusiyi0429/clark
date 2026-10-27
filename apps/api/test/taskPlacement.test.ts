import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emptyDraft, emptyPreflight } from "../src/meetingStore.js";
import { dispatchMeetingTodo, TASK_PLACE_JOB } from "../src/tasks.js";
import { taskPlacementJobs, type TaskPlacementAgent } from "../src/taskPlacement.js";
import { call, executionFixture, type Fixture } from "./executionFixture.js";
import { TEST_CEO, TEST_MEMBER } from "./helpers.js";

const NOW = new Date("2026-10-10T02:00:00.000Z");

async function meeting(f: Fixture, anchors: unknown[]): Promise<string> {
  const id = randomUUID();
  await f.t.sql(`INSERT INTO meetings(id,version,title,status,scheduled_at,lead_dri_id,ceo_participant_id,participants,issue_ids,preflight,draft,materials,origin_ref,ends_at,world_anchors)
    VALUES($1,1,'inception review','held',$2,$3,$4,'[]'::jsonb,'[]'::jsonb,$5::jsonb,$6::jsonb,'[]'::jsonb,'{}'::jsonb,$7,$8::jsonb)`,
  [id, "2026-10-09T08:00:00Z", TEST_MEMBER.personId, TEST_CEO.personId, JSON.stringify(emptyPreflight()), JSON.stringify(emptyDraft()), "2026-10-09T09:00:00Z", JSON.stringify(anchors)]);
  return id;
}

async function dispatch(f: Fixture, meetingId: string, text: string): Promise<string> {
  const client = await f.t.pool.connect();
  try {
    return (await dispatchMeetingTodo(client, { id: meetingId, leadDriId: TEST_MEMBER.personId, ceoId: TEST_CEO.personId, title: "inception review", now: NOW },
      { id: randomUUID(), text, ownerPersonId: TEST_MEMBER.personId, dueDate: undefined, quote: null }))!;
  } finally { client.release(); }
}

const fakeAgent = (answer: Awaited<ReturnType<TaskPlacementAgent["place"]>>): TaskPlacementAgent & { inputs: unknown[] } => {
  const inputs: unknown[] = [];
  return { inputs, async place(input) { inputs.push(input); return answer; } };
};
const runPlacement = (f: Fixture, agent: TaskPlacementAgent, taskId: string) =>
  taskPlacementJobs({ pool: f.t.pool, agent, now: () => NOW })[TASK_PLACE_JOB]({ taskId }, {} as never);
const task = async (f: Fixture, id: string) => (await call(f, f.member, "GET", `/api/me/tasks/${id}`)).json().task;

describe("待归位：会后分派和外部 Agent 建的事项必须挂到 Mission", () => {
  it("会挂在负责人自己的 Mission 上：分派时直接挂上，不排归位", async () => {
    const f = await executionFixture();
    try {
      const id = await dispatch(f, await meeting(f, [{ kind: "mission", id: "execution-two" }]), "把会议纪要导入验证一遍");
      expect(await task(f, id)).toMatchObject({ mission: { missionId: "execution-two" } });
      expect((await task(f, id)).unplaced).toBeUndefined();
      expect(await f.t.sql("SELECT 1 FROM jobs WHERE kind=$1", [TASK_PLACE_JOB])).toHaveLength(0);
    } finally { await f.t.close(); }
  });

  it("会挂点对不上：先进待归位、排一次归位；Agent 挑中本人能挂的 Mission 就挂上，群里记一句", async () => {
    const f = await executionFixture();
    try {
      const id = await dispatch(f, await meeting(f, [{ kind: "po", id: "<po>", title: "本期目标" }]), "联调一键唤醒对话");
      expect((await task(f, id)).unplaced).toEqual({ reason: null });
      expect(await f.t.sql("SELECT payload FROM jobs WHERE kind=$1", [TASK_PLACE_JOB])).toEqual([{ payload: { taskId: id } }]);
      const agent = fakeAgent({ missionId: "execution-one", reason: "在交付上线这个 Mission" });
      await runPlacement(f, agent, id);
      expect(agent.inputs[0]).toMatchObject({ item: { title: "联调一键唤醒对话" }, meeting: { title: "inception review", anchors: ["本期目标"] },
        missions: [expect.objectContaining({ id: "execution-one", title: "上线" }), expect.objectContaining({ id: "execution-two", title: "验证" })] });
      const placed = await task(f, id);
      expect(placed).toMatchObject({ mission: { missionId: "execution-one" } });
      expect(placed.unplaced).toBeUndefined();
      const messages = await f.t.sql("SELECT content FROM thread_messages WHERE object_type='task' AND object_id=$1 ORDER BY id", [id]);
      expect(messages.at(-1)!.content).toContain("挂到了 Mission「上线」");
      // 已经挂好的不再动。
      await runPlacement(f, fakeAgent({ missionId: "execution-two", reason: "x" }), id);
      expect(await task(f, id)).toMatchObject({ mission: { missionId: "execution-one" } });
    } finally { await f.t.close(); }
  });

  it("挑不出（或挑了别人的 Mission）：留在待归位并写原因；首页单独一组、不混进全部；本人确认不属于任何 Mission 后按独立事项算", async () => {
    const f = await executionFixture();
    try {
      const meetingId = await meeting(f, []);
      const id = await dispatch(f, meetingId, "研究一号位外部数据源的付费模式");
      await runPlacement(f, fakeAgent({ missionId: null, reason: "你名下没有和数据源调研对得上的 Mission" }), id);
      const other = await dispatch(f, meetingId, "整理产品需求");
      await runPlacement(f, fakeAgent({ missionId: "not-mine", reason: "猜的" }), other);
      expect((await task(f, other)).unplaced).toEqual({ reason: "猜的" });
      const home = (await call(f, f.member, "GET", "/api/me/home-plan")).json();
      expect(home.unplaced.map((item: { id: string }) => item.id).sort()).toEqual([id, other].sort());
      expect(home.unplaced.find((item: { id: string }) => item.id === id).unplaced).toEqual({ reason: "你名下没有和数据源调研对得上的 Mission" });
      expect(home.activities.some((entry: { item: { id: string } }) => [id, other].includes(entry.item.id))).toBe(false);

      const current = await task(f, id);
      const empty = await call(f, f.member, "POST", `/api/me/tasks/${id}/standalone`, { version: current.version, reason: " " });
      expect(empty.statusCode).toBe(400);
      const done = await call(f, f.member, "POST", `/api/me/tasks/${id}/standalone`, { version: current.version, reason: "是一次性的调研，不属于本月任何 Mission" });
      expect(done.statusCode).toBe(200);
      expect(done.json().unplaced).toBeUndefined();
      expect((await call(f, f.member, "GET", "/api/me/home-plan")).json().unplaced.map((item: { id: string }) => item.id)).toEqual([other]);
      const again = await call(f, f.member, "POST", `/api/me/tasks/${id}/standalone`, { version: done.json().version, reason: "再来" });
      expect(again.statusCode).toBe(409);

      // 本人在事项里挂上 Mission：离开待归位，原因清掉。
      const attached = await call(f, f.member, "PATCH", `/api/me/tasks/${other}`, { version: (await task(f, other)).version, missionId: "execution-two" });
      expect(attached.statusCode).toBe(200);
      expect(attached.json()).toMatchObject({ mission: { missionId: "execution-two" } });
      expect(attached.json().unplaced).toBeUndefined();
      expect((await f.t.sql("SELECT unplaced_reason FROM tasks WHERE id=$1", [other]))[0].unplaced_reason).toBeNull();
    } finally { await f.t.close(); }
  });

  it("本人自己建的事项可以不挂 Mission，不进待归位", async () => {
    const f = await executionFixture();
    try {
      const created = await call(f, f.member, "POST", "/api/me/tasks", { clientId: randomUUID(), title: "整理书架", missionId: null });
      expect(created.statusCode).toBe(200);
      expect(created.json().unplaced).toBeUndefined();
      expect((await call(f, f.member, "GET", "/api/me/home-plan")).json().unplaced).toEqual([]);
    } finally { await f.t.close(); }
  });

  it("10/27 补一遍归位：还在待归位的会议、Agent 事项各排一次，本人自己建的、已挂好、确认不属于任何 Mission、已完成的不排", async () => {
    const f = await executionFixture();
    try {
      const at = await meeting(f, [{ kind: "po", id: "<po>", title: "本期目标" }]);
      const [fromMeeting, fromAgent, mine, standalone, done, placed] = await Promise.all(
        ["会上分的", "Agent 建的", "本人建的", "不属于 Mission", "已完成", "已挂好"].map((text) => dispatch(f, at, text)));
      await f.t.sql("UPDATE tasks SET created_by='agent' WHERE id=$1", [fromAgent]);
      await f.t.sql("UPDATE tasks SET created_by='self' WHERE id=$1", [mine]);
      await f.t.sql("UPDATE tasks SET standalone_at=now() WHERE id=$1", [standalone]);
      await f.t.sql("UPDATE tasks SET status='done' WHERE id=$1", [done]);
      await f.t.sql("UPDATE tasks SET mission_id='execution-one',step_order=99 WHERE id=$1", [placed]);
      await f.t.sql(readFileSync(new URL("../migrations/214_task_placement_backfill.sql", import.meta.url), "utf8"));
      const jobs = await f.t.sql("SELECT payload->>'taskId' AS id FROM jobs WHERE kind=$1 AND dedupe_key LIKE 'task.place:backfill-%' ORDER BY id", [TASK_PLACE_JOB]);
      expect(jobs.map((row) => row.id).sort()).toEqual([fromMeeting, fromAgent].sort());
      const agent = fakeAgent({ missionId: "execution-two", reason: "在推进验证" });
      await runPlacement(f, agent, fromAgent);
      expect(await task(f, fromAgent)).toMatchObject({ mission: { missionId: "execution-two" } });
      const messages = await f.t.sql("SELECT content FROM thread_messages WHERE object_type='task' AND object_id=$1 ORDER BY id", [fromAgent]);
      expect(messages.at(-1)!.content).toContain("按事项内容挂到了 Mission「验证」");
    } finally { await f.t.close(); }
  });
});
