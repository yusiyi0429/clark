import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EMPTY_VIEW, foldEvents, type SessionEntry } from "@/lib/local/sessionView";
import { createMockRunner } from "@/lib/local/mock";
import { createHttpRunner } from "@/lib/local/client";
import type { LocalRunner, TLocalPermissionRequestView, TLocalSessionEvent } from "@/lib/local/runner";
import { SessionTranscript, sessionOutbox, withOutgoing, type Outgoing } from "./SessionTranscript";

const at = "2026-11-11T01:00:00Z";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const render = (entries: SessionEntry[], extra: Partial<Parameters<typeof SessionTranscript>[0]> = {}) =>
  renderToStaticMarkup(<SessionTranscript entries={entries} agentName="Claude Code" canAct onDecide={vi.fn()} live={false} {...extra} />);
const user = (seq: number, messageId: string, words = "先跑测试"): TLocalSessionEvent => ({ seq, at, type: "user_message", text: words, source: "web", messageId } as TLocalSessionEvent);

/** 发话那一头：先画着的几句存在一个数组里（页面里是 state）。 */
function outbox(runner: Partial<LocalRunner> & { clientMessageIds?: boolean }, pending: TLocalPermissionRequestView[] = [], upload = vi.fn(async (files: File[]) => files.map((file) => ({ id: "00000000-0000-4000-8000-0000000000f1", fileName: file.name, size: file.size, sha256: "a".repeat(64) })))) {
  let list: Outgoing[] = [];
  const box = sessionOutbox(() => ({ runner: runner as LocalRunner, sessionId: "s1", pending, list }), (change) => { list = change(list); }, upload);
  return { box, upload, list: () => list };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("子会话一按发送就先画出来", () => {
  it("本机收 messageId：先画一句「发送中」（带附件的小卡），同一个编号交给本机；事件流里同编号的来了换成真的，不重复", async () => {
    const sendMessage = vi.fn(async () => ({ delivery: "new_turn" as const, messageId: "x" }));
    const { box, upload, list } = outbox({ clientMessageIds: true, sendMessage });
    const file = new File(["png"], "截图.png");
    expect(await box.say("看这张图", [file])).toBe(true);
    const [item] = list();
    expect(item).toMatchObject({ text: "看这张图", failed: false });
    const shown = withOutgoing({ entries: [], lastSeq: 7 }, list());
    expect(shown).toEqual([expect.objectContaining({ kind: "user", text: "看这张图", local: "sending", messageId: item!.messageId, attachments: [{ name: "截图.png", size: 3 }] })]);
    const html = render(shown);
    expect(html).toContain("data-sending");
    expect(text(html)).toContain("发送中");
    expect(text(html)).toContain("截图.png");
    await flush();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("s1", "看这张图", undefined, [expect.objectContaining({ fileName: "截图.png" })], item!.messageId);
    // 真的那条来了：只剩真的，没有「发送中」。
    const real = foldEvents([user(8, item!.messageId, "看这张图")]);
    const merged = withOutgoing(real, list());
    expect(merged).toHaveLength(1);
    expect(merged[0]).not.toHaveProperty("local");
    expect(text(render(merged))).not.toContain("发送中");
  });

  it("发话报错：那句变「没发出去 · 重发」；重发用同一个编号，附件传好了不再传", async () => {
    const sendMessage = vi.fn().mockRejectedValueOnce(new Error("断了")).mockResolvedValueOnce({ delivery: "new_turn", messageId: "x" });
    const { box, upload, list } = outbox({ clientMessageIds: true, sendMessage }, []);
    await box.say("再改样式", [new File(["a"], "a.txt")]);
    await flush();
    const [item] = list();
    expect(item!.failed).toBe(true);
    const retry = vi.fn();
    const html = text(render(withOutgoing({ entries: [], lastSeq: 0 }, list()), { onRetry: retry }));
    expect(html).toContain("没发出去");
    expect(html).toContain("重发");
    expect(html).not.toContain("发送中");
    box.retry(item!.messageId);
    expect(list()[0]!.failed).toBe(false);
    await flush();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]![4]).toBe(item!.messageId);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("本机不收 messageId（老版本）：不带编号、不先画，等发完才算发出去，和原来一样", async () => {
    const sendMessage = vi.fn(async () => ({ delivery: "new_turn" as const, messageId: "x" }));
    const { box, list } = outbox({ clientMessageIds: false, sendMessage });
    expect(await box.say("顺手提交")).toBe(true);
    expect(list()).toEqual([]);
    expect(sendMessage).toHaveBeenCalledWith("s1", "顺手提交", undefined, [], undefined);
    // 报错照旧抛给输入框（它把字放回去、写「失败 · 重试」）。
    const broken = outbox({ clientMessageIds: false, sendMessage: vi.fn().mockRejectedValue(new Error("断了")) });
    await expect(broken.box.say("顺手提交")).rejects.toThrow("断了");
  });

  it("有没批的批准、这句话放得进「换个做法」：只记换个做法、不发话，所以不先画；放不进的照样先画、带编号插话", async () => {
    const pending = [{ requestId: "r1", toolName: "Bash", title: "运行 rm", input: {}, canAllowForSession: false } as unknown as TLocalPermissionRequestView];
    const decidePermission = vi.fn(async () => undefined);
    const sendMessage = vi.fn(async (..._args: unknown[]) => ({ delivery: "next_step" as const, messageId: "x" }));
    const short = outbox({ clientMessageIds: true, sendMessage, decidePermission } as never, pending);
    await short.box.say("换成 git clean");
    expect(short.list()).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
    const long = outbox({ clientMessageIds: true, sendMessage, decidePermission } as never, pending);
    await long.box.say("长".repeat(2000));
    expect(long.list()).toHaveLength(1);
    await flush();
    expect(sendMessage.mock.calls[0]![4]).toBe(long.list()[0]!.messageId);
  });

  it("假本机按网页给的编号回 user_message（先画的那句对得上）", async () => {
    const runner = createMockRunner({ stepMs: 5 });
    const session = await runner.createSession({ subject: { kind: "card", cardId: "c1" }, title: "卡", cwd: "C:\\work\\tianshu", firstMessage: "交代" });
    const events: TLocalSessionEvent[] = [];
    const stop = new AbortController();
    void runner.watch(session.id, { after: 0, onEvent: (event) => events.push(event), signal: stop.signal });
    const messageId = "00000000-0000-4000-8000-00000000abcd";
    await runner.sendMessage(session.id, "继续", undefined, undefined, messageId);
    stop.abort();
    expect(events.some((event) => event.type === "user_message" && event.messageId === messageId)).toBe(true);
    expect(runner.clientMessageIds).toBe(true);
  });

  it("真本机的客户端：给了编号才放进请求体；health 读过、protocol ≥ 2 才收（老本机程序是 1）", async () => {
    const bodies: unknown[] = [];
    let protocol = 1;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ app: "tianshu-local", version: "0.9.0", protocol, platform: "win32", tokenValid: true, slots: { max: 3, running: 0, queued: 0 }, delivery: "new_turn", messageId: "x" }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    try {
      const runner = createHttpRunner("http://127.0.0.1:1", () => "t");
      expect(runner.clientMessageIds).toBe(false);
      await runner.health();
      expect(runner.clientMessageIds).toBe(false);
      protocol = 2;
      await runner.health();
      expect(runner.clientMessageIds).toBe(true);
      await runner.sendMessage("s1", "先跑测试");
      await runner.sendMessage("s1", "再改样式", undefined, undefined, "00000000-0000-4000-8000-00000000abcd");
      expect(bodies).toEqual([{ text: "先跑测试" }, { text: "再改样式", messageId: "00000000-0000-4000-8000-00000000abcd" }]);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("启动中（本机在拉起执行方）", () => {
  it("状态 starting：在跑那一行写「启动中 · N 秒」；running 以后照旧只写时长", () => {
    const entries = foldEvents([user(1, "00000000-0000-4000-8000-0000000000a1")], EMPTY_VIEW).entries;
    const starting = text(render(entries, { live: true, starting: true }));
    expect(starting).toMatch(/启动中 · \d/);
    const running = text(render(entries, { live: true }));
    expect(running).not.toContain("启动中");
    expect(renderToStaticMarkup(<SessionTranscript entries={entries} agentName="Claude Code" canAct onDecide={vi.fn()} live starting />)).toContain('aria-label="启动中"');
  });
});
