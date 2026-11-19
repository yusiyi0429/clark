import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { TLocalAgentStatus, TLocalStatusResponse } from "@warmap/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work/settings/connections" }));

import { LocalContext } from "@/lib/local/LocalRunnerProvider";
import { createMockRunner } from "@/lib/local/mock";
import type { LocalPhase } from "@/lib/local/connection";
import { KINGDEE_PLACEHOLDER, agentRow, feishuRow, localToolRow, mcpRow, programRow, tokenHubRow, toolRow } from "./connectionRows";
import { ConnectionsPage } from "./ConnectionsPage";
import { MonthNav, MonthView } from "./MonthPage";
import type { MonthExtras } from "./monthLive";
import { PreferencesPage } from "./PreferencesPage";
import { MONTH_PAGE, SECONDARY_PAGES } from "./index";
import { dutyLine } from "./RolesPage";
import { PAGE_TITLE } from "../pageKeys";
import { httpMonthSource, monthFixture, nextPeriod, type MonthActions, type MonthPageData, type MonthTask } from "./useMonthPage";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const NOW = Date.parse("2026-11-07T04:00:00.000Z");
const fresh = () => new Date().toISOString();

const agent = (patch: Partial<TLocalAgentStatus> = {}): TLocalAgentStatus => ({
  kind: "claude-code", installed: true, version: "2.1.318", path: null, loggedIn: true, authMethod: null, subscriptionType: "max", loginExpiresAt: null,
  minimumVersion: null, compatible: true, setup: { phase: "idle", startedAt: null, loginUrl: null, error: null }, ...patch,
});
const status = (patch: Partial<TLocalStatusResponse> = {}): TLocalStatusResponse => ({
  deviceId: "00000000-0000-4000-8000-0000000000d1", version: "0.9.2", agents: [agent()], activeSessions: 0, slots: { max: 3, running: 0, queued: 0 },
  cloud: { personId: "p-sunm", linked: true, apiBaseUrl: null, personName: "孙铭泽", outbox: { pending: 0, lastSyncedAt: null, lastError: null } },
  settings: { includePersonalConfigByDefault: false, allowedOrigins: [], paused: false, maxConcurrent: 3, autoMerge: true },
  quota: [{ id: "claude", name: "Claude", kind: "subscription", remainingPercent: null, amounts: [], resetsAt: null, plan: "max", extraUsage: false, updatedAt: fresh(), error: null, blockedUntil: null,
    windows: [{ kind: "weekly_all", model: null, usedPercent: 83, state: "warning", resetsAt: new Date(Date.now() + 3_600_000).toISOString() }, { kind: "weekly_scoped", model: "Fable", usedPercent: 40, state: "ok", resetsAt: null }] }],
  tools: [
    { kind: "gh", state: "ready", version: "2.80.0", account: "sunm", checkedAt: fresh() },
    { kind: "lark-cli", state: "not_logged_in", version: "1.2.0", account: null, checkedAt: fresh() },
  ],
  ...patch,
});
const install = "irm http://x/install.ps1 | iex";

