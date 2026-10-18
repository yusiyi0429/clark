import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TProgressOverview } from "@warmap/contracts";
import { ProgressBody } from "./ProgressScreen";
import { artifactLabel, coverageText, dayRangeText, meterParts, spentText } from "./progressText";

const person = { personId: "p2", name: "孙铭泽" };
const mission = { missionId: "m1", title: "可信记忆与读写闭环", deadline: "2026-10-20" };
const task = (title: string, extra: Partial<TProgressOverview["onTrack"][number]["task"]> = {}) => ({
  taskId: title, title, status: "in_progress" as const, startDate: "2026-10-12", dueDate: "2026-10-14", plannedDays: 3, usedDays: 5, ...extra,
});
const fixture: TProgressOverview = {
  today: "2026-10-16",
  redLines: [
    { kind: "slow", reason: "overdue", person, mission, task: task("冻结写回协议"), artifacts: [{ url: "https://github.com/TokenkingOS/Tianshu-MVP/pull/30", title: null }], coverageUntil: "2026-10-15T12:00:00.000Z" },
    { kind: "deadline", person, mission, neededDays: 4, leftDays: 3, tasks: [task("冻结写回协议"), task("读回校验", { dueDate: "2026-10-20" })], artifacts: [], coverageUntil: null },
  ],
  onTrack: [],
  summaries: [{ person: { personId: "p3", name: "刘人豪" }, weeklyReview: null, recent: [], artifacts: [], coverageUntil: null }],
  offPlan: [
    { id: "00000000-0000-4000-8000-000000000001", person, kind: "attach", text: "调研读回校验的写法", candidateTask: { taskId: "读回校验", title: "读回校验" },
      evidence: { source: "claude", repo: "Tianshu-MVP", startedAt: "2026-10-15T05:00:00.000Z", endedAt: "2026-10-15T08:00:00.000Z", links: [] }, spentMinutes: 90, replanProposedAt: null },
    { id: "00000000-0000-4000-8000-000000000002", person, kind: "replan", text: "重写上手流程的体验构想", candidateTask: null,
      evidence: { source: "codex", repo: null, startedAt: "2026-10-15T05:00:00.000Z", endedAt: "2026-10-15T07:00:00.000Z", links: [] }, spentMinutes: 120, replanProposedAt: "2026-10-16T02:00:00.000Z" },
  ],
};

describe("全局进展的展示", () => {
  it("进度条：超出的部分单独一段，竖线在预计的位置；没超出没有竖线", () => {
    expect(meterParts(3, 5)).toEqual({ fill: 60, over: 40, mark: 60 });
    expect(meterParts(10, 4)).toEqual({ fill: 40, over: 0, mark: null });
    expect(meterParts(0, 0)).toEqual({ fill: 0, over: 0, mark: null });
  });

  it("花的时间、日期段、信息截至、链接上的字", () => {
    expect(spentText(45)).toBe("45 分钟");
    expect(spentText(90)).toBe("1.5 小时");
    expect(dayRangeText("2026-10-12", "2026-10-14")).toBe("10/12–10/14");
    expect(dayRangeText("2026-10-20", "2026-10-20")).toBe("10/20");
    expect(coverageText(null)).toBe("无采集");
    expect(coverageText("2026-10-15T12:00:00.000Z")).toBe("信息截至 10/15 20:00");
    expect(artifactLabel({ url: "https://github.com/TokenkingOS/Tianshu-MVP/pull/30", title: null })).toBe("github.com · 30");
    expect(artifactLabel({ url: "https://docs.test/a", title: "读回样例" })).toBe("读回样例");
  });

  it("红线用「预计 / 已用」「剩 / 还需」加进度条表达，计划外分两组带花的时间；不写解释句", () => {
    const html = renderToStaticMarkup(<ProgressBody progress={fixture} onNavigate={() => undefined} />);
    expect(html).toContain("比预期慢");
    expect(html).toContain('aria-label="预计 3 天 / 已用 5 天"');
    expect(html).toContain("做不完");
    expect(html).toContain('aria-label="剩 3 天 / 还需 4 天"');
    expect(html).toContain("信息截至 10/15 20:00");
    expect(html).toContain("待挂靠");
    expect(html).toContain("待改计划");
    expect(html).toContain("合计 3.5 小时");
    expect(html).toContain("像「读回校验」");
    expect(html).toContain("已提改计划");
    expect(html).toContain("无周复盘");
    // 不出现解释概念、操作指引一类的句子。
    for (const sentence of ["就是红线", "演示", "预期和实际", "说明计划", "没有接"]) expect(html).not.toContain(sentence);
  });
});
