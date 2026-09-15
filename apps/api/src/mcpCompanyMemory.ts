import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Value } from "@sinclair/typebox/value";
import type { Static } from "@sinclair/typebox";
import {
  GetPassagesInput,
  ListSectionsInput,
  SearchPeopleInput,
  SearchSectionsInput,
} from "@warmap/contracts";
import type { CompanyMemoryRepository } from "./companyMemory.js";

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function tool(name: string, description: string, inputSchema: object, extra: Partial<Tool> = {}): Tool {
  return { name, description, inputSchema: inputSchema as Tool["inputSchema"], annotations: { readOnlyHint: true }, ...extra };
}

/**
 * 每个请求一个 MCP session（官方无状态模式）：握手、协议协商与 JSON-RPC 全部交给 SDK，
 * 工具层只暴露四个只读方法，存储细节封闭在 CompanyMemoryRepository 后面。
 */
export async function createCompanyMemoryMcpSession(
  repo: CompanyMemoryRepository,
): Promise<{ server: Server; transport: StreamableHTTPServerTransport }> {
  const server = new Server({ name: "company-memory", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      tool("list_sections", "列出 CompanyMemory 全部章节目录", ListSectionsInput),
      tool("search_sections", "按相关度搜索相关章节", SearchSectionsInput),
      tool("get_passages", "读取指定章节最相关段落", GetPassagesInput),
      tool("search_people", "查询 company-people.v1 人员目录", SearchPeopleInput),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case "list_sections": {
          if (!Value.Check(ListSectionsInput, args)) throw new Error("参数校验失败：不接受额外参数");
          return textResult({ sections: repo.listSections() });
        }
        case "search_sections": {
          if (!Value.Check(SearchSectionsInput, args)) throw new Error("参数校验失败：需要 query");
          const q = args as Static<typeof SearchSectionsInput>;
          return textResult({ results: repo.searchSections(q.query, q.limit ?? 5) });
        }
        case "get_passages": {
          if (!Value.Check(GetPassagesInput, args)) throw new Error("参数校验失败：需要 sectionId");
          const q = args as Static<typeof GetPassagesInput>;
          return textResult(repo.getPassages(q.sectionId, q.query, q.limit ?? 5));
        }
        case "search_people": {
          if (!Value.Check(SearchPeopleInput, args)) throw new Error("参数校验失败：query 类型不合法");
          const q = args as Static<typeof SearchPeopleInput>;
          return textResult({ people: repo.searchPeople(q.query) });
        }
        default:
          // 没有写工具：CompanyMemory 对 WarMap 只读（ADR-0004/0013）
          throw new Error(`未知工具: ${name}`);
      }
    } catch (err) {
      return { isError: true, content: [{ type: "text" as const, text: (err as Error).message }] };
    }
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return { server, transport };
}