describe("连接页每一行（设计 9.5、5.4.6）", () => {
  it("本机程序：七种状态落到四个状态词加小字和一个动作；离线带安装命令，未配对给配对，等确认时写确认码，暂停给继续，没关联云端给连接", () => {
    const base = { status: null, version: null, pairing: null, error: null, linking: false, install };
    expect(programRow({ ...base, phase: "checking" })).toMatchObject({ sub: "检查中", state: null, action: null });
    expect(programRow({ ...base, phase: "prompt" })).toMatchObject({ sub: "等浏览器允许", state: "disconnected", action: "retry" });
    expect(programRow({ ...base, phase: "blocked" }).sub).toContain("被拦截");
    expect(programRow({ ...base, phase: "offline" })).toMatchObject({ sub: "离线", action: "retry", command: install });
    // Mac：这一版没有 Mac 版，不给安装命令和重试。
    expect(programRow({ ...base, install: null, phase: "offline" })).toEqual({ key: "program", name: "本机程序", sub: "暂不支持 Mac", state: "disconnected", action: null });
    expect(programRow({ ...base, phase: "unpaired" })).toMatchObject({ sub: "未配对", action: "pair" });
    expect(programRow({ ...base, phase: "unpaired", pairing: { code: "4821", state: "waiting" } })).toMatchObject({ sub: "确认码 4821", action: null });
    expect(programRow({ ...base, phase: "unpaired", pairing: { code: "4821", state: "denied" } }).sub).toBe("本机拒绝了");
    expect(programRow({ ...base, phase: "ready", status: status({ settings: { ...status().settings, paused: true } }) })).toMatchObject({ sub: "暂停中 · v0.9.2", state: "connected", action: "resume" });
    const unlinked = status({ cloud: { ...status().cloud, linked: false } });
    expect(programRow({ ...base, phase: "ready", status: unlinked })).toMatchObject({ sub: "v0.9.2 · 云端未关联", action: "link" });
    expect(programRow({ ...base, phase: "ready", status: unlinked, linking: true })).toMatchObject({ sub: "v0.9.2 · 正在关联云端", action: "unpair" });
    expect(programRow({ ...base, phase: "ready", status: status() })).toMatchObject({ sub: "v0.9.2", state: "connected", action: "unpair" });
  });

  it("Claude Code、Codex：没装、没登录是未连接（没登录给连接），登录过期是已过期（重新授权），额度用完是用完", () => {
    expect(agentRow(agent({ installed: false }), NOW)).toMatchObject({ name: "Claude Code", sub: "没装", state: "disconnected", action: null });
    expect(agentRow(agent({ loggedIn: false }), NOW)).toMatchObject({ state: "disconnected", action: "login" });
    expect(agentRow(agent({ loginExpiresAt: "2026-11-01T00:00:00.000Z" }), NOW)).toMatchObject({ state: "expired", action: "reauth" });
    expect(agentRow(agent(), NOW, true).state).toBe("exhausted");
    expect(agentRow(agent(), NOW)).toMatchObject({ sub: "2.1.318 · Max", state: "connected", action: null });
    expect(agentRow(agent({ kind: "codex", subscriptionType: null }), NOW).name).toBe("Codex");
  });

  it("Codex 的 prolite 显示成 Pro 100", () => {
    const codex = (subscriptionType: string) => agentRow(agent({ kind: "codex", version: "0.170.0", subscriptionType }), NOW).sub;
    expect(codex("prolite")).toBe("0.170.0 · Pro 100");
    expect(codex("pro")).toBe("0.170.0 · Pro 200");
    expect(codex("promax")).toBe("0.170.0 · Pro 500");
    expect(codex("plus")).toBe("0.170.0 · Plus");
    // 认不出的照原样。
    expect(codex("enterprise")).toBe("0.170.0 · enterprise");
  });

  it("Claude 的 planTier 认不出时按 subscriptionType 显示", () => {
    const claude = (patch: Partial<TLocalAgentStatus>) => agentRow(agent(patch), NOW).sub;
    expect(claude({ subscriptionType: "max", planTier: "max_40x" })).toBe("2.1.318 · Max");
    expect(claude({ subscriptionType: "pro", planTier: "default_claude_ai" })).toBe("2.1.318 · Pro");
    // 两个都认不出：照原样，planTier 优先。
    expect(claude({ subscriptionType: "team", planTier: "team_tier" })).toBe("2.1.318 · team_tier");
    expect(claude({ subscriptionType: "team" })).toBe("2.1.318 · team");
  });

  it("Claude 有 planTier 时显示 Max 20x", () => {
    const claude = (patch: Partial<TLocalAgentStatus>) => agentRow(agent(patch), NOW).sub;
    expect(claude({ subscriptionType: "max", planTier: "max_20x" })).toBe("2.1.318 · Max 20x");
    expect(claude({ subscriptionType: "max", planTier: "max_5x" })).toBe("2.1.318 · Max 5x");
    // 没有 planTier 时按 subscriptionType；认不出的照原样。
    expect(claude({ subscriptionType: "max" })).toBe("2.1.318 · Max");
    expect(claude({ subscriptionType: "pro" })).toBe("2.1.318 · Pro");
    // 连接页「这台电脑」那一行也是这个名字。
    const html = withLocal(<ConnectionsPage go={() => undefined} />, "ready", status({ agents: [agent({ planTier: "max_20x" })] }));
    expect(text(html.split('data-testid="row-agent:claude-code"')[1]!.split("</li>")[0]!)).toContain("Claude Code 2.1.318 · Max 20x 已连接");
  });

  it("GitHub、飞书命令行写登的是谁；没登录时小字是登录命令", () => {
    expect(toolRow({ kind: "gh", state: "ready", version: null, account: "sunm", checkedAt: null })).toMatchObject({ name: "GitHub", sub: "gh · sunm", state: "connected" });
    expect(toolRow({ kind: "lark-cli", state: "not_logged_in", version: null, account: null, checkedAt: null })).toMatchObject({ name: "飞书命令行", state: "disconnected", command: "lark-cli auth login" });
    expect(toolRow({ kind: "gh", state: "expired", version: null, account: null, checkedAt: null }).state).toBe("expired");
    expect(toolRow({ kind: "gh", state: "unknown", version: null, account: null, checkedAt: null })).toMatchObject({ sub: "检查中", state: null });
  });

  it("TokenHub（17.2 第 51 条）：没有连接时建的模型（th- 开头）是未连接、给「连接」；有就是已连接、小字写模型名、给「断开」；本人自己配的网关不算", () => {
    const gateway = (id: string, name: string) => ({ id, label: name, modelName: name, source: "gateway" as const, agent: "claude-code" as const, baseUrl: null, model: null, smallModel: null, webSearch: true, isDefault: false, hasKey: true });
    expect(tokenHubRow([])).toEqual({ key: "tokenhub", name: "TokenHub", sub: null, state: "disconnected", action: "link" });
    expect(tokenHubRow([gateway("my-gw", "DeepSeek")])).toMatchObject({ sub: null, state: "disconnected", action: "link" });
    expect(tokenHubRow([gateway("my-gw", "DeepSeek"), gateway("th-a", "Opus 5.5"), gateway("th-b", "deepseek-v4.1-flash")]))
      .toMatchObject({ sub: "Opus 5.5 · deepseek-v4.1-flash", state: "connected", action: "unpair" });
    expect(tokenHubRow(["A", "B", "C", "D", "E"].map((n) => gateway(`th-${n}`, n))).sub).toBe("A · B · C 等 5 个");
  });

  it("本人加的工具：连上写有几个工具，未授权、连不上写原因，还没查写地址；金蝶没加过时占一行未连接、不给动作", () => {
    const tool = { id: "kb", name: "知识库", preset: "custom" as const, url: "https://mcp.example.com/kb", keyHeader: null, hasKey: true, toolCount: null, error: null, checkedAt: null, addedAt: fresh() };
    expect(localToolRow({ ...tool, state: "ready", toolCount: 6 })).toMatchObject({ name: "知识库", sub: "6 个工具", state: "connected", action: null });
    expect(localToolRow({ ...tool, state: "unauthorized", error: "钥匙不对（401）" })).toMatchObject({ sub: "钥匙不对（401）", state: "unauthorized" });
    expect(localToolRow({ ...tool, state: "unreachable", error: "连不上这个地址" }).state).toBe("unreachable");
    expect(localToolRow({ ...tool, state: "unknown" })).toMatchObject({ sub: "https://mcp.example.com/kb", state: "unknown" });
    expect(KINGDEE_PLACEHOLDER).toMatchObject({ name: "金蝶", state: "disconnected", action: null });
  });

  it("我的账号：没配公司飞书应用时飞书照样有，写「未开通」、不给动作（还没读到不画）；连上给断开，过期给重新授权，没连给连接；让外部 AI 读天枢用过的算连上，只剩过期的是已过期", () => {
    expect(feishuRow(null)).toBeNull();
    expect(feishuRow({ enabled: false, state: "not_connected" })).toMatchObject({ name: "飞书", state: "not_enabled", action: null });
    expect(feishuRow({ enabled: true, state: "connected" })).toMatchObject({ state: "connected", action: "unpair" });
    expect(feishuRow({ enabled: true, state: "expired" })).toMatchObject({ state: "expired", action: "reauth" });
    expect(feishuRow({ enabled: true, state: "not_connected" })).toMatchObject({ state: "disconnected", action: "link" });
    expect(mcpRow([{ name: "Claude", expiresAt: null, lastUsedAt: "2026-11-06T00:00:00.000Z" }, { name: "Codex", expiresAt: null, lastUsedAt: null }], NOW)).toMatchObject({ state: "connected", sub: "Claude" });
    expect(mcpRow([{ name: "Claude", expiresAt: "2026-11-01T00:00:00.000Z", lastUsedAt: "2026-10-30T00:00:00.000Z" }], NOW).state).toBe("expired");
    expect(mcpRow([], NOW)).toMatchObject({ state: "disconnected", sub: null });
  });
});

