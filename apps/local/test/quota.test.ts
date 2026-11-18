// 额度、停着等额度恢复、花费只算真钱、按档位传模型和思考强度、命令行工具登没登录（新首页设计第 11 节「马上」那一批）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { quotaFromUsage, QuotaTracker, QUOTA_TTL_MS, subscriptionSource } from "../src/quota.js";
import { CliTools, claudeTool, type ToolExec } from "../src/tools.js";
import { costOf, evalExpr, GatewayPricing, inInterval, pricesUrl } from "../src/pricing.js";
import { readUsage } from "../src/agents/claudeCode.js";
import { CodexQuota, codexQuotaFrom } from "../src/codexQuota.js";
import { codexTool } from "../src/agents/codexSetup.js";
import { Value } from "@sinclair/typebox/value";
import { LocalSessionSummary, LocalStatusResponse } from "@warmap/contracts";
import { registerFormats } from "../src/store.js";
import { api, gitRepo, pair, startTestRunner, tempDir, FAKE_CLAUDE } from "./helpers.js";

registerFormats();
/** 本机回给网页的东西都得合契约（摘要是严格的：多一个字段也不行）。 */
const conforms = (schema: Parameters<typeof Value.Check>[0], value: unknown) => {
  const errors = [...Value.Errors(schema, value)].map((e) => `${e.path} ${e.message}`);
  expect(errors).toEqual([]);
};

/** 11/07 实测 get_usage 回执的样子（假 claude 默认回的就是这个）。 */
const USAGE = {
  subscription_type: "max",
  rate_limits: {
    limits: [
      { kind: "session", group: "session", percent: 12, severity: "normal", resets_at: "2026-11-07T10:00:00Z", scope: null, is_active: true },
      { kind: "weekly_all", group: "weekly", percent: 40, severity: "normal", resets_at: "2026-11-12T00:00:00Z", scope: null, is_active: true },
      { kind: "weekly_scoped", group: "weekly", percent: 81, severity: "warning", resets_at: "2026-11-12T00:00:00Z", scope: { model: { display_name: "Opus" } }, is_active: true },
      { kind: "something_new", percent: 3 },
    ],
    extra_usage: { is_enabled: false },
  },
  account: { email: "someone@example.com", organization: "Org" },
};

