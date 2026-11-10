import { randomUUID } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Value } from "@sinclair/typebox/value";
import { WebSearchInput } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";
import type { WebSearchAdapter } from "./webSearch.js";

/**
 * /mcp/me 的只读工具 web_search（V2 第 18 节「联网搜索」）：本机程序拉起的 Claude Code、Codex 不管接哪家模型，都经它用博查搜，
 * 钥匙只在服务器。每人每分钟、每天有上限；每真搜一次在 web_search_calls 记一行，按次算钱。挂进 mcpMe.ts 的工具列表是共享文件那一步。
 */
export const WEB_SEARCH_PER_MINUTE = 10;
export const WEB_SEARCH_PER_DAY = 200;
// 交给模型的结果和对话里的 web_search 一样：去重，最多 8 条，摘要截到 500 字，不带图。
const RESULTS_FOR_MODEL = 8;
const EXCERPT_CHARS = 500;

export const WEB_SEARCH_TOOL: Tool = {
  name: "web_search",
  description: `联网搜索（博查）：查当前的外部事实，返回标题、链接、摘要和发布时间；freshness 限定时间，domains 限定网站。每人每分钟最多 ${WEB_SEARCH_PER_MINUTE} 次、`
    + `每天 ${WEB_SEARCH_PER_DAY} 次，证据够了就停。Read-only web search (Bocha) for current external facts.`,
  inputSchema: WebSearchInput as Tool["inputSchema"],
  annotations: { readOnlyHint: true, openWorldHint: true },
};

type Found = { title: string; url: string; excerpt: string; publishedAt?: string };
export type WebSearchToolResult = { ok: true; value: { results: Found[]; warnings: string[] } }
  | { ok: false; code: "INVALID_INPUT" | "WEB_SEARCH_NOT_CONFIGURED" | "RATE_LIMITED" | "WEB_SEARCH_FAILED"; message: string };

/** 先占一次额度（并发时最多多出一两次），再搜；成没成都记下。provider 的错误只进日志，不回给模型。 */
export async function runWebSearch(deps: { q: Query; search: WebSearchAdapter & { configured: boolean }; now: Date },
  caller: { personId: string; client: string }, args: unknown, signal: AbortSignal): Promise<WebSearchToolResult> {
  if (!Value.Check(WebSearchInput, args)) return { ok: false, code: "INVALID_INPUT", message: "query 必填（500 字内）；freshness 只能是 day、week、month、year；domains 最多 20 个" };
  if (!deps.search.configured) return { ok: false, code: "WEB_SEARCH_NOT_CONFIGURED", message: "联网搜索还没接通" };
  const id = randomUUID();
  const taken = await deps.q(`INSERT INTO web_search_calls(id,person_id,client,at) SELECT $1,$2,$3,$4
    WHERE (SELECT count(*) FROM web_search_calls WHERE person_id=$2 AND at>$4::timestamptz-interval '1 minute')<$5
      AND (SELECT count(*) FROM web_search_calls WHERE person_id=$2
        AND at>=date_trunc('day',$4::timestamptz AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')<$6
    RETURNING id`, [id, caller.personId, caller.client, deps.now, WEB_SEARCH_PER_MINUTE, WEB_SEARCH_PER_DAY]);
  if (!taken.rows.length) return { ok: false, code: "RATE_LIMITED",
    message: `搜得太频繁了：每人每分钟最多 ${WEB_SEARCH_PER_MINUTE} 次、每天 ${WEB_SEARCH_PER_DAY} 次。先用已有材料作答，或稍后再搜` };
  try {
    const response = await deps.search.search(args, signal);
    const seen = new Set<string>();
    const results = response.results.flatMap(({ title, url, excerpt, publishedAt }) => {
      if (seen.has(url)) return [];
      seen.add(url);
      return [{ title, url, excerpt: excerpt.length > EXCERPT_CHARS ? `${excerpt.slice(0, EXCERPT_CHARS)}…` : excerpt, ...(publishedAt ? { publishedAt } : {}) }];
    }).slice(0, RESULTS_FOR_MODEL);
    await deps.q("UPDATE web_search_calls SET ok=TRUE,result_count=$2 WHERE id=$1", [id, results.length]);
    return { ok: true, value: { results, warnings: response.warnings } };
  } catch (cause) {
    await deps.q("UPDATE web_search_calls SET ok=FALSE WHERE id=$1", [id]);
    logEvent({ event: "mcp.web_search.failed", personId: caller.personId, error: cause instanceof Error ? cause.message : String(cause) });
    return { ok: false, code: "WEB_SEARCH_FAILED", message: "搜索服务这次没成，稍后再试，或先用已有材料作答" };
  }
}