const local = (phase: LocalPhase, value: TLocalStatusResponse | null) => ({
  runner: createMockRunner(), phase, version: "0.9.2", status: value, models: [], folders: [{ id: "f1", label: "Tianshu-MVP", path: "C:/code/Tianshu-MVP" }], sessions: [],
  pairing: null, error: null, refresh: vi.fn(), pair: vi.fn(), unpair: vi.fn(), pickFolder: vi.fn(), setIncludePersonal: vi.fn(),
}) as unknown as Parameters<typeof LocalContext.Provider>[0]["value"];
const withLocal = (node: ReactNode, phase: LocalPhase, value: TLocalStatusResponse | null) =>
  renderToStaticMarkup(<LocalContext.Provider value={local(phase, value)}>{node}</LocalContext.Provider>);

describe("连接（卡片网格 + 三组）", () => {
  it("这台电脑就绪：上面是连接的卡（本体、GitHub、飞书命令行）；下面这台电脑（本机程序、Claude Code 带额度、文件夹、同时跑、两个开关）、我的账号、公司", () => {
    const html = withLocal(<ConnectionsPage go={() => undefined} />, "ready", status());
    expect(text(html)).toMatch(/本体.*GitHub.*飞书命令行.*这台电脑.*我的账号.*公司/);
    const claude = html.split('data-testid="row-agent:claude-code"')[1]!.split("data-testid=\"row-")[0]!;
    expect(text(claude)).toContain("Claude Code 2.1.318 · Max 已连接");
    // 额度和右栏「用量」同一套数（usageCells）。
    expect(text(claude)).toContain("Claude 17%");
    expect(text(claude)).toContain("本周：剩 17%");
    expect(text(claude)).toContain("本周 · Fable：剩 60%");
    expect(text(claude)).toContain("额外额度：未开");
    expect(claude).toContain('data-tone="warning"');
    // 卡：图标、名字、一行状态、来源；连上的右上角 ✓。本机程序排第一，配好了右上 ✓、点卡是菜单；「这台电脑」组里不再有那一行。
    const card = (id: string) => html.split(`data-testid="card-${id}"`)[1]!.split("</li>")[0]!;
    expect(html.indexOf('data-testid="card-program"')).toBeLessThan(html.indexOf('data-testid="card-world"'));
    expect(text(card("program"))).toContain("本机程序 已连接 · v0.9.2 这台电脑");
    expect(card("program")).toContain('aria-label="已连接"');
    expect(html).not.toContain('data-testid="row-program"');
    expect(text(card("tool:gh"))).toContain("GitHub 已连接 · gh · sunm 本机");
    expect(card("tool:gh")).toContain('aria-label="已连接"');
    expect(text(card("tool:lark-cli"))).toContain("飞书命令行 未连接 · lark-cli auth login 本机");
    expect(card("tool:lark-cli")).not.toContain('aria-label="已连接"');
    expect(html).not.toContain('data-testid="row-tool:gh"');
    // 文件夹默认收起：只有「文件夹 1 个」和「添加」（展开见 connectionFolders.behavior.test.tsx）。
    expect(text(html)).not.toContain("C:/code/Tianshu-MVP");
    expect(html).toContain('aria-label="同时跑 3 个"');
    const row = (id: string) => html.split(`data-testid="row-${id}"`)[1]!.split("</li>")[0]!;
    // 开关是左右拨动的那种（整行一个 role="switch" 按钮），不是勾选框。
    expect(row("auto-merge")).toMatch(/<button type="button" role="switch" aria-checked="true"/);
    expect(row("personal-config")).toMatch(/<button type="button" role="switch" aria-checked="false"/);
    expect(text(row("folders"))).toMatch(/^> 文件夹 1 个 添加$/);
    expect(text(row("auto-merge"))).toMatch(/^> 验收后自动合并$/);
    expect(html).not.toContain('type="checkbox"');
    // 状态词只有那四个；不写「插件」。
    expect(text(html)).not.toContain("插件");
  });

  it("Claude 只有旧数时画旧数和暂时读不到；一个数都没有时写 Claude 暂时读不到", () => {
    const base = status().quota[0]!;
    const claudeRow = (quota: TLocalStatusResponse["quota"]) => {
      const html = withLocal(<ConnectionsPage go={() => undefined} />, "ready", status({ quota }));
      return html.split('data-testid="row-agent:claude-code"')[1]!.split("data-testid=\"row-")[0]!;
    };
    // 旧数照画（剩多少、额度条、本周剩余和重置时间），旁边淡色短语「暂时读不到」，不写原因
    const stale = claudeRow([{ ...base, updatedAt: new Date(Date.now() - 50 * 60_000).toISOString(), error: "暂时读不到（get_usage 没给额度）" }]);
    expect(text(stale)).toContain("Claude 17% 暂时读不到");
    expect(text(stale)).toContain("本周：剩 17%");
    expect(stale).not.toContain("get_usage");
    // 一个数都没有：只写「Claude 暂时读不到」，没有额度条和明细
    const empty = claudeRow([{ ...base, windows: [], updatedAt: null, extraUsage: null, error: "暂时读不到（get_usage 没给额度）" }]);
    const block = empty.split('data-testid="quota-block"')[1]!;
    expect(text(block.split("</div>")[0]!)).toBe('> Claude 暂时读不到');
    expect(text(empty)).not.toContain("额外额度");
  });

  it("同时跑不设上限：能选到 10 以上；超过 10 个时这一行下面提醒一句，10 个以内不提醒", () => {
    const row = (max: number) => {
      const html = withLocal(<ConnectionsPage go={() => undefined} />, "ready", status({ settings: { ...status().settings, maxConcurrent: max } }));
      return html.split('data-testid="row-concurrency"')[1]!.split("</li>")[0]!;
    };
    expect(row(15)).toContain('aria-label="同时跑 15 个"');
    expect(text(row(15))).toContain("超过 10 个，电脑和额度可能吃紧");
    expect(text(row(10))).not.toContain("超过 10 个");
  });

  it("可添加：金蝶（还没定，写未连接、不给动作）和「其他工具」（+）；本机没就绪时 + 不能点", () => {
    const html = withLocal(<ConnectionsPage go={() => undefined} view="add" />, "offline", null);
    const card = (id: string) => html.split(`data-testid="${id}"`)[1]!.split("</li>")[0]!;
    expect(text(card("local-tool:kingdee"))).toContain("金蝶 未连接 预设 · 本机");
    expect(card("local-tool:kingdee")).not.toContain("<button");
    expect(text(card("card-add-tool"))).toContain("其他工具 本机");
    expect(card("card-add-tool")).toMatch(/aria-label="添加工具"[^>]*disabled=""|disabled=""[^>]*aria-label="添加工具"/);
    expect(html).not.toContain("这台电脑");
  });

  it("本机没配对：本机卡写「未配对」，右上给「配对」", () => {
    const html = withLocal(<ConnectionsPage go={() => undefined} />, "unpaired", null);
    const card = html.split('data-testid="card-program"')[1]!.split("</li>")[0]!;
    expect(text(card)).toContain("本机程序 未连接 · 未配对 这台电脑 配对");
  });

  it("这台电脑离线：本机程序写「离线」，下面是安装命令和复制；不列 Claude Code 等本机才知道的行", () => {
    const html = withLocal(<ConnectionsPage go={() => undefined} />, "offline", null);
    // 本机程序是网格里第一张卡（11/09），「这台电脑」组里不再有那一行。
    expect(text(html)).toContain("本机程序 未连接 · 离线 这台电脑 重试");
    expect(html.indexOf('data-testid="card-program"')).toBeLessThan(html.indexOf('data-testid="card-world"'));
    expect(html).not.toContain('data-testid="row-program"');
    expect(html).toMatch(/<code>irm [^<]*install/);
    expect(html).not.toContain('data-testid="row-agent:claude-code"');
    expect(html).not.toContain('data-testid="row-folders"');
  });
});

