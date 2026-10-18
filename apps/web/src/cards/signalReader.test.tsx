import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { WorkspaceTestProvider } from "@/components/shell/testing";
import { SignalCard, joinSentences, signalSourceLabel, upNextSignals } from "./SignalCard";
import { SignalStory } from "./SignalStory";
import { SignalArticle } from "./SignalArticle";
import { personalReading } from "@/components/radar/MemberSignalScreen";

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

  it("信号页头沿用会议的紧凑阅读页，并返回信号列表", () => {
    const html = render(signalCard("outlet", "CNBC"));
    expect(html).toContain('class="ts-detail-header"');
    expect(html).toContain(">信号详情<");
    expect(html).toContain(">雷达<");
    expect(html).toContain("返回信号列表");
    expect(html).toContain("data-close-view");
    expect(html).toContain('data-radar-reader-layout="true"');
  });

  it("标题是文章标题，三块内容：总结（含尚未确定）/ 对公司的影响（含战略锚点）/ 原文", () => {
    const html = render(signalCard("web", "Web", { assessment: { anchorId: "a1", location: { type: "company" }, summary: "摘要", strategicImpact: "影响", evidenceQuote: "", unknowns: ["是否适用于中国"], score: { relevance: 1, impact: 1, urgency: 1 } } }));
    expect(html).toContain(">欧盟就企业 AI 代理发布新规<");
    expect(html).toContain(">总结<");
    expect(html).toContain("尚未确定");
    expect(html).toContain("是否适用于中国");
    expect(html).toContain(">对公司的影响<");
    expect(html).toContain("战略锚点 · 企业 Agent 监管");
    expect(html).toContain('aria-label="原文"');
    expect(html).toContain("仅摘要 ·");
    expect(html).not.toContain("以上是来源给出的摘要");
  });

  it("原文：点进来就是全文，不再要按钮展开；出处行末一个低调的原文链接", () => {
    const html = render(signalCard("outlet", "CNBC"));
    expect(html).not.toContain("data-expanded");
    expect(html).not.toContain("展开全部摘录");
    expect(html).toContain("原文摘录");
    expect(html).toContain('aria-label="原文链接：欧盟就企业 AI 代理发布新规"');
    expect(html).not.toContain("阅读原文");
  });

  it("出处行：逐篇抓取文章页的发布方写「发布方原文（自动抓取）」，检索/feed 摘录不宣称全文", () => {
    const fullText = render(signalCard("outlet", "量子位", { source: { type: "outlet", title: "文章", url: "https://www.qbitai.com/a", publishedAt: "2026-09-24T02:00:00.000Z", excerpt: "原文", fullText: true } }));
    expect(fullText).toContain("发布方原文（自动抓取） · 共 2 字 · 采集于");
    expect(fullText).not.toContain("原文摘录");
    const excerpt = render(signalCard("outlet", "CNBC", { source: { type: "outlet", title: "文章", url: "https://www.cnbc.com/a", publishedAt: "2026-09-24T02:00:00.000Z", excerpt: "摘录", fullText: false } }));
    expect(excerpt).toContain("原文摘录 · 共 2 字 · 采集于");
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
    // 图走同源代理，且不带 Referer（防盗链站点直连时也不因 Referer 被拒）
    expect(html).toContain('referrerPolicy="no-referrer"');
  });

  it("原文首图放在正文开头，原文里不再重复这一张；其余配图照常按位插入", () => {
    const reading = {
      title: "有图的信号", sourceLabel: "量子位", publishedAt: "2026-09-24T02:00:00.000Z", summary: "摘要", unknowns: [],
      relation: { heading: "对公司的影响", text: "影响" }, excerpt: "第一段\n\n第二段", evidenceQuote: "", fullText: true,
      collectedAt: "2026-09-24T02:00:00.000Z", url: "https://example.com/i",
      images: [{ src: "/api/signals/1/images/0", after: 0 }, { src: "/api/signals/1/images/1", after: 1 }],
    };
    const html = renderToStaticMarkup(
      <SignalArticle reading={reading} state={{}} pending={false} error={null} onUpdate={async () => true} onRetry={() => undefined} upNext={[]} />,
    );
    expect(html.match(/src="\/api\/signals\/1\/images\/0"/g)).toHaveLength(1);
    // 首图是正文的第一张图：在简报之后、正文第一段之前。
    expect(html.indexOf('src="/api/signals/1/images/0"')).toBeGreaterThan(html.indexOf("总结"));
    expect(html.indexOf('src="/api/signals/1/images/0"')).toBeLessThan(html.indexOf("第一段"));
    expect(html.indexOf('src="/api/signals/1/images/1"')).toBeGreaterThan(html.indexOf("第二段"));
    const plain = renderToStaticMarkup(
      <SignalArticle reading={{ ...reading, images: [] }} state={{}} pending={false} error={null} onUpdate={async () => true} onRetry={() => undefined} upNext={[]} />,
    );
    expect(plain).not.toContain("<img");
    expect(plain).not.toContain("<figure");
  });

  it("成员版正文与公司版同一份排版：关系写「和你的方向」、正文用命中理由、标签写你的方向；没有尚未确定与配图", () => {
    const personal = {
      id: "7f1c0e0a-2b1d-4c55-9a55-0a0b0c0d0e0f",
      source: { type: "outlet" as const, label: "金融时报", title: "欧洲的企业 Agent 采购开始按结果付费", url: "https://www.ft.com/a", publishedAt: "2026-09-26T02:00:00.000Z", listedOn: null, listing: null },
      direction: { id: "d_1", text: "Agent 的定价方式" },
      summary: "采购方开始按结果付费",
      reason: "直接回答了按结果收费能否被大客户接受",
      relevance: 5,
      state: { read: false, saved: false, dismissed: false },
      collectedAt: "2026-09-26T03:00:00.000Z",
      excerpt: "第一段原文。",
      fullText: false,
      evidenceQuote: "第一段原文",
    };
    const html = renderToStaticMarkup(
      <SignalArticle reading={personalReading(personal)} state={personal.state} pending={false} error={null} onUpdate={async () => true} onRetry={() => undefined} upNext={[]} />,
    );
    expect(html).toContain(">和你的方向<");
    expect(html).toContain("直接回答了按结果收费能否被大客户接受");
    expect(html).toContain("你的方向 · Agent 的定价方式");
    expect(html).toContain("金融时报 · 2026/9/26");
    expect(html).not.toContain("对公司的影响");
    expect(html).not.toContain("战略锚点");
    expect(html).not.toContain("尚未确定");
    expect(html).not.toContain("<img");
    expect(html).toContain("不再出现在阅读列表");
  });

  it("成员版的榜单条目（02b）：写上榜日、语言与时段 star，不写发布日期；原文说明是榜单条目、未读仓库内容", () => {
    const listed = {
      id: "7f1c0e0a-2b1d-4c55-9a55-0a0b0c0d0e10",
      source: { type: "list" as const, label: "GitHub Trending", title: "owner/agent", url: "https://github.com/owner/agent", publishedAt: null, listedOn: "2026-10-08", listing: { language: "Rust", starsInPeriod: 321, since: "weekly" as const } },
      direction: { id: "d_1", text: "Agent 的工程实践" },
      summary: "一个 Agent 框架进入本周榜单",
      reason: "和你关注的 Agent 工程实践直接相关",
      relevance: 4,
      state: { read: false, saved: false, dismissed: false },
      collectedAt: "2026-10-08T02:00:00.000Z",
      excerpt: "owner/agent：没有描述（语言 Rust，本周 321 star）",
      fullText: false,
      evidenceQuote: "没有描述",
    };
    const html = renderToStaticMarkup(
      <SignalArticle reading={personalReading(listed)} state={listed.state} pending={false} error={null} onUpdate={async () => true} onRetry={() => undefined} upNext={[]} />,
    );
    expect(html).toContain("GitHub Trending · 上榜于 2026/10/8 · Rust · 本周 321 star");
    expect(html).toContain("GitHub Trending 的榜单条目，未读取仓库内容");
    expect(html).not.toContain("检索服务返回的摘录");
    expect(html).not.toContain("日期未提供");
  });
});