describe("额度", () => {
  it("get_usage 的回执：只取认得的窗口，到 100% 算用完、几点恢复（只看在用的窗口）；邮箱、组织不取", async () => {
    const q = quotaFromUsage(USAGE);
    expect(q).toEqual({
      plan: "max", extraUsage: false, blockedUntil: null,
      windows: [
        { kind: "session", model: null, usedPercent: 12, state: "ok", resetsAt: "2026-11-07T10:00:00.000Z" },
        { kind: "weekly_all", model: null, usedPercent: 40, state: "ok", resetsAt: "2026-11-12T00:00:00.000Z" },
        { kind: "weekly_scoped", model: "Opus", usedPercent: 81, state: "warning", resetsAt: "2026-11-12T00:00:00.000Z" },
      ],
    });
    expect(JSON.stringify(q)).not.toContain("someone@example.com");
    // 用量那一格：按模型分的周额度（Opus 81%）不算进剩多少，看 5 小时和本周的里用得最多的（40%）
    expect(subscriptionSource("claude", "Claude", { ...q, updatedAt: null, error: null })).toMatchObject({ remainingPercent: 60, resetsAt: "2026-11-12T00:00:00.000Z" });
    expect(subscriptionSource("claude", "Claude", { ...q, windows: [q.windows[2]!], updatedAt: null, error: null }).remainingPercent).toBe(19); // 只有它时才看它
    const full = quotaFromUsage({ rate_limits: { limits: [
      { kind: "session", percent: 100, severity: "critical", resets_at: "2026-11-07T10:00:00Z" },
      { kind: "weekly_all", percent: 100, resets_at: "2026-11-09T00:00:00Z" },
      { kind: "weekly_scoped", percent: 100, resets_at: "2026-11-10T00:00:00Z", scope: { model: { display_name: "Fable" } }, is_active: false },
    ] } });
    expect(full.windows.map((w) => w.state)).toEqual(["blocked", "blocked", "blocked"]);
    expect(full.blockedUntil).toBe("2026-11-09T00:00:00.000Z"); // 两个都用完：等晚的那个；没在用的模型满了不算
    // 只有没在用的模型满了：本机不算用完（跑着的卡真碰上了会报 rejected）
    const idle = new QuotaTracker(tempDir("tl-quota-"), async () => ({ rate_limits: { limits: [
      { kind: "weekly_all", percent: 40, resets_at: "2026-11-12T00:00:00Z", is_active: true },
      { kind: "weekly_scoped", percent: 100, resets_at: "2026-11-10T00:00:00Z", scope: { model: { display_name: "Fable" } }, is_active: false },
    ] } }), () => Date.parse("2026-11-07T00:00:00Z"));
    await idle.refresh(true);
    expect(idle.view()[0]!.windows[1]!.state).toBe("blocked");
    expect(idle.blockedUntil()).toBeNull();
  });

  it("跑着的卡报的额度变化：rejected 记下几点恢复，过了点就不算用完；没给时间的 rejected 不沿用旧的时间；存在数据目录，重启还认得；同步只带百分比、状态、时间", async () => {
    const dir = tempDir("tl-quota-");
    let now = Date.parse("2026-11-07T08:00:00Z");
    let reads = 0;
    const read = async () => { reads += 1; return USAGE; };
    const q = new QuotaTracker(dir, read, () => now);
    expect(q.view()).toEqual([]);
    expect(q.syncView()).toEqual([]);
    expect(q.blockedUntil()).toBeNull();
    const resetsAt = Date.parse("2026-11-07T09:00:00Z") / 1000;
    q.fromEvent({ status: "rejected", resetsAt, rateLimitType: "five_hour", utilization: 1, unifiedWindows: { five_hour: { utilization: 1, resetsAt, status: "rejected" }, seven_day: { utilization: 0.42, resetsAt: resetsAt + 86400, status: "allowed" } } });
    expect(q.blockedUntil()).toBe(resetsAt * 1000);
    expect(q.view()[0]!.windows).toEqual([
      { kind: "session", model: null, usedPercent: 100, state: "blocked", resetsAt: "2026-11-07T09:00:00.000Z" },
      { kind: "weekly_all", model: null, usedPercent: 42, state: "ok", resetsAt: "2026-11-08T09:00:00.000Z" },
    ]);
    // 后来又来一条没给时间的 rejected：不沿用上一次已经过了的时间（过了点就当没用完会一直重试）
    const later = new QuotaTracker(tempDir("tl-quota-"), read, () => resetsAt * 1000 + 3_600_000);
    later.fromEvent({ status: "rejected", resetsAt, unifiedWindows: { five_hour: { utilization: 1, resetsAt, status: "rejected" } } });
    expect(later.blockedUntil()).toBeNull();
    later.fromEvent({ status: "rejected", unifiedWindows: { five_hour: { utilization: 1, status: "rejected" } } });
    expect(later.view()[0]!.blockedUntil).toBeNull();
    expect(later.blockedUntil()).toBe(Infinity); // 窗口用完了又不知道几点
    const [sync] = q.syncView();
    expect(Object.keys(sync!).sort()).toEqual(["amounts", "blockedUntil", "id", "kind", "name", "remainingPercent", "resetsAt", "updatedAt", "windows"]);
    // 用量那一格：剩多少是 100 减去用得最多的窗口，几点重置跟着它
    expect(sync).toMatchObject({ id: "claude", name: "Claude", kind: "subscription", remainingPercent: 0, resetsAt: "2026-11-07T09:00:00.000Z", amounts: [] });
    // 重启后照样认得（存在 quota.json）
    expect(new QuotaTracker(dir, read, () => now).blockedUntil()).toBe(resetsAt * 1000);
    // 读额度：5 分钟内读过（跑着的卡刚报过）就不再读，过了 5 分钟、force 照读
    await q.refresh();
    expect(reads).toBe(0);
    now = resetsAt * 1000 + 1;
    expect(q.blockedUntil()).toBeNull(); // 过了点
    await q.refresh();
    expect(reads).toBe(1);
    expect(q.view()[0]).toMatchObject({ plan: "max", blockedUntil: null, error: null, updatedAt: new Date(now).toISOString() });
    await q.refresh();
    expect(reads).toBe(1);
    now += QUOTA_TTL_MS;
    await q.refresh();
    expect(reads).toBe(2);
    await q.refresh(true);
    expect(reads).toBe(3);
    // 读不到：记下原因，窗口照旧
    let fails = 0;
    const broken = new QuotaTracker(dir, async () => { fails += 1; throw new Error("没读到额度"); }, () => now);
    now += QUOTA_TTL_MS;
    await broken.refresh();
    expect(broken.view()[0]).toMatchObject({ plan: "max", error: "没读到额度" });
    expect(broken.view()[0]!.windows).toHaveLength(3);
    await broken.refresh(); // 刚试过没读到：5 分钟内不再起进程去读（网页每 10 秒问一次状态）
    expect(fails).toBe(1);
    now += QUOTA_TTL_MS;
    await broken.refresh();
    expect(fails).toBe(2);
  });

  it("向假 Claude Code 读额度：不发提示，只握手和 get_usage", async () => {
    const dir = tempDir("tl-usage-");
    const resp = await readUsage({ command: process.execPath, prefixArgs: [FAKE_CLAUDE] }, dir);
    expect(quotaFromUsage(resp).windows).toHaveLength(3);
    const trace = readFileSync(join(dir, ".fake-claude-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(trace.find((l) => l.getUsage)?.getUsage).toEqual({ subtype: "get_usage", skip_behaviors: true });
    expect(existsSync(join(dir, ".fake-claude-turns.jsonl"))).toBe(false); // 没开过一轮
    expect(trace[0].argv).toEqual(expect.arrayContaining(["--no-session-persistence", "--strict-mcp-config"]));
  });

  /** 11/18 实测：官方额度接口对这个登录回 429 时，get_usage 回成功，但 rate_limits 是 null（Claude Code 2.1.327）。 */
  const LIMITED = { subscription_type: "max", rate_limits_available: true, rate_limits: null };

  it("Claude 额度接口读不到时保留上一次的窗口，并标明暂时读不到", async () => {
    let now = Date.parse("2026-11-18T08:00:00Z");
    let resp: Record<string, unknown> = USAGE;
    const q = new QuotaTracker(tempDir("tl-quota-"), async () => resp, () => now);
    await q.refresh();
    expect(q.view()[0]).toMatchObject({ remainingPercent: 60, error: null });
    resp = LIMITED;
    now += QUOTA_TTL_MS;
    await q.refresh();
    expect(q.view()[0]!.windows).toHaveLength(3); // 不清空
    expect(q.view()[0]).toMatchObject({ remainingPercent: 60, plan: "max", updatedAt: "2026-11-18T08:00:00.000Z" }); // 还是上一次读到的数和时间
    expect(q.view()[0]!.error).toBeTruthy(); // 标明暂时读不到
    // rate_limits 有、但一个认得的窗口都没有（比如只剩缓存的那几项）：也算读不到，不清空
    const empty = new QuotaTracker(tempDir("tl-quota-"), async () => resp, () => now);
    resp = USAGE;
    await empty.refresh();
    resp = { subscription_type: "max", rate_limits_available: true, rate_limits: { five_hour: null } };
    now += 60 * 60_000;
    await empty.refresh();
    expect(empty.view()[0]!.windows).toHaveLength(3);
    expect(empty.view()[0]!.error).toBeTruthy();
    // 从来没读到过数的：照样报这个来源，带暂时读不到
    const never = new QuotaTracker(tempDir("tl-quota-"), async () => LIMITED, () => now);
    await never.refresh();
    expect(never.view()).toHaveLength(1);
    expect(never.view()[0]).toMatchObject({ id: "claude", name: "Claude", windows: [], remainingPercent: null, updatedAt: null });
    expect(never.view()[0]!.error).toBeTruthy();
    expect(never.syncView()).toEqual([]); // 没读到过，不报云端
  });

  it("读不到后停一段再读，不每次都去撞", async () => {
    let now = Date.parse("2026-11-18T08:00:00Z");
    let reads = 0;
    const q = new QuotaTracker(tempDir("tl-quota-"), async () => { reads += 1; return LIMITED; }, () => now);
    await q.refresh();
    expect(reads).toBe(1);
    for (let i = 0; i < 8; i += 1) { now += QUOTA_TTL_MS; await q.refresh(); } // 40 分钟里网页一直在问状态
    expect(reads).toBe(1);
    now += QUOTA_TTL_MS; // 45 分钟到了
    await q.refresh();
    expect(reads).toBe(2);
    // 读到了以后照旧每 5 分钟读一次
    const ok = new QuotaTracker(tempDir("tl-quota-"), async () => { reads += 1; return reads === 3 ? LIMITED : USAGE; }, () => now);
    await ok.refresh();
    expect(reads).toBe(3);
    now += 45 * 60_000;
    await ok.refresh();
    expect(reads).toBe(4);
    expect(ok.view()[0]).toMatchObject({ remainingPercent: 60, error: null });
    now += QUOTA_TTL_MS;
    await ok.refresh();
    expect(reads).toBe(5);
  });

  it("跑着的卡报的额度不会被下一次空读清掉", async () => {
    let now = Date.parse("2026-11-18T08:00:00Z");
    let resp: Record<string, unknown> = LIMITED;
    let release: (() => void) | null = null;
    let gate: Promise<void> | null = null;
    const q = new QuotaTracker(tempDir("tl-quota-"), async () => { if (gate) await gate; return resp; }, () => now);
    await q.refresh(); // 先读不到
    expect(q.view()[0]!.error).toBeTruthy();
    const resetsAt = Date.parse("2026-11-18T10:00:00Z") / 1000;
    const event = { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.3, resetsAt, status: "allowed" }, seven_day: { utilization: 0.55, resetsAt: resetsAt + 86400, status: "allowed" } } };
    now += 60_000;
    q.fromEvent(event);
    expect(q.view()[0]).toMatchObject({ remainingPercent: 45, error: null }); // 卡报的为准，读得到了
    // 下一次去读还是读不到：不覆盖卡报的
    now += 45 * 60_000;
    await q.refresh();
    expect(q.view()[0]!.windows.map((w) => w.usedPercent)).toEqual([30, 55]);
    expect(q.view()[0]!.remainingPercent).toBe(45);
    // 读到了，但读的途中卡又报了一次（比这次读新）：以卡报的为准
    resp = USAGE;
    gate = new Promise((resolve) => { release = resolve; });
    now += 45 * 60_000;
    const reading = q.refresh();
    now += 1_000;
    q.fromEvent({ status: "allowed", unifiedWindows: { five_hour: { utilization: 0.35, resetsAt, status: "allowed" } } });
    release!();
    await reading;
    expect(q.view()[0]!.windows.find((w) => w.kind === "session")!.usedPercent).toBe(35);
    expect(q.view()[0]!.remainingPercent).toBe(45);
    // 读到了、读的途中卡没报：读到的更新，以读到的为准
    gate = null;
    now += 10 * 60_000;
    await q.refresh();
    expect(q.view()[0]).toMatchObject({ remainingPercent: 60, error: null });
    expect(q.view()[0]!.windows).toHaveLength(3);
  });
});