describe("月份页（设计 10.4、10.5；11/19 DRI 根据地）", () => {
  const go = vi.fn();
  const render = (data: MonthPageData, extras?: (task: { taskId: string; missionId: string }) => MonthExtras, today: string | null = "2026-11-19", actions?: MonthActions) =>
    renderToStaticMarkup(<MonthView data={data} go={go} extras={extras} today={today} actions={actions} />);
  const MISSION = "天枢 11 月：V1 11/18 上线，V2 11/30 上线";
  const task = (patch: Partial<MonthTask> = {}): MonthTask => ({ taskId: "t1", missionId: "m1", missionTitle: MISSION, missionOutcome: "内部 20 人每天用天枢派活", name: "甲",
    criteria: [{ text: "标准一", met: false, changed: false, original: null }], edited: null, dueDate: "2026-11-30", missionDueDate: "2026-11-30", disposition: "current", deferredTo: null, version: null, running: 0, blocked: 0, done: false,
    settlement: null, continuedFrom: null, ...patch });
  const month = (tasks: MonthTask[]): MonthPageData => ({ period: "2026-11", tasks, draft: null });
  /** 按 data-testid 切开：attrs 是这个元素 data-testid 后面那几个属性，body 是它的内容（到下一个同名元素为止）。 */
  const parts = (html: string, id: string) => html.split(`data-testid="${id}"`).slice(1)
    .map((part) => ({ attrs: part.slice(0, part.indexOf(">")), body: part.slice(part.indexOf(">") + 1) }));
  const rows = (html: string) => parts(html, "month-task").map(({ attrs, body }) => `${attrs}>${body}`);
  const rowText = (row: string) => text(row.slice(row.indexOf(">") + 1));
  const segments = (html: string) => parts(html, "month-segment").map(({ attrs, body }) => ({ attrs, label: text(body.slice(0, body.indexOf("</p>"))) }));

  it("本月页不再有汇总行、约定 0/3、未开始和底部两个按钮", () => {
    const extras = (): MonthExtras => ({ waiting: 0, project: null, attach: null });
    const html = render(monthFixture("2026-11"), extras);
    for (const gone of ["11 月的 Task", "件 Task ·", "下次验收", "约定", "未交付", "未开始", "都做完了", "和伙伴过一遍", "去 M2 签复盘"]) expect(text(html)).not.toContain(gone);
    expect(html).not.toContain('data-testid="month-foot"');
    expect(html).not.toContain('data-testid="month-summary"');
    // Mission 行：名字加重、右边「完成数/总数」；成果一句常显（和标题一样时不写）。
    const missions = parts(html, "month-mission").map(({ body }) => text(body));
    expect(missions[0]).toContain("首页与派活 1/2");
    expect(missions[0]).toContain("首页和派活每天有人用");
    expect(text(render(month([task({ missionOutcome: MISSION })])))).toBe(`${MISSION} 0/1 11/30 验收 · 剩 11 天 甲`);
  });

  it("Mission 行右边有延期、取消时写「· 延期 N · 取消 N」", () => {
    const html = render(month([task(), task({ taskId: "t2", done: true }), task({ taskId: "t3", disposition: "deferred", deferredTo: "2026-12" }), task({ taskId: "t4", disposition: "cancelled" })]));
    expect(text(parts(html, "month-mission")[0]!.body)).toContain(`${MISSION} 1/4 · 延期 1 · 取消 1`);
  });

  it("过了验收时间点、段里有没交的，段头写已过 N 天并标橙", () => {
    const html = render(month([
      task({ taskId: "a", name: "甲", dueDate: "2026-11-18" }),
      task({ taskId: "b", name: "乙", dueDate: "2026-11-16", done: true }),
      task({ taskId: "c", name: "丙", dueDate: "2026-11-19" }),
      task({ taskId: "d", name: "丁", dueDate: "2026-11-30" }),
      task({ taskId: "e", name: "戊", dueDate: null }),
    ]));
    expect(segments(html).map((segment) => segment.label)).toEqual(["11/16 验收 · 已过 3 天", "11/18 验收 · 已过 1 天", "11/19 验收 · 今天", "11/30 验收 · 剩 11 天"]);
    const overdue = segments(html).map((segment) => segment.attrs.includes("data-overdue"));
    expect(overdue).toEqual([false, true, false, false]);
  });

  it("行尾只写有的：1/3 加等你、受阻、进行中、交付第几版里的第一个", () => {
    const three = (met: number) => [0, 1, 2].map((i) => ({ text: `标准${i + 1}`, met: i < met, changed: false, original: null }));
    const html = render(month([
      task({ taskId: "a", name: "甲", criteria: three(1), blocked: 1, running: 1, version: 2 }),
      task({ taskId: "b", name: "乙", criteria: three(0), blocked: 1, running: 1, version: 2 }),
      task({ taskId: "c", name: "丙", criteria: three(2), running: 1, version: 2 }),
      task({ taskId: "d", name: "丁", criteria: three(0), version: 2 }),
      task({ taskId: "e", name: "戊", criteria: three(0) }),
    ]), (key) => ({ waiting: key.taskId === "a" ? 2 : 0, project: null, attach: null }));
    const trail = (name: string) => {
      const row = rows(html).find((part) => rowText(part).startsWith(name))!;
      const match = /data-testid="task-status"[^>]*>(.*?)<\/span>/.exec(row);
      return match ? text(match[1]!) : null;
    };
    expect(trail("甲")).toBe("1/3 · 等你 2");
    expect(trail("乙")).toBe("受阻 1");
    expect(trail("丙")).toBe("2/3 · 进行中 1");
    expect(trail("丁")).toBe("交付第 2 版");
    expect(trail("戊")).toBeNull();
  });

  it("改过验收时间点的行上淡色写「原 11/18」，改回和原值一样的不写", () => {
    const html = render(month([task({ taskId: "a", name: "甲", dueDate: "2026-11-25", missionDueDate: "2026-11-18" }),
      task({ taskId: "b", name: "乙", dueDate: "2026-11-18", missionDueDate: "2026-11-18" })]));
    expect(rowText(rows(html).find((row) => rowText(row).startsWith("甲"))!)).toContain("甲 原 11/18");
    expect(rowText(rows(html).find((row) => rowText(row).startsWith("乙"))!)).not.toContain("原");
  });

  it("月中能定去向，定了延期的挪到延期和取消", () => {
    const html = render(month([task({ taskId: "a", name: "甲" }), task({ taskId: "b", name: "乙", disposition: "deferred", deferredTo: "2026-12" }),
      task({ taskId: "c", name: "丙", disposition: "cancelled" })]), undefined, "2026-11-19", { setDueDate: vi.fn(), setDisposition: vi.fn(), setGoal: vi.fn() });
    // 上面的分段里只剩本期验收的甲。
    expect(rows(html).map((row) => rowText(row).split(" ")[0])).toEqual(["甲"]);
    const aside = parts(html, "month-set-aside")[0]!.body;
    expect(text(aside.slice(0, aside.indexOf("</section>")))).toBe("延期和取消 乙 延期到 12 月 丙 已取消");
    expect(aside).toContain('aria-label="乙的去向"');
    // Mission 行照样数上它们。
    expect(text(parts(html, "month-mission")[0]!.body)).toContain("0/3 · 延期 1 · 取消 1");
  });

  it("完成的行首一个勾、整行变淡；延续来的写「延续自 10 月的 X」，延续出去的下面一行「已延续到 12 月的 X」", () => {
    const data = monthFixture("2026-11");
    data.tasks[0] = { ...data.tasks[0]!, continuedFrom: { taskId: "old", name: "首页改版一期", missionId: "m0", period: "2026-10" } };
    data.tasks[2] = { ...data.tasks[2]!, disposition: "current", deferredTo: null };
    const html = render(data);
    const byName = (name: string) => rows(html).find((part) => rowText(part).startsWith(name))!;
    expect(rowText(byName("新首页改版"))).toContain("延续自 10 月的首页改版一期");
    expect(byName("会后写回本体")).toContain('aria-label="已完成"');
    expect(byName("会后写回本体").slice(0, byName("会后写回本体").indexOf(">"))).toContain("data-done");
    expect(rowText(byName("月度复盘入口"))).toContain("已延续到 12 月的复盘入口收尾");
  });

  it("下半是 12 月的草稿，延续来的写「延续自 11 月的 X · X 现在的状态」；没有主按钮", () => {
    const html = render(monthFixture("2026-11"));
    expect(text(html)).toContain("12 月的草稿");
    const drafts = html.split('data-testid="draft-row"').slice(1).map(text);
    expect(drafts[0]).toContain("新首页收尾 延续自 11 月的新首页改版 · 交付第 2 版");
    expect(drafts[1]).toContain("CEO 的新首页");
    expect(drafts[1]).not.toContain("延续自");
    expect(html).not.toContain("button--primary");
  });

  it("翻月：不在当月时多一个「回到本月」；往前最早到 10 月", () => {
    const nav = (period: string) => renderToStaticMarkup(<MonthNav period={period} today="2026-11-16" go={go} />);
    expect(text(nav("2026-10"))).toContain("回到本月");
    expect(text(nav("2026-11"))).not.toContain("回到本月");
    expect(nav("2026-10")).toMatch(/aria-label="上个月"[^>]*disabled|disabled[^>]*aria-label="上个月"/);
    expect(nav("2026-12")).toMatch(/aria-label="下个月"[^>]*disabled|disabled[^>]*aria-label="下个月"/);
  });

  it("这个月还没有 Mission：一行「12 月还没有 Mission」，别的都不画", () => {
    const html = render({ period: "2026-12", tasks: [], draft: null });
    expect(text(html)).toBe("12 月还没有 Mission");
    expect(nextPeriod("2026-12")).toBe("2027-01");
  });

  it("数据来源：B2 的接口在就用它；404 时开发里退回假数据，生产里报错不冒充", async () => {
    const served: MonthPageData = { period: "2026-11", tasks: [], draft: null };
    const ok = httpMonthSource(async () => new Response(JSON.stringify(served), { status: 200 }));
    expect(await ok.load("2026-11")).toEqual(served);
    const missing = async () => new Response("{}", { status: 404 });
    expect((await httpMonthSource(missing, true).load("2026-11")).tasks).toHaveLength(3);
    await expect(httpMonthSource(missing, false).load("2026-11")).rejects.toThrow("月份接口还没有");
    await expect(httpMonthSource(async () => new Response("{}", { status: 500 }), true).load("2026-11")).rejects.toThrow("500");
  });
});

