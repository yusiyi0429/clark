import { randomUUID } from "node:crypto";
import type { THomePlanTask } from "@warmap/contracts";
import { describe, expect, it } from "vitest";
import { reviewWindow } from "../src/homeWaiting.js";
import { TEST_MEMBER } from "./helpers.js";
import { BOARD_NOW, BOARD_TASKS, boardFixture, THIRD, type BoardFixture } from "./boardFixture.js";

/** 首页「等你」按设计 9.6 扩的几种：计划等你开工、请你认可、月份、电脑、额度；排序。本机那条路（云端拆卡、验收关着）。 */

type Waiting = { id: string; kind: string; title: string; source: string | null; at: string | null; open: { kind: string; id: string }; taskId: string | null;
  sessionId: string | null; deviceId: string | null; deviceName: string | null; dueAt: string | null; answer: string; person: unknown; month: unknown };
const waiting = async (f: BoardFixture, kind?: string): Promise<Waiting[]> => {
  const res = await f.call("GET", "/api/me/work-home");
  expect(res.statusCode).toBe(200);
  return (res.json().waiting as Waiting[]).filter((item) => !kind || item.kind === kind);
};
/** 本人建一张带岗位、交给 Claude Code 的卡（子会话）。 */
const roleCard = async (f: BoardFixture, title: string, planTaskId = "task-open") => {
  const existing = (await f.t.sql("SELECT id::text FROM roles WHERE owner_id=$1 AND name='开发'", [TEST_MEMBER.personId]))[0]?.id as string | undefined;
  const roleId = existing ?? (await f.call("POST", "/api/me/roles", { name: "开发", family: "dev", kind: "worker" })).json().id as string;
  const id = await f.card(title, { planTaskId });
  await f.call("PATCH", `/api/me/cards/${id}`, { version: 1, roleId, executor: "claude_code" });
  return id;
};
const status = (state: string, title: string, hold?: { reason: string; until: string | null }) =>
  ["status", { status: state, title, agent: "claude-code", modelLabel: "订阅 · Sonnet", ...(hold ? { hold } : {}) }] as [string, unknown];