describe("Codex 订阅的额度", () => {
  /** 11/07 实测 codex-cli 0.159.2 的 account/rateLimits/read（Plus 计划，只留本机用到的字段）。 */
  const CODEX = {
    ordinaryUsageAllowed: true, accountId: "acc-1",
    rateLimits: { limitId: "codex", planType: "plus", primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1794049466 }, secondary: { usedPercent: 21, windowDurationMins: 10080, resetsAt: 1794383425 } },
    rateLimitsByLimitId: { codex: { limitId: "codex", planType: "plus", primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1794049466 }, secondary: { usedPercent: 21, windowDurationMins: 10080, resetsAt: 1794383425 } } },
    rateLimitResetCredits: { availableCount: 2, credits: null },
  };
  it("按窗口长度认 5 小时和本周（不按先后）；到 100% 或不许用了算用完；没装不列；读不到记原因；同步只带窗口和时间", async () => {
    expect(codexQuotaFrom(CODEX)).toEqual({
      plan: "plus", extraUsage: null, blockedUntil: null,
      windows: [
        { kind: "session", model: null, usedPercent: 0, state: "ok", resetsAt: new Date(1794049466 * 1000).toISOString() },
        { kind: "weekly_all", model: null, usedPercent: 21, state: "ok", resetsAt: new Date(1794383425 * 1000).toISOString() },
      ],
    });
    // 先后反过来、多一个认不得的窗口
    const swapped = { rateLimits: { planType: "pro", primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1794383425 }, secondary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1794049466 } } };
    expect(codexQuotaFrom(swapped).windows.map((w) => [w.kind, w.state])).toEqual([["weekly_all", "blocked"], ["session", "ok"]]);
    expect(codexQuotaFrom(swapped).blockedUntil).toBe(new Date(1794383425 * 1000).toISOString());
    expect(codexQuotaFrom({ ...CODEX, ordinaryUsageAllowed: false }).windows[1]!.state).toBe("blocked");
    expect(JSON.stringify(codexQuotaFrom(CODEX))).not.toContain("acc-1");

    let next: () => Promise<any> = async () => CODEX;
    const now = Date.parse("2026-11-07T08:00:00Z");
    const q = new CodexQuota(() => next(), () => now);
    await q.refresh();
    expect(q.view()).toEqual([expect.objectContaining({ id: "codex", name: "Codex", kind: "subscription", remainingPercent: 79, plan: "plus", error: null, updatedAt: "2026-11-07T08:00:00.000Z" })]);
    expect(q.view()[0]!.resetsAt).toBe(new Date(1794383425 * 1000).toISOString()); // 剩得最少的是本周那个
    expect(q.syncView()).toEqual([{ id: "codex", name: "Codex", kind: "subscription", remainingPercent: 79, amounts: [], windows: q.view()[0]!.windows, resetsAt: q.view()[0]!.resetsAt, blockedUntil: null, updatedAt: "2026-11-07T08:00:00.000Z" }]);
    next = async () => { throw new Error("Codex 没有响应握手"); };
    await q.refresh(true);
    expect(q.view()[0]).toMatchObject({ error: "Codex 没有响应握手", windows: q.view()[0]!.windows });
    next = async () => null; // 卸载了
    await q.refresh(true);
    expect(q.view()).toEqual([]);
  });
});

