import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";

import { RadarOriginTag } from "./OriginTag";
import { IssueRow, issueRowData } from "./IssueRow";
import { railGroups } from "./NotificationRail";

// 来源标识只留雷达：雷达自动升级的议题带「雷达图标 + 雷达」小标签（读屏「来自雷达」）；资料包导入的 AI 候选议题什么都不标。

function card(kind: string, id: string, title: string, payload: unknown, urgency?: string): Card {
  return { schemaVersion: 1, id: `${kind}:${id}`, version: 1, kind, objectRef: { type: kind, id, version: 1 }, title, payload, actions: [], ...(urgency ? { urgency } : {}) } as unknown as Card;
}
const issuePayload = (origin: "radar" | "dri") => ({
  origin, originRef: null, status: "pending", location: { level: "company", relatedBattlefieldIds: [] }, urgency: { level: "red" },
  research: { status: "failed" }, receipts: [], dismissedAt: null, dismissReason: null, nature: "ai_suggested",
});
const radarIssue = card("issue", "i-radar", "是否跟进竞品降价", issuePayload("radar"), "red");
const importedIssue = card("issue", "i-imported", "是否把验收清单前置到签约前", issuePayload("dri"), "red");
const ICON = 'data-origin-radar="true"';
const RADAR_TAG = /<span[^>]*data-origin-tag="radar"[^>]*aria-label="来自雷达"[^>]*title="来自雷达"[^>]*><svg[^>]*data-origin-radar="true"[^>]*>.*?<\/svg>雷达<\/span>/;
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("来自雷达的议题", () => {
  it("标签：雷达来源（origin=radar 或 fromRadar）有图标和「雷达」二字并写读屏说明；资料包导入的与普通议题没有", () => {
    expect(renderToStaticMarkup(<RadarOriginTag issue={{ nature: "ai_suggested", origin: "radar" }} />)).toMatch(RADAR_TAG);
    expect(renderToStaticMarkup(<RadarOriginTag issue={{ nature: "ai_suggested", fromRadar: true }} />)).toMatch(RADAR_TAG);
    expect(renderToStaticMarkup(<RadarOriginTag issue={{ nature: "ai_suggested", origin: "dri" }} />)).toBe("");
    expect(renderToStaticMarkup(<RadarOriginTag issue={{ origin: "dri" }} />)).toBe("");
  });

  it("首页 / 集团块议题行：雷达来源有标签，读屏写「来自雷达」；导入来源什么都没有", () => {
    const render = (item: Card) => renderToStaticMarkup(<IssueRow issue={issueRowData(item, new Map())} onNavigate={() => undefined} />);
    const radar = render(radarIssue);
    expect(radar).toMatch(RADAR_TAG);
    expect(radar).toContain("是否跟进竞品降价（来自雷达）");
    expect(radar).not.toContain("AI 建议");
    const imported = render(importedIssue);
    expect(imported).not.toContain(ICON);
    expect(imported).not.toContain("AI 建议");
    expect(imported).toContain("是否把验收清单前置到签约前");
  });

  it("左栏通知：研究组副标题里雷达来源写「雷达」并带图标；只有导入来源时不写来源", () => {
    const subtitle = (cards: Card[]) => {
      const group = railGroups(cards, new Date("2026-10-11T02:00:00Z")).find((item) => item.kind === "research")!;
      return renderToStaticMarkup(<small>{group.subtitle}</small>);
    };
    const both = subtitle([radarIssue, importedIssue]);
    expect(count(both, ICON)).toBe(1);
    expect(both).toMatch(/<span aria-label="来自雷达" title="来自雷达"><svg[^>]*>.*?<\/svg>雷达<\/span>/);
    expect(both).not.toContain("AI 建议");
    expect(subtitle([importedIssue])).not.toContain("AI 建议");
  });
});
