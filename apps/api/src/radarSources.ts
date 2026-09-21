import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TRadarSourceItem } from "@warmap/contracts";
import type { RadarWebAdapter, RadarWechatAdapter } from "./radar.js";
import { createBochaWebSearchAdapter, type BochaWebSearchOptions } from "./webSearch.js";

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Web 来源只走博查（Ticket 16 决策，删除 Brave/SEARCH_API_KEY）。
 * 无发布时间的搜索结果不进入时间窗研判，避免用抓取时间冒充发布时间。
 */
export function createBochaRadarWebAdapter(options: BochaWebSearchOptions): RadarWebAdapter {
  const search = createBochaWebSearchAdapter(options);
  return {
    configured: search.configured,
    async search(input, signal): Promise<TRadarSourceItem[]> {
      const { results } = await search.search({ query: input.query, domains: input.domains }, signal);
      // RadarSourceItem.publishedAt 必填：无发布时间的条目留在管线外，不拿抓取时间冒充发布时间
      return results.flatMap((result) => result.publishedAt ? [{
        sourceType: "web" as const,
        title: result.title,
        url: result.url,
        publishedAt: result.publishedAt,
        excerpt: result.excerpt,
        sourceRef: { type: "web-search" as const, provider: "bocha", query: input.query },
      }] : []);
    },
  };
}

export type WechatMcpCallTool = (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

/** list_subscriptions 走 structuredContent({result})，get_recent_articles/read_article 走 text JSON。 */
function unwrapToolResult(value: unknown): unknown {
  const record = obj(value);
  if ("result" in record && Object.keys(record).length === 1) return record.result;
  return value;
}

function callToolResult(result: unknown): unknown {
  const record = obj(result);
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content.map((part) => str(obj(part).text)).filter(Boolean).join("\n");
  if (record.isError === true) throw new Error(text || "公众号 MCP tool 调用失败");
  if (record.structuredContent !== undefined) return unwrapToolResult(record.structuredContent);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function createStreamableHttpCallTool(url: string, token: string): WechatMcpCallTool {
  return async (name, args, signal) => {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "warmap-radar", version: "1.0.0" });
    try {
      await client.connect(transport, { signal });
      const result = await client.callTool({ name, arguments: args }, undefined, { signal });
      return callToolResult(result);
    } finally {
      await client.close().catch(() => undefined);
    }
  };
}

export type WechatMcpAdapterOptions = {
  /** sidecar 内网 MCP 端点，如 http://wechat:5000/mcp；不经 Caddy。 */
  url?: string;
  /** sidecar 的静态 Bearer Token；WarMap 从不接触微信 Cookie。 */
  token?: string;
  limit?: number;
  /** 测试注入；默认用真实 MCP Streamable HTTP client。 */
  callTool?: WechatMcpCallTool;
};

/**
 * 公众号来源只按稳定账号（fakeid）经 tmwgsicp/wechat-download-api sidecar 的 MCP 拉取：
 * list_subscriptions 校验账号来源，get_recent_articles 取列表，正文摘要缺失时 read_article。
 * 不使用关键词检索或 site:mp.weixin.qq.com 替代账号订阅。
 */
export function createWechatMcpAdapter({
  url,
  token,
  limit = 30,
  callTool,
}: WechatMcpAdapterOptions): RadarWechatAdapter {
  const configured = Boolean(url && token);
  const call = callTool ?? (configured ? createStreamableHttpCallTool(url!, token!) : undefined);
  return {
    configured,
    async fetchLatest({ accountId, accountName }, signal): Promise<TRadarSourceItem[]> {
      if (!call) throw new Error("微信公众号 sidecar 未配置 WECHAT_MCP_URL/WECHAT_MCP_TOKEN");
      const subscriptions = await call("list_subscriptions", {}, signal);
      const subscribed = (Array.isArray(subscriptions) ? subscriptions : [])
        .some((entry) => str(obj(entry).fakeid) === accountId);
      if (!subscribed) {
        throw new Error(`账号 ${accountId}（${accountName}）不在公众号 sidecar 订阅列表；拒绝退回关键词搜索`);
      }
      const payload = obj(await call("get_recent_articles", { since: 0, limit, source_id: accountId }, signal));
      const articles = Array.isArray(payload.articles) ? payload.articles : [];
      const items: TRadarSourceItem[] = [];
      // CEO 2026-09-21 裁决：Signal 存完整原文而非摘录；digest 是 teaser，不能代表原文。
      // read_article 每次都是真实抓取：单账号单次扫描至多 15 次全文读取，其余退回 digest，避免对 sidecar 触发大量抓取。
      let fullTextReads = 0;
      for (const raw of articles) {
        const article = obj(raw);
        const title = str(article.title);
        const link = str(article.link);
        const publishTime = Number(article.publish_time);
        if (!title || !link || !Number.isFinite(publishTime) || publishTime <= 0) continue;
        try {
          new URL(link);
        } catch {
          continue;
        }
        let excerpt = "";
        let images: { src: string; after: number }[] | undefined;
        if (fullTextReads < 15) {
          fullTextReads += 1;
          const full = await readArticleText(call, Number(article.id), signal);
          excerpt = full.text;
          if (full.images.length) images = full.images;
        }
        excerpt = excerpt || str(article.digest);
        items.push({
          sourceType: "wechat-account",
          title,
          url: link,
          publishedAt: new Date(publishTime * 1000).toISOString(),
          excerpt: excerpt.slice(0, 10_000) || title,
          sourceRef: { type: "wechat-account", provider: "wechat-mcp", accountId, accountName },
          ...(images ? { images } : {}),
        });
      }
      return items;
    },
  };
}

/**
 * 公众号全文：去 YAML frontmatter；markdown 图片行 `![](https://…)` 提为按位配图（after = 前一段索引），
 * 其余保留段落换行（Signal 阅读页 pre-wrap 渲染），压平行内空白。
 */
async function readArticleText(
  call: WechatMcpCallTool,
  articleId: number,
  signal: AbortSignal,
): Promise<{ text: string; images: { src: string; after: number }[] }> {
  if (!Number.isFinite(articleId)) return { text: "", images: [] };
  try {
    const raw = await call("read_article", { article_id: articleId }, signal);
    if (typeof raw !== "string") return { text: "", images: [] };
    const lines = raw.replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
    const images: { src: string; after: number }[] = [];
    const out: string[] = [];
    let separators = 0;
    let pendingBlank = false;
    for (const line of lines) {
      const img = line.match(/^!\[[^\]]*\]\((https:\/\/[^)\s]+)\)\s*$/);
      if (img) {
        if (images.length < 12) images.push({ src: img[1].slice(0, 1000), after: Math.max(0, separators - 1) });
        continue;
      }
      const trimmed = line.replace(/\s+/g, " ").trim();
      if (!trimmed) {
        pendingBlank = out.length > 0;
        continue;
      }
      if (pendingBlank) {
        out.push("");
        separators += 1;
        pendingBlank = false;
      }
      out.push(trimmed);
    }
    const text = out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "").slice(0, 10_000);
    return { text, images };
  } catch {
    return { text: "", images: [] };
  }
}