describe("命令行工具登没登录", () => {
  const exec = (table: Record<string, { code?: number; stdout: string } | null>): ToolExec => async (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    if (!(key in table)) throw new Error(`没料到的命令 ${key}`);
    const r = table[key];
    return r ? { code: r.code ?? 0, stdout: r.stdout, stderr: "" } : null;
  };
  const check = async (table: Parameters<typeof exec>[0], now = Date.parse("2026-11-07T00:00:00Z")) => {
    const t = new CliTools(exec(table), () => now);
    expect(t.view().map((x) => x.state)).toEqual(["unknown", "unknown"]);
    await t.refresh();
    return t.view().map(({ checkedAt, ...rest }) => { expect(checkedAt).toBeTruthy(); return rest; });
  };

  it("gh、lark-cli：没装、没登录、登着（是谁）、过期；Claude Code、Codex 照它们自己报的", async () => {
    expect(claudeTool({ installed: false, loggedIn: false, version: null, loginExpiresAt: null }).state).toBe("not_installed");
    expect(claudeTool({ installed: true, loggedIn: false, version: "2.1.318", loginExpiresAt: null }).state).toBe("not_logged_in");
    expect(claudeTool({ installed: true, loggedIn: true, version: "2.1.318", loginExpiresAt: "2026-11-01T00:00:00Z" }, Date.parse("2026-11-07T00:00:00Z")).state).toBe("expired");
    expect(claudeTool({ installed: true, loggedIn: true, version: "2.1.318", loginExpiresAt: null })).toMatchObject({ kind: "claude-code", state: "ready", version: "2.1.318", account: null });
    const codex = { kind: "codex" as const, installed: true, version: "0.159.2", path: null, loggedIn: false, authMethod: null, subscriptionType: null, loginExpiresAt: null, minimumVersion: "0.159.0", compatible: true, setup: { phase: "idle" as const, startedAt: null, loginUrl: null, error: null } };
    expect(codexTool({ ...codex, installed: false, version: null }).state).toBe("not_installed");
    expect(codexTool(codex).state).toBe("not_logged_in");
    expect(codexTool({ ...codex, loggedIn: true })).toMatchObject({ kind: "codex", state: "ready", version: "0.159.2", account: null });
    expect(await check({ "gh --version": null, "lark-cli --version": null })).toEqual([
      { kind: "gh", state: "not_installed", version: null, account: null },
      { kind: "lark-cli", state: "not_installed", version: null, account: null },
    ]);
    const ghV = { stdout: "gh version 2.88.1 (2026-10-01)\n" };
    const larkV = { stdout: "lark-cli version 1.0.93\n" };
    expect(await check({
      "gh --version": ghV, "gh auth status --json hosts": { stdout: JSON.stringify({ hosts: { "github.com": [{ state: "success", active: true, login: "sean" }, { state: "success", active: false, login: "other" }] } }) },
      "lark-cli --version": larkV, "lark-cli auth status": { stdout: JSON.stringify({ identities: { user: { status: "valid", available: true, userName: "孙明泽", refreshExpiresAt: "2026-12-01T00:00:00Z" }, bot: { available: true } } }) },
    })).toEqual([
      { kind: "gh", state: "ready", version: "2.88.1", account: "sean" },
      { kind: "lark-cli", state: "ready", version: "1.0.93", account: "孙明泽" },
    ]);
    expect(await check({
      "gh --version": ghV, "gh auth status --json hosts": { code: 1, stdout: JSON.stringify({ hosts: { "github.com": [{ state: "error", active: true, login: "sean" }] } }) },
      "lark-cli --version": larkV, "lark-cli auth status": { stdout: JSON.stringify({ identities: { user: { status: "valid", available: true, userName: "孙明泽", refreshExpiresAt: "2026-11-01T00:00:00Z" } } }) },
    })).toEqual([
      { kind: "gh", state: "expired", version: "2.88.1", account: "sean" },
      { kind: "lark-cli", state: "expired", version: "1.0.93", account: "孙明泽" },
    ]);
    expect(await check({
      "gh --version": ghV, "gh auth status --json hosts": { code: 1, stdout: JSON.stringify({ hosts: {} }) },
      "lark-cli --version": larkV, "lark-cli auth status": { stdout: JSON.stringify({ identities: { bot: { available: true } } }) }, // 只有机器人身份
    })).toEqual([
      { kind: "gh", state: "not_logged_in", version: "2.88.1", account: null },
      { kind: "lark-cli", state: "not_logged_in", version: "1.0.93", account: null },
    ]);
  });
});

