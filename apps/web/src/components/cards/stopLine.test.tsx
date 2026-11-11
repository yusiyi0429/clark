import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TLocalSessionEvent } from "@warmap/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));

import { foldEvents } from "@/lib/local/sessionView";
import { SessionTranscript, StopLine, stopText } from "./SessionTranscript";

/** 子会话停了要有交代（主循环第 65 条）。 */
const text = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");
const at = "2026-11-11T08:00:00.000Z";
const status = (seq: number, patch: Partial<Extract<TLocalSessionEvent, { type: "status" }>>): TLocalSessionEvent => ({ seq, at, sessionId: "s1", type: "status", status: "idle", ...patch });

describe("停下的原因", () => {
  it("事件流记下最近一次停下的原因；做完一轮、又跑起来了就没有", () => {
    expect(foldEvents([status(1, { status: "exited", why: "runner_restart" })]).stopped).toEqual({ why: "runner_restart", reason: null, hold: null });
    expect(foldEvents([status(1, { status: "idle", why: "interrupted" }), status(2, { status: "running" })]).stopped).toBeNull();
    expect(foldEvents([status(1, { status: "idle", why: "turn_done" })]).stopped).toBeNull();
  });
  it("出错带原因时不再另记一行出错（末尾那一行写）；老本机不带原因照旧记", () => {
    expect(foldEvents([status(1, { status: "failed", why: "error", reason: "执行方没开起来" })]).entries).toEqual([]);
    expect(foldEvents([status(1, { status: "failed", reason: "执行方没开起来" })]).entries).toHaveLength(1);
  });
  it("字：你停的 / 本机程序重启 / 出错：一句话 / 额度用完，几点恢复", () => {
    expect(stopText({ why: "interrupted", reason: null, hold: null })).toBe("你停的");
    expect(stopText({ why: "runner_restart", reason: null, hold: null })).toBe("本机程序重启");
    expect(stopText({ why: "error", reason: "执行方没开起来", hold: null })).toBe("出错：执行方没开起来");
    expect(stopText({ why: "held", reason: null, hold: { reason: "usage_limit", until: null } })).toBe("额度用完");
    expect(stopText({ why: "held", reason: null, hold: { reason: "usage_limit", until: "2026-11-11T10:00:00.000Z" } })).toMatch(/^额度用完，.*18:00 恢复$/);
  });
  it("行尾「接着做」只在这台电脑上给", () => {
    const stopped = { why: "runner_restart" as const, reason: null, hold: null };
    expect(text(renderToStaticMarkup(<StopLine stopped={stopped} onResume={() => undefined} />))).toBe("|本机程序重启|接着做|");
    expect(text(renderToStaticMarkup(<StopLine stopped={stopped} />))).toBe("|本机程序重启|");
  });
  it("对话末尾：停着才画，在跑不画", () => {
    const stopped = { why: "interrupted" as const, reason: null, hold: null };
    const render = (live: boolean) => renderToStaticMarkup(<SessionTranscript entries={[]} agentName="Claude Code" canAct onDecide={vi.fn()} live={live} stopped={stopped} onResume={() => undefined} />);
    expect(render(false)).toContain('data-testid="stop-line"');
    expect(render(true)).not.toContain('data-testid="stop-line"');
  });
});
