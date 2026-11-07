import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TEST_MEMBER } from "./helpers.js";
import { BOARD_NOW, boardFixture } from "./boardFixture.js";

const status = (state: string, title: string) => ["status", { status: state, title, agent: "claude-code", modelLabel: "订阅 · Sonnet" }] as [string, unknown];
/** 执行方在问本人（本机 idle 带 question）；不带的 idle 是一轮做完停下了（新首页 9.6）。 */
const QUESTION = { requestId: "q-1", questions: [{ question: "先做哪一页？", header: "顺序", options: [{ label: "登录页", description: "" }, { label: "首页", description: "" }],
  multiSelect: false }], askedAt: "2026-11-06T01:00:00.000Z" };
const asking = (title: string) => ["status", { status: "idle", title, agent: "claude-code", modelLabel: "订阅 · Sonnet", question: QUESTION }] as [string, unknown];

describe("worker 列表", { timeout: 30_000 }, () => {
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
      // 我的电脑先配对（固定时钟下两台的配对时间一样，列表按配对先后排）。
      await f.t.sql("UPDATE local_devices SET created_at=$2 WHERE id=$1", [laptop.device, new Date(BOARD_NOW.getTime() - 60_000)]);
      const queuedTopic = randomUUID(), runningTopic = randomUUID();
      await f.t.sql(`INSERT INTO research_topics(id,owner_id,title,role_id,plan_task_id,mission_id) VALUES($1,$3,'竞品调研',$4,'task-open','mine'),($2,$3,'行业报告',$4,NULL,NULL)`,
        [queuedTopic, runningTopic, TEST_MEMBER.personId, researcher.id]);
      await laptop.send({ kind: "topic", topicId: runningTopic }, [asking("行业报告")]);

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
        // 订阅的用量只算 token，Claude Code 估的 costUsd 不是真钱（设计第 11 节）。
        elapsedSeconds: 3599, cost: { inputTokens: 1000, outputTokens: 200, costUsd: null, costCny: null }, stage: "doing", wait: null, needsYou: false, queueReason: null,
        queuePosition: null });
      expect(item("等批准")).toMatchObject({ wait: "approval", needsYou: true, stage: "doing" });
      expect(item("验收中")).toMatchObject({ stage: "review", wait: "reviewing", needsYou: false, role: { kind: "reviewer" },
        resource: { where: "cloud", deviceId: null, deviceName: null, modelLabel: "test-heavy-model" } });
      expect(item("等开工")).toMatchObject({ stage: "todo", queueReason: "not_dispatched", resource: null, startedAt: null, elapsedSeconds: null });
      expect(item("那台电脑关了")).toMatchObject({ queueReason: "device_offline", queuePosition: null, wait: null, resource: { deviceName: "另一台" } });
      // 等空位的还没开工：卡在待开始、不算开工时间。
      expect(item("等空位一")).toMatchObject({ stage: "todo", queueReason: "slot", queuePosition: 1, wait: null, needsYou: false, startedAt: null,
        resource: { deviceName: "我的电脑" } });
      expect(item("等空位二")).toMatchObject({ stage: "todo", queueReason: "slot", queuePosition: 2 });
      expect(item("今天完成")).toMatchObject({ stage: "done", finishedAt: BOARD_NOW.toISOString() });
      expect(item("竞品调研")).toMatchObject({ kind: "topic", topicId: queuedTopic, role: { id: researcher.id }, queueReason: "not_dispatched",
        task: { id: "task-open" }, mission: { title: "内部版上线" } });
      expect(item("行业报告")).toMatchObject({ kind: "topic", stage: "doing", wait: "reply", needsYou: true, task: null, mission: null });

      // #号：同一岗位按开工时间排，没开工的排在后面。
      const numbers = (roleId: string) => [...body.running, ...body.queued, ...body.done].filter((entry: { role: { id: string } }) => entry.role.id === roleId)
        .map((entry: { workerNo: number }) => entry.workerNo).sort();
      expect(numbers(dev.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(["等开工", "今天完成", "等空位一", "等空位二"].map((title) => item(title).workerNo).sort()).toEqual([4, 5, 6, 7]);
      expect(numbers(researcher.id)).toEqual([1, 2]);
      expect(item("竞品调研").workerNo).toBe(2);

      expect(body.resources).toEqual({
        devices: [{ id: laptop.device, name: "我的电脑", lastSeenAt: BOARD_NOW.toISOString(), online: true },
          { id: desktop.device, name: "另一台", lastSeenAt: new Date(BOARD_NOW.getTime() - 60 * 60_000).toISOString(), online: false }],
        // 另一台不在线，不算它的位置。
        running: 2, cap: 2,
        cost: { today: { inputTokens: 1000, outputTokens: 200, costUsd: null, costCny: null }, month: { inputTokens: 1000, outputTokens: 200, costUsd: null, costCny: null } },
        quota: [],
      });

      const internal = (headers: Record<string, string>) => f.t.app.inject({ method: "GET", url: "/internal/me/workers", headers });
      const viaChat = await internal({ authorization: "Bearer chat-token", "x-owner-id": TEST_MEMBER.personId });
      expect(viaChat.statusCode).toBe(200);
      expect(viaChat.json()).toEqual(body);
      expect((await internal({ authorization: "Bearer chat-token", "x-owner-id": "nobody" })).statusCode).toBe(404);
      expect((await internal({ authorization: "Bearer wrong", "x-owner-id": TEST_MEMBER.personId })).statusCode).toBe(401);

      // 答完以后这一轮做完停下（idle 不带提问）：已停下，不算等你。
      // 另开的这个会话晚一分钟开始，取「最近一次」时才稳定是它（两个会话的开始时间相同时按随机 id 决胜）。
      const after = await laptop.send({ kind: "topic", topicId: runningTopic }, [status("idle", "行业报告")]);
      await f.t.sql("UPDATE local_runs SET started_at=started_at+interval '1 minute' WHERE id=$1", [after]);
      expect((await f.call("GET", "/api/me/workers")).json().running.find((entry: { title: string }) => entry.title === "行业报告")).toMatchObject({ wait: "paused", needsYou: false });
    } finally { await f.close(); }
  });

  it("执行异常退出一次的卡算已暂停（不是进行中里没有标记的一行）；停着等额度恢复的卡在看板上不算等你回复", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const dev = (await f.call("POST", "/api/me/roles", { name: "开发", family: "dev", kind: "worker" })).json();
      const ids: Record<string, string> = {};
      for (const title of ["崩了一次", "等额度"]) {
        ids[title] = await f.card(title);
        await f.call("PATCH", `/api/me/cards/${ids[title]}`, { version: 1, roleId: dev.id, executor: "claude_code" });
      }
      const laptop = await f.local();
      await laptop.send({ kind: "card", cardId: ids["崩了一次"] }, [status("running", "崩了一次"), status("failed", "崩了一次")]);
      await laptop.send({ kind: "card", cardId: ids["等额度"] }, [["status", { status: "idle", title: "等额度", agent: "claude-code", modelLabel: "订阅 · Sonnet",
        hold: { reason: "usage_limit", until: "2026-11-06T05:00:00.000Z" } }]]);
      const body = (await f.call("GET", "/api/me/workers")).json();
      expect(body.running.find((item: { cardId: string }) => item.cardId === ids["崩了一次"])).toMatchObject({ stage: "doing", wait: "paused", needsYou: false, queueReason: null });
      expect(body.queued.find((item: { cardId: string }) => item.cardId === ids["等额度"])).toMatchObject({ queueReason: "quota", wait: null });
      const board = (await f.call("GET", "/api/plan-tasks/task-open/cards")).json();
      const card = (title: string) => board.cards.find((item: { id: string }) => item.id === ids[title]).card;
      expect([card("崩了一次").stage, card("崩了一次").wait]).toEqual(["doing", "paused"]);
      expect([card("等额度").stage, card("等额度").wait]).toEqual(["doing", null]);
      expect((await f.call("GET", `/api/me/tasks/${ids["等额度"]}`)).json().task.card.wait).toBeNull();
    } finally { await f.close(); }
  });

  it("心跳：本机闲着时每 5 分钟发一批空的，一直算在线、位置数跟着刷新；10 分钟没同步算不在线", async () => {
    let clock = BOARD_NOW;
    const f = await boardFixture({ monthlyNow: () => clock });
    try {
      const laptop = await f.local("我的电脑");
      const beat = (running: number) => f.t.app.inject({ method: "POST", url: "/api/local-runner/sync", headers: { authorization: `Bearer ${laptop.token}` },
        payload: { deviceId: laptop.device, runnerVersion: "0.2.0", slots: { max: 3, running, queued: 0 }, items: [] } });
      const resources = async () => (await f.call("GET", "/api/me/workers")).json().resources;
      const at = (minutes: number, seconds = 0) => new Date(BOARD_NOW.getTime() + minutes * 60_000 + seconds * 1000);
      // 配对了还没同步过：不在线。
      expect((await resources()).devices).toEqual([{ id: laptop.device, name: "我的电脑", lastSeenAt: null, online: false }]);

      for (const minute of [0, 5, 10, 15, 20]) {
        clock = at(minute);
        const res = await beat(minute === 20 ? 1 : 0);
        expect([res.statusCode, res.json()]).toEqual([200, { accepted: [], rejected: [] }]);
        // 下一次心跳之前（离上一次 4 分 59 秒）一直在线。
        clock = at(minute + 4, 59);
        expect((await resources()).devices[0]).toMatchObject({ online: true, lastSeenAt: at(minute).toISOString() });
      }
      clock = at(29, 59);
      expect(await resources()).toMatchObject({ devices: [{ online: true }], running: 1, cap: 3 });
      expect(await f.t.sql("SELECT app_version FROM local_devices WHERE id=$1", [laptop.device])).toEqual([{ app_version: "0.2.0" }]);
      // 最后一次心跳在第 20 分钟：满 10 分钟没同步就不在线，位置数也不算了。
      clock = at(30);
      expect(await resources()).toMatchObject({ devices: [{ online: false, lastSeenAt: at(20).toISOString() }], running: 0, cap: null });
      clock = at(31);
      await beat(0);
      expect((await resources()).devices[0]).toMatchObject({ online: true, lastSeenAt: at(31).toISOString() });
      // 空的一批也要令牌和设备对得上。
      expect((await f.t.app.inject({ method: "POST", url: "/api/local-runner/sync", headers: { authorization: "Bearer nope" },
        payload: { deviceId: laptop.device, runnerVersion: "0.2.0", slots: { max: 3, running: 0, queued: 0 }, items: [] } })).statusCode).toBe(401);
    } finally { await f.close(); }
  });

  it("本机的规划员、验收员也是 worker（第 21 节，云端验收关着）：从同步上来的会话列，带岗位、本机和模型、排第几；验收员写明在验哪张卡，本机还没起时等开工或等本机上线", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const dev = (await f.call("POST", "/api/me/roles", { name: "开发", family: "dev", kind: "worker" })).json();
      const withRole = async (title: string) => {
        const id = await f.card(title);
        await f.call("PATCH", `/api/me/cards/${id}`, { version: 1, roleId: dev.id, executor: "claude_code" });
        return id;
      };
      const [checking, waiting, offline] = [await withRole("在验的卡"), await withRole("等验的卡"), await withRole("那台电脑交的卡")];
      const laptop = await f.local("我的电脑", { max: 2, running: 2, queued: 1 });
      const desktop = await f.local("另一台");
      for (const card of [checking, waiting]) await laptop.handBack(card);
      await desktop.handBack(offline);
      await f.t.sql("UPDATE local_devices SET last_sync_at=$2 WHERE id=$1", [desktop.device, new Date(BOARD_NOW.getTime() - 60 * 60_000)]);
      const keyOf = async (card: string) => (await f.t.sql("SELECT client_id FROM card_handbacks WHERE task_id=$1", [card]))[0].client_id as string;

      // 本机交回以后起了验收员（在交回之后开的会话）；还有一个规划员在跑、一个规划员等空位。
      const verify = await laptop.send({ kind: "verify", cardId: checking, handbackKey: await keyOf(checking) } as never, [status("running", "验收"),
        ["cost", { modelLabel: "订阅 · Opus", usage: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1 } }]]);
      const planning = await laptop.send({ kind: "plan", taskId: "task-open" } as never, [["status", { status: "running", title: "拆卡", agent: "claude-code", modelLabel: "订阅 · Opus" }],
        ["plan", { entries: [{ content: "读约定", status: "completed" }, { content: "出派活单", status: "in_progress" }], progress: { done: 1, total: 2, step: 2, current: "出派活单" } }]]);
      const queued = await laptop.send({ kind: "plan", taskId: "task-theirs" } as never, [status("queued", "拆卡")]);
      for (const [run, minute] of [[verify, 10], [planning, 20], [queued, 30]] as const)
        await f.t.sql("UPDATE local_runs SET started_at=$2 WHERE id=$1", [run, new Date(Date.UTC(2026, 10, 6, 3, minute))]);

      const body = (await f.call("GET", "/api/me/workers")).json();
      const all = [...body.running, ...body.queued, ...body.done];
      const byKey = (key: string) => all.find((entry: { key: string }) => entry.key === key);
      expect(byKey(`verify:${checking}`)).toMatchObject({ kind: "verify", cardId: checking, title: "在验的卡", role: { name: "验收员", kind: "reviewer" },
        task: { id: "task-open", name: "对话质量达标" }, mission: { id: "mine", title: "内部版上线" }, stage: "review", wait: null, queueReason: null,
        resource: { where: "local", deviceId: laptop.device, deviceName: "我的电脑", modelLabel: "订阅 · Opus" }, startedAt: "2026-11-06T03:10:00.000Z",
        cost: { inputTokens: 300, outputTokens: 40, costUsd: null, costCny: null } });
      expect(byKey(`plan:${planning}`)).toMatchObject({ kind: "plan", cardId: null, topicId: null, title: "对话质量达标", role: { name: "规划员" },
        task: { id: "task-open", name: "对话质量达标" }, mission: { id: "mine", title: "内部版上线" }, stage: "doing", step: { n: 2, total: 2, label: "出派活单" },
        resource: { where: "local", deviceName: "我的电脑", modelLabel: "订阅 · Opus" }, queueReason: null });
      expect(byKey(`plan:${queued}`)).toMatchObject({ kind: "plan", title: "别人负责的", queueReason: "slot", queuePosition: 1 });
      // 本机还没起验收员：交回的那台电脑在线是等开工，不在线是等本机上线；都不算云端的验收员。
      expect(byKey(`verify:${waiting}`)).toMatchObject({ kind: "verify", cardId: waiting, queueReason: "not_dispatched", cost: null,
        resource: { where: "local", deviceName: "我的电脑", modelLabel: null } });
      expect(byKey(`verify:${offline}`)).toMatchObject({ kind: "verify", queueReason: "device_offline", resource: { deviceName: "另一台" } });
      expect(body.running.map((entry: { key: string }) => entry.key).sort()).toEqual([`plan:${planning}`, `verify:${checking}`].sort());
      expect(body.queued.map((entry: { key: string }) => entry.key).sort()).toEqual([`plan:${queued}`, `verify:${offline}`, `verify:${waiting}`].sort());
      expect(all.some((entry: { resource: { where: string } | null }) => entry.resource?.where === "cloud")).toBe(false);
      // 验收员的会话不算卡自己的执行：卡的花费里没有它。
      expect((await f.call("GET", `/api/me/cards/${checking}`)).json().runs.map((run: { id: string }) => run.id)).not.toContain(verify);

      // 验收员交了结论以后卡不在验收中，这一行就没了。
      await laptop.send({ kind: "verify", cardId: checking, handbackKey: await keyOf(checking) } as never, [["verdict", { passed: true, summary: "都对上", beyondScope: [],
        criteria: [1, 2].map((index) => ({ index, verdict: "met", reason: "有", evidence: null, fix: null })), modelLabel: "订阅 · Opus", roleId: null, roleVersion: null }]]);
      const after = (await f.call("GET", "/api/me/workers")).json();
      expect([...after.running, ...after.queued].map((entry: { key: string }) => entry.key)).not.toContain(`verify:${checking}`);
    } finally { await f.close(); }
  });
});
