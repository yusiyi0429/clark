import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TBattlefieldSummary } from "@warmap/contracts";
import { BattlefieldSummaryList, elapsedText } from "./BattlefieldSummaries";

const today: TBattlefieldSummary = {
  battlefieldId: "growth", name: "增长战场", generation: null,
  summary: { day: "2026-10-26", goal: "10 月签下 3 家渠道", paragraphs: ["按目前进展有风险。", "测试乙的上线完成一半。", "需要测试甲在 10/28 前给出测试账号。"],
    progressUntil: "2026-10-26T06:30:00.000Z", summarizedAt: "2026-10-26T07:02:00.000Z" },
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const card = (html: string, id: string) => html.match(new RegExp(`<li[^>]*data-battlefield="${id}"[^>]*>.*?</li>`, "s"))?.[0] ?? "";

describe("按战场", () => {
  it("每个战场一块：战场名、本期目标一行、几段话、进展收集至与总结于", () => {
    const html = renderToStaticMarkup(<BattlefieldSummaryList battlefields={[today]} />);
    expect(text(html)).toBe("按战场 1 增长战场 本期目标 10 月签下 3 家渠道 按目前进展有风险。 测试乙的上线完成一半。 需要测试甲在 10/28 前给出测试账号。 进展收集至 10/26 14:30 · 总结于 10/26 15:02");
    expect(card(html, "growth").match(/<p>/g)).toHaveLength(3);
  });

  it("今天这份在整理：写阶段和已用时间，先给之前那份；没整理出来、没有目标、没有进展记录都如实写", () => {
    const html = renderToStaticMarkup(<BattlefieldSummaryList battlefields={[
      { ...today, generation: { state: "running", phase: "writing", startedAt: new Date(Date.now() - 5_000).toISOString() },
        summary: { ...today.summary!, day: "2026-10-25", progressUntil: "2026-10-25T06:30:00.000Z", summarizedAt: "2026-10-24T23:31:00.000Z" } },
      { battlefieldId: "product", name: "产品战场", summary: null, generation: { state: "running", phase: "reading", startedAt: new Date().toISOString() } },
      { battlefieldId: "ops", name: "交付战场", generation: { state: "failed", at: "2026-10-26T07:00:00.000Z" },
        summary: { day: "2026-10-24", goal: null, paragraphs: ["这个战场近两周没有进展记录。"], progressUntil: null, summarizedAt: "2026-10-23T23:31:00.000Z" } },
    ]} />);
    expect(text(card(html, "growth"))).toMatch(/^增长战场 本期目标 10 月签下 3 家渠道 正在整理 · 已用 \d 秒，约 1 分钟 按目前进展有风险。.* 进展收集至 10\/25 14:30 · 总结于 10\/25 07:31$/);
    expect(text(card(html, "product"))).toMatch(/^产品战场 正在读进展 · 已用 \d 秒，约 1 分钟$/);
    expect(text(card(html, "ops"))).toBe("交付战场 本期目标 未载入 没整理出来 这个战场近两周没有进展记录。 没有进展记录 · 总结于 10/24 07:31");
  });

  it("已用时间：一分钟内写秒并带预计，超过预计只写已用多久", () => {
    const start = "2026-10-26T07:00:00.000Z", at = (seconds: number) => Date.parse(start) + seconds * 1000;
    expect(elapsedText(start, at(12))).toBe("已用 12 秒，约 1 分钟");
    expect(elapsedText(start, at(-3))).toBe("已用 0 秒，约 1 分钟");
    expect(elapsedText(start, at(80))).toBe("已用 1 分 20 秒");
    expect(elapsedText(start, at(120))).toBe("已用 2 分钟");
  });
});
