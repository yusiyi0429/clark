import type { FeishuClient, FeishuReceiveIdType } from "./client.js";
import { safeNextPath } from "./oauth.js";

export type FeishuReceiver = { type: FeishuReceiveIdType; id: string };
export type FeishuLinkCard = {
  title: string;
  /** 正文按纯文本显示，不解析 Markdown。 */
  body: string;
  /** 每个按钮都是跳回天枢的站内路径；V1 不接卡片回调。 */
  links: { label: string; path: string }[];
};

/**
 * 跳回天枢的深链接：经 /api/auth/feishu/start，已登录直接进 path，没登录先走飞书授权免登。
 * 在飞书客户端和普通浏览器里点开都能用。
 */
export function feishuDeepLink(publicOrigin: string, path: string): string {
  return `${publicOrigin}/api/auth/feishu/start?next=${encodeURIComponent(safeNextPath(path))}`;
}

/** 消息卡片（1.0 结构）：标题、纯文本正文、一排链接按钮，没有回传交互。 */
export function linkCardContent(card: FeishuLinkCard, publicOrigin: string): object {
  return {
    config: { wide_screen_mode: true },
    header: { template: "blue", title: { tag: "plain_text", content: card.title } },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: card.body } },
      {
        tag: "action",
        actions: card.links.map((link, index) => ({
          tag: "button",
          text: { tag: "plain_text", content: link.label },
          type: index === 0 ? "primary" : "default",
          url: feishuDeepLink(publicOrigin, link.path),
        })),
      },
    ],
  };
}

export function sendFeishuText(client: Pick<FeishuClient, "sendMessage">, to: FeishuReceiver, text: string, options?: { uuid?: string }) {
  return client.sendMessage(to.type, to.id, "text", { text }, options);
}

export function sendFeishuLinkCard(client: Pick<FeishuClient, "sendMessage">, to: FeishuReceiver, card: FeishuLinkCard, publicOrigin: string, options?: { uuid?: string }) {
  return client.sendMessage(to.type, to.id, "interactive", linkCardContent(card, publicOrigin), options);
}
