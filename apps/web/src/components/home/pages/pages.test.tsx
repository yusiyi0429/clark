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
import { MonthView } from "./MonthPage";
import { PreferencesPage } from "./PreferencesPage";
import { MONTH_PAGE, SECONDARY_PAGES } from "./index";
import { httpMonthSource, monthFixture, monthSummary, nextPeriod, type MonthPageData } from "./useMonthPage";

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
    windows: [{ kind: "weekly_all", model: null, usedPercent: 83, state: "warning", resetsAt: fresh() }, { kind: "weekly_scoped", model: "Fable", usedPercent: 40, state: "ok", resetsAt: null }] }],
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
    expect(agentRow(agent(), NOW)).toMatchObject({ sub: "2.1.318 · max", state: "connected", action: null });
    expect(agentRow(agent({ kind: "codex", subscriptionType: null }), NOW).name).toBe("Codex");
  });

  it("GitHub、飞书命令行写登的是谁；没登录时小字是登录命令；TokenHub 看本机有没有网关模型", () => {
    expect(toolRow({ kind: "gh", state: "ready", version: null, account: "sunm", checkedAt: null })).toMatchObject({ name: "GitHub", sub: "gh · sunm", state: "connected" });
    expect(toolRow({ kind: "lark-cli", state: "not_logged_in", version: null, account: null, checkedAt: null })).toMatchObject({ name: "飞书命令行", state: "disconnected", command: "lark-cli auth login" });
    expect(toolRow({ kind: "gh", state: "expired", version: null, account: null, checkedAt: null }).state).toBe("expired");
    expect(toolRow({ kind: "gh", state: "unknown", version: null, account: null, checkedAt: null })).toMatchObject({ sub: "检查中", state: null });
    expect(tokenHubRow([]).state).toBe("disconnected");
    const gateway = { id: "m1", label: "DeepSeek", source: "gateway" as const, agent: "claude-code" as const, baseUrl: null, model: null, smallModel: null, webSearch: true, isDefault: false, tier: null };
    expect(tokenHubRow([gateway] as never)).toMatchObject({ sub: "DeepSeek", state: "connected" });
  });

  it("本人加的工具：连上写有几个工具，未授权、连不上写原因，还没查写地址；金蝶没加过时占一行未连接、不给动作", () => {
    const tool = { id: "kb", name: "知识库", preset: "custom" as const, url: "https://mcp.example.com/kb", keyHeader: null, hasKey: true, toolCount: null, error: null, checkedAt: null, addedAt: fresh() };
    expect(localToolRow({ ...tool, state: "ready", toolCount: 6 })).toMatchObject({ name: "知识库", sub: "6 个工具", state: "connected", action: null });
    expect(localToolRow({ ...tool, state: "unauthorized", error: "钥匙不对（401）" })).toMatchObject({ sub: "钥匙不对（401）", state: "unauthorized" });
    expect(localToolRow({ ...tool, state: "unreachable", error: "连不上这个地址" }).state).toBe("unreachable");
    expect(localToolRow({ ...tool, state: "unknown" })).toMatchObject({ sub: "https://mcp.example.com/kb", state: "unknown" });
    expect(KINGDEE_PLACEHOLDER).toMatchObject({ name: "金蝶", state: "disconnected", action: null });
  });

  it("我的账号：没接飞书不画飞书；连上给断开，过期给重新授权，没连给连接；让外部 AI 读天枢用过的算连上，只剩过期的是已过期", () => {
    expect(feishuRow({ enabled: false, state: "not_connected" })).toBeNull();
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

describe("连接页（三组）", () => {
  it("这台电脑就绪：本机程序、Claude Code 下面是额度和每个窗口的明细，GitHub、飞书命令行、文件夹、同时跑、两个开关；再是我的账号、公司两组", () => {
    const html = withLocal(<ConnectionsPage go={() => undefined} />, "ready", status());
    expect(text(html)).toMatch(/这台电脑.*我的账号.*公司/);
    const claude = html.split('data-testid="row-agent:claude-code"')[1]!.split("data-testid=\"row-")[0]!;
    expect(text(claude)).toContain("Claude Code 2.1.318 · max 已连接");
    // 额度和右栏「用量」同一套数（usageCells）。
    expect(text(claude)).toContain("Claude 17%");
    expect(text(claude)).toContain("本周：剩 17%");
    expect(text(claude)).toContain("本周 · Fable：剩 60%");
    expect(text(claude)).toContain("额外额度：未开");
    expect(claude).toContain('data-tone="warning"');
    expect(text(html)).toContain("GitHub gh · sunm 已连接");
    expect(text(html)).toContain("飞书命令行 lark-cli auth login 未连接");
    expect(text(html)).toContain("C:/code/Tianshu-MVP");
    // 工具：一行「工具」带「添加」（列表在本机读回来以后画在下面）；在 GitHub 那几行后面、文件夹前面。
    expect(html).toMatch(/data-testid="row-tool:lark-cli".*data-testid="row-local-tools".*data-testid="row-folders"/s);
    expect(html.split('data-testid="row-local-tools"')[1]!.split("</li>")[0]).toContain('aria-label="添加工具"');
    expect(html).toContain('aria-label="同时跑 3 个"');
    const row = (id: string) => html.split(`data-testid="row-${id}"`)[1]!.split("</li>")[0]!;
    expect(row("auto-merge")).toMatch(/role="switch"[^>]* checked=""/);
    expect(row("personal-config")).toContain(`role="switch"`);
    expect(row("personal-config")).not.toContain(` checked=""`);
    // 状态词只有那四个；不写「插件」。
    expect(text(html)).not.toContain("插件");
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

  it("这台电脑离线：本机程序写「离线」，下面是安装命令和复制；不列 Claude Code 等本机才知道的行", () => {
    const html = withLocal(<ConnectionsPage go={() => undefined} />, "offline", null);
    expect(text(html)).toContain("本机程序 离线 未连接 重试");
    expect(html).toMatch(/<code>(irm|curl) [^<]*install/);
    expect(html).not.toContain('data-testid="row-agent:claude-code"');
    expect(html).not.toContain('data-testid="row-folders"');
  });
});

describe("月份页（设计 10.4、10.5）", () => {
  const go = vi.fn();
  const render = (data: MonthPageData) => renderToStaticMarkup(<MonthView data={data} go={go} decide={async () => undefined} />);

  it("上半：每件 Task 一行，小字「约定 2/3 · 交付第 2 版 · 进行中 1」；没完成的接选项框「继续做（推荐）/ 改一改再做 / 到此为止 / 自己说…」，完成的行首一个勾、不问", () => {
    const html = render(monthFixture("2026-11"));
    expect(text(html)).toContain("11 月的 Task");
    const tasks = html.split('data-testid="month-task"').slice(1);
    expect(tasks).toHaveLength(3);
    expect(text(tasks[0]!)).toContain("新首页改版 约定 2/3 · 交付第 2 版 · 进行中 1");
    expect(text(tasks[0]!)).toContain("12 月怎么办");
    expect(text(tasks[0]!)).toMatch(/继续做 ?（推荐）.*改一改再做.*到此为止/);
    expect(tasks[0]).toContain('placeholder="自己说…"');
    expect(tasks[0]).toContain('maxLength="200"');
    expect(tasks[1]).toContain('aria-label="已完成"');
    expect(tasks[1]).not.toContain('data-testid="month-decision"');
    expect(text(tasks[2]!)).toContain("约定 0/2 · 未交付 · 受阻 1");
  });

  it("答过的收成一行「12 月怎么办 · 改一改再做：补一句」；下半是 12 月的草稿，延续来的写「延续自 11 月的 X · X 现在的状态」；底部两个动作，没有主按钮", () => {
    const data = monthFixture("2026-11");
    data.tasks[0] = { ...data.tasks[0]!, answer: { choice: "revise", note: "先把连接页做完" } };
    const html = render(data);
    expect(html.split('data-testid="month-task"')[1]).toContain("data-resolved");
    expect(text(html)).toContain("12 月怎么办 改一改再做：先把连接页做完");
    expect(text(html)).toContain("12 月的草稿");
    const drafts = html.split('data-testid="draft-row"').slice(1).map(text);
    expect(drafts[0]).toContain("新首页收尾 延续自 11 月的新首页改版 · 约定 2/3 · 交付第 2 版");
    expect(drafts[1]).toContain("CEO 的新首页");
    expect(drafts[1]).not.toContain("延续自");
    const foot = text(html.split('data-testid="month-foot"')[1]!);
    expect(foot).toContain("和伙伴过一遍");
    expect(foot).toContain("去 M2 签复盘");
    expect(html).not.toContain("button--primary");
  });

  it("已经延续出去的不再问怎么办，下面一行「已延续到 12 月的 X」；延续来的小字加「延续自 10 月的 X」", () => {
    const data = monthFixture("2026-11");
    data.tasks[0] = { ...data.tasks[0]!, continuedFrom: { taskId: "old", name: "首页改版一期", missionId: "m0", period: "2026-10" } };
    const tasks = render(data).split('data-testid="month-task"').slice(1);
    expect(text(tasks[0]!)).toContain("延续自 10 月的首页改版一期");
    expect(tasks[0]).toContain('data-testid="month-decision"');
    expect(tasks[2]).not.toContain('data-testid="month-decision"');
    expect(text(tasks[2]!)).toContain("已延续到 12 月的复盘入口收尾");
  });

  it("选项和补的话都空时不发（接口会回 400）", async () => {
    const request = vi.fn();
    const source = httpMonthSource(request as unknown as typeof fetch, false);
    await expect(source.decide("2026-11", "t1", { choice: null, note: "  " })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("没有 Task、没有草稿的部分不画；小字里是 0 的不写", () => {
    const html = render({ period: "2026-12", tasks: [], draft: null });
    expect(text(html)).not.toContain("的 Task");
    expect(text(html)).not.toContain("草稿");
    expect(html).toContain('data-testid="month-foot"');
    expect(monthSummary({ agreement: null, version: 3, running: 0, blocked: 0 })).toBe("交付第 3 版");
    expect(nextPeriod("2026-12")).toBe("2027-01");
  });

  it("数据来源：B2 的接口在就用它；404 时开发里退回假数据（答过的记住），生产里报错不冒充", async () => {
    const served: MonthPageData = { period: "2026-11", tasks: [], draft: null };
    const ok = httpMonthSource(async () => new Response(JSON.stringify(served), { status: 200 }));
    expect(await ok.load("2026-11")).toEqual(served);
    const missing = async () => new Response("{}", { status: 404 });
    const dev = httpMonthSource(missing, true);
    await dev.decide("2026-11", "fixture-home", { choice: "stop", note: null });
    expect((await dev.load("2026-11")).tasks.find((task) => task.taskId === "fixture-home")?.answer).toEqual({ choice: "stop", note: null });
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
    expect(MONTH_PAGE).not.toBeNull();
  });
});
