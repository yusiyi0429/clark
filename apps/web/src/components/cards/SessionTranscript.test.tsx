import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionEntry } from "@/lib/local/sessionView";
import { SessionTranscript } from "./SessionTranscript";

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