describe("网关的真钱（照 TokenHub 价目表）", () => {
  const TIERED = {
    strategy: "input-tiered", unit: "1M-token", currency: "CNY",
    tiers: [
      { range: "[0, 32k]", input: 2, output: 8, explicit_cached: { ttl: [{ read: 0.5, write: 2.5 }] } },
      { range: "(32k, inf)", input: 4, output: 16 },
    ],
  };
  const TIMED = {
    strategy: "peak-low-timed", unit: "1M-token", currency: "CNY",
    datetime_define: { timezone: "UTC+8", time: { night: ["00:30-08:30"] } },
    price_periods: {
      low: { datetime: "night", price: { strategy: "input-tiered", tiers: [{ range: "[0, inf)", input: 1, output: 4 }] } },
      other: { price: { strategy: "reference", ref: { refer_to: "low", multiply: 2 } } },
    },
  };
  const at = new Date("2026-11-07T01:00:00Z"); // 新加坡 09:00

  it("按一次请求的输入长度选档；缓存读写按显式缓存价，没给缓存价按输入价；分时段按价目表时区，参考段乘倍率", () => {
    expect(inInterval(32_000, "[0, 32k]")).toBe(true);
    expect(inInterval(32_000, "(32k, inf)")).toBe(false);
    expect(evalExpr("weekday & !(night | weekend)", { weekday: true, weekend: false, night: false })).toBe(true);
    // 1000 普通输入 + 3000 缓存读 + 200 输出：2×1000 + 0.5×3000 + 8×200
    const u = { input: 4000, cacheRead: 3000, cacheWrite: 0, output: 200, perRequestInput: 4000 };
    expect(costOf(u, TIERED, at).amount).toBeCloseTo(0.0051, 10);
    // 长的一档没给缓存价：缓存读按输入价 4×(1000+3000) + 16×200
    expect(costOf({ ...u, perRequestInput: 40_000 }, TIERED, at).amount).toBeCloseTo(0.0192, 10);
    expect(costOf(u, TIMED, at)).toEqual({ amount: (2 * 4000 + 8 * 200) / 1e6, currency: "CNY" }); // 白天：低价段的两倍
    expect(costOf(u, TIMED, new Date("2026-11-06T18:00:00Z")).amount).toBeCloseTo((1 * 4000 + 4 * 200) / 1e6, 12); // 新加坡 02:00
  });

  it("读价目表带本机存的钥匙、缓存；读不到这一轮不算真钱", async () => {
    const calls: { url: string; key: string | null }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, key: new Headers(init?.headers).get("x-api-key") });
      if (url.includes("model_name=deepseek-v4")) return new Response(JSON.stringify({ model_name: "deepseek-v4", price_info: TIERED }), { status: 200 });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const p = new GatewayPricing(fetchImpl, () => at.getTime());
    const gw = { baseUrl: "https://tokenhub.corp.tokenkingos.com/api/anthropic", apiKey: "test-key" };
    const turn = { models: [{ model: "deepseek-v4", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 0, costBasis: "unknown", requests: 2 }] };
    expect(await p.money(gw, turn, at)).toEqual({ amount: 0.0051, currency: "CNY", estimated: true });
    expect(await p.money(gw, turn, at)).toEqual({ amount: 0.0051, currency: "CNY", estimated: true });
    expect(calls).toEqual([{ url: pricesUrl(gw.baseUrl, "deepseek-v4"), key: "test-key" }]); // 缓存住了
    expect(calls[0]!.url).toBe("https://tokenhub.corp.tokenkingos.com/api/tokavi/v1/model/prices?model_name=deepseek-v4");
    expect(await p.money(gw, { ...turn, models: [{ ...turn.models[0]!, model: "unknown-model" }] }, at)).toBeNull();
    expect(await p.money({ ...gw, apiKey: null }, turn, at)).toBeNull();
  });
});

// ───────── 跑起来：本机程序 + 假 claude ─────────

