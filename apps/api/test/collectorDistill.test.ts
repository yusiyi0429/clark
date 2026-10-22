import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { distillPending, openableLinks, purgeExpiredRaw, type CollectorDistillAgent, type CollectorDistillInput } from "../src/collectorDistill.js";
import { call, executionFixture, type Fixture } from "./executionFixture.js";

const MEMBER = "person-fixture-002", THIRD = "person-fixture-003";
const NAMES = new Map([[MEMBER, "测试乙"]]);
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
async function seedEarlier(f: Fixture, placement: string, text: string, extra: { taskId?: string; missionId?: string; resolution?: string; links?: unknown[] } = {}) {
  const id = randomUUID();
  await f.t.sql(`INSERT INTO collector_progress(id,person_id,source,started_at,ended_at,text,placement,confidence,task_id,mission_id,item_ids,links,created_at,resolution,resolved_at,resolved_by)
    VALUES($1,$2,'claude','2026-10-09T01:00:00Z','2026-10-09T02:00:00Z',$3,$4,0.6,$5,$6,ARRAY[$7::uuid],$8::jsonb,now(),$9,$10,$11)`,
  [id, MEMBER, text, placement, extra.taskId ?? null, extra.missionId ?? null, randomUUID(), JSON.stringify(extra.links ?? []),
    extra.resolution ?? null, extra.resolution ? AT : null, extra.resolution ? MEMBER : null]);
  return id;
}
const entry = (itemIds: string[], text: string, extra: { taskId?: string | null; missionId?: string | null; confidence?: number; newTaskTitle?: string | null } = {}) =>
  ({ itemIds, text, taskId: null, missionId: null, confidence: 0, newTaskTitle: null, ...extra });
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

  it("只整理已同意的人；结合本人 Mission 与 Task 归位，置信度 ≥0.5 直接归到 Task 并写进执行事项进展，出处是原文段", async () => {
    const f = await executionFixture();
    try {
      const task = await seedTask(f, "采集器服务端整理");
      const [a, b, c] = [await seedItem(f, MEMBER, "改完整理服务 sk-abcdefghijklmnop1234"), await seedItem(f, MEMBER, "补测试"), await seedItem(f, MEMBER, "看了下别的仓库")];
      const other = await seedItem(f, THIRD, "丙没同意");
      const { agent, calls } = fakeAgent(() => ({
        entries: [
          entry([a, b], "采集器整理服务写完并补了测试", { taskId: task, confidence: 0.9 }),
          entry([c], "看了别的仓库的做法", { taskId: task, confidence: 0.5 }),
        ],
        skipped: [],
      }));
      expect(await distillPending(f.t.pool, agent, AT, NAMES)).toBe(0);
      expect((await consent(f, f.member, true)).statusCode).toBe(200);
      await f.t.sql("UPDATE collector_items SET links=$2::jsonb WHERE id=$1", [c, JSON.stringify([{ url: "http://localhost:3000/me" }, { url: "https://tk.tokenkingos.com/me`" }])]);
      expect(await distillPending(f.t.pool, agent, AT, NAMES)).toBe(3);
      expect(calls).toHaveLength(1);
      expect(calls[0].items.map((item) => item.id).sort()).toEqual([a, b, c].sort());
      expect(calls[0].items.find((item) => item.id === a)!.text).not.toContain("sk-abcdefghijklmnop1234");
      expect(calls[0].missions.map((mission) => mission.id)).toEqual(["execution-one", "execution-two"]);
      expect(calls[0].tasks.map((item) => item.id)).toEqual([task]);
      const rows = await f.t.sql("SELECT text,placement,confidence::text AS confidence,task_id::text AS task_id,mission_id,repo,item_ids::text[] AS item_ids,task_progress_id FROM collector_progress ORDER BY confidence DESC");
      expect(rows).toMatchObject([
        { text: "采集器整理服务写完并补了测试", placement: "task", confidence: "0.90", task_id: task, mission_id: "execution-one", repo: "Tianshu-MVP" },
        { text: "看了别的仓库的做法", placement: "task", confidence: "0.50", task_id: task, mission_id: "execution-one" },
      ]);
      expect([...(rows[0].item_ids as string[])].sort()).toEqual([a, b].sort());
      const progress = await f.t.sql("SELECT id,task_id::text AS task_id,author_id,source,body,links FROM task_progress ORDER BY body DESC");
      expect(progress).toEqual([
        expect.objectContaining({ id: rows[0].task_progress_id, task_id: task, author_id: MEMBER, source: "codex",
          body: "采集器整理服务写完并补了测试", links: [{ url: "https://github.com/TokenkingOS/Tianshu-MVP/pull/9" }] }),
        expect.objectContaining({ id: rows[1].task_progress_id, task_id: task, body: "看了别的仓库的做法", links: [{ url: "https://tk.tokenkingos.com/me" }] }),
      ]);
      expect(await f.t.sql("SELECT count(*)::int AS n FROM tasks")).toEqual([{ n: 1 }]);
      expect((await f.t.sql("SELECT id,distill_status FROM collector_items WHERE person_id=$1", [THIRD]))).toEqual([{ id: other, distill_status: "pending" }]);
    } finally { await f.t.close(); }
  });

  it("整理结果不合规（编造的 Task、漏掉的段）不写，记次数；三次都不合规的段不再整理", async () => {
    const f = await executionFixture();
    try {
      await consent(f, f.member, true);
      const id = await seedItem(f, MEMBER, "做了点事");
      const bad = fakeAgent(() => ({ entries: [entry([id], "做了点事", { taskId: randomUUID(), confidence: 0.9 })], skipped: [] }));
      for (let i = 0; i < 3; i += 1) await distillPending(f.t.pool, bad.agent, AT, NAMES);
      expect(await f.t.sql("SELECT distill_status,distill_attempts,distill_error FROM collector_items WHERE id=$1", [id]))
        .toEqual([{ distill_status: "done", distill_attempts: 3, distill_error: expect.stringContaining("不是本人的执行事项") }]);
      expect(await f.t.sql("SELECT 1 FROM collector_progress")).toEqual([]);
      const skipped = await seedItem(f, MEMBER, "你好");
      await distillPending(f.t.pool, fakeAgent(() => ({ entries: [], skipped: [] })).agent, AT, NAMES);
      expect((await f.t.sql("SELECT distill_error FROM collector_items WHERE id=$1", [skipped]))[0].distill_error).toBe("有 1 段没有整理也没有跳过");
    } finally { await f.t.close(); }
  });

  it("对不上执行事项的，天枢新建一件再归进去：同一件事的几条合成一件，建在 Mission 下或独立；本人同名的未完成事项复用；下一次整理看得到", async () => {
    const f = await executionFixture();
    try {
      await consent(f, f.member, true);
      const task = await seedTask(f, "采集器服务端整理");
      const staging = await seedTask(f, "预发环境部署", null);
      await seedTask(f, "整理采集器文档", null, "done");
      const [a, b, c, d] = [await seedItem(f, MEMBER, "会议回流"), await seedItem(f, MEMBER, "会议回流补测试"), await seedItem(f, MEMBER, "部署预发"), await seedItem(f, MEMBER, "写文档")];
      const { agent, calls } = fakeAgent((input) => input.items.length === 4 ? {
        entries: [
          entry([a], "会议纪要写进本体跑通", { missionId: "execution-two", newTaskTitle: "会议回流写入本体" }),
          entry([b], "会议回流补了测试", { taskId: task, missionId: "execution-two", confidence: 0.3, newTaskTitle: "会议回流写入本体" }),
          entry([c], "预发环境部署完成", { newTaskTitle: "预发环境部署" }),
          entry([d], "采集器文档写完", { newTaskTitle: "整理采集器文档" }),
        ],
        skipped: [],
      } : { entries: [entry([input.items[0].id], "会议回流上线", { taskId: input.tasks.find((item) => item.title === "会议回流写入本体")!.id, confidence: 0.9 })], skipped: [] });
      expect(await distillPending(f.t.pool, agent, AT, NAMES)).toBe(4);

      const created = await f.t.sql("SELECT id::text AS id, title, mission_id, step_order, status FROM tasks WHERE created_by='agent' ORDER BY title");
      expect(created).toEqual([
        { id: expect.any(String), title: "会议回流写入本体", mission_id: "execution-two", step_order: 1, status: "not_started" },
        { id: expect.any(String), title: "整理采集器文档", mission_id: null, step_order: null, status: "not_started" },
      ]);
      const [meeting, docs] = created.map((row) => row.id as string);
      expect(await f.t.sql("SELECT task_id::text AS task_id, body FROM task_progress ORDER BY body")).toEqual([
        { task_id: meeting, body: "会议回流补了测试" }, { task_id: meeting, body: "会议纪要写进本体跑通" },
        { task_id: docs, body: "采集器文档写完" }, { task_id: staging, body: "预发环境部署完成" },
      ]);
      expect(await f.t.sql("SELECT DISTINCT placement FROM collector_progress")).toEqual([{ placement: "task" }]);
      expect(await f.t.sql("SELECT person_id FROM task_members WHERE task_id=$1", [meeting])).toEqual([{ person_id: MEMBER }]);
      expect((await f.t.sql("SELECT content FROM thread_messages WHERE object_type='task' AND object_id=$1", [meeting]))[0].content).toContain("测试乙");

      await seedItem(f, MEMBER, "会议回流上线");
      expect(await distillPending(f.t.pool, agent, AT, NAMES)).toBe(1);
      expect(calls[1].tasks.map((item) => item.title)).toContain("会议回流写入本体");
      expect(await f.t.sql("SELECT count(*)::int AS n FROM task_progress WHERE task_id=$1", [meeting])).toEqual([{ n: 3 }]);
      expect(await f.t.sql("SELECT count(*)::int AS n FROM tasks WHERE created_by='agent'")).toEqual([{ n: 2 }]);
    } finally { await f.t.close(); }
  });

  it("早先的待挂靠、待改计划在下一次整理时补归位，不调模型：候选还能挂就挂上，其余按第一个分句新建；本人挂过的不动", async () => {
    const f = await executionFixture();
    try {
      await consent(f, f.member, true);
      const task = await seedTask(f, "采集器服务端整理");
      const closed = await seedTask(f, "旧的事", "execution-one", "done");
      const attach = await seedEarlier(f, "pending_attach", "调研读回校验的写法", { taskId: task });
      const replan = await seedEarlier(f, "pending_replan", "重写上手流程的体验构想，先出了一版草图", { missionId: "execution-two", resolution: "replan",
        links: [{ url: "http://localhost:3000/me" }, { url: "https://tk-preview.tokenkingos.com，然后看" }] });
      const stale = await seedEarlier(f, "pending_attach", "补旧事的收尾", { taskId: closed, missionId: "execution-one" });
      const attached = await seedEarlier(f, "pending_attach", "本人挂过的", { taskId: task, resolution: "attached" });
      const { agent, calls } = fakeAgent(() => ({ entries: [], skipped: [] }));
      expect(await distillPending(f.t.pool, agent, AT, NAMES)).toBe(0);
      expect(calls).toEqual([]);

      const rows = await f.t.sql(`SELECT cp.id::text AS id, cp.placement, cp.resolution, cp.links, t.title, t.created_by, t.mission_id, tp.body
        FROM collector_progress cp LEFT JOIN tasks t ON t.id=cp.task_id LEFT JOIN task_progress tp ON tp.id=cp.task_progress_id`);
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(attach)).toMatchObject({ placement: "task", title: "采集器服务端整理", body: "调研读回校验的写法" });
      expect(byId.get(replan)).toMatchObject({ placement: "task", title: "重写上手流程的体验构想", created_by: "agent", mission_id: "execution-two",
        links: [{ url: "https://tk-preview.tokenkingos.com" }], body: "重写上手流程的体验构想，先出了一版草图" });
      expect(byId.get(stale)).toMatchObject({ placement: "task", title: "补旧事的收尾", created_by: "agent", mission_id: "execution-one" });
      expect(byId.get(attached)).toMatchObject({ placement: "pending_attach", resolution: "attached", body: null });

      await distillPending(f.t.pool, agent, AT, NAMES);
      expect(await f.t.sql("SELECT count(*)::int AS n FROM task_progress")).toEqual([{ n: 3 }]);
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
