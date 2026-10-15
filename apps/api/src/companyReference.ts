import { Type } from "@sinclair/typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { companyProse, readCompanyContext, type CompanyContext } from "./companyContext.js";

/** One candidate run owns its short continuation handles; World cursor metadata stays server-side. */
export function createCompanyReference(context: CompanyContext, signal?: AbortSignal) {
  const continuations = new Map<string, { cursor: string; query?: string }>();
  const read = async (request: { query?: string; cursor?: string }) => {
    const saved = request.cursor ? continuations.get(request.cursor) : undefined;
    if (request.cursor && (!saved || request.query !== undefined && request.query !== saved.query)) {
      return { status: "unavailable", entries: [], message: "公司参考分页已失效，请重新查询。" };
    }
    const query = saved ? saved.query : request.query;
    const view = await readCompanyContext(context, query, signal, saved?.cursor);
    const prose = companyProse(view);
    if (!view.nextCursor) return prose;
    const cursor = `CP${continuations.size + 1}`;
    continuations.set(cursor, { cursor: view.nextCursor, query });
    return { ...prose, nextCursor: cursor };
  };
  const tool = defineTool({
    name: "query_company", label: "查询公司事实", description: "按关键词读取授权 World 公司正文。返回有界参考；有 nextCursor 时尚有未读内容，可携该短句柄继续。公司事实不可用时不能以页面或历史补齐。",
    parameters: Type.Object({ query: Type.Optional(Type.String({ maxLength: 1000 })), cursor: Type.Optional(Type.String({ maxLength: 20 })) }, { additionalProperties: false }),
    execute: async (_id, args) => {
      const value = await read(args);
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
    },
  });
  return { read, tool };
}