describe("偏好页（外观、通知、缺省预算、伙伴、回收站）", () => {
  it("读到之前只有外观三段和几块标题；不加说明文字", () => {
    expect(text(renderToStaticMarkup(<PreferencesPage go={() => undefined} />))).toBe("外观 跟随系统 浅色 深色 通知 新 Task 缺省预算 伙伴");
  });
});

describe("挂载表", () => {
  it("六个二级页和月份页都交了", () => {
    expect(Object.keys(SECONDARY_PAGES).sort()).toEqual(["buddy", "connections", "memory", "preferences", "profile", "roles"]);
    // 连接和技能：两个老页键开同一页，分别落在「连接」「技能」标签。
    expect(PAGE_TITLE.connections).toBe("连接和技能");
    expect(PAGE_TITLE.roles).toBe("连接和技能");
    const tabOf = (page: "connections" | "roles") => {
      const Page = SECONDARY_PAGES[page];
      const html = withLocal(<Page go={() => undefined} />, "offline", null);
      return text(html.split('data-testid="customize-bar"')[1]!.split("</div>")[0]!.match(/aria-checked="true"[^>]*>([^<]+)</)?.[1] ?? "");
    };
    expect(tabOf("connections")).toContain("连接");
    expect(tabOf("roles")).toContain("技能");
    expect(MONTH_PAGE).not.toBeNull();
  });
});

