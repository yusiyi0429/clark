import { randomUUID } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { COLLECTOR_DISTILL_PROMPT, CollectorDistillCandidate, distillPending, openableLinks, purgeExpiredRaw, type CollectorDistillAgent, type CollectorDistillInput } from "../src/collectorDistill.js";
import { call, executionFixture, type Fixture } from "./executionFixture.js";

const MEMBER = "person-fixture-002", THIRD = "person-fixture-003";
const AT = new Date("2026-10-10T03:00:00Z");

async function seedItem(f: Fixture, personId: string, summary: string, receivedAt = new Date("2026-10-10T02:00:00Z"), repo = "Tianshu-MVP") {
  const token = randomUUID(), id = randomUUID();
  await f.t.sql("INSERT INTO personal_tokens(id,person_id,name,client,secret_hash,created_at) VALUES($1,$2,'collector','collector',$3,$4)", [token, personId, randomUUID(), receivedAt]);
  await f.t.sql(`INSERT INTO collector_items(id,person_id,device_id,token_id,report_kind,client_event_id,source,started_at,ended_at,summary,links,task_hint,received_at)
    VALUES($1,$2,'device-test-01',$3,'digest',$4,'codex',$5,$6,$7,'[{"url":"https://github.com/TokenkingOS/Tianshu-MVP/pull/9"}]',$8,$6)`,
  [id, personId, token, randomUUID(), new Date(receivedAt.getTime() - 3_600_000), receivedAt, summary, repo]);
  return id;
}
async function seedTask(f: Fixture, title: string, missionId: string | null = "execution-one", status = "in_progress") {
  const id = randomUUID();
  await f.t.sql("INSERT INTO tasks(id,title,status,owner_id,created_by,mission_id,step_order) VALUES($1,$2,$3,$4,'self',$5,$6)",
    [id, title, status, MEMBER, missionId, missionId ? 1 : null]);
  return id;
}
async function seedEarlier(f: Fixture, placement: string, text: string, extra: { taskId?: string; missionId?: string } = {}) {
  const id = randomUUID();
  await f.t.sql(`INSERT INTO collector_progress(id,person_id,source,started_at,ended_at,text,placement,confidence,task_id,mission_id,item_ids,created_at)
    VALUES($1,$2,'claude','2026-10-09T01:00:00Z','2026-10-09T02:00:00Z',$3,$4,0.6,$5,$6,ARRAY[$7::uuid],now())`,
  [id, MEMBER, text, placement, extra.taskId ?? null, extra.missionId ?? null, randomUUID()]);
  return id;
}
const entry = (itemIds: string[], text: string, extra: { taskId?: string | null; missionId?: string | null; confidence?: number } = {}) =>
  ({ itemIds, text, taskId: null, missionId: null, confidence: 0, ...extra });
const consent = (f: Fixture, cookie: string, granted: boolean) => call(f, cookie, "PUT", "/api/me/collector/consent", { granted });
function fakeAgent(answer: (input: CollectorDistillInput) => unknown) {
  const calls: CollectorDistillInput[] = [];
  const agent: CollectorDistillAgent = { async distill(input) { calls.push(input); return { candidate: answer(input) }; } };
  return { agent, calls };
}

