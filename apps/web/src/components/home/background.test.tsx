import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));

import { LocalContext } from "@/lib/local/LocalRunnerProvider";
import { createMockRunner } from "@/lib/local/mock";
import type { LocalPhase } from "@/lib/local/connection";
import type { BackgroundItem } from "@/lib/home/types";
import type { Resources } from "@/lib/work/useWork";
import { LocalInstall } from "@/components/local/PluginsPage";
import { BackgroundPanel, useMachine } from "./BackgroundPanel";
import { scopeOf } from "./view";

const today = (hours: number, minutes = 0) => { const at = new Date(); at.setHours(hours, minutes, 0, 0); return at.toISOString(); };
const fresh = () => new Date().toISOString();
const windows = (usedPercent: number) => [{ kind: "session" as const, model: null, usedPercent, state: usedPercent >= 100 ? "blocked" as const : "ok" as const, resetsAt: new Date(Date.now() + 3 * 3_600_000).toISOString() }]; // 跟着现在往后推：过了重置时间的窗口按 0 算，写死钟点深夜跑会挂
const cloud = (deviceName: string, usedPercent: number, n: number): Resources["quota"][number] => ({
  deviceId: `00000000-0000-4000-8000-0000000000d${n}`, deviceName, id: "claude", name: "Claude", kind: "subscription", remainingPercent: null, amounts: [],
  windows: windows(usedPercent), resetsAt: null, blockedUntil: null, updatedAt: fresh(),
});
const resources = (quota: Resources["quota"] = []): Resources => ({ local: { online: false, name: null, used: 0, cap: 3 }, models: [], todayUsd: null, quota });
const local = (phase: LocalPhase, quota: unknown[] = [], tools: unknown[] = []) => ({
  runner: createMockRunner(), phase, version: null, status: phase === "ready" ? { settings: { paused: false }, quota, tools } : null, models: [], folders: [], sessions: [],
  pairing: null, error: null, refresh: vi.fn(), pair: vi.fn(), unpair: vi.fn(), pickFolder: vi.fn(), setIncludePersonal: vi.fn(),
}) as unknown as Parameters<typeof LocalContext.Provider>[0]["value"];
const item = (extra: Partial<BackgroundItem>): BackgroundItem => ({
  id: "plan:00000000-0000-4000-8000-0000000000a1", title: "拆卡", kind: "plan", state: "running", startedAt: today(0), finishedAt: null, stoppable: true,
  sessionId: "00000000-0000-4000-8000-0000000000a1", itemId: null, deviceId: null, taskId: "t1", cardId: null, topicId: null, holdUntil: null, ...extra,
});
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const render = (node: ReactNode, phase: LocalPhase, localQuota: unknown[] = [], tools: unknown[] = []) =>
  renderToStaticMarkup(<LocalContext.Provider value={local(phase, localQuota, tools)}>{node}</LocalContext.Provider>);
const sub = (remainingPercent: number) => ({ id: "claude", name: "Claude", kind: "subscription", remainingPercent, amounts: [], windows: windows(100 - remainingPercent),
  resetsAt: null, blockedUntil: null, plan: "max", extraUsage: true, updatedAt: fresh(), error: null });
const tool = (kind: string, state = "ready") => ({ kind, state, version: null, account: null, checkedAt: fresh() });
const panel = (items: BackgroundItem[], quota: Resources["quota"] = []) =>
  <BackgroundPanel items={items} resources={resources(quota)} onStop={async () => undefined} />;

