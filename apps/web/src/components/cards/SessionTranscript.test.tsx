import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { foldEvents, type SessionEntry } from "@/lib/local/sessionView";
import type { TLocalSessionEvent } from "@/lib/local/runner";
import { SessionComposer, SessionTranscript } from "./SessionTranscript";

const step = (seq: number, title: string, at: string, done = true): SessionEntry => ({ kind: "step", seq, at, toolUseId: `t${seq}`, title, done, isError: false });
const render = (entries: SessionEntry[], live = true) =>
  renderToStaticMarkup(<SessionTranscript entries={entries} agentName="Claude Code" canAct onDecide={vi.fn()} live={live} />);
/** 组头：带 aria-expanded 的按钮。 */
const heads = (html: string) => [...html.matchAll(/<button[^>]*aria-expanded="[^"]*"[^>]*>([\s\S]*?)<\/button>/g)].map((match) => match[1]!);

describe("工具调用行（设计 5.4.3）", () => {
  it("连续 3 步折成一行：「3 步」加最后一步，收着", () => {
    const html = render([
      step(1, "读 SessionTranscript.tsx", "2026-11-07T01:00:00Z"),
      step(2, "改 v2-session.module.css", "2026-11-07T01:00:20Z"),
      step(3, "跑 vitest", "2026-11-07T01:01:12Z"),
    ]);
    const found = heads(html);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("3 步");
    expect(found[0]).toContain("跑 vitest");
    expect(found[0]).toContain("1 分");
    expect(html).toContain('aria-expanded="false"');
  });

  it("只有一步不画组头", () => {
    const html = render([step(1, "读 SessionTranscript.tsx", "2026-11-07T01:00:00Z")]);
    expect(heads(html)).toHaveLength(0);
    expect(html).not.toContain("1 步");
    expect(html).toContain("读 SessionTranscript.tsx");
  });

  it("最后一步还在跑：组头转圈；会话不在跑了就是箭头", () => {
    const entries = [step(1, "读 a.ts", "2026-11-07T01:00:00Z"), step(2, "跑 pnpm test", "2026-11-07T01:00:05Z", false)];
    expect(heads(render(entries))[0]).toContain('aria-label="进行中"');
    expect(heads(render(entries, false))[0]).not.toContain('aria-label="进行中"');
  });

  it("中间隔着别的话就分成两组，产出单独一行", () => {
    const html = render([
      step(1, "读 a.ts", "2026-11-07T01:00:00Z"),
      step(2, "读 b.ts", "2026-11-07T01:00:01Z"),
      { kind: "assistant", seq: 3, at: "2026-11-07T01:00:02Z", text: "看完了" },
      step(4, "改 a.ts", "2026-11-07T01:00:03Z"),
      { kind: "artifact", seq: 5, at: "2026-11-07T01:00:04Z", title: "a", fileName: "a.md" },
      step(6, "跑 vitest", "2026-11-07T01:00:05Z"),
    ]);
    expect(heads(html).map((head) => head.includes("2 步"))).toEqual([true]);
    expect(html).toContain("交出 a.md");
  });
});

describe("子会话回执（17.4）", () => {
  const at = "2026-11-08T02:00:00Z";
  const ev = (seq: number, body: Record<string, unknown>) => ({ seq, at, ...body }) as unknown as TLocalSessionEvent;
  const ids = ["00000000-0000-4000-8000-0000000000b1", "00000000-0000-4000-8000-0000000000b2", "00000000-0000-4000-8000-0000000000b3"] as const;

  it("按编号挂到那句话上：一个勾已送达、两个勾已读、failed 写「没读到 · 重发」；本机补发的话没有回执", () => {
    const view = foldEvents([
      ev(1, { type: "user_message", text: "先跑测试", source: "web", messageId: ids[0] }),
      ev(2, { type: "user_message", text: "再改样式", source: "web", messageId: ids[1] }),
      ev(3, { type: "user_message", text: "额度恢复了，接着做", source: "web" }),
      ev(4, { type: "user_message", text: "顺手提交", source: "web", messageId: ids[2] }),
      ev(5, { type: "receipt", messageId: ids[0], state: "delivered" }),
      ev(6, { type: "receipt", messageId: ids[1], state: "delivered" }),
      ev(7, { type: "receipt", messageId: ids[1], state: "read" }),
      ev(8, { type: "receipt", messageId: ids[2], state: "delivered" }),
      ev(9, { type: "receipt", messageId: ids[2], state: "failed" }),
    ]);
    expect(view.entries.map((entry) => entry.kind === "user" ? entry.receipt ?? null : "-")).toEqual(["delivered", "read", null, "failed"]);
    const html = render(view.entries);
    expect(html).toMatch(/先跑测试<\/div><span[^>]*data-receipt="delivered"[^>]*aria-label="已送达"/);
    expect(html).toMatch(/再改样式<\/div><span[^>]*data-receipt="read"[^>]*aria-label="已读"/);
    expect(html).toMatch(/额度恢复了，接着做<\/div><div/);
    expect(html.replace(/<[^>]+>/g, "")).toContain("顺手提交没读到 ·重发");
    // 这里答不了（别的电脑、手机）：只写「没读到」，不给重发。
    const away = renderToStaticMarkup(<SessionTranscript entries={view.entries} agentName="Claude Code" canAct={false} onDecide={vi.fn()} live />);
    expect(away.replace(/<[^>]+>/g, "")).toContain("顺手提交没读到");
    expect(away).not.toContain("重发");
  });
});

describe("子会话的输入框", () => {
  it("不放占位字（空着就是一行），读屏名字还是「给{子会话名}插话」", () => {
    const html = renderToStaticMarkup(<SessionComposer label="给拆左栏插话" disabled={false} onSend={vi.fn()} subject={{ kind: "card", id: "00000000-0000-4000-8000-0000000000c1" }} />);
    const box = html.match(/<textarea[^>]*>/)?.[0] ?? "";
    expect(box).toContain('aria-label="给拆左栏插话"');
    expect(box).toMatch(/placeholder=""/);
    expect(html).not.toContain("插话…");
  });
});
