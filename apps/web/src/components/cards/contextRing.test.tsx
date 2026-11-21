import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockRunner } from "@/lib/local/mock";
import type { TLocalSessionEvent } from "@/lib/local/runner";
import { contextUsage, foldEvents } from "@/lib/local/sessionView";
import { SessionComposer, SessionTranscript } from "./SessionTranscript";

const subject = { kind: "card" as const, id: "00000000-0000-4000-8000-0000000000c1" };
const until = async (check: () => boolean) => { for (let i = 0; i < 300 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 2)); };

describe("子会话显示上下文用了多少（17.2 第 42 条，D 契约 584eb5e9）", () => {
  it("百分比取整，到 80% 是警告色；悬停写「16.6 万 / 20 万」；还没报过、读不到上限时不画", () => {
    expect(contextUsage({ usedTokens: 166_000, maxTokens: 200_000 })).toEqual({ percent: 83, warn: true, tip: "16.6 万 / 20 万", amount: "17 万 / 20 万" });
    expect(contextUsage({ usedTokens: 42_000, maxTokens: 200_000 })).toEqual({ percent: 21, warn: false, tip: "4.2 万 / 20 万", amount: "4 万 / 20 万" });
    expect(contextUsage({ usedTokens: 158_800, maxTokens: 200_000 })).toMatchObject({ percent: 79, warn: false });
    expect(contextUsage({ usedTokens: 159_000, maxTokens: 200_000 })).toMatchObject({ percent: 80, warn: true });
    expect(contextUsage({ usedTokens: 1_200_000, maxTokens: 1_000_000 })).toMatchObject({ percent: 100, tip: "120 万 / 100 万" });
    expect(contextUsage({ usedTokens: 3_000, maxTokens: null })).toBeNull();
    expect(contextUsage(undefined)).toBeNull();
    expect(contextUsage(null)).toBeNull();
  });

  it("输入框下面、模型胶囊前面一个小圆环加数字；没有就不画", () => {
    const html = renderToStaticMarkup(<SessionComposer label="插话" disabled={false} onSend={vi.fn()} subject={subject} model={{ label: "Opus 5.5" }} context={contextUsage({ usedTokens: 166_000, maxTokens: 200_000 })} />);
    expect(html).toMatch(/<span[^>]*data-tone="warning"[^>]*data-testid="context-usage"[^>]*><svg[\s\S]*?<\/svg><span[^>]*>83%<\/span><\/span>/);
    // 悬停提示用站内统一的那种（useHoverTip），不用原生 title。
    expect(html).not.toMatch(/data-testid="context-usage"[^>]*title=|title="[^"]*"[^>]*data-testid="context-usage"/);
    expect(html).toContain('aria-label="上下文 83%，16.6 万 / 20 万"');
    expect(html.indexOf("context-usage")).toBeLessThan(html.indexOf("session-model"));
    const calm = renderToStaticMarkup(<SessionComposer label="插话" disabled={false} onSend={vi.fn()} subject={subject} model={{ label: "Opus 5.5" }} context={contextUsage({ usedTokens: 42_000, maxTokens: 200_000 })} />);
    expect(calm).toContain("21%");
    expect(calm).not.toContain('data-tone="warning"');
    expect(renderToStaticMarkup(<SessionComposer label="插话" disabled={false} onSend={vi.fn()} subject={subject} model={{ label: "Opus 5.5" }} context={contextUsage(null)} />)).not.toContain("context-usage");
  });

  it("事件 context_usage 更新圆环的数；压缩了上下文时对话里记一行", async () => {
    const runner = createMockRunner({ stepMs: 1 });
    const session = await runner.createSession({ subject: { kind: "card", cardId: "c1" }, title: "卡", cwd: "C:/work/tianshu", firstMessage: "交代" });
    expect(session.context).toBeUndefined();
    const seen: TLocalSessionEvent[] = [];
    const controller = new AbortController();
    void runner.watch(session.id, { after: 0, onEvent: (event) => seen.push(event), signal: controller.signal });
    // 一轮做完报一次（假本机程序：停下来算一轮）。
    expect((await runner.interrupt(session.id)).context).toMatchObject({ usedTokens: 166_000, maxTokens: 200_000 });
    await until(() => seen.some((event) => event.type === "context_usage"));
    expect(foldEvents(seen).context).toMatchObject({ usedTokens: 166_000, maxTokens: 200_000 });
    expect(contextUsage(foldEvents(seen).context)).toMatchObject({ percent: 83, warn: true });
    // 快满了执行方自己压缩：记一行「压缩了上下文」，数跟着掉下来。
    expect((await runner.interrupt(session.id)).context).toMatchObject({ usedTokens: 42_000 });
    await until(() => seen.some((event) => event.type === "notice" && event.code === "context_compacted"));
    controller.abort();
    const view = foldEvents(seen);
    expect(view.context).toMatchObject({ usedTokens: 42_000 });
    const html = renderToStaticMarkup(<SessionTranscript entries={view.entries} agentName="Claude Code" canAct onDecide={vi.fn()} live={false} />);
    expect(html).toContain("压缩了上下文");
  });
});