const trace = (work: string) => existsSync(join(work, ".fake-claude-trace.jsonl"))
  ? readFileSync(join(work, ".fake-claude-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const turns = (work: string, id: string) => existsSync(join(work, ".fake-claude-turns.jsonl"))
  ? readFileSync(join(work, ".fake-claude-turns.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.sid === id).map((l) => l.turnText) : [];
const argvOf = (work: string, id: string) => trace(work).filter((l) => l.argv?.includes(id)).map((l) => l.argv as string[]);
const flag = (argv: string[] | undefined, name: string) => (argv?.includes(name) ? argv[argv.indexOf(name) + 1]! : null);
const outboxItems = (dataDir: string, id: string, type: string) => JSON.parse(readFileSync(join(dataDir, "outbox.json"), "utf8")).entries
  .map((e: any) => e.item).filter((i: any) => i.sessionId === id && i.type === type).map((i: any) => i.data);

async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function setup(opts: { fetchImpl?: typeof fetch; toolsExec?: ToolExec; resumeAfterMs?: number } = {}) {
  const work = tempDir("tl-work-");
  const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  const t = await startTestRunner({ pickFolder: work, fetchImpl: opts.fetchImpl ?? offline, toolsExec: opts.toolsExec, holdTiming: { resumeAfterMs: opts.resumeAfterMs ?? 200, pollMs: 60_000 } });
  const token = await pair(t.port);
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  await call("POST", "/v1/folders/pick", {});
  const fake = (cfg: Record<string, unknown>) => writeFileSync(join(work, ".fake-claude.json"), JSON.stringify(cfg));
  fake({});
  const session = async (id: string) => (await call("GET", `/v1/sessions/${id}`)).body.session;
  const open = async (title: string, extra: Record<string, unknown> = {}) => {
    mkdirSync(join(work, title), { recursive: true });
    const r = await call("POST", "/v1/sessions", { subject: { kind: "card", cardId: title }, title, cwd: join(work, title), firstMessage: `做 ${title}`, ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  };
  const waitStatus = async (id: string, want: string) => {
    let last: any = null;
    try {
      return await until(async () => { last = await session(id); return last.status === want && last; });
    } catch {
      throw new Error(`等 ${want} 超时：现在是 ${last?.status}，hold ${JSON.stringify(last?.hold ?? null)}`);
    }
  };
  const events = (id: string) => readFileSync(join(t.dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { t, work, call, fake, session, open, waitStatus, events };
}

const CONTINUE = "额度恢复了，接着把刚才没做完的做完。";

describe("额度用完：停着等，到点自动接着做", { timeout: 40_000 }, () => {
  it("一轮碰壁：停在「等额度恢复」（不算出错）；排着的订阅卡不开始，取消的不再开始；到点往开着的进程里说一句，排着的接上", async () => {
    const h = await setup();
    try {
      const resetsAt = Math.floor(Date.now() / 1000) + 6; // 留够拉起的时间：机器忙时开一个会话要一两秒
      const until = new Date(resetsAt * 1000).toISOString();
      h.fake({ usageLimit: { resetsAt } });
      const a = await h.open("A");
      const held = await h.waitStatus(a.id, "idle");
      expect(held.hold).toEqual({ reason: "usage_limit", until });
      conforms(LocalSessionSummary, held);
      expect(h.events(a.id).find((e) => e.type === "turn_end")).toMatchObject({ isError: true, errorKind: "usage_limit" });
      expect(h.events(a.id).filter((e) => e.type === "status").at(-1)).toMatchObject({ status: "idle", hold: { reason: "usage_limit", until } });
      expect(outboxItems(h.t.dataDir, a.id, "status").at(-1)).toMatchObject({ status: "idle", hold: { reason: "usage_limit", until } });
      // 状态接口里的额度：跑着的卡报的那一刻就有，订阅窗口用完、几点恢复
      const quota = (await h.call("GET", "/v1/status")).body.quota;
      expect(quota).toEqual([expect.objectContaining({ id: "claude", kind: "subscription", remainingPercent: 0, blockedUntil: until })]);
      expect(quota[0].windows).toContainEqual({ kind: "session", model: null, usedPercent: 100, state: "blocked", resetsAt: until });

      // 用完时新开的订阅卡排着等，不开始；排着时取消的就不再开始
      const b = await h.open("B");
      expect(b).toMatchObject({ status: "queued", hold: { reason: "usage_limit", until } });
      conforms(LocalSessionSummary, b);
      const c = await h.open("C");
      expect(c.status).toBe("queued");
      expect((await h.call("POST", `/v1/sessions/${c.id}/kill`, {})).body.session.status).toBe("exited");
      expect((await h.session(c.id)).hold).toBeUndefined();

      await new Promise((r) => setTimeout(r, 300));
      expect(argvOf(h.work, b.id)).toHaveLength(0); // 用完时 B 一直没开始
      h.fake({}); // 额度恢复
      await h.waitStatus(a.id, "waiting_permission"); // 接着做的这一轮照常来要权限
      await h.waitStatus(b.id, "waiting_permission");
      expect((await h.session(a.id)).hold).toBeUndefined();
      expect((await h.session(b.id)).hold).toBeUndefined();
      expect(Date.now()).toBeGreaterThanOrEqual(resetsAt * 1000 + 200); // 过了恢复时间再等一会儿
      // A 没重开进程，是往开着的进程里说的；C 从没开始过
      expect(argvOf(h.work, a.id)).toHaveLength(1);
      expect(turns(h.work, a.id)).toEqual([`做 A`, CONTINUE]);
      conforms(LocalSessionSummary, await h.session(a.id));
      expect(argvOf(h.work, c.id)).toHaveLength(0);
      expect(h.events(a.id).some((e) => e.type === "notice" && e.code === "usage_resumed")).toBe(true);
      expect(outboxItems(h.t.dataDir, a.id, "status").at(-1).hold).toBeUndefined();
    } finally {
      await h.t.cleanup();
    }
  });

  it("排着等空位的订阅卡：跑着的卡途中报了额度用完，它也停着等，到点才开始；恢复时间过了也要再等一会儿", async () => {
    const h = await setup({ resumeAfterMs: 2_000 });
    try {
      await h.call("PATCH", "/v1/settings", { maxConcurrent: 1 });
      const a = await h.open("A");
      await h.waitStatus(a.id, "waiting_permission");
      const b = await h.open("B");
      expect(b.status).toBe("queued");
      expect(b.hold).toBeUndefined(); // 这时额度还没用完，是在等空位
      const resetsAt = Math.floor(Date.now() / 1000) + 5;
      const resetIso = new Date(resetsAt * 1000).toISOString();
      // A 批了以后这一轮里才报用完（跑着的卡报的 rate_limit_event），这一轮照常做完
      h.fake({ rateInfoOnAllow: { status: "rejected", resetsAt, rateLimitType: "five_hour", utilization: 1, unifiedWindows: { five_hour: { utilization: 1, resetsAt, status: "rejected" } } } });
      const perm = await until(async () => (await h.call("GET", `/v1/sessions/${a.id}`)).body.pendingPermissions[0]);
      await h.call("POST", `/v1/sessions/${a.id}/permissions/${encodeURIComponent(perm.requestId)}`, { decision: "allow" });
      await h.waitStatus(a.id, "idle"); // A 让出了位置
      expect((await h.session(a.id)).hold).toBeUndefined(); // A 这一轮没碰壁，不停
      expect((await h.session(b.id)).hold).toEqual({ reason: "usage_limit", until: resetIso });
      h.fake({});
      await new Promise((r) => setTimeout(r, 300));
      expect(argvOf(h.work, b.id)).toHaveLength(0); // B 没开始
      // 恢复时间过了、还没到再等的那一会儿：别的事让本机看一遍队（调上限）也不开始
      await until(() => Date.now() > resetsAt * 1000 + 300 || null);
      await h.call("PATCH", "/v1/settings", { maxConcurrent: 1 });
      await new Promise((r) => setTimeout(r, 300));
      expect(argvOf(h.work, b.id)).toHaveLength(0);
      await h.waitStatus(b.id, "waiting_permission");
      expect(Date.now()).toBeGreaterThanOrEqual(resetsAt * 1000 + 2_000);
    } finally {
      await h.t.cleanup();
    }
  });

  it("碰壁就退出的：也是停着等（不算失败），到点续接（--resume）再说一句；本人说一句、停下就不再等", async () => {
    const h = await setup();
    try {
      const resetsAt = Math.floor(Date.now() / 1000) + 5;
      h.fake({ usageLimit: { resetsAt, exit: true } });
      const a = await h.open("A");
      const held = await h.waitStatus(a.id, "exited");
      expect(held.hold).toEqual({ reason: "usage_limit", until: new Date(resetsAt * 1000).toISOString() });
      expect(h.events(a.id).filter((e) => e.type === "status").at(-1)).toMatchObject({ status: "exited", exitCode: 1, reason: "订阅额度用完了，恢复后自动接着做" });
      // 还在用完时本人停下：不再等
      const b = await h.open("B");
      expect(b.status).toBe("queued");
      expect((await h.call("POST", `/v1/sessions/${b.id}/interrupt`, {})).body.session.status).toBe("exited");
      expect((await h.session(b.id)).hold).toBeUndefined();

      h.fake({});
      await h.waitStatus(a.id, "waiting_permission");
      const runs = argvOf(h.work, a.id);
      expect(runs).toHaveLength(2);
      expect(flag(runs[1], "--resume")).toBe(a.id);
      expect(turns(h.work, a.id)).toEqual([`做 A`, CONTINUE]);
      expect(argvOf(h.work, b.id)).toHaveLength(0);

      // 10 分钟后才恢复的：本人等不及说一句，就不再等，马上照常发
      h.fake({ usageLimit: { resetsAt: Math.floor(Date.now() / 1000) + 600 } });
      const d = await h.open("D");
      expect((await h.waitStatus(d.id, "idle")).hold).toBeTruthy();
      h.fake({});
      expect((await h.call("POST", `/v1/sessions/${d.id}/messages`, { text: "换个法子接着做" })).body.delivery).toBe("new_turn");
      expect((await h.waitStatus(d.id, "waiting_permission")).hold).toBeUndefined();
    } finally {
      await h.t.cleanup();
    }
  });
});

describe("额度用完：不该停、不该乱续的情况（11/07 评审）", { timeout: 40_000 }, () => {
  const PLAN = { summary: "拆一件", steps: [{ title: "改页面" }], risks: [], cards: [{ title: "改登录页", brief: "改", doneDefinition: "能登录", modelTier: "normal" }] };

  it("只有 rate_limit 的别的 429 不算额度用完；不知道几点恢复的不马上接着做（额度读着没满也等）；本人说一句照常发", async () => {
    const h = await setup();
    try {
      h.fake({ usageLimit: { plain429: true } });
      const a = await h.open("A");
      const idle = await h.waitStatus(a.id, "idle");
      expect(idle.hold).toBeUndefined();
      expect(h.events(a.id).find((e) => e.type === "turn_end")).toMatchObject({ isError: true, errorKind: "api" });
      expect(idle.usage.costUsd).toBe(0); // 这一轮没调成模型（用量是 {}）：算 0，累计的标价不变成 null
      // 碰壁了却没给恢复时间（Claude Code 说用完、额度读着没满）：停着等，不马上「接着做 → 又碰壁」
      h.fake({ usageLimit: {} });
      expect((await h.call("POST", `/v1/sessions/${a.id}/messages`, { text: "再来" })).body.delivery).toBe("new_turn");
      await until(async () => (await h.session(a.id)).hold || null);
      expect((await h.session(a.id)).hold).toEqual({ reason: "usage_limit", until: null });
      await new Promise((r) => setTimeout(r, 2_000));
      expect(turns(h.work, a.id)).toEqual(["做 A", "再来"]); // 没有自己接着做
      expect((await h.session(a.id)).hold).toBeTruthy();
      h.fake({});
      expect((await h.call("POST", `/v1/sessions/${a.id}/messages`, { text: "接着" })).body.delivery).toBe("new_turn");
      expect((await h.waitStatus(a.id, "waiting_permission")).hold).toBeUndefined();
    } finally {
      await h.t.cleanup();
    }
  });

  it("规划员交了计划、同一轮接下来碰壁：照样收工（done），不留「等额度恢复」", async () => {
    const h = await setup();
    try {
      h.fake({ plan: PLAN, usageLimitAfterSubmit: { resetsAt: Math.floor(Date.now() / 1000) + 600 } });
      // 规划员在像样的仓库里拆（开拆前的检查不拦）；假 claude 往上找到 work 里的配置
      const r = await h.call("POST", "/v1/sessions", { subject: { kind: "plan", taskId: "T1" }, title: "拆卡：T1", cwd: gitRepo(join(h.work, "repo")), firstMessage: "拆卡交代" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const done = await h.waitStatus(r.body.id, "done");
      expect(done.hold).toBeUndefined();
      expect(h.events(r.body.id).find((e) => e.type === "turn_end")).toMatchObject({ errorKind: "usage_limit" });
      expect(outboxItems(h.t.dataDir, r.body.id, "status").at(-1)).toMatchObject({ status: "done" });
      expect(outboxItems(h.t.dataDir, r.body.id, "status").at(-1).hold).toBeUndefined();
    } finally {
      await h.t.cleanup();
    }
  });

  it("暂停全部不取消等额度：恢复以后照样到点接着做", async () => {
    const h = await setup();
    try {
      const resetsAt = Math.floor(Date.now() / 1000) + 5;
      h.fake({ usageLimit: { resetsAt } });
      const a = await h.open("A");
      await h.waitStatus(a.id, "idle");
      expect((await h.call("PATCH", "/v1/settings", { paused: true })).status).toBe(200);
      expect((await h.session(a.id)).hold).toEqual({ reason: "usage_limit", until: new Date(resetsAt * 1000).toISOString() });
      h.fake({});
      h.t.menu("resume"); // 托盘「恢复」（网页不能替本人恢复）
      await h.waitStatus(a.id, "waiting_permission");
      expect(turns(h.work, a.id)).toEqual(["做 A", CONTINUE]);
    } finally {
      await h.t.cleanup();
    }
  });
});

describe("花费、档位、状态接口", { timeout: 40_000 }, () => {
  it("订阅：标价照算、带来源和模型、没有真钱；网关：Claude Code 瞎算的不算，按价目表估真钱", async () => {
    const prices: string[] = [];
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("/api/tokavi/v1/model/prices")) {
        prices.push(String(url));
        // 两档：一次请求 500 以内便宜。这一轮 4 次请求共 1000 输入，按平均 250 选便宜的一档（按整轮 1000 就是贵的）
        return new Response(JSON.stringify({ model_name: "deepseek-v4", price_info: { strategy: "input-tiered", unit: "1M-token", currency: "CNY", tiers: [{ range: "[0, 500]", input: 2, output: 8 }, { range: "(500, inf)", input: 4, output: 16 }] } }), { status: 200 });
      }
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const h = await setup({ fetchImpl });
    try {
      h.fake({ modelUsage: { "claude-sonnet-5-5": { costUSD: 0.02, costBasis: "list", inputTokens: 3, outputTokens: 5 } } });
      const a = await h.open("A");
      // 第一轮在等权限：拒了它这一轮就做完
      const perm = await until(async () => (await h.call("GET", `/v1/sessions/${a.id}`)).body.pendingPermissions[0]);
      await h.call("POST", `/v1/sessions/${a.id}/permissions/${encodeURIComponent(perm.requestId)}`, { decision: "deny", message: "不用写" });
      const subCost = await until(() => outboxItems(h.t.dataDir, a.id, "cost")[0]);
      expect(subCost).toMatchObject({ source: "subscription", model: "claude-sonnet-5-5", money: null });
      expect(subCost.usage.costUsd).toBeCloseTo(0.02, 10);

      const put = await h.call("PUT", "/v1/models/th", { label: "TokenHub", source: "gateway", baseUrl: "https://tokenhub.example.com/api/anthropic", model: "deepseek-v4", apiKey: "test-key" });
      expect(put.status).toBe(200);
      h.fake({ modelUsage: { "deepseek-v4": { costUSD: 0.5, costBasis: "unknown", inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } });
      const g = await h.open("G", { modelProfileId: "th" });
      const gperm = await until(async () => (await h.call("GET", `/v1/sessions/${g.id}`)).body.pendingPermissions[0]);
      await h.call("POST", `/v1/sessions/${g.id}/permissions/${encodeURIComponent(gperm.requestId)}`, { decision: "deny", message: "不用写" });
      const gwCost = await until(() => outboxItems(h.t.dataDir, g.id, "cost")[0]);
      expect(gwCost).toMatchObject({ source: "gateway", model: "deepseek-v4", money: { amount: (2 * 1000 + 8 * 200) / 1e6, currency: "CNY", estimated: true } });
      expect(gwCost.usage.costUsd).toBeNull();
      expect((await h.session(g.id)).usage.costUsd).toBeNull();
      expect(prices).toEqual(["https://tokenhub.example.com/api/tokavi/v1/model/prices?model_name=deepseek-v4"]);
      // 网关不传思考强度
      expect(flag(argvOf(h.work, g.id)[0], "--effort")).toBeNull();
    } finally {
      await h.t.cleanup();
    }
  });

  it("订阅按档位传模型和思考强度：强 Opus high、标准 Opus medium、轻 Sonnet low；没说档位按标准", async () => {
    const h = await setup();
    try {
      await h.call("PATCH", "/v1/settings", { maxConcurrent: 4 });
      const ids: Record<string, string> = {};
      for (const [name, tier] of [["S", "strong"], ["N", "normal"], ["L", "light"], ["X", undefined]] as const) {
        ids[name] = (await h.open(name, tier ? { modelTier: tier } : {})).id;
      }
      const got = Object.fromEntries(Object.entries(ids).map(([name, id]) => {
        const argv = argvOf(h.work, id)[0];
        return [name, [flag(argv, "--model"), flag(argv, "--effort")]];
      }));
      expect(got).toEqual({ S: ["opus", "high"], N: ["opus", "medium"], L: ["sonnet", "low"], X: ["opus", "medium"] });
    } finally {
      await h.t.cleanup();
    }
  });

  it("状态接口带额度和命令行工具登没登录", async () => {
    const exec: ToolExec = async (cmd, args) => {
      if (cmd === "gh") return args[0] === "--version" ? { code: 0, stdout: "gh version 2.88.1", stderr: "" } : { code: 0, stdout: JSON.stringify({ hosts: { "github.com": [{ state: "success", active: true, login: "sean" }] } }), stderr: "" };
      return null;
    };
    const h = await setup({ toolsExec: exec });
    try {
      const tools = await until(async () => {
        const list = (await h.call("GET", "/v1/status")).body.tools;
        return list.find((x: any) => x.kind === "gh").state !== "unknown" && list;
      });
      // 这台电脑逐项：Claude Code（照它自己报的）、Codex、gh、飞书命令行
      expect(tools.map((x: any) => x.kind)).toEqual(["claude-code", "codex", "gh", "lark-cli"]);
      expect(tools.slice(1).map((x: any) => [x.kind, x.state, x.account])).toEqual([["codex", "not_installed", null], ["gh", "ready", "sean"], ["lark-cli", "not_installed", null]]);
      const status = (await h.call("GET", "/v1/status")).body;
      expect(Array.isArray(status.quota)).toBe(true);
      conforms(LocalStatusResponse, status);
    } finally {
      await h.t.cleanup();
    }
  });
});