describe("技能卡上那一行", () => {
  it("取职责的第一句，去掉 Markdown 记号", () => {
    expect(dutyLine("## 职责\n- 按交代改代码、补测试。交回前跑全量测试")).toBe("按交代改代码、补测试。");
    expect(dutyLine("- **按交代**改代码、补测试。交回前跑全量测试")).toBe("按交代改代码、补测试。");
    expect(dutyLine("Review the diff. Then report")).toBe("Review the diff.");
    expect(dutyLine("")).toBe("");
  });
});

describe("连接页的来源（17.2 第 52 条）", () => {
  it("本机有来源接口：这台电脑下面一行「来源」带「添加」，列加过的（TokenHub 那一行单独管，不重复），每个能换 Key、删除；老本机程序（sources 为 null）不画这一行", () => {
    const kimi = { id: "kimi-coding_plan-cn", presetId: "kimi", name: "Kimi 编程套餐", plan: "coding_plan" as const, region: "cn" as const, baseUrl: "https://kimi.example/anthropic",
      formats: ["anthropic" as const], agents: ["claude-code" as const], models: [{ id: "kimi-k2.5", name: "kimi-k2.5" }], verified: false, addedAt: "2026-11-11T00:00:00.000Z" };
    const tokenhub = { ...kimi, id: "tokenhub", presetId: "tokenhub", name: "TokenHub", plan: "api" as const, region: null };
    const value = { ...local("ready", status()), sources: { presets: [], sources: [tokenhub, kimi] } } as Parameters<typeof LocalContext.Provider>[0]["value"];
    const html = renderToStaticMarkup(<LocalContext.Provider value={value}><ConnectionsPage go={() => undefined} /></LocalContext.Provider>);
    const row = html.split('data-testid="row-sources"')[1]!.split('data-testid="row-folders"')[0]!;
    expect(text(row)).toMatch(/来源 1 个 添加 Kimi 编程套餐 kimi-k2\.5 换 Key/);
    expect(row).toContain('aria-label="删除 Kimi 编程套餐"');
    expect(row.split('data-testid="source-row"')).toHaveLength(2);
    expect(withLocal(<ConnectionsPage go={() => undefined} />, "ready", status())).not.toContain('data-testid="row-sources"');
  });
});
