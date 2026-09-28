import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { groupInputState, mergeGroupEntries } from "./missionCardGroup";
import { MissionGroupTranscript } from "./MissionGroupTranscript";
import { MissionGroupComposer } from "./MissionGroupComposer";

describe("任务卡群组的阶段和公开记录", () => {
  it.each([
    ["draft", false, "讨论还没开放"],
    ["open", true, "输入你的想法…"],
    ["closed", true, "截止后留言 · 不进这一轮集中 Review"],
    ["reviewing", true, "截止后留言 · 不进这一轮集中 Review"],
    ["confirmed", false, "本月 Mission Card 已确定"],
  ] as const)("%s 的输入和说明", (phase, writable, placeholder) => {
    expect(groupInputState(phase)).toEqual({ writable, placeholder });
    const html = renderToStaticMarkup(<MissionGroupComposer cardId="card" phase={phase} channels={[]} channel="group" onChannel={() => {}} narrow={false} mobileOpen={false} onMobileOpen={() => {}} onHeightChange={() => {}} reference={null} onRemoveReference={() => {}} busy={false} onSend={async () => true} />);
    expect(html).toContain(`placeholder="${placeholder}"`);
    expect(html.includes('disabled=""')).toBe(true); // 空输入发送钮始终停用。
    expect(/<textarea[^>]*disabled/.test(html)).toBe(!writable);
    expect(html).toContain('data-tone="group"');
  });
  it("增量轮询不重复开场和分隔线；同一条意见可更新处理结果", () => {
    const opening = { type: "opening", at: "2026-10-01T00:00:00Z", text: "讨论孙铭泽的卡" } as const;
    expect(mergeGroupEntries([opening], [opening])).toEqual([opening]);
    const old = { type: "message", feedback: { id: "a", seq: 1, createdAt: opening.at, body: "旧" } } as never;
    const next = { type: "message", feedback: { id: "a", seq: 1, createdAt: opening.at, body: "新" } } as never;
    expect(mergeGroupEntries([old, opening], [opening, next])).toEqual([opening, next]);
    const cutoff = { type: "divider", at: opening.at, text: "讨论截止 · 之后的留言不进这一轮" } as const;
    const reopened = { ...cutoff, text: "讨论截止" };
    expect(mergeGroupEntries([cutoff, old], [reopened])).toEqual([reopened, old]);
  });
  it("有开场时没有暂无消息；群组展示版本与截止后标签", () => {
    const html = renderToStaticMarkup(<MissionGroupTranscript entries={[
      { type: "divider", at: "2026-10-01T00:00:00Z", text: "全战场统一开放 48 小时讨论" },
      { type: "opening", at: "2026-10-01T00:00:00Z", text: "占位 · 沿用 9 月任务卡" },
      { type: "message", feedback: { id: "f", seq: 1, authorName: "孙铭泽", body: "核对交付边界", quote: "原文", sourceVersion: 1, proposed: null, original: null, late: true, kind: "quote", createdAt: "2026-10-03T00:00:00Z", verdict: { text: "截止后留言 · 不在这一轮", tone: "late" } } as never },
    ]} />);
    expect(html).toContain("Co-Agent");
    expect(html).toContain("截止后留言");
    expect(html).toContain("v1");
    expect(html).not.toContain("暂无消息");
  });
  it("引用条显示源版本并允许取消", () => {
    const html = renderToStaticMarkup(<MissionGroupComposer cardId="card" phase="open" channels={[]} channel="group" onChannel={() => {}} narrow={false} mobileOpen={false} onMobileOpen={() => {}} onHeightChange={() => {}} reference={{ missionId: "m", field: "why", quote: "讨论依据", sourceVersion: 2, nonce: 1 }} onRemoveReference={() => {}} busy={false} onSend={async () => true} />);
    expect(html).toContain("讨论依据");
    expect(html).toContain("v2");
    expect(html).toContain('aria-label="取消引用"');
  });
});
