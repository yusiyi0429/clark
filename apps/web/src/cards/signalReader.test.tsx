import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { WorkspaceTestProvider } from "@/components/shell/testing";
import { SignalCard, joinSentences, signalSourceLabel, upNextSignals } from "./SignalCard";
import { SignalStory } from "./SignalStory";

function signalCard(type: string, badge?: string, patch: Record<string, unknown> = {}): Card {
  return {
    schemaVersion: 1,
    id: "signal:1",
    version: 1,
    kind: "signal",
    objectRef: { type: "signal", id: "1", version: 1 },
    title: "对象",
    badge,
    payload: {
      source: { type, title: "欧盟就企业 AI 代理发布新规", url: "https://example.com/a", publishedAt: "2025-09-17T09:40:00.000Z", excerpt: "摘录" },
      assessment: {
        anchorId: "a1",
        location: { type: "company" },
        summary: "摘要",
        strategicImpact: "影响",
        evidenceQuote: "引用",
        unknowns: [],
        score: { relevance: 1, impact: 1, urgency: 1 },
      },
      state: { read: false, saved: false, dismissed: false },
      collectedAt: "2025-09-17T09:40:00.000Z",
      ...patch,
    },
    actions: [],
  } as unknown as Card;
}

const radar = {
  schemaVersion: 1,
  id: "radar:default",
  version: 1,
  kind: "radar",
  objectRef: { type: "radar", id: "default", version: 1 },
  title: "Radar",
  payload: { anchors: [{ id: "a1", title: "企业 Agent 监管", query: "海外监管对企业 Agent 的影响", location: { type: "company" } }] },
  actions: [],
} as unknown as Card;

function render(card: Card, homeCards: Card[] = [radar]): string {
  return renderToStaticMarkup(
    <WorkspaceTestProvider api={{ homeCards }}>
      <SignalCard card={card} collection={[card]} onCard={() => undefined} onNavigate={() => undefined} />
    </WorkspaceTestProvider>,
  );
}