describe("首页等你：扩的几种", { timeout: 30_000 }, () => {
  it("计划等你开工：树上的 Task 最近一次拆卡的派活单还有没处理的草稿；算进这件 Task 的「N 件等你」；最近一次还没出、不在树上的 Task 不出", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const plan = async (taskId: string, missionId: string, created: string, finished: string | null, drafts: string[]) => {
        const id = randomUUID();
        await f.t.sql(`INSERT INTO card_plans(id,plan_task_id,mission_id,owner_id,status,source,created_at,finished_at) VALUES($1,$2,$3,$4,$5,'local',$6,$7)`,
          [id, taskId, missionId, TEST_MEMBER.personId, finished ? "done" : "running", created, finished]);
        for (const [position, draftStatus] of drafts.entries())
          await f.t.sql(`INSERT INTO card_drafts(id,plan_id,plan_task_id,owner_id,position,title,done_definition,executor,model_tier,status)
            VALUES($1,$2,$3,$4,$5,$6,'有结果','claude_code','normal',$7)`, [randomUUID(), id, taskId, TEST_MEMBER.personId, position, `草稿 ${position}`, draftStatus]);
        return id;
      };
      await plan("task-open", "mine", "2026-11-05T01:00:00Z", "2026-11-05T01:05:00Z", ["open"]);
      const latest = await plan("task-open", "mine", "2026-11-06T01:00:00Z", "2026-11-06T01:10:00Z", ["open", "open", "dismissed", "accepted"]);
      // 别人负责的 Task 不在树上。
      await plan("task-theirs", "mine", "2026-11-06T01:00:00Z", "2026-11-06T01:10:00Z", ["open"]);

      let items = await waiting(f, "plan_start");
      expect(items).toEqual([{ id: `plan_start:${latest}`, kind: "plan_start", title: "对话质量达标：计划等你开工", source: "2 件等你开工",
        at: "2026-11-06T01:10:00.000Z", open: { kind: "task", id: "task-open" }, taskId: "task-open", sessionId: null, deviceId: null, deviceName: null,
        dueAt: null, answer: "inline", person: null, month: null }]);
      const task = (await f.call("GET", "/api/me/work-home")).json().missions[0].tasks[0];
      expect(task.summary.needsYou).toBe(1);

      // 又开始拆了一次、还没出派活单：上一次的草稿不算在等开工。
      await plan("task-open", "mine", "2026-11-06T01:30:00Z", null, []);
      expect(await waiting(f, "plan_start")).toEqual([]);
    } finally { await f.close(); }
  });

  it("请你认可：7 天内负责人请本人看、最新一版还没交付的，同一条只出一条（取最近一次）；请的是别人、太久以前、交付了、找不到的 Task 不出", async () => {
    const colon: THomePlanTask = { taskId: "world:t:9", missionId: "other", name: "带冒号的", doneDefinition: null, criteria: ["一", "二"] };
    const f = await boardFixture({ planTasks: async (missions) => [...BOARD_TASKS, colon].filter((task) => missions.some((mission) => mission.id === task.missionId)) },
      { boardCloudAgents: false });
    try {
      const ask = (taskId: string, index: number, personId: string, at: string) => f.t.sql(
        "INSERT INTO jobs(kind,dedupe_key,payload,status,created_at) VALUES('feishu.notify',$1,'{}','done',$2)",
        [`feishu.notify:task-check:${taskId}:${index}:${personId}:${at.slice(0, 10)}`, at]);
      await ask("task-other", 1, TEST_MEMBER.personId, "2026-11-04T02:00:00.000Z");
      await ask("task-other", 1, TEST_MEMBER.personId, "2026-11-05T02:00:00.000Z");
      await ask("world:t:9", 2, TEST_MEMBER.personId, "2026-11-06T01:00:00.000Z");
      await ask("task-other", 1, THIRD.personId, "2026-11-06T01:00:00.000Z");
      await ask("task-theirs", 1, TEST_MEMBER.personId, "2026-10-29T01:00:00.000Z");
      await ask("ghost", 1, TEST_MEMBER.personId, "2026-11-06T01:00:00.000Z");

      let items = await waiting(f, "acceptance");
      expect(items).toEqual([
        { id: "acceptance:world:t:9:2", kind: "acceptance", title: "请你认可「带冒号的」第 2 条", source: null, at: "2026-11-06T01:00:00.000Z",
          open: { kind: "task_detail", id: "world:t:9" }, taskId: null, sessionId: null, deviceId: null, deviceName: null, dueAt: null, answer: "open",
          person: { personId: THIRD.personId, name: "测试丙" }, month: null },
        expect.objectContaining({ id: "acceptance:task-other:1", title: "请你认可「别人 Mission 的」第 1 条", at: "2026-11-05T02:00:00.000Z",
          person: { personId: THIRD.personId, name: "测试丙" } }),
      ]);

      // 最新一版交付了：不用再认了。
      await f.t.sql(`INSERT INTO deliverable_versions(id,task_id,mission_id,author_id,number,task_name,basis,criteria,delivered_at)
        VALUES($1,'task-other','other',$2,1,'x','acceptance','[]','2026-11-06T01:30:00Z')`, [randomUUID(), THIRD.personId]);
      items = await waiting(f, "acceptance");
      expect(items.map((item) => item.id)).toEqual(["acceptance:world:t:9:2"]);
    } finally { await f.close(); }
  });

  it("月份：复盘窗口里出「复盘 N 月」（截止是窗口关闭），窗口外不出；之前月份还有没了结的 Task 每个月一条，了结了的不算", async () => {
    let now = BOARD_NOW;
    const october: THomePlanTask[] = [
      { taskId: "oct-a", missionId: "oct", name: "十月甲", doneDefinition: null, criteria: [] },
      { taskId: "oct-b", missionId: "oct", name: "十月乙", doneDefinition: null, criteria: [] },
    ];
    const f = await boardFixture({ monthlyNow: () => now,
      planTasks: async (missions) => [...BOARD_TASKS, ...october].filter((task) => missions.some((mission) => mission.id === task.missionId)) }, { boardCloudAgents: false });
    try {
      await f.t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,milestones,source_ref,source_document_id,source_revision,source_title)
        VALUES('oct',1,'oct','2026-10','十月的 Mission',$1,'method','["growth"]','目标','[]','fixture://b','fixture',1,'fixture')`, [TEST_MEMBER.personId]);
      for (const taskId of ["oct-a", "oct-b"]) await f.t.sql("UPDATE tasks SET mission_id='oct',plan_task_id=$2 WHERE id=$1", [await roleCard(f, taskId), taskId]);

      // 11/06 在 10 月的复盘窗口里（10/30 起到 11/07 23:59）。
      let items = await waiting(f, "month");
      expect(items).toEqual([
        { id: "month:review:2026-10", kind: "month", title: "复盘 10 月", source: null, at: null, open: { kind: "month", id: "2026-10" }, taskId: null,
          sessionId: null, deviceId: null, deviceName: null, dueAt: "2026-11-07T15:59:59.000Z", answer: "open", person: null, month: { step: "review", period: "2026-10" } },
        { id: "month:continue:2026-10", kind: "month", title: "10 月还有 2 件没了结", source: null, at: null, open: { kind: "month", id: "2026-10" }, taskId: null,
          sessionId: null, deviceId: null, deviceName: null, dueAt: null, answer: "open", person: null, month: { step: "continue", period: "2026-10" } },
      ]);

      // 月中：不在复盘窗口里；交付了一件，还剩一件没了结。
      now = new Date("2026-11-15T02:00:00.000Z");
      await f.t.sql(`INSERT INTO deliverable_versions(id,task_id,mission_id,author_id,number,task_name,basis,criteria,delivered_at)
        VALUES($1,'oct-b','oct',$2,1,'x','acceptance','[]','2026-11-10T00:00:00Z')`, [randomUUID(), TEST_MEMBER.personId]);
      items = await waiting(f, "month");
      expect(items.map((item) => [item.id, item.title])).toEqual([["month:continue:2026-10", "10 月还有 1 件没了结"]]);

      // 月底最后两天：复盘本月，截止下个月 7 号 23:59。
      now = new Date("2026-11-29T02:00:00.000Z");
      items = await waiting(f, "month");
      expect(items.find((item) => item.id === "month:review:2026-11")).toMatchObject({ title: "复盘 11 月", dueAt: "2026-12-07T15:59:59.000Z",
        month: { step: "review", period: "2026-11" } });
    } finally { await f.close(); }
  });

  it("复盘窗口的边界（公司时区）：每月最后 2 天 0 点起，到下个月 7 号 23:59:59", () => {
    expect(reviewWindow(new Date("2026-11-28T15:59:59.000Z"))).toBeNull();
    expect(reviewWindow(new Date("2026-11-28T16:00:00.000Z"))).toEqual({ period: "2026-11", closesAt: "2026-12-07T15:59:59.000Z" });
    expect(reviewWindow(new Date("2026-12-07T15:59:59.000Z"))).toEqual({ period: "2026-11", closesAt: "2026-12-07T15:59:59.000Z" });
    expect(reviewWindow(new Date("2026-12-07T16:00:00.000Z"))).toBeNull();
    expect(reviewWindow(new Date("2027-01-03T00:00:00.000Z"))).toEqual({ period: "2026-12", closesAt: "2027-01-07T15:59:59.000Z" });
    expect(reviewWindow(new Date("2027-02-26T16:00:00.000Z"))).toEqual({ period: "2027-02", closesAt: "2027-03-07T15:59:59.000Z" });
  });

  it("电脑：一台在线的都没有、又有活在等本机时出一条（没配对过是「还没有配对的电脑」）；没活在等、或有在线的电脑，不出", async () => {
    let now = new Date("2026-11-15T02:00:00.000Z");
    const f = await boardFixture({ monthlyNow: () => now }, { boardCloudAgents: false });
    try {
      expect(await waiting(f, "device")).toEqual([]);
      await roleCard(f, "等开工的卡");
      expect(await waiting(f, "device")).toEqual([{ id: "device:this_computer", kind: "device", title: "还没有配对的电脑", source: "1 件在等", at: null,
        open: { kind: "connections", id: "this_computer" }, taskId: null, sessionId: null, deviceId: null, deviceName: null, dueAt: null, answer: "open",
        person: null, month: null }]);

      // 配对了但没上报过（不在线）；拆卡登记也在等本机开规划员。
      const laptop = await f.local();
      expect((await f.call("POST", "/api/plan-tasks/task-open/card-splits")).statusCode).toBe(201);
      expect((await waiting(f, "device")).map((item) => [item.title, item.source])).toEqual([["电脑不在线 · 2 件在等", null]]);

      // 那台电脑上线了。
      await f.t.sql("UPDATE local_devices SET last_sync_at=$2 WHERE id=$1", [laptop.device, now]);
      expect(await waiting(f, "device")).toEqual([]);
      // 过了 10 分钟没上报，又算不在线。
      now = new Date(now.getTime() + 11 * 60_000);
      expect((await waiting(f, "device")).map((item) => item.title)).toEqual(["电脑不在线 · 2 件在等"]);
    } finally { await f.close(); }
  });

  it("额度：一台电脑一条，停着几件、最早几点恢复（截止）；恢复了接着跑的不算；排序是卡住在跑的活的在前（有截止的先），再是有截止的，其余新的在前", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const laptop = await f.local("我的电脑");
      const desktop = await f.local("另一台");
      const cards: string[] = [];
      for (const title of ["早恢复", "晚恢复", "恢复了", "另一台的", "等批准"]) cards.push(await roleCard(f, title));
      const [early, late, resumed, other, asking] = cards;
      await laptop.send({ kind: "card", cardId: early }, [status("idle", "早恢复", { reason: "usage_limit", until: "2026-11-06T04:30:00.000Z" })]);
      await laptop.send({ kind: "card", cardId: late }, [status("queued", "晚恢复", { reason: "usage_limit", until: "2026-11-06T05:00:00.000Z" })]);
      await laptop.send({ kind: "plan", taskId: "task-open" } as never, [status("exited", "拆卡", { reason: "usage_limit", until: null })]);
      // 停过、又在新会话里接着跑了：最近一次执行没停着。
      await laptop.send({ kind: "card", cardId: resumed }, [status("idle", "恢复了", { reason: "usage_limit", until: "2026-11-06T03:00:00.000Z" })]);
      const again = await laptop.send({ kind: "card", cardId: resumed }, [status("running", "恢复了")]);
      await f.t.sql("UPDATE local_runs SET started_at='2026-11-06T01:30:00Z',updated_at='2026-11-06T01:30:00Z' WHERE id=$1", [again]);
      await desktop.send({ kind: "card", cardId: other }, [status("idle", "另一台的", { reason: "usage_limit", until: "2026-11-06T06:00:00.000Z" })]);
      const approval = await laptop.send({ kind: "card", cardId: asking }, [status("waiting_permission", "等批准")]);
      await f.t.sql("UPDATE local_runs SET updated_at='2026-11-06T01:50:00Z' WHERE id=$1", [approval]);
      const dev = (await f.t.sql("SELECT role_id::text FROM tasks WHERE id=$1", [asking]))[0].role_id as string;
      const proposal = randomUUID();
      await f.t.sql(`INSERT INTO role_proposals(id,role_id,owner_id,task_id,source_kind,source_id,base_version,field,proposed_text,why,status,created_at)
        VALUES($1,$2,$3,$4,'second_fail',$5,1,'practice_md','先跑题库再写','两次都没跑题库','open','2026-11-06T01:55:00Z')`,
      [proposal, dev, TEST_MEMBER.personId, asking, randomUUID()]);

      const items = await waiting(f);
      expect(items.find((item) => item.id === `quota:${laptop.device}`)).toEqual({ id: `quota:${laptop.device}`, kind: "quota",
        title: "Claude 订阅额度用完 · 12:30 恢复", source: "3 件停着", at: null, open: { kind: "connections", id: "this_computer" }, taskId: null, sessionId: null,
        deviceId: laptop.device, deviceName: "我的电脑", dueAt: "2026-11-06T04:30:00.000Z", answer: "open", person: null, month: null });
      expect(items.find((item) => item.id === `quota:${desktop.device}`)).toMatchObject({ title: "Claude 订阅额度用完 · 14:00 恢复", source: "1 件停着",
        deviceName: "另一台", dueAt: "2026-11-06T06:00:00.000Z" });
      // 额度（截止早的先）、批准，然后是有截止的复盘（11/06 在 10 月的复盘窗口里），其余新的在前。
      expect(items.map((item) => item.id)).toEqual([`quota:${laptop.device}`, `quota:${desktop.device}`, `approval:card:${asking}`, "month:review:2026-10",
        `role:${proposal}`]);
    } finally { await f.close(); }
  });
});
