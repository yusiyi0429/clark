import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TEST_MEMBER } from "./helpers.js";
import { BOARD_NOW, boardFixture } from "./boardFixture.js";

const status = (state: string, title: string) => ["status", { status: state, title, agent: "claude-code", modelLabel: "订阅 · Sonnet" }] as [string, unknown];

describe("worker 列表", () => {
  it("带岗位的卡和专题按进行中、已排队、已完成（今天）列出；等你的排在最前；验收中的是云端的验收员；等空位的排第几；资源取在线设备报的位置数；伙伴读的是同一份", async () => {
    // 验收用一个不返回的桩：交回以后一直在「验收中」。
    const f = await boardFixture({ boardAgents: { acceptance: { accept: () => new Promise(() => undefined) } } }, { internalChatToken: "chat-token" });
    try {
      const dev = (await f.call("POST", "/api/me/roles", { name: "开发", family: "dev", kind: "worker" })).json();
      const researcher = (await f.call("POST", "/api/me/roles", { presetKey: "researcher" })).json();
      const withRole = async (title: string) => {
        const id = await f.card(title);
        await f.call("PATCH", `/api/me/cards/${id}`, { version: 1, roleId: dev.id, executor: "claude_code" });
        return id;
      };
      const ids: Record<string, string> = {};
      for (const title of ["等开工", "跑着", "等批准", "验收中", "今天完成", "昨天完成", "那台电脑关了", "等空位一", "等空位二"]) ids[title] = await withRole(title);
      await f.card("人自己的活");
      const laptop = await f.local("我的电脑", { max: 2, running: 2, queued: 2 });
      await laptop.send({ kind: "card", cardId: ids["跑着"] }, [status("running", "跑着"),
        ["plan", { entries: [{ content: "读", status: "completed" }, { content: "写", status: "in_progress" }, { content: "测", status: "pending" }],
          progress: { done: 1, total: 3, step: 2, current: "写" } }],
        ["cost", { modelLabel: "订阅 · Sonnet", usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5 } }]]);
      await laptop.send({ kind: "card", cardId: ids["等批准"] }, [status("waiting_permission", "等批准")]);
      // 本机满了：后开的两件等空位，先开的排第 1。
      for (const [title, minute] of [["等空位二", 20], ["等空位一", 10]] as const) {
        await laptop.send({ kind: "card", cardId: ids[title] }, [status("queued", title)]);
        await f.t.sql("UPDATE local_runs SET started_at=$2 WHERE task_id=$1", [ids[title], new Date(Date.UTC(2026, 10, 6, 1, minute))]);
      }
      await laptop.handBack(ids["验收中"]);
      await f.t.sql("UPDATE tasks SET status='done',acceptance=jsonb_build_object('at',$2::text) WHERE id=$1", [ids["今天完成"], BOARD_NOW.toISOString()]);
      await f.t.sql("UPDATE tasks SET status='done',acceptance=jsonb_build_object('at',$2::text) WHERE id=$1", [ids["昨天完成"], "2026-11-05T02:00:00.000Z"]);
      const desktop = await f.local("另一台");
      await desktop.send({ kind: "card", cardId: ids["那台电脑关了"] }, [status("running", "那台电脑关了")]);
      await f.t.sql("UPDATE local_devices SET last_sync_at=$2 WHERE id=$1", [desktop.device, new Date(BOARD_NOW.getTime() - 60 * 60_000)]);
      const queuedTopic = randomUUID(), runningTopic = randomUUID();
      await f.t.sql(`INSERT INTO research_topics(id,owner_id,title,role_id,plan_task_id,mission_id) VALUES($1,$3,'竞品调研',$4,'task-open','mine'),($2,$3,'行业报告',$4,NULL,NULL)`,
        [queuedTopic, runningTopic, TEST_MEMBER.personId, researcher.id]);
      await laptop.send({ kind: "topic", topicId: runningTopic }, [status("idle", "行业报告")]);

      const res = await f.call("GET", "/api/me/workers");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const titles = (group: { title: string }[]) => group.map((item) => item.title);
      expect(titles(body.running)[0]).toBe("等批准");
      expect(titles(body.running).sort()).toEqual(["等批准", "行业报告", "跑着", "验收中"].sort());
      expect(titles(body.queued).sort()).toEqual(["等开工", "竞品调研", "那台电脑关了", "等空位一", "等空位二"].sort());
      expect(titles(body.done)).toEqual(["今天完成"]);
      const item = (title: string) => [...body.running, ...body.queued, ...body.done].find((entry: { title: string }) => entry.title === title);
      expect(item("跑着")).toMatchObject({ key: `card:${ids["跑着"]}`, kind: "card", cardId: ids["跑着"], topicId: null, role: { id: dev.id, name: "开发", kind: "worker" },
        task: { id: "task-open", name: "对话质量达标" }, mission: { id: "mine", title: "内部版上线" }, step: { n: 2, total: 3, label: "写" },
        resource: { where: "local", deviceId: laptop.device, deviceName: "我的电脑", modelLabel: "订阅 · Sonnet" }, startedAt: "2026-11-06T01:00:01.000Z",
        elapsedSeconds: 3599, cost: { inputTokens: 1000, outputTokens: 200, costUsd: 0.5, costCny: null }, stage: "doing", wait: null, needsYou: false, queueReason: null,
        queuePosition: null });
      expect(item("等批准")).toMatchObject({ wait: "approval", needsYou: true, stage: "doing" });
      expect(item("验收中")).toMatchObject({ stage: "review", wait: "reviewing", needsYou: false, role: { kind: "reviewer" },
        resource: { where: "cloud", deviceId: null, deviceName: null, modelLabel: "test-heavy-model" } });
      expect(item("等开工")).toMatchObject({ stage: "todo", queueReason: "not_dispatched", resource: null, startedAt: null, elapsedSeconds: null });
      expect(item("那台电脑关了")).toMatchObject({ queueReason: "device_offline", queuePosition: null, wait: null, resource: { deviceName: "另一台" } });
      expect(item("等空位一")).toMatchObject({ queueReason: "slot", queuePosition: 1, wait: null, needsYou: false, resource: { deviceName: "我的电脑" } });
      expect(item("等空位二")).toMatchObject({ queueReason: "slot", queuePosition: 2 });
      expect(item("今天完成")).toMatchObject({ stage: "done", finishedAt: BOARD_NOW.toISOString() });
      expect(item("竞品调研")).toMatchObject({ kind: "topic", topicId: queuedTopic, role: { id: researcher.id }, queueReason: "not_dispatched",
        task: { id: "task-open" }, mission: { title: "内部版上线" } });
      expect(item("行业报告")).toMatchObject({ kind: "topic", stage: "doing", wait: "reply", needsYou: true, task: null, mission: null });

      // #号：同一岗位按开工时间排，没开工的排在后面。
      const numbers = (roleId: string) => [...body.running, ...body.queued, ...body.done].filter((entry: { role: { id: string } }) => entry.role.id === roleId)
        .map((entry: { workerNo: number }) => entry.workerNo).sort();
      expect(numbers(dev.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect([item("等开工").workerNo, item("今天完成").workerNo].sort()).toEqual([6, 7]);
      expect(numbers(researcher.id)).toEqual([1, 2]);
      expect(item("竞品调研").workerNo).toBe(2);

      expect(body.resources).toEqual({
        devices: [{ id: laptop.device, name: "我的电脑", lastSeenAt: BOARD_NOW.toISOString(), online: true },
          { id: desktop.device, name: "另一台", lastSeenAt: new Date(BOARD_NOW.getTime() - 60 * 60_000).toISOString(), online: false }],
        // 另一台不在线，不算它的位置。
        running: 2, cap: 2,
        cost: { today: { inputTokens: 1000, outputTokens: 200, costUsd: 0.5, costCny: null }, month: { inputTokens: 1000, outputTokens: 200, costUsd: 0.5, costCny: null } },
      });

      const internal = (headers: Record<string, string>) => f.t.app.inject({ method: "GET", url: "/internal/me/workers", headers });
      const viaChat = await internal({ authorization: "Bearer chat-token", "x-owner-id": TEST_MEMBER.personId });
      expect(viaChat.statusCode).toBe(200);
      expect(viaChat.json()).toEqual(body);
      expect((await internal({ authorization: "Bearer chat-token", "x-owner-id": "nobody" })).statusCode).toBe(404);
      expect((await internal({ authorization: "Bearer wrong", "x-owner-id": TEST_MEMBER.personId })).statusCode).toBe(401);
    } finally { await f.close(); }
  });
});
