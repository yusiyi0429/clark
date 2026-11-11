import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionEntry } from "@/lib/local/sessionView";
import { createHttpRunner, parseSse } from "@/lib/local/client";
import { createMockRunner } from "@/lib/local/mock";
import type { TLocalSessionDraft } from "@warmap/contracts";
import type { TLocalSessionEvent } from "@/lib/local/runner";
import { SessionTranscript } from "./SessionTranscript";

const render = (entries: SessionEntry[], extra: Partial<Parameters<typeof SessionTranscript>[0]> = {}) =>
  renderToStaticMarkup(<SessionTranscript entries={entries} agentName="Claude Code" canAct onDecide={vi.fn()} live {...extra} />);

describe("「正在写」的草稿（流畅感第 1、2 条，契约 LocalSessionDraft）", () => {
  it("SSE：event: draft 那一帧带上 type、没有编号；普通事件照旧", () => {
    const text = 'id: 3\ndata: {"seq":3}\n\nevent: draft\ndata: {"type":"draft","sessionId":"s","text":"写到"}\n\n';
    expect(parseSse(text).events).toEqual([{ id: 3, data: '{"seq":3}' }, { id: null, data: '{"type":"draft","sessionId":"s","text":"写到"}', type: "draft" }]);
  });

  it("真本机客户端：要草稿时带 ?drafts=1；草稿交给 onDraft，不当事件、不动续接的编号", async () => {
    const urls: string[] = [];
    const body = 'id: 1\ndata: {"seq":1,"type":"assistant_text","text":"a"}\n\nevent: draft\ndata: {"type":"draft","sessionId":"s1","text":"写"}\n\n';
    vi.stubGlobal("fetch", vi.fn(async (url: string) => { urls.push(url); return new Response(body, { status: 200 }); }));
    try {
      const runner = createHttpRunner("http://127.0.0.1:1", () => "t");
      const events: TLocalSessionEvent[] = [];
      const drafts: TLocalSessionDraft[] = [];
      const stop = new AbortController();
      const done = runner.watch("s1", { after: 0, signal: stop.signal, onEvent: (event) => { events.push(event); }, onDraft: (draft) => { drafts.push(draft); stop.abort(); } });
      await done;
      expect(urls[0]).toMatch(/\/v1\/sessions\/s1\/events\?drafts=1$/);
      expect(events.map((event) => event.seq)).toEqual([1]);
      expect(drafts).toEqual([{ type: "draft", sessionId: "s1", text: "写" }]);
    } finally { vi.unstubAllGlobals(); }
  });

  it("假本机：有人看草稿时那段回答先一点点推全文，说完才来 assistant_text", async () => {
    const runner = createMockRunner({ stepMs: 1 });
    const session = await runner.createSession({ subject: { kind: "card", cardId: "c1" }, title: "卡", cwd: "C:\\work\\tianshu", firstMessage: "交代" });
    const seen: string[] = [];
    const events: TLocalSessionEvent[] = [];
    const stop = new AbortController();
    void runner.watch(session.id, { after: 0, signal: stop.signal, onEvent: (event) => { events.push(event); if (event.type === "assistant_text") seen.push(`text:${event.text.length}`); },
      onDraft: (draft) => { seen.push(`draft:${draft.text.length}`); } });
    const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 2)); };
    // 批了要的权限、答了它问的那句，下一步就是那段带表格的回答。
    await until(() => events.some((event) => event.type === "permission_request"));
    const request = events.find((event) => event.type === "permission_request");
    if (request?.type !== "permission_request") throw new Error("没有权限请求");
    await runner.decidePermission(session.id, request.request.requestId, { decision: "allow" });
    await until(() => events.some((event) => event.type === "question"));
    await runner.sendMessage(session.id, "删掉");
    await until(() => events.some((event) => event.type === "handback"));
    stop.abort();
    const drafts = seen.filter((item) => item.startsWith("draft:")).map((item) => Number(item.slice(6)));
    expect(drafts.length).toBeGreaterThan(3);
    expect(drafts).toEqual([...drafts].sort((a, b) => a - b));
    const lastText = seen.lastIndexOf(seen.filter((item) => item.startsWith("text:")).at(-1)!);
    expect(seen.slice(0, lastText).filter((item) => item.startsWith("draft:")).length).toBe(drafts.length);
  });

  it("页面：有草稿就在最后画「正在写」那段（不再出在跑那一行）；按草稿出过的那段换成真的时不再整段淡入", () => {
    const at = new Date().toISOString();
    const html = render([{ kind: "user", seq: 1, at, text: "删掉" }], { draft: "好，按你说的改，**两处**" });
    expect(html).toContain('data-testid="session-draft"');
    expect(html).not.toContain('data-testid="session-working"');
    expect(html).toContain("data-arrival");
    const entries: SessionEntry[] = [{ kind: "assistant", seq: 2, at, text: "好，按你说的改，**两处**：" }];
    expect(render(entries, { live: false })).toContain("data-arrival");
    expect(render(entries, { live: false, drafted: new Set([2]) })).not.toContain("data-arrival");
  });
});
