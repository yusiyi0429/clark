// 三种模式和预算（新首页设计 11.3、11.4）、TokenHub 自己报的花费（11.2、13.1）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalBudgetListResponse, LocalSessionSummary, LocalStatusResponse, LocalTaskBudgetView, type TBudget } from "@warmap/contracts";
import { Budgets, reworkRounds, runFor } from "../src/budget.js";
import { dayAndMonthStart, GatewaySpend, usageUrl } from "../src/spend.js";
import { registerFormats } from "../src/store.js";
import { api, pair, startTestRunner, tempDir } from "./helpers.js";

registerFormats();
const conforms = (schema: Parameters<typeof Value.Check>[0], value: unknown) => {
  expect([...Value.Errors(schema, value)].map((e) => `${e.path} ${e.message}`)).toEqual([]);
};
const set = (b: Partial<TBudget>): TBudget => ({ mode: "set", hours: null, weeklyPercent: null, money: null, ...b });
const AUTO: TBudget = { mode: "auto", hours: null, weeklyPercent: null, money: null };
const UNLIMITED: TBudget = { mode: "unlimited", hours: null, weeklyPercent: null, money: null };

describe("预算记账", () => {
  it("时长、本周额度（重置后接着累加）、网关的钱（只算预算的币种）；比例取最大的那项，80% 算到了、100% 算用完；存在数据目录", () => {
    const dir = tempDir("tl-budget-");
    const b = new Budgets(dir, () => Date.parse("2026-11-07T08:00:00Z"));
    const key = Budgets.key("T-1", "s1");
    expect(key).toBe("task:T-1");
    expect(Budgets.key(null, "s1")).toBe("session:s1");
    expect(b.set(key, { taskId: "T-1", sessionId: null }, set({ hours: 2, weeklyPercent: 10, money: { amount: 10, currency: "CNY" } }))).toBe(true);
    expect(b.set(key, { taskId: "T-1", sessionId: null }, set({ hours: 2, weeklyPercent: 10, money: { amount: 10, currency: "CNY" } }))).toBe(false); // 一样的不算变
    // 还没开工：本周额度不记
    b.observeWeekly(30);
    expect(b.view(key)!.spent).toEqual({ hours: 0, weeklyPercent: null, money: null });
    b.start(key, 40);
    b.observeWeekly(43);
    b.addRun(key, 30 * 60_000);
    b.addMoney(key, { amount: 2, currency: "CNY", estimated: true });
    b.addMoney(key, { amount: 5, currency: "USD", estimated: true }); // 别的币种不算
    expect(b.view(key, 30 * 60_000)!.spent).toEqual({ hours: 1, weeklyPercent: 3, money: { amount: 2, currency: "CNY", estimated: true } });
    expect(b.ratio(key, 30 * 60_000)).toBe(0.5); // 时长 1/2，额度 3/10，钱 2/10
    expect(b.judge(key, 30 * 60_000)).toBe("ok");
    b.observeWeekly(48);
    expect(b.judge(key)).toBe("warning"); // 额度 8/10
    // 本周重置：之前涨的 8 个点留着，从 0 接着算
    b.observeWeekly(3);
    expect(b.view(key)!.spent.weeklyPercent).toBe(11);
    expect(b.judge(key)).toBe("exhausted");
    b.setState(key, "exhausted");
    // 重启后还认得
    const again = new Budgets(dir);
    expect(again.state(key)).toBe("exhausted");
    expect(again.view(key)!.spent.weeklyPercent).toBe(11);
    conforms(LocalTaskBudgetView, again.view(key));
    // 别的模式不算比例、不会用完
    again.set(key, { taskId: "T-1", sessionId: null }, UNLIMITED);
    expect(again.ratio(key)).toBeNull();
    expect(again.judge(key)).toBe("ok");
    // 没设金额：照第一笔的币种
    const k2 = Budgets.key(null, "s2");
    again.set(k2, { taskId: null, sessionId: "s2" }, set({ hours: 1 }));
    again.start(k2, null);
    again.addMoney(k2, { amount: 1, currency: "USD", estimated: true });
    again.addMoney(k2, { amount: 2, currency: "CNY", estimated: true });
    expect(again.view(k2)!.spent.money).toEqual({ amount: 1, currency: "USD", estimated: true });
  });

  it("三种模式每张卡怎么跑（11.3 的表）；受阻前返工几轮", () => {
    const base = { verify: false, budgetState: "ok" as const, quotaPercent: 40, quotaWarning: false };
    // 自动：按档位；额度到警戒线降一档
    expect(runFor({ ...base, mode: "auto", tier: "strong" })).toEqual({ model: "opus", effort: "high", multiAgent: false });
    expect(runFor({ ...base, mode: "auto", tier: "normal" })).toEqual({ model: "opus", effort: "medium", multiAgent: false });
    expect(runFor({ ...base, mode: "auto", tier: "light" })).toEqual({ model: "sonnet", effort: "low", multiAgent: false });
    expect(runFor({ ...base, mode: "auto", tier: "strong", quotaWarning: true }).effort).toBe("medium");
    expect(runFor({ ...base, mode: "auto", tier: "light", quotaWarning: true }).effort).toBe("low");
    // 自动不看预算到没到 80%
    expect(runFor({ ...base, mode: "auto", tier: "strong", budgetState: "warning" }).effort).toBe("high");
    // 设预算：到 80% 降一档（和警戒线一起也只降一档）；验收员这时用轻档
    expect(runFor({ ...base, mode: "set", tier: "strong", budgetState: "warning" }).effort).toBe("medium");
    expect(runFor({ ...base, mode: "set", tier: "strong", budgetState: "warning", quotaWarning: true }).effort).toBe("medium");
    expect(runFor({ ...base, mode: "set", tier: "strong", verify: true, budgetState: "warning" })).toEqual({ model: "sonnet", effort: "low", multiAgent: false });
    expect(runFor({ ...base, mode: "set", tier: "strong", verify: true })).toEqual({ model: "opus", effort: "high", multiAgent: false });
    // 无上限：Opus、max、多 agent；额度到 95% 不开；验收员 Opus high
    expect(runFor({ ...base, mode: "unlimited", tier: "light" })).toEqual({ model: "opus", effort: "max", multiAgent: true });
    expect(runFor({ ...base, mode: "unlimited", tier: "light", quotaPercent: 95 }).multiAgent).toBe(false);
    expect(runFor({ ...base, mode: "unlimited", tier: "light", quotaWarning: true }).effort).toBe("max");
    expect(runFor({ ...base, mode: "unlimited", tier: "light", verify: true })).toEqual({ model: "opus", effort: "high", multiAgent: false });
    expect([reworkRounds("auto"), reworkRounds("set"), reworkRounds("unlimited")]).toEqual([2, 2, 3]);
  });
});