describe("采集器原文的服务端整理", () => {
  it("链接只留点得开的外部网页：截掉中文标点和反引号，去掉 localhost、内网地址", () => {
    expect(openableLinks([
      { url: "https://tk-preview.tokenkingos.com，然后看一下" }, { url: "https://tk.tokenkingos.com/me`" }, { url: "https://tk.tokenkingos.com/me" },
      { url: "https://github.com/TokenkingOS/Tianshu-MVP/pull/9。" }, { url: "https://docs.test/a?b=1&c=2", title: "文档" },
      { url: "http://localhost:3000/me" }, { url: "http://127.0.0.1:8787/api" }, { url: "http://192.168.1.5/x" }, { url: "http://10.0.0.2/" },
      { url: "http://172.20.1.1/" }, { url: "http://intranet/wiki" }, { url: "http://web.localhost:3000/" }, { url: "https://，" },
    ])).toEqual([
      { url: "https://tk-preview.tokenkingos.com" }, { url: "https://tk.tokenkingos.com/me" },
      { url: "https://github.com/TokenkingOS/Tianshu-MVP/pull/9" }, { url: "https://docs.test/a?b=1&c=2", title: "文档" },
    ]);
  });

  it("只整理已同意的人；置信度 ≥0.75 归到 Task 并写进执行事项进展，未启动的改成进行中；出处是原文段", async () => {
    const f = await executionFixture();
    try {
      const task = await seedTask(f, "采集器服务端整理", "execution-one", "not_started");
      const [a, b, c] = [await seedItem(f, MEMBER, "改完整理服务 sk-abcdefghijklmnop1234"), await seedItem(f, MEMBER, "补测试"), await seedItem(f, MEMBER, "看了下别的仓库")];
      const other = await seedItem(f, THIRD, "丙没同意");
      const { agent, calls } = fakeAgent(() => ({
        entries: [
          entry([a, b], "采集器整理服务写完并补了测试", { taskId: task, confidence: 0.9 }),
          entry([c], "看了别的仓库的做法", { taskId: task, confidence: 0.75 }),
        ],
        skipped: [],
      }));
      expect(await distillPending(f.t.pool, agent, AT)).toBe(0);
      expect((await consent(f, f.member, true)).statusCode).toBe(200);
      await f.t.sql("UPDATE collector_items SET links=$2::jsonb WHERE id=$1", [c, JSON.stringify([{ url: "http://localhost:3000/me" }, { url: "https://tk.tokenkingos.com/me`" }])]);
      expect(await distillPending(f.t.pool, agent, AT)).toBe(3);
      expect(calls).toHaveLength(1);
      expect(calls[0].items.map((item) => item.id).sort()).toEqual([a, b, c].sort());
      expect(calls[0].items.find((item) => item.id === a)!.text).not.toContain("sk-abcdefghijklmnop1234");
      expect(calls[0].missions.map((mission) => mission.id)).toEqual(["execution-one", "execution-two"]);
      expect(calls[0].tasks.map((item) => item.id)).toEqual([task]);
      const rows = await f.t.sql("SELECT text,placement,confidence::text AS confidence,task_id::text AS task_id,mission_id,repo,item_ids::text[] AS item_ids,task_progress_id FROM collector_progress ORDER BY confidence DESC");
      expect(rows).toMatchObject([
        { text: "采集器整理服务写完并补了测试", placement: "task", confidence: "0.90", task_id: task, mission_id: "execution-one", repo: "Tianshu-MVP" },
        { text: "看了别的仓库的做法", placement: "task", confidence: "0.75", task_id: task, mission_id: "execution-one" },
      ]);
      expect([...(rows[0].item_ids as string[])].sort()).toEqual([a, b].sort());
      const progress = await f.t.sql("SELECT id,task_id::text AS task_id,author_id,source,body,links FROM task_progress ORDER BY body DESC");
      expect(progress).toEqual([
        expect.objectContaining({ id: rows[0].task_progress_id, task_id: task, author_id: MEMBER, source: "codex",
          body: "采集器整理服务写完并补了测试", links: [{ url: "https://github.com/TokenkingOS/Tianshu-MVP/pull/9" }] }),
        expect.objectContaining({ id: rows[1].task_progress_id, task_id: task, body: "看了别的仓库的做法", links: [{ url: "https://tk.tokenkingos.com/me" }] }),
      ]);
      expect(await f.t.sql("SELECT id::text AS id,status,version,created_by FROM tasks")).toEqual([{ id: task, status: "in_progress", version: 2, created_by: "self" }]);
      expect((await f.t.sql("SELECT id,distill_status FROM collector_items WHERE person_id=$1", [THIRD]))).toEqual([{ id: other, distill_status: "pending" }]);
    } finally { await f.t.close(); }
  });

  it("整理结果不合规（编造的 Task、漏掉的段）不写，记次数；三次都不合规的段不再整理", async () => {
    const f = await executionFixture();
    try {
      await consent(f, f.member, true);
      const id = await seedItem(f, MEMBER, "做了点事");
      const bad = fakeAgent(() => ({ entries: [entry([id], "做了点事", { taskId: randomUUID(), confidence: 0.9 })], skipped: [] }));
      for (let i = 0; i < 3; i += 1) await distillPending(f.t.pool, bad.agent, AT);
      expect(await f.t.sql("SELECT distill_status,distill_attempts,distill_error FROM collector_items WHERE id=$1", [id]))
        .toEqual([{ distill_status: "done", distill_attempts: 3, distill_error: expect.stringContaining("不是本人的执行事项") }]);
      expect(await f.t.sql("SELECT 1 FROM collector_progress")).toEqual([]);
      const skipped = await seedItem(f, MEMBER, "你好");
      await distillPending(f.t.pool, fakeAgent(() => ({ entries: [], skipped: [] })).agent, AT);
      expect((await f.t.sql("SELECT distill_error FROM collector_items WHERE id=$1", [skipped]))[0].distill_error).toBe("有 1 段没有整理也没有跳过");
    } finally { await f.t.close(); }
  });

  it("置信度 0.5–0.75 记待核，更低或对不上记候选：不建执行事项、不写执行事项进展、状态不动；不再要 newTaskTitle", async () => {
    const f = await executionFixture();
    try {
      await consent(f, f.member, true);
      const task = await seedTask(f, "采集器服务端整理", "execution-one", "not_started");
      const [a, b, c, d] = [await seedItem(f, MEMBER, "调研读回校验"), await seedItem(f, MEMBER, "补接口说明"), await seedItem(f, MEMBER, "试别的整理方式"), await seedItem(f, MEMBER, "部署预发")];
      const { agent } = fakeAgent(() => ({
        entries: [
          entry([a], "读回校验的写法调研完", { taskId: task, confidence: 0.74 }),
          entry([b], "补了一版接口说明", { taskId: task, confidence: 0.5 }),
          entry([c], "试了另一种整理方式", { taskId: task, missionId: "execution-two", confidence: 0.49 }),
          entry([d], "预发环境部署完成", { missionId: "execution-two" }),
        ],
        skipped: [],
      }));
      expect(await distillPending(f.t.pool, agent, AT)).toBe(4);
      expect(await f.t.sql(`SELECT text,placement,confidence::text AS confidence,task_id::text AS task_id,mission_id,task_progress_id
        FROM collector_progress ORDER BY confidence DESC`)).toEqual([
        { text: "读回校验的写法调研完", placement: "pending_attach", confidence: "0.74", task_id: task, mission_id: "execution-one", task_progress_id: null },
        { text: "补了一版接口说明", placement: "pending_attach", confidence: "0.50", task_id: task, mission_id: "execution-one", task_progress_id: null },
        { text: "试了另一种整理方式", placement: "pending_replan", confidence: "0.49", task_id: null, mission_id: "execution-two", task_progress_id: null },
        { text: "预发环境部署完成", placement: "pending_replan", confidence: "0.00", task_id: null, mission_id: "execution-two", task_progress_id: null },
      ]);
      expect(await f.t.sql("SELECT count(*)::int AS n FROM task_progress")).toEqual([{ n: 0 }]);
      expect(await f.t.sql("SELECT id::text AS id,status,version FROM tasks")).toEqual([{ id: task, status: "not_started", version: 1 }]);

      expect(COLLECTOR_DISTILL_PROMPT).not.toContain("newTaskTitle");
      expect(Value.Check(CollectorDistillCandidate, { entries: [{ ...entry([a], "读回校验的写法调研完"), newTaskTitle: "调研读回校验" }], skipped: [] })).toBe(false);
    } finally { await f.t.close(); }
  });

  it("早先的待核、候选不再被转成执行事项，也不调模型", async () => {
    const f = await executionFixture();
    try {
      await consent(f, f.member, true);
      const task = await seedTask(f, "采集器服务端整理", "execution-one", "not_started");
      const attach = await seedEarlier(f, "pending_attach", "调研读回校验的写法", { taskId: task });
      const replan = await seedEarlier(f, "pending_replan", "重写上手流程的体验构想，先出了一版草图", { missionId: "execution-two" });
      const { agent, calls } = fakeAgent(() => ({ entries: [], skipped: [] }));
      expect(await distillPending(f.t.pool, agent, AT)).toBe(0);
      expect(calls).toEqual([]);
      const rows = new Map((await f.t.sql("SELECT id::text AS id,placement,task_id::text AS task_id,mission_id,task_progress_id FROM collector_progress"))
        .map((row) => [row.id, row]));
      expect(rows.get(attach)).toEqual({ id: attach, placement: "pending_attach", task_id: task, mission_id: null, task_progress_id: null });
      expect(rows.get(replan)).toEqual({ id: replan, placement: "pending_replan", task_id: null, mission_id: "execution-two", task_progress_id: null });
      expect(await f.t.sql("SELECT count(*)::int AS n FROM task_progress")).toEqual([{ n: 0 }]);
      expect(await f.t.sql("SELECT id::text AS id,status,created_by FROM tasks")).toEqual([{ id: task, status: "not_started", created_by: "self" }]);
    } finally { await f.t.close(); }
  });

  it("原文收到 14 天后清空，整理结果和出处留下；整理那次运行存下的输入一并清空；撤回同意立即清空本人原文", async () => {
    const f = await executionFixture();
    try {
      await consent(f, f.member, true);
      const old = await seedItem(f, MEMBER, "两周前的原文", new Date("2026-09-25T02:00:00Z"));
      const fresh = await seedItem(f, MEMBER, "昨天的原文", new Date("2026-10-09T02:00:00Z"));
      await f.t.sql(`INSERT INTO collector_progress(id,person_id,source,started_at,ended_at,text,placement,confidence,item_ids,created_at)
        VALUES($1,$2,'codex',now(),now(),'整理好的进展','pending_replan',0.1,ARRAY[$3::uuid],now())`, [randomUUID(), MEMBER, old]);
      await f.t.sql(`INSERT INTO agent_runs(id,kind,status,model_slot,prompt_hash,input_snapshot,started_at) VALUES
        ($1,'collector-distill','succeeded','heavy','h','{"items":[{"text":"两周前的原文"}]}','2026-09-25T03:00:00Z'),
        ($2,'collector-distill','succeeded','heavy','h','{"items":[{"text":"昨天的原文"}]}','2026-10-09T03:00:00Z')`, [randomUUID(), randomUUID()]);
      expect(await purgeExpiredRaw(f.t.pool.query.bind(f.t.pool), new Date("2026-10-10T02:00:00Z"))).toBe(1);
      expect(await f.t.sql("SELECT id,summary,raw_purged_at IS NOT NULL AS purged FROM collector_items ORDER BY received_at")).toEqual([
        { id: old, summary: null, purged: true }, { id: fresh, summary: "昨天的原文", purged: false }]);
      expect((await f.t.sql("SELECT input_snapshot FROM agent_runs ORDER BY started_at")).map((row) => row.input_snapshot))
        .toEqual([{ reason: "collector raw retention", purged: true }, { items: [{ text: "昨天的原文" }] }]);
      expect(await f.t.sql("SELECT text FROM collector_progress")).toEqual([{ text: "整理好的进展" }]);

      expect((await consent(f, f.member, false)).json()).toMatchObject({ consent: { granted: false } });
      expect(await f.t.sql("SELECT summary FROM collector_items WHERE id=$1", [fresh])).toEqual([{ summary: null }]);
    } finally { await f.t.close(); }
  });
});