describe("Signal 阅读", () => {
  it("来源：发布方级来源写真实媒体名，其余只写类型；日期按公司时区", () => {
    expect(signalSourceLabel("wechat-account")).toBe("微信公众号");
    expect(signalSourceLabel("outlet")).toBe("发布方级媒体来源");
    expect(signalSourceLabel("web")).toBe("Web");
    expect(render(signalCard("outlet", "CNBC"))).toContain("CNBC · 2025/9/17");
    expect(render(signalCard("web", "Web"))).toContain("Web · 2025/9/17");
  });

  it("页头按 clark：信号详情眉题、返回信号列表、关闭雷达", () => {
    const html = render(signalCard("outlet", "CNBC"));
    expect(html).toContain("信号详情 · 雷达");
    expect(html).toContain("返回信号列表");
    expect(html).toContain('aria-label="关闭雷达"');
    expect(html).toContain('data-radar-reader-layout="true"');
  });

  it("标题是文章标题，三块内容：总结（含尚未确定）/ 对我们的影响（含战略锚点）/ 原文", () => {
    const html = render(signalCard("web", "Web", { assessment: { anchorId: "a1", location: { type: "company" }, summary: "摘要", strategicImpact: "影响", evidenceQuote: "", unknowns: ["是否适用于中国"], score: { relevance: 1, impact: 1, urgency: 1 } } }));
    expect(html).toContain(">欧盟就企业 AI 代理发布新规<");
    expect(html).toContain(">总结<");
    expect(html).toContain("尚未确定");
    expect(html).toContain("是否适用于中国");
    expect(html).toContain(">对我们的影响<");
    expect(html).toContain("战略锚点 · 企业 Agent 监管");
    expect(html).toContain(">原文<");
  });

  it("原文：点进来就是全文，不再要按钮展开；出处行末一个低调的原文链接", () => {
    const html = render(signalCard("outlet", "CNBC"));
    expect(html).not.toContain("data-expanded");
    expect(html).not.toContain("展开全部摘录");
    expect(html).toContain("检索服务返回的摘录，未宣称阅读全文");
    expect(html).toContain('aria-label="原文链接：欧盟就企业 AI 代理发布新规"');
    expect(html).not.toContain("阅读原文");
  });

  it("出处行：逐篇抓取文章页的发布方写「发布方原文（自动抓取）」，检索/feed 摘录不宣称全文", () => {
    const fullText = render(signalCard("outlet", "量子位", { source: { type: "outlet", title: "文章", url: "https://www.qbitai.com/a", publishedAt: "2026-09-24T02:00:00.000Z", excerpt: "原文", fullText: true } }));
    expect(fullText).toContain("发布方原文（自动抓取） · 共 2 字 · 采集于");
    expect(fullText).not.toContain("未宣称阅读全文");
    const excerpt = render(signalCard("outlet", "CNBC", { source: { type: "outlet", title: "文章", url: "https://www.cnbc.com/a", publishedAt: "2026-09-24T02:00:00.000Z", excerpt: "摘录", fullText: false } }));
    expect(excerpt).toContain("检索服务返回的摘录，未宣称阅读全文 · 共 2 字 · 采集于");
    expect(excerpt).not.toContain("发布方原文");
  });

  it("状态：收藏是图标切换，隐藏写成「不再出现在阅读列表」，已读/未读手动切换", () => {
    const html = render(signalCard("outlet", "CNBC"));
    expect(html).toContain('aria-label="收藏信号"');
    expect(html).toContain("不再出现在阅读列表");
    expect(html).toContain("标记为已读");
  });

  it("多条尚未确定连成一段，不出现「。；」", () => {
    expect(joinSentences(["报道未说明漏洞成因。", "尚不清楚是否为准入要求"])).toBe("报道未说明漏洞成因。尚不清楚是否为准入要求。");
  });

  it("对话由工作面右侧的对话列提供，信号卡自己不再内嵌对话栏", () => {
    const html = render(signalCard("outlet", "CNBC"));
    expect(html).not.toContain('data-testid="conversation-dock"');
    expect(html).not.toContain('data-testid="meeting-chat-sidebar"');
  });

  it("继续浏览：未隐藏的信号按时间倒序，从当前这条往后排、排到底回到头上，不含当前这条", () => {
    const at = (id: string, day: string, dismissed = false) =>
      signalCard("outlet", "CNBC", { source: { type: "outlet", title: id, url: "https://example.com/" + id, publishedAt: `2026-09-${day}T02:00:00.000Z`, excerpt: "摘录" }, state: { read: false, saved: false, dismissed } });
    const cards = [at("a", "24"), at("b", "23"), at("c", "22"), at("d", "21", true)].map((card, index) => ({ ...card, id: `signal:${index}` }) as Card);
    const order = (current: Card) => upNextSignals(current, cards).map((card) => (card.payload as { source: { title: string } }).source.title);
    expect(order(cards[1])).toEqual(["c", "a"]);
    expect(order(cards[0])).toEqual(["b", "c"]);
  });

  it("原文有配图时，信号卡带第一张图作陪衬；没有图就是纯文字卡", () => {
    const withImage = signalCard("outlet", "量子位", { source: { type: "outlet", title: "有图", url: "https://example.com/i", publishedAt: "2026-09-24T02:00:00.000Z", excerpt: "摘录", images: [{ src: "https://i.example.com/1.png", after: 0 }] } });
    const html = renderToStaticMarkup(<SignalStory card={withImage} onOpen={() => undefined} />);
    expect(html).toContain('src="/api/signals/1/images/0"');
    expect(html).toContain("data-has-image");
    expect(renderToStaticMarkup(<SignalStory card={signalCard("outlet", "CNBC")} onOpen={() => undefined} />)).not.toContain("<img");
  });
});
