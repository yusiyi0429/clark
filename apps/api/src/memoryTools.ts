import { defineTool } from "@earendil-works/pi-coding-agent";
import { GetPassagesInput, ListSectionsInput, SearchSectionsInput } from "@warmap/contracts";
import { RETRIEVE_SOURCES, withRetrieve } from "./tracing.js";

/** 只读企业知识工具的结果形状；各运行时用 in-memory MCP client.callTool 适配。 */
export type MemoryToolCall = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ content: { type: "text"; text: string }[]; details: unknown }>;

/**
 * list_sections / search_sections / get_passages 三件套。radar、preflight、对话运行时共用一份定义，
 * 企业知识改名或工具描述调整只动这里。写入能力不在本模块：MCP server 侧没有写工具。
 */
export function makeMemoryTools(rawCall: MemoryToolCall) {
  // 每次真实读取企业知识一个 retrieve:company-memory 节点（挂在对应 tool 节点下）。
  const call: MemoryToolCall = (name, args) => withRetrieve(RETRIEVE_SOURCES.companyMemory, () => ({ operation: name, ...args }),
    () => rawCall(name, args), (result) => ({ blocks: result.content.length, chars: result.content.reduce((sum, item) => sum + item.text.length, 0) }));
  return [
    defineTool({ name: "list_sections", label: "企业知识章节", description: "列出企业知识章节", parameters: ListSectionsInput, execute: async (_id, args) => call("list_sections", args) }),
    defineTool({ name: "search_sections", label: "搜索企业知识", description: "搜索相关企业知识章节", parameters: SearchSectionsInput, execute: async (_id, args) => call("search_sections", args) }),
    defineTool({ name: "get_passages", label: "读取企业知识", description: "读取指定章节段落", parameters: GetPassagesInput, execute: async (_id, args) => call("get_passages", args) }),
  ];
}