describe("TokenHub 自己报的花费", () => {
  const NOW = new Date(2026, 10, 7, 14, 30); // 本机时间 11/07 14:30
  const { day, month } = dayAndMonthStart(NOW);
  const at = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60_000).toISOString();
  it("按币种加今天（0 点起）、本月（1 日起）；翻页读完；不是 TokenHub 的不列；钥匙不对报错；同一个账户的几把钥匙只算一次；同步不带账户名", async () => {
    const calls: string[] = [];
    const items = [
      { call_time_half_hour: at(day, 60), account_name: "sunm", model_id: "deepseek-v4", pay_currency: "CNY", wallet_charge: 1.5 },
      { call_time_half_hour: at(day, 30), account_name: "sunm", model_id: "deepseek-v4", pay_currency: "CNY", wallet_charge: 0.25 },
      { call_time_half_hour: at(day, -30), account_name: "sunm", model_id: "deepseek-v4", pay_currency: "CNY", wallet_charge: 10 }, // 昨天
      { call_time_half_hour: at(month, 30), account_name: "sunm", model_id: "gpt", pay_currency: "USD", wallet_charge: 2 },
      { call_time_half_hour: at(month, 60), account_name: "sunm", model_id: "free", pay_currency: "", wallet_charge: 0 }, // 不计费
    ];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      const u = new URL(String(url));
      const key = (init?.headers as Record<string, string>)["x-api-key"];
      if (u.host === "other.example.com") return new Response("{}", { status: 404 });
      if (key === "bad") return new Response("{}", { status: 401 });
      // 一页 2 条（本机要 500 条一页，这里假装服务端只给 2 条）
      const page = Number(u.searchParams.get("page"));
      const body = { account_name: "sunm", time_start: u.searchParams.get("time_start"), time_end: NOW.toISOString(), total: items.length, page, page_size: 2, items: items.slice((page - 1) * 2, page * 2) };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const gateways = [
      { baseUrl: "https://tokenhub.corp.tokenkingos.com/api/anthropic", apiKey: "k1" },
      { baseUrl: "https://tokenhub.corp.tokenkingos.com/api/anthropic", apiKey: "k1" }, // 同一把钥匙配在两个模型上
      { baseUrl: "https://tokenhub.corp.tokenkingos.com/api/anthropic", apiKey: "k2" }, // 同一个账户的另一把钥匙
      { baseUrl: "https://other.example.com/v1", apiKey: "k3" },
    ];
    const spend = new GatewaySpend(async () => gateways, fetchImpl, () => NOW.getTime());
    await spend.refresh();
    expect(calls[0]).toBe(usageUrl(gateways[0]!.baseUrl, month, 1));
    expect(new URL(calls[0]!).searchParams.get("time_start")).toBe(month.toISOString());
    expect(spend.view()).toEqual([{
      source: "tokenhub", host: "tokenhub.corp.tokenkingos.com", account: "sunm", updatedAt: NOW.toISOString(), error: null,
      today: [{ amount: 1.75, currency: "CNY", estimated: false }],
      month: [{ amount: 11.75, currency: "CNY", estimated: false }, { amount: 2, currency: "USD", estimated: false }],
    }]);
    expect(spend.syncView()).toEqual([{ source: "tokenhub", today: spend.view()[0]!.today, month: spend.view()[0]!.month, updatedAt: NOW.toISOString() }]);
    // 5 分钟内不再读
    const n = calls.length;
    await spend.refresh();
    expect(calls.length).toBe(n);
    // 钥匙不对：记原因，留着上次读到的
    gateways.splice(0, 3, { baseUrl: "https://tokenhub.corp.tokenkingos.com/api/anthropic", apiKey: "bad" });
    await spend.refresh(true);
    expect(spend.view()).toEqual([expect.objectContaining({ account: null, error: "TokenHub 不认这把钥匙", today: [] })]);
    expect(spend.syncView()).toEqual([]);
  });
});

