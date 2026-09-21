import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { ConversationDock } from "@/conversation/ConversationDock";
import { SignalCard, signalSourceLabel } from "./SignalCard";

function signalCard(type: string, badge?: string): Card {
  return {
    schemaVersion: 1,
    id: "signal:1",
    version: 1,
    kind: "signal",
    objectRef: { type: "signal", id: "1", version: 1 },
    title: "对象",
    badge,
    payload: {
      source: { type, title: "标题", url: "https://example.com/a", publishedAt: "2025-09-17T09:40:00.000Z", excerpt: "摘录" },
      assessment: { anchorId: "a1", location: { type: "company" }, summary: "摘要", strategicImpact: "影响", evidenceQuote: "引用", unknowns: [], score: { relevance: 1, impact: 1, urgency: 1 } },
      state: { read: false, saved: false, dismissed: false },
      collectedAt: "2025-09-17T09:40:00.000Z",
    },
    actions: [],
  } as unknown as Card;
}

function render(card: Card): string {
  return renderToStaticMarkup(
    <SignalCard card={card} collection={[card]} onCard={() => undefined} onNavigate={() => undefined} />,
  );
}

describe("Signal 阅读", () => {
  it("来源类型与发布方都用真实字段", () => {
    expect(signalSourceLabel("wechat-account")).toBe("微信公众号");
    expect(signalSourceLabel("outlet")).toBe("发布方级媒体来源");
    expect(signalSourceLabel("web")).toBe("Web");
    // 发布方级来源带真实媒体名；Web 搜索没有可核验发布方，只显示类型。
    expect(render(signalCard("outlet", "CNBC"))).toContain("发布方级媒体来源 · CNBC · 采集于 2025-09-17 09:40");
    expect(render(signalCard("web", "Web"))).toContain("Web · 采集于 2025-09-17 09:40");
  });

  it("右侧栏复用同一个 Conversation，不另建对话入口", () => {
    const html = render(signalCard("outlet", "CNBC"));
    expect(html).toContain('data-testid="meeting-chat-sidebar"');
    expect(html).toContain('data-tone="light"');
    expect(html).toContain("问天枢：本条信号…");
    expect(html).toContain('data-testid="conversation-dock"');
  });

  it("渲染真实抓到的来源文本，且不宣称已内嵌全文", () => {
    const html = render(signalCard("outlet", "CNBC"));
    expect(html).toContain('aria-label="原文"');
    expect(html).toContain("摘录");
    expect(html).not.toContain("原文全文");
  });

  it("浅色侧栏收起时用指向左的箭头还原，不用消息图标", () => {
    const html = renderToStaticMarkup(
      <ConversationDock
        scope="signal:1"
        label="对象"
        availableCards={[]}
        variant="sidebar"
        sidebar={{ title: "对话 · 本条信号", tone: "light", open: false }}
      />,
    );
    expect(html).toContain('data-open="false"');
    expect(html).toContain('aria-label="展开对话 · 本条信号"');
    expect(html).toContain("lucide-chevron-left");
    expect(html).not.toContain("lucide-message-circle");
  });
});