describe("右栏（5.4.5）", () => {
  it("二级页、月份页只要资源块：scope 是 resources", () => {
    expect([scopeOf({ kind: "page", page: "connections" }), scopeOf({ kind: "month", period: "2026-11" })]).toEqual(["resources", "resources"]);
  });

  it("停着等额度恢复的行，用时那格写「等额度恢复 · 08:00」，停止按钮照旧；没有恢复时间的还是「已排队」", () => {
    const html = render(panel([item({ state: "queued", holdUntil: today(8) }), item({ id: "verify:x", kind: "verify", title: "验收「greet」", state: "queued", stoppable: false })]), "ready");
    const rows = html.split('data-testid="bg-row"').slice(1).map(text);
    expect(rows[0]).toContain("等额度恢复 · 08:00");
    expect(rows[0]).not.toContain("已排队");
    expect(html).toContain('aria-label="停止 拆卡"');
    expect(rows[1]).toContain("已排队");
  });

  it("规划、验收的名字下面一行淡色小字「来源 · 模型 · 思考」（56 条）：在跑、跑完（失败自动展开）、只有「自动」都写；没带的行照旧", () => {
    const html = render(panel([
      item({ model: "Claude 订阅 · Opus 5.5 · 高" }),
      item({ id: "plan:auto", sessionId: "00000000-0000-4000-8000-0000000000a2", title: "拆另一张", model: "Claude 订阅 · 自动 · 自动" }),
      item({ id: "verify:done", kind: "verify", title: "验收「改样式」", state: "failed", finishedAt: today(0, 30), stoppable: false, model: "API · Sonnet 5.5 · 最高" }),
      item({ id: "cmd:1", kind: "command", title: "pnpm test", sessionId: null }),
    ]), "ready");
    const lines = [...html.matchAll(/data-testid="bg-model"[^>]*>([^<]+)</g)].map((match) => match[1]);
    expect(lines).toEqual(["Claude 订阅 · Opus 5.5 · 高", "Claude 订阅 · 自动 · 自动", "API · Sonnet 5.5 · 最高"]);
    expect(text(html)).toContain("pnpm test");
  });
  it("这台电脑没就绪：用量用云端报的，每台设备一格「Claude · 设备名」", () => {
    const html = render(panel([], [cloud("ThinkPad", 83, 1), cloud("Mac mini", 40, 2)]), "offline");
    const rows = html.split('data-testid="quota-row"').slice(1).map(text);
    expect(rows).toHaveLength(2);
    expect(text(html)).toContain("剩余用量");
    expect(rows[0]).toContain("Claude · ThinkPad");
    expect(rows[0]).toContain("17%");
    expect(rows[1]).toContain("Claude · Mac mini");
  });

  it("「这台电脑」逐项：就绪时收着；有一项没登录就琥珀点、自动展开、给「重试」；没就绪时工具写「—」；没有模型那一行", () => {
    const fine = render(panel([], []), "ready", [], [tool("claude-code"), tool("codex"), tool("gh"), tool("lark-cli")]);
    expect(fine).toMatch(/aria-expanded="false"[^>]*data-testid="machine-row"/);
    expect(fine).not.toContain('data-testid="machine-checks"');
    expect(text(fine)).toContain("在跑的子会话 0/3");
    expect(fine).toContain('aria-label="本机 0/3"');
    // 上限超过 10（不设上限以后）：格子放不下，只写数字。
    const many = render(<BackgroundPanel items={[]} resources={{ ...resources(), local: { online: true, name: null, used: 4, cap: 15 } }} onStop={async () => undefined} />, "ready", [], [tool("claude-code")]);
    expect(text(many)).toContain("在跑的子会话 4/15");
    expect(many).not.toContain('aria-label="本机 4/15"');
    const bad = render(panel([], []), "ready", [], [tool("claude-code"), tool("codex", "not_logged_in"), tool("gh"), tool("lark-cli")]);
    const checks = text(bad.split('data-testid="machine-checks"')[1]!);
    expect(checks).toMatch(/本机程序 已连接 Claude Code 已登录 Codex 没登录 gh 已登录 飞书命令行 已登录/);
    expect(bad).toContain("重试");
    const off = text(render(panel([], []), "offline", [], [tool("gh")]));
    expect(off).toContain("本机程序 离线");
    expect(off).not.toContain("在跑的子会话");
    // 离线：给打开本机程序的路（安装命令和「复制」），还有「重试」。
    expect(off).toMatch(/irm .*\/install\.ps1 \| iex/);
    expect(off).toContain("复制");
    expect(off).toContain("重试");
    expect(text(render(panel([], []), "prompt"))).not.toContain("install.ps1");
  });

  it("Mac 上离线算中性：不亮琥珀点、不给安装命令和「重试」，展开后只写「暂不支持 Mac」", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
    try {
      // 不算没连上（本人行不亮琥珀、「等你」里没有那一行）；「这台电脑」没有要处理的，默认收着（有一项不对才自动展开、给「重试」）。
      expect(render(<Machine />, "offline")).toBe("ok");
      const html = render(panel([], []), "offline", [], [tool("gh")]);
      expect(html).toMatch(/aria-expanded="false"[^>]*data-testid="machine-row"/);
      expect(text(html)).not.toContain("重试");
      // 展开后那一块：只写「暂不支持 Mac」。
      const off = text(render(<LocalInstall />, "offline"));
      expect(off).toContain("暂不支持 Mac");
      expect(off).not.toMatch(/install|curl|irm /);
      expect(off).not.toContain("复制");
      expect(off).not.toContain("重试");
    } finally { vi.unstubAllGlobals(); }
  });

  it("这台电脑就绪且读得到额度：只列本机的，别的设备不列；读不到时用云端的", () => {
    const ready = text(render(panel([], [cloud("ThinkPad", 83, 1)]), "ready", [sub(70)]));
    expect(ready).toContain("Claude 70%");
    expect(ready).not.toContain("ThinkPad");
    expect(text(render(panel([], [cloud("ThinkPad", 83, 1)]), "ready", []))).toContain("Claude · ThinkPad");
  });

  it("Claude 只有旧数时画旧数和暂时读不到；一个数都没有时写 Claude 暂时读不到", () => {
    const old = { ...sub(70), updatedAt: new Date(Date.now() - 50 * 60_000).toISOString(), error: "暂时读不到（get_usage 没给额度）" };
    const cells = (html: string) => html.split('data-testid="quota-row"').slice(1).map((cell) => text(cell.split("</li>")[0]!).replace(/^>/, "").trim());
    // 旧数照画（圆环、百分比），旁边淡色短语「暂时读不到」，不写原因
    const stale = render(panel([]), "ready", [old]);
    expect(cells(stale)).toEqual(["Claude 暂时读不到 70%"]); // 名字、暂时读不到、数：数照旧靠右，和别的格子对齐
    expect(stale).toContain("<circle");
    expect(stale).not.toContain("get_usage");
    // 「暂时读不到」自己一个 span，不和名字连成一串
    const row = stale.split('data-testid="quota-row"')[1]!.split("</li>")[0]!;
    expect(row).toMatch(/>Claude<\/span>/);
    expect(row).toMatch(/<span class="[^"]*usageNote[^"]*">暂时读不到<\/span>/);
    // 有数、读得到：照旧，没有「暂时读不到」
    expect(cells(render(panel([]), "ready", [sub(70)]))).toEqual(["Claude 70%"]);
    // 一个数都没有：那一格只写「Claude 暂时读不到」；画一个只有底圈的空圆环占住位置（和别的格子对齐），不画进度、不画「¥」
    const never = { ...sub(70), remainingPercent: null, windows: [], updatedAt: null, extraUsage: null, error: "暂时读不到（get_usage 没给额度）" };
    const empty = render(panel([]), "ready", [never]);
    expect(cells(empty)).toEqual(["Claude 暂时读不到"]);
    const emptyRow = empty.split('data-testid="quota-row"')[1]!.split("</li>")[0]!;
    expect(emptyRow).toContain("<svg");
    expect(emptyRow.match(/<circle/g)).toHaveLength(1);
    expect(emptyRow).not.toContain("¥");
    // 没读过、也没出错（还没去读）：照旧不画
    expect(render(panel([]), "ready", [{ ...never, error: null }])).not.toContain('data-testid="quota-row"');
  });

  it("这台电脑块里用量来源名字放不下时换行，不出省略号", () => {
    const long = { ...sub(70), id: "tokenhub", name: "TokenHub 团队共享额度" };
    const html = render(panel([], []), "ready", [long], [tool("claude-code")]);
    const block = html.slice(html.indexOf('data-testid="resources"'));
    expect(text(block)).toContain("TokenHub 团队共享额度");
    expect(block).not.toContain("…");
    // 块里用到的每个类（CSS 模块在测试里是 _名字_哈希）：home.module.css 里带它的规则都不截断，用量名字换行，格子跟着长高。
    const used = new Set([...block.matchAll(/class="([^"]+)"/g)].flatMap((match) => match[1].split(/\s+/)).map((name) => /^_(\w+)_[0-9a-f]+$/.exec(name)?.[1]).filter(Boolean));
    const css = readFileSync(new URL("../../styles/home.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1].trim(), body: match[2] }));
    const mine = (name: string) => rules.filter((rule) => new RegExp(`\\.${name}(?![\\w-])`).test(rule.selector));
    for (const name of used) for (const rule of mine(name!)) expect(`${rule.selector} { ${rule.body} }`).not.toMatch(/text-overflow:\s*ellipsis|line-clamp/);
    expect(mine("usageName").map((rule) => rule.body).join(";")).toMatch(/white-space:\s*normal;[\s\S]*overflow-wrap:\s*anywhere/);
    expect(mine("usageCell").map((rule) => rule.body).join(";")).not.toMatch(/(^|[;\s])height:/);
  });

  it("没连上（第 73 条：本人行琥珀、「等你」里一行）：离线、没配对、浏览器拦着算；就绪、检查中不算", () => {
    expect(render(<Machine />, "offline")).toBe("disconnected");
    expect(render(<Machine />, "unpaired")).toBe("disconnected");
    expect(render(<Machine />, "blocked")).toBe("disconnected");
    expect(render(<Machine />, "ready")).toBe("ok");
    expect(render(<Machine />, "checking")).toBe("ok");
  });
});

/** 只看 useMachine 的 disconnected。 */
function Machine() { return <>{useMachine([]).disconnected ? "disconnected" : "ok"}</>; }
