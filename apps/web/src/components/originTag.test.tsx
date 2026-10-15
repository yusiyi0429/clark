import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";

import { isFromRadar, RadarOriginTag } from "./OriginTag";
import { IssueRow, issueRowData } from "./IssueRow";
import { emptySourceContext, sourceLabel } from "@/cards/meetingSources";
import { DetailFrame } from "@/components/shell/DetailFrame";

// 来源标注（反馈会议 + 10/13 验收会议）：界面上没有「AI 建议」标签；来自雷达的议题上有「雷达图标 + 雷达」小标签；

function card(kind: string, id: string, title: string, payload: unknown): Card {
  return { schemaVersion: 1, id: `${kind}:${id}`, version: 1, kind, objectRef: { type: kind, id, version: 1 }, title, payload, actions: [] } as unknown as Card;
}

const issuePayload = (extra: Record<string, unknown> = {}) => ({
  origin: "dri", originRef: null, status: "pending", location: { level: "company", relatedBattlefieldIds: [] }, urgency: { level: "gray" },
  research: { status: "failed" }, receipts: [], dismissedAt: null, dismissReason: null, ...extra,
});
const aiIssue = card("issue", "i-ai", "是否把验收清单前置到签约前", issuePayload({ nature: "ai_suggested" }));
const radarIssue = card("issue", "i-radar", "是否跟进竞品降价", issuePayload({ nature: "ai_suggested", origin: "radar" }));
const realIssue = card("issue", "i-real", "是否调整研发排期", issuePayload());

const RADAR = 'data-origin-tag="radar"';

describe("来源标注组件", () => {
  it("只有来自雷达的议题出「雷达」小标签（读屏「来自雷达」）；资料包导入的 AI 候选议题与普通议题什么都不显示", () => {
    const radar = renderToStaticMarkup(<RadarOriginTag issue={{ nature: "ai_suggested", origin: "radar" }} />);
    expect(radar).toContain(RADAR);
    expect(radar).toContain('aria-label="来自雷达"');
    expect(radar).toMatch(/<svg[^>]*data-origin-radar="true"[^>]*>.*<\/svg>雷达<\/span>/);
    expect(renderToStaticMarkup(<RadarOriginTag issue={{ fromRadar: true }} />)).toContain(RADAR);
    expect(renderToStaticMarkup(<RadarOriginTag issue={{ nature: "ai_suggested" }} />)).toBe("");
    expect(renderToStaticMarkup(<RadarOriginTag issue={{}} />)).toBe("");
    expect(isFromRadar({ origin: "radar" })).toBe(true);
    expect(isFromRadar({ origin: "dri" })).toBe(false);
  });

  it("首页待决策议题行：AI 候选议题不标来源；雷达来源的标题旁有「雷达」小标签，读屏说来自雷达", () => {
    const render = (item: Card) => renderToStaticMarkup(<IssueRow issue={issueRowData(item, new Map())} onNavigate={() => undefined} />);
    const ai = render(aiIssue);
    expect(ai).not.toContain("data-origin-tag");
    expect(ai).not.toContain("AI 建议");
    expect(ai).toContain("是否把验收清单前置到签约前");
    expect(render(realIssue)).not.toContain("data-origin-tag");
    const radar = render(radarIssue);
    expect(radar).toMatch(/<span title="是否跟进竞品降价">是否跟进竞品降价<span[^>]*data-origin-tag="radar"[^>]*>/);
    expect(radar).toContain("是否跟进竞品降价（来自雷达）");
    expect(radar).not.toContain("AI 建议");
  });
});

describe("议题页页头", () => {
  it("标题后面只在来自雷达时接「雷达」小标签（IssueCard 把 RadarOriginTag 作为 titleTag 传给页头）；其他来源和不传都和普通议题一样", () => {
    const radar = renderToStaticMarkup(<DetailFrame title="是否跟进竞品降价" titleTag={<RadarOriginTag issue={{ nature: "ai_suggested", origin: "radar" }} />} onBack={() => undefined} headingId="issue-title" />);
    expect(radar).toMatch(/<h1 id="issue-title">是否跟进竞品降价<span[^>]*data-origin-tag="radar"[^>]*>/);
    const imported = renderToStaticMarkup(<DetailFrame title="是否把验收清单前置到签约前" titleTag={<RadarOriginTag issue={{ nature: "ai_suggested" }} />} onBack={() => undefined} headingId="issue-title" />);
    expect(imported).toContain('<h1 id="issue-title">是否把验收清单前置到签约前</h1>');
    const plain = renderToStaticMarkup(<DetailFrame title="是否调整研发排期" titleTag={<RadarOriginTag issue={{}} />} onBack={() => undefined} headingId="issue-title" />);
    expect(plain).toContain('<h1 id="issue-title">是否调整研发排期</h1>');
  });
});

describe("会前预审报告的依据", () => {
  it("引用议题时依据名不再带「AI 建议」", () => {
    const context = emptySourceContext({
      issueTitle: (id) => (id === "i-ai" ? "是否把验收清单前置到签约前" : id === "i-real" ? "是否调整研发排期" : undefined),
    });
    expect(sourceLabel("issue:i-ai", context)).toBe("议题「是否把验收清单前置到签约前」");
    expect(sourceLabel("issue:i-real", context)).toBe("议题「是否调整研发排期」");
  });
});
