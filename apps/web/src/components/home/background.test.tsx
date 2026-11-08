import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));

import { LocalContext } from "@/lib/local/LocalRunnerProvider";
import { createMockRunner } from "@/lib/local/mock";
import type { LocalPhase } from "@/lib/local/connection";
import type { BackgroundItem } from "@/lib/home/types";
import type { Resources } from "@/lib/work/useWork";
import { BackgroundPanel, BackgroundStrip } from "./BackgroundPanel";
import { scopeOf } from "./view";

const today = (hours: number, minutes = 0) => { const at = new Date(); at.setHours(hours, minutes, 0, 0); return at.toISOString(); };
const fresh = () => new Date().toISOString();
const windows = (usedPercent: number) => [{ kind: "session" as const, model: null, usedPercent, state: usedPercent >= 100 ? "blocked" as const : "ok" as const, resetsAt: today(23, 30) }];
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

  it("这台电脑就绪且读得到额度：只列本机的，别的设备不列；读不到时用云端的", () => {
    const ready = text(render(panel([], [cloud("ThinkPad", 83, 1)]), "ready", [sub(70)]));
    expect(ready).toContain("Claude 70%");
    expect(ready).not.toContain("ThinkPad");
    expect(text(render(panel([], [cloud("ThinkPad", 83, 1)]), "ready", []))).toContain("Claude · ThinkPad");
  });

  it("收起条的额度点看列出来的那几行：没就绪时云端报的用完是红点", () => {
    const dot = render(<BackgroundStrip running={0} quota={[cloud("ThinkPad", 100, 1)]} onExpand={() => undefined} />, "checking");
    expect(dot).toContain('aria-label="额度快用完了"');
    expect(dot).toContain('data-tone="danger"');
    expect(render(<BackgroundStrip running={0} quota={[cloud("ThinkPad", 100, 1)]} onExpand={() => undefined} />, "ready", [sub(70)])).not.toContain("额度快用完了");
  });

  it("这台电脑离线（本身要处理）时，云端报的额度用完照样是红点，不被琥珀点盖掉", () => {
    const strip = render(<BackgroundStrip running={0} quota={[cloud("ThinkPad", 100, 1)]} onExpand={() => undefined} />, "offline");
    expect(strip).toContain('data-tone="danger"');
    expect(strip).toContain('aria-label="额度快用完了"');
    const amber = render(<BackgroundStrip running={0} quota={[cloud("ThinkPad", 40, 1)]} onExpand={() => undefined} />, "offline");
    expect(amber).not.toContain('data-tone="danger"');
    expect(amber).toContain('aria-label="这台电脑要处理"');
  });
});
