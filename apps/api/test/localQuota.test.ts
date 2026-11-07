import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TEST_MEMBER } from "./helpers.js";
import { BOARD_NOW, boardFixture, type BoardFixture } from "./boardFixture.js";

/** 额度和真钱（设计第 11 节）：本机报的 hold、网关的钱、设备的订阅额度，在 worker 列表和资源摘要里怎么显示。 */

const UNTIL = "2026-11-06T05:00:00.000Z";
const HOLD = { reason: "usage_limit", until: UNTIL };
const status = (state: string, title: string, extra: Record<string, unknown> = {}) =>
  ["status", { status: state, title, agent: "claude-code", modelLabel: "订阅 · Sonnet", ...extra }] as [string, unknown];
const usage = (inputTokens: number, outputTokens: number, costUsd: number | null) => ({ inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd });
const quota = (usedPercent: number, blockedUntil: string | null) => ({ id: "claude", name: "Claude", kind: "subscription", remainingPercent: 100 - usedPercent,
  amounts: [], resetsAt: blockedUntil, blockedUntil, updatedAt: "2026-11-06T01:59:00.000Z",
  windows: [{ kind: "session", model: null, usedPercent, state: blockedUntil ? "blocked" : "ok", resetsAt: blockedUntil },
    { kind: "weekly_scoped", model: "Fable", usedPercent: 40, state: "ok", resetsAt: "2026-11-10T00:00:00.000Z" }] });

/** 一台电脑：一个会话里按序号报几条（同一个会话分几批报，序号可以乱序到），也可以发带额度的心跳。 */
async function computer(f: BoardFixture, name = "我的电脑") {
  const { device, token, handBack } = await f.local(name);
  const post = (items: unknown[], extra: Record<string, unknown> = {}) => f.t.app.inject({ method: "POST", url: "/api/local-runner/sync",
    headers: { authorization: `Bearer ${token}` }, payload: { deviceId: device, runnerVersion: "0.3.0", slots: { max: 3, running: 0, queued: 0 }, items, ...extra } });
  const session = (subject: Record<string, unknown>) => {
    const sessionId = randomUUID();
    const send = async (seq: number, [type, data]: [string, unknown]) => {
      const res = await post([{ key: `${device}:${sessionId}:${seq}`, sessionId, subject, occurredAt: new Date(Date.UTC(2026, 10, 6, 1, 0, seq)).toISOString(), type, data }]);
      if (res.statusCode !== 200 || res.json().rejected.length) throw new Error(res.body);
    };
    return { sessionId, send };
  };
  return { device, post, session, handBack };
}