// ───────── 用假 claude 跑一遍 ─────────

async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 15_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function setup(opts: { fetchImpl?: typeof fetch; budgetGraceMs?: number; budgetTickMs?: number; codexLimits?: () => Promise<Record<string, unknown> | null> } = {}) {
  const work = tempDir("tl-bud-");
  const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  const t = await startTestRunner({
    pickFolder: work, fetchImpl: opts.fetchImpl ?? offline, codexLimits: opts.codexLimits,
    holdTiming: { resumeAfterMs: 200, pollMs: 60_000, budgetGraceMs: opts.budgetGraceMs ?? 60_000, budgetTickMs: opts.budgetTickMs ?? 100 },
  });
  const token = await pair(t.port);
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  await call("POST", "/v1/folders/pick", {});
  await call("PATCH", "/v1/settings", { maxConcurrent: 5 });
  const fake = (cfg: Record<string, unknown>) => writeFileSync(join(work, ".fake-claude.json"), JSON.stringify(cfg));
  fake({});
  const session = async (id: string) => (await call("GET", `/v1/sessions/${id}`)).body.session;
  const open = async (title: string, budget: TBudget | null, extra: Record<string, unknown> = {}) => {
    mkdirSync(join(work, title), { recursive: true });
    const r = await call("POST", "/v1/sessions", {
      subject: { kind: "card", cardId: title }, title, cwd: join(work, title), firstMessage: `做 ${title}`,
      ...(budget ? { taskBudget: { taskId: "T-1", budget } } : {}), ...extra,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  };
  const waitFor = async (id: string, ok: (s: any) => boolean, what: string) => {
    let last: any = null;
    try { return await until(async () => { last = await session(id); return ok(last) && last; }); }
    catch { throw new Error(`等 ${what} 超时：现在是 ${last?.status}，hold ${JSON.stringify(last?.hold ?? null)}`); }
  };
  const waitStatus = (id: string, want: string) => waitFor(id, (s) => s.status === want, want);
  const lines = (f: string) => (existsSync(join(work, f)) ? readFileSync(join(work, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  const trace = () => lines(".fake-claude-trace.jsonl");
  const argvOf = (id: string) => trace().filter((l) => l.argv?.includes(id)).map((l) => l.argv as string[]);
  const said = (id: string) => lines(".fake-claude-turns.jsonl").filter((l) => l.sid === id).map((l) => l.turnText ?? `插话：${l.interjection}`);
  const events = (id: string) => readFileSync(join(t.dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const synced = (type: string) => JSON.parse(readFileSync(join(t.dataDir, "outbox.json"), "utf8")).entries.map((e: any) => e.item).filter((i: any) => i.type === type);
  const budget = async () => (await call("GET", "/v1/budgets")).body.budgets.find((b: any) => b.taskId === "T-1");
  /** 跑着的卡报一次本周额度（rate_limit_event 的 seven_day）：每轮开头报 */
  const weekly = (percent: number) => ({ status: "allowed", unifiedWindows: { seven_day: { utilization: percent / 100, resetsAt: Math.floor(Date.now() / 1000) + 86_400 * 3, status: "allowed" } } });
  return { t, work, call, fake, session, open, waitFor, waitStatus, trace, argvOf, said, events, synced, budget, weekly };
}
const flag = (argv: string[] | undefined, name: string) => (argv?.includes(name) ? argv[argv.indexOf(name) + 1]! : null);
const BUDGET_STOP = "这件 Task 的预算用完了：把手上这一步做完就停下，列出还没做完的，不要再开新的步骤。";

describe("设预算：80% 降档、100% 停下、加了预算接着做（假 claude 跑一遍）", { timeout: 60_000 }, () => {
  it("本周额度：到 80% 后面开的卡思考强度降一档、报一条；「加 50%」回落；到 100% 跑着的做完这一步就停、排着的不开始，问本人；加了预算接着做", async () => {
    const h = await setup();
    try {
      const budget = set({ weeklyPercent: 10 });
      // A 第一轮：本周额度 40%（起点）
      h.fake({ rateInfo: h.weekly(40), work: { ms: 50 } });
      const a = await h.open("A", budget);
      await h.waitStatus(a.id, "idle");
      expect(flag(h.argvOf(a.id)[0], "--effort")).toBe("medium");
      expect(await h.budget()).toMatchObject({ state: "ok", spent: { weeklyPercent: 0 }, since: expect.any(String) });

      // 第二轮额度涨到 48%：用了 8/10，到 80%
      h.fake({ rateInfo: h.weekly(48), work: { ms: 50 } });
      await h.call("POST", `/v1/sessions/${a.id}/messages`, { text: "接着做" });
      const warned = await until(async () => { const b = await h.budget(); return b.state === "warning" && b; });
      expect(warned).toMatchObject({ ratio: 0.8, spent: { weeklyPercent: 8 } });
      conforms(LocalTaskBudgetView, warned);
      expect(h.synced("budget").at(-1).data).toMatchObject({ taskId: "T-1", state: "warning" });
      await until(() => h.events(a.id).some((e) => e.type === "notice" && e.code === "budget_warning"));
      // 后面开的卡降一档；不打断 A
      const b = await h.open("B", budget);
      await h.waitStatus(b.id, "idle");
      expect(flag(h.argvOf(b.id)[0], "--effort")).toBe("low");
      expect((await h.session(b.id)).run).toEqual({ mode: "set", model: "opus", effort: "low", multiAgent: false });
      conforms(LocalSessionSummary, await h.session(b.id));
      expect((await h.session(a.id)).hold).toBeUndefined();

      // 「加 50%」：网页带着加过的预算来一次，回落到没到 80%，后面开的卡回到原来的档
      const raised = await h.call("PUT", "/v1/budgets", { taskId: "T-1", budget: set({ weeklyPercent: 15 }) });
      expect(raised.status).toBe(200);
      expect(raised.body).toMatchObject({ state: "ok", ratio: 0.533 });
      const c = await h.open("C", set({ weeklyPercent: 15 }));
      await h.waitStatus(c.id, "idle");
      expect(flag(h.argvOf(c.id)[0], "--effort")).toBe("medium");

      // 到 100%：C 这一轮开头额度涨到 56%（16/15），C 正跑着 → 收到「做完这一步就停」，这一轮做完停着等加预算
      h.fake({ rateInfo: h.weekly(56), work: { ms: 5_000 } });
      await h.call("POST", `/v1/sessions/${c.id}/messages`, { text: "再做一步" });
      const stopped = await h.waitFor(c.id, (s) => s.hold?.reason === "budget" && s.status === "idle", "C 停着等加预算");
      expect(stopped.hold).toEqual({ reason: "budget", until: null });
      conforms(LocalSessionSummary, stopped);
      expect(h.said(c.id)).toContain(`插话：${BUDGET_STOP}`);
      expect(h.events(c.id).filter((e) => e.type === "status").at(-1)).toMatchObject({ status: "idle", hold: { reason: "budget" }, reason: "预算用完了，等你加预算" });
      expect(h.synced("status").filter((i: any) => i.sessionId === c.id).at(-1).data).toMatchObject({ status: "idle", hold: { reason: "budget", until: null } });
      expect(h.synced("budget").at(-1).data).toMatchObject({ state: "exhausted" });
      // 用完时新开的卡排着、不开始；一轮做完在等本人的 A、B 不动
      const d = await h.open("D", set({ weeklyPercent: 15 }));
      expect(d).toMatchObject({ status: "queued", hold: { reason: "budget", until: null } });
      await new Promise((r) => setTimeout(r, 300));
      expect(h.argvOf(d.id)).toHaveLength(0);
      expect((await h.session(a.id)).hold).toBeUndefined();
      expect(await h.budget()).toMatchObject({ state: "exhausted", spent: { weeklyPercent: 16 } });

      // 「加 50% 继续」：C 往开着的进程里说一句接着做，D 开始
      h.fake({ work: { ms: 50 } });
      const more = await h.call("PUT", "/v1/budgets", { taskId: "T-1", budget: set({ weeklyPercent: 23 }) });
      expect(more.body.state).toBe("ok");
      await h.waitFor(c.id, (s) => !s.hold && s.status === "idle", "C 接着做完");
      expect(h.said(c.id).at(-1)).toBe("预算加了，接着把刚才没做完的做完。");
      expect(h.argvOf(c.id)).toHaveLength(1); // 进程一直开着，没重开
      await h.waitStatus(d.id, "idle");
      expect(h.argvOf(d.id)).toHaveLength(1);
      expect(h.events(c.id).some((e) => e.type === "notice" && e.code === "budget_resumed")).toBe(true);
      conforms(LocalBudgetListResponse, (await h.call("GET", "/v1/budgets")).body);
    } finally {
      await h.t.cleanup();
    }
  });

  it("时长只算真在跑的：到点跑着的收到「做完这一步就停」，不理就 3 分钟（测试里 0.4 秒）后打断；停着等时加预算接着做，排着时等的时间不算", async () => {
    const h = await setup({ budgetGraceMs: 400 });
    try {
      // 0.0004 小时 ≈ 1.44 秒
      const budget = set({ hours: 0.0004 });
      h.fake({ work: { ms: 10_000 }, ignoreStop: true });
      const a = await h.open("A", budget);
      const stopped = await h.waitFor(a.id, (s) => s.hold?.reason === "budget" && s.status === "idle", "A 被打断后停着等");
      expect(h.said(a.id)).toContain(`插话：${BUDGET_STOP}`);
      expect(h.events(a.id).find((e) => e.type === "turn_end")).toMatchObject({ errorKind: "interrupted" });
      const spent = (await h.budget()).spent.hours;
      expect(spent).toBeGreaterThanOrEqual(0.0004);
      expect(spent).toBeLessThan(0.002); // 打断以后停着等的时间不算
      await new Promise((r) => setTimeout(r, 500));
      expect((await h.budget()).spent.hours).toBe(spent);
      expect(stopped.run).toMatchObject({ mode: "set" });

      // 停下（本人点的）：不再等预算，加了预算也不自己接着做
      h.fake({ work: { ms: 50 } });
      const b = await h.open("B", budget);
      expect(b).toMatchObject({ status: "queued", hold: { reason: "budget" } });
      await h.call("POST", `/v1/sessions/${a.id}/interrupt`, {});
      expect((await h.session(a.id)).hold).toBeUndefined();
      await h.call("PUT", "/v1/budgets", { taskId: "T-1", budget: set({ hours: 1 }) });
      await h.waitStatus(b.id, "idle");
      await new Promise((r) => setTimeout(r, 300));
      expect(h.said(a.id).filter((t) => t === "预算加了，接着把刚才没做完的做完。")).toHaveLength(0);
    } finally {
      await h.t.cleanup();
    }
  });

  it("收到「做完这一步就停」还没停下时加了预算：说一句不用停，不打断、不停着等", async () => {
    const h = await setup({ budgetGraceMs: 2_000 });
    try {
      h.fake({ work: { ms: 2_500 }, ignoreStop: true });
      const a = await h.open("A", set({ hours: 0.0002 }));
      await until(() => h.said(a.id).includes(`插话：${BUDGET_STOP}`));
      expect((await h.call("PUT", "/v1/budgets", { taskId: "T-1", budget: set({ hours: 1 }) })).body.state).toBe("ok");
      await until(() => h.said(a.id).includes("插话：预算加了，不用停，接着做。"));
      const done = await h.waitStatus(a.id, "idle");
      expect(done.hold).toBeUndefined();
      expect(h.events(a.id).find((e) => e.type === "turn_end")).toMatchObject({ isError: false, text: "做完了" });
    } finally {
      await h.t.cleanup();
    }
  });
});

describe("无上限和自动", { timeout: 60_000 }, () => {
  it("无上限：Opus、max、多 agent 开；额度到 95% 后新的一轮关掉多 agent；自动不开；不挂 Task 的专题按会话记", async () => {
    const h = await setup();
    try {
      h.fake({ work: { ms: 50 } });
      const a = await h.open("A", UNLIMITED, { modelTier: "light" });
      await h.waitStatus(a.id, "idle");
      const argv = h.argvOf(a.id)[0]!;
      expect([flag(argv, "--model"), flag(argv, "--effort")]).toEqual(["opus", "max"]);
      expect(JSON.parse(flag(argv, "--settings")!)).toMatchObject({ ultracode: true });
      expect((await h.session(a.id)).run).toEqual({ mode: "unlimited", model: "opus", effort: "max", multiAgent: true });
      // 这一轮报了额度 96%：下一轮之前关掉多 agent
      h.fake({ work: { ms: 50 }, rateInfo: h.weekly(96) });
      await h.call("POST", `/v1/sessions/${a.id}/messages`, { text: "接着做" });
      await h.waitStatus(a.id, "idle");
      expect(h.trace().filter((l) => l.applyFlags)).toEqual([]);
      await h.call("POST", `/v1/sessions/${a.id}/messages`, { text: "再做" });
      await until(() => h.trace().some((l) => l.applyFlags && l.sid === a.id));
      expect(h.trace().filter((l) => l.applyFlags)).toEqual([{ applyFlags: { ultracode: false }, sid: a.id }]);
      await h.waitStatus(a.id, "idle");
      expect((await h.session(a.id)).run).toMatchObject({ multiAgent: false });
      expect(h.synced("status").filter((i: any) => i.sessionId === a.id).at(-1).data.run).toMatchObject({ mode: "unlimited", multiAgent: false });
      // 无上限不记比例，不会用完
      expect(await h.budget()).toMatchObject({ budget: UNLIMITED, ratio: null, state: "ok" });

      // 自动：按档位，不开多 agent
      const b = await h.open("B", AUTO, { modelTier: "strong" });
      await h.waitStatus(b.id, "idle");
      expect([flag(h.argvOf(b.id)[0], "--model"), flag(h.argvOf(b.id)[0], "--effort")]).toEqual(["opus", "high"]);
      expect(JSON.parse(flag(h.argvOf(b.id)[0], "--settings")!).ultracode).toBeUndefined();

      // 不挂 Task 的专题：预算按这个会话记，改的时候带 sessionId
      const r = await h.call("POST", "/v1/sessions", { subject: { kind: "topic", topicId: "tp1" }, title: "调研", firstMessage: "调研一下", taskBudget: { taskId: null, budget: set({ hours: 5 }) } });
      expect(r.status).toBe(200);
      const list = (await h.call("GET", "/v1/budgets")).body.budgets;
      expect(list).toContainEqual(expect.objectContaining({ taskId: null, sessionId: r.body.id, budget: set({ hours: 5 }) }));
      expect((await h.call("PUT", "/v1/budgets", { sessionId: r.body.id, budget: set({ hours: 6 }) })).body).toMatchObject({ sessionId: r.body.id, budget: { hours: 6 } });
      expect((await h.call("PUT", "/v1/budgets", { taskId: "T-1", sessionId: r.body.id, budget: AUTO })).status).toBe(400);
    } finally {
      await h.t.cleanup();
    }
  });
});

describe("TokenHub 余额不足和花费", { timeout: 60_000 }, () => {
  it("余额不足（402）：停着等本人、不重试；用同一个网关模型排着的、新开的也先不开始；本人说一句放开；状态里有 TokenHub 今天、本月花了多少", async () => {
    const usage = { account_name: "sunm", total: 1, page: 1, page_size: 500, items: [{ call_time_half_hour: new Date().toISOString(), account_name: "sunm", model_id: "deepseek-v4", pay_currency: "CNY", wallet_charge: 12.4 }] };
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/api/tokavi/v1/log/usage")) return new Response(JSON.stringify(usage), { status: 200 });
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const codexLimits = async () => ({ ordinaryUsageAllowed: true, rateLimits: { planType: "plus", primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1794049466 }, secondary: { usedPercent: 21, windowDurationMins: 10080, resetsAt: 1794383425 } } });
    const h = await setup({ fetchImpl, codexLimits });
    try {
      expect((await h.call("PUT", "/v1/models/gw", { label: "DeepSeek", source: "gateway", baseUrl: "https://tokenhub.example.com/api/anthropic", model: "deepseek-v4", apiKey: "tkv-test" })).status).toBe(200);
      h.fake({ balance: true });
      const a = await h.open("A", null, { modelProfileId: "gw" });
      const held = await h.waitFor(a.id, (s) => s.hold?.reason === "balance", "A 停着等本人");
      expect(held.status).toBe("idle");
      conforms(LocalSessionSummary, held);
      expect(h.events(a.id).find((e) => e.type === "turn_end")).toMatchObject({ isError: true, errorKind: "balance" });
      expect(held.run).toEqual({ mode: "auto", model: "deepseek-v4", effort: null, multiAgent: false });
      expect(flag(h.argvOf(a.id)[0], "--effort")).toBeNull();
      const b = await h.open("B", null, { modelProfileId: "gw" });
      expect(b).toMatchObject({ status: "queued", hold: { reason: "balance" } });
      // 订阅的照常开始
      h.fake({ work: { ms: 50 } });
      const c = await h.open("C", null);
      await h.waitStatus(c.id, "idle");
      // 充值后本人说一句：A 接着做，B 也开始
      await h.call("POST", `/v1/sessions/${a.id}/messages`, { text: "充好了，接着做" });
      await h.waitFor(a.id, (s) => !s.hold && s.status === "idle", "A 接着做完");
      await h.waitStatus(b.id, "idle");

      // 状态里的 TokenHub 花费（TokenHub 自己的统计，不是本机估的）
      const status = await until(async () => { const s = (await h.call("GET", "/v1/status")).body; return s.spend.length && s; });
      expect(status.spend).toEqual([expect.objectContaining({ source: "tokenhub", host: "tokenhub.example.com", account: "sunm", today: [{ amount: 12.4, currency: "CNY", estimated: false }] })]);
      // 装了 Codex：额度里多一项 Codex 订阅
      const withCodex = await until(async () => { const s = (await h.call("GET", "/v1/status")).body; return s.quota.some((q: any) => q.source === "codex_subscription") && s; });
      expect(withCodex.quota.find((q: any) => q.source === "codex_subscription")).toMatchObject({ plan: "plus", windows: [{ kind: "session", usedPercent: 3 }, { kind: "weekly_all", usedPercent: 21 }] });
      conforms(LocalStatusResponse, withCodex);
      conforms(LocalStatusResponse, status);
    } finally {
      await h.t.cleanup();
    }
  });
});