describe("额度、停着等恢复、真钱花费", { timeout: 60_000 }, () => {
  it("停着等额度恢复：卡、专题、规划员、验收员都在已排队 · 等额度恢复，带恢复时间，不算等你；恢复后报的状态不带 hold 就清掉，晚到的旧条目不改", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const dev = (await f.call("POST", "/api/me/roles", { name: "开发", family: "dev", kind: "worker" })).json();
      const researcher = (await f.call("POST", "/api/me/roles", { presetKey: "researcher" })).json();
      const withRole = async (title: string) => {
        const id = await f.card(title);
        await f.call("PATCH", `/api/me/cards/${id}`, { version: 1, roleId: dev.id, executor: "claude_code" });
        return id;
      };
      const [doing, notStarted, checked] = [await withRole("做到一半"), await withRole("还没开始"), await withRole("在验的卡")];
      const topic = randomUUID();
      await f.t.sql("INSERT INTO research_topics(id,owner_id,title,role_id,plan_task_id,mission_id) VALUES($1,$2,'竞品调研',$3,'task-open','mine')",
        [topic, TEST_MEMBER.personId, researcher.id]);
      const laptop = await computer(f);

      // 一轮做到一半额度用完：本机报 idle 带 hold（不是等你回复）。
      const card = laptop.session({ kind: "card", cardId: doing });
      await card.send(1, status("running", "做到一半"));
      await card.send(3, status("idle", "做到一半", { hold: HOLD }));
      // 还没开始的订阅卡停在排队里、带这个原因。
      await laptop.session({ kind: "card", cardId: notStarted }).send(1, status("queued", "还没开始", { queuePosition: 1, hold: HOLD }));
      // 专题的进程退了；规划员的恢复时间读不到。
      await laptop.session({ kind: "topic", topicId: topic }).send(1, status("exited", "竞品调研", { hold: HOLD }));
      const plan = laptop.session({ kind: "plan", taskId: "task-open" });
      await plan.send(1, status("exited", "拆卡", { hold: { reason: "usage_limit", until: null } }));
      // 交回以后起的验收员也停着。
      await laptop.handBack(checked);
      const handbackKey = (await f.t.sql("SELECT client_id FROM card_handbacks WHERE task_id=$1", [checked]))[0].client_id as string;
      const verify = laptop.session({ kind: "verify", cardId: checked, handbackKey });
      await verify.send(1, status("idle", "验收：在验的卡", { hold: HOLD }));
      await f.t.sql("UPDATE local_runs SET started_at=$2 WHERE id=$1", [verify.sessionId, new Date(Date.UTC(2026, 10, 6, 3, 10))]);

      expect(await f.t.sql("SELECT hold FROM local_runs WHERE id=$1", [card.sessionId])).toEqual([{ hold: HOLD }]);
      const workers = async () => {
        const body = (await f.call("GET", "/api/me/workers")).json();
        return { body, byKey: (key: string) => [...body.running, ...body.queued, ...body.done].find((entry: { key: string }) => entry.key === key) };
      };
      const { body, byKey } = await workers();
      const held = { queueReason: "quota", wait: null, needsYou: false, queuePosition: null };
      expect(byKey(`card:${doing}`)).toMatchObject({ ...held, stage: "doing", holdUntil: UNTIL });
      expect(byKey(`card:${notStarted}`)).toMatchObject({ ...held, stage: "todo", holdUntil: UNTIL });
      expect(byKey(`topic:${topic}`)).toMatchObject({ ...held, holdUntil: UNTIL });
      expect(byKey(`plan:${plan.sessionId}`)).toMatchObject({ ...held, holdUntil: null });
      expect(byKey(`verify:${checked}`)).toMatchObject({ ...held, stage: "review", holdUntil: UNTIL });
      expect(body.running).toEqual([]);
      expect(body.queued.map((entry: { key: string }) => entry.key).sort())
        .toEqual([`card:${doing}`, `card:${notStarted}`, `topic:${topic}`, `plan:${plan.sessionId}`, `verify:${checked}`].sort());

      // 到点接着做：同一个会话报 running，不带 hold，就清掉，回到进行中。
      await card.send(4, status("running", "做到一半"));
      expect(await f.t.sql("SELECT hold,state FROM local_runs WHERE id=$1", [card.sessionId])).toEqual([{ hold: null, state: "running" }]);
      // 发件箱重试：序号更小、带 hold 的旧条目晚到了，不改。
      await card.send(2, status("idle", "做到一半", { hold: HOLD }));
      expect(await f.t.sql("SELECT hold,state FROM local_runs WHERE id=$1", [card.sessionId])).toEqual([{ hold: null, state: "running" }]);
      const after = await workers();
      expect(after.byKey(`card:${doing}`)).toMatchObject({ stage: "doing", queueReason: null, holdUntil: null });
      expect(after.body.running.map((entry: { key: string }) => entry.key)).toEqual([`card:${doing}`]);
    } finally { await f.close(); }
  });

  it("预算用完、余额不足的 hold 不算等额度恢复；budget 条目按 Task 存最新的一份，晚到的旧份不改", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const dev = (await f.call("POST", "/api/me/roles", { name: "开发", family: "dev", kind: "worker" })).json();
      const id = await f.card("预算用完的卡");
      await f.call("PATCH", `/api/me/cards/${id}`, { version: 1, roleId: dev.id, executor: "claude_code" });
      const laptop = await computer(f);
      const run = laptop.session({ kind: "card", cardId: id });
      await run.send(1, status("running", "预算用完的卡"));
      await run.send(2, status("idle", "预算用完的卡", { hold: { reason: "budget", until: null } }));
      const body = (await f.call("GET", "/api/me/workers")).json();
      expect([...body.running, ...body.queued, ...body.done].find((entry: { key: string }) => entry.key === `card:${id}`))
        .toMatchObject({ queueReason: null, holdUntil: null });

      const view = (state: string, hours: number, updatedAt: string) => ({ taskId: "task-open", sessionId: run.sessionId,
        budget: { mode: "set", hours: 4, weeklyPercent: null, money: null }, spent: { hours, weeklyPercent: 12, money: null }, ratio: hours / 4, state,
        since: "2026-11-06T01:00:00.000Z", updatedAt });
      await run.send(3, ["budget", view("warning", 3.2, "2026-11-06T02:00:00.000Z")]);
      await run.send(5, ["budget", view("exhausted", 4, "2026-11-06T03:00:00.000Z")]);
      await run.send(4, ["budget", view("warning", 3.5, "2026-11-06T02:30:00.000Z")]); // 发件箱重试晚到的
      expect(await f.t.sql("SELECT subject_key,view FROM local_task_budgets WHERE owner_id=$1", [TEST_MEMBER.personId]))
        .toEqual([{ subject_key: "task:task-open", view: view("exhausted", 4, "2026-11-06T03:00:00.000Z") }]);
    } finally { await f.close(); }
  });

  it("花费只算网关的真钱：按币种分开，订阅的 costUsd 不算；token 都算；旧的 cost 条目（没有 source、money）照收", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const dev = (await f.call("POST", "/api/me/roles", { name: "开发", family: "dev", kind: "worker" })).json();
      const id = await f.card("网关跑的卡");
      await f.call("PATCH", `/api/me/cards/${id}`, { version: 1, roleId: dev.id, executor: "claude_code" });
      const laptop = await computer(f);
      const run = laptop.session({ kind: "card", cardId: id });
      await run.send(1, status("running", "网关跑的卡"));
      await run.send(2, ["cost", { modelLabel: "TokenHub · DeepSeek", usage: usage(1000, 100, null), source: "gateway", model: "deepseek-v4",
        money: { amount: 1.2, currency: "CNY", estimated: true } }]);
      await run.send(3, ["cost", { modelLabel: "TokenHub · DeepSeek", usage: usage(500, 50, null), source: "gateway", model: "deepseek-v4",
        money: { amount: 0.8, currency: "CNY", estimated: true } }]);
      await run.send(4, ["cost", { modelLabel: "TokenHub · GPT", usage: usage(200, 20, null), source: "gateway", model: "gpt", money: { amount: 0.25, currency: "USD", estimated: true } }]);
      // 订阅：Claude Code 按标价估的 costUsd 不是花费。
      await run.send(5, ["cost", { modelLabel: "订阅 · Sonnet", usage: usage(300, 30, 0.5), source: "subscription", model: "claude-sonnet", money: null }]);
      // 旧版本机程序报的：没有 source、model、money。
      await run.send(6, ["cost", { modelLabel: "订阅 · Sonnet", usage: usage(100, 10, 0.1) }]);

      const [row] = await f.t.sql("SELECT money,cost_usd,tokens FROM local_runs WHERE id=$1", [run.sessionId]);
      expect(row.money).toEqual({ CNY: 2, USD: 0.25 });
      expect(Number(row.cost_usd)).toBeCloseTo(0.6);
      expect(row.tokens).toMatchObject({ input: 2100, output: 210 });
      const body = (await f.call("GET", "/api/me/workers")).json();
      const spent = { inputTokens: 2100, outputTokens: 210, costUsd: 0.25, costCny: 2 };
      expect(body.running.find((entry: { key: string }) => entry.key === `card:${id}`).cost).toEqual(spent);
      expect(body.resources.cost).toEqual({ today: spent, month: spent });

      // 只用订阅的会话：钱为 null，token 照算。
      const sub = await f.card("订阅跑的卡");
      await f.call("PATCH", `/api/me/cards/${sub}`, { version: 1, roleId: dev.id, executor: "claude_code" });
      const subRun = laptop.session({ kind: "card", cardId: sub });
      await subRun.send(1, status("running", "订阅跑的卡"));
      await subRun.send(2, ["cost", { modelLabel: "订阅 · Sonnet", usage: usage(400, 40, 0.3), source: "subscription", model: "claude-sonnet", money: null }]);
      const again = (await f.call("GET", "/api/me/workers")).json();
      expect(again.running.find((entry: { key: string }) => entry.key === `card:${sub}`).cost).toEqual({ inputTokens: 400, outputTokens: 40, costUsd: null, costCny: null });
      expect(again.resources.cost.today).toEqual({ inputTokens: 2500, outputTokens: 250, costUsd: 0.25, costCny: 2 });
    } finally { await f.close(); }
  });

  it("批次带的额度存到这台设备（心跳也带）：整份覆盖、没带的留着上次的；资源摘要列每台报过的电脑，不管在不在线，没报过的不列", async () => {
    // 三台先后配对（配对时间不同，列表按配对先后排），再回到 BOARD_NOW 同步。
    let clock = new Date(BOARD_NOW.getTime() - 3 * 60_000);
    const f = await boardFixture({ monthlyNow: () => clock });
    try {
      const laptop = await computer(f);
      clock = new Date(BOARD_NOW.getTime() - 2 * 60_000);
      const desktop = await computer(f, "另一台");
      clock = new Date(BOARD_NOW.getTime() - 60_000);
      await computer(f, "没报过额度的");
      clock = BOARD_NOW;
      const resources = async () => (await f.call("GET", "/api/me/workers")).json().resources;

      expect((await laptop.post([], { quota: [quota(100, UNTIL)] })).json()).toEqual({ accepted: [], rejected: [] });
      expect(await f.t.sql("SELECT quota FROM local_devices WHERE id=$1", [laptop.device])).toEqual([{ quota: [quota(100, UNTIL)] }]);
      await desktop.post([], { quota: [quota(30, null)] });
      // 下一次心跳没带额度：留着上次的。
      await laptop.post([]);
      expect((await resources()).quota).toEqual([
        { deviceId: laptop.device, deviceName: "我的电脑", ...quota(100, UNTIL) },
        { deviceId: desktop.device, deviceName: "另一台", ...quota(30, null) },
      ]);

      // 额度恢复了：新的一份整份换掉。另一台过了一小时没同步，不在线也照列。
      clock = new Date(BOARD_NOW.getTime() + 60 * 60_000);
      await laptop.post([], { quota: [quota(5, null)] });
      const later = await resources();
      expect(later.devices.find((device: { id: string }) => device.id === desktop.device)).toMatchObject({ online: false });
      expect(later.quota).toEqual([
        { deviceId: laptop.device, deviceName: "我的电脑", ...quota(5, null) },
        { deviceId: desktop.device, deviceName: "另一台", ...quota(30, null) },
      ]);
      // 改版前存下的旧形状（按 source、没有 id）不列，等本机下一次报新的。
      await f.t.sql(`UPDATE local_devices SET quota='[{"source":"claude_subscription","windows":[],"blockedUntil":null,"updatedAt":"2026-11-06T01:00:00.000Z"}]' WHERE id=$1`,
        [desktop.device]);
      expect((await resources()).quota.map((entry: { deviceId: string }) => entry.deviceId)).toEqual([laptop.device]);
      await desktop.post([], { quota: [quota(30, null)] });
      // 吊销的电脑不列。
      expect((await f.call("DELETE", `/api/me/local-devices/${desktop.device}`)).statusCode).toBe(204);
      expect((await resources()).quota.map((entry: { deviceId: string }) => entry.deviceId)).toEqual([laptop.device]);
    } finally { await f.close(); }
  });
});
