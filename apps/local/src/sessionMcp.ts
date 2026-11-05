import type { SessionManager } from "./sessions.js";

/**
 * 本会话的 MCP（HTTP，挂在本机程序的 /internal/sessions/:id/mcp）：执行方用它把产出物、证据、交回报给本机程序，
 * 本机程序再排进发件箱单向报给云端。用 HTTP 而不是 stdio：不用为每个会话再起一个本机程序进程。
 * 本机程序把地址和本会话密钥写进 --mcp-config 文件（不进命令行）；这些工具预先放行，不弹权限请求。
 */
export const SESSION_TOOLS = [
  {
    name: "add_artifact",
    description: "交一个产出物（Markdown、HTML、PDF、Word、纯文本）。文件先写在当前工作目录里，再给相对路径。同名再交记成新一版。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "相对当前工作目录的路径" }, title: { type: "string", description: "给人看的标题" } },
      required: ["path"],
    },
  },
  {
    name: "add_evidence",
    description: "交一条证据：一段说明、日志片段、链接（如 PR）、改动摘要。不要贴完整输出。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["note", "log", "link", "diff_summary"] },
        title: { type: "string" }, text: { type: "string" }, url: { type: "string" },
      },
      required: ["kind", "title"],
    },
  },
  {
    name: "submit_handback",
    description: "做完后交回：逐条对照完成标准写达到（met）、部分（partial）还是没达到（unmet），附证据；再写一句总结。交回后由 Agent 验收。",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        criteria: {
          type: "array",
          items: {
            type: "object",
            properties: { index: { type: "integer", minimum: 1 }, result: { type: "string", enum: ["met", "partial", "unmet"] }, evidence: { type: "string" } },
            required: ["index", "result", "evidence"],
          },
        },
      },
      required: ["summary", "criteria"],
    },
  },
] as const;

export const SESSION_MCP_NAME = "tianshu";
export const SESSION_TOOL_NAMES = SESSION_TOOLS.map((t) => `mcp__${SESSION_MCP_NAME}__${t.name}`);

function callTool(sessions: SessionManager, id: string, name: string, input: any): string {
  if (name === "add_artifact" && typeof input?.path === "string") return sessions.addArtifact(id, input);
  if (name === "add_evidence" && ["note", "log", "link", "diff_summary"].includes(input?.kind) && typeof input?.title === "string") {
    if (input.url !== undefined && !/^https?:\/\//.test(String(input.url))) throw new Error("链接只收 http(s)");
    return sessions.addEvidence(id, input);
  }
  if (name === "submit_handback" && typeof input?.summary === "string" && Array.isArray(input?.criteria)) {
    const criteria = input.criteria
      .filter((c: any) => Number.isInteger(c?.index) && c.index >= 1 && ["met", "partial", "unmet"].includes(c?.result))
      .map((c: any) => ({ index: c.index, result: c.result, evidence: String(c.evidence ?? "").slice(0, 2000) }));
    return sessions.submitHandback(id, { summary: input.summary, criteria });
  }
  throw new Error("工具名或参数不对");
}

/** 处理一条 JSON-RPC 消息；通知（没有 id）返回 null，HTTP 回 202。 */
export function handleMcpMessage(sessions: SessionManager, id: string, msg: any): unknown | null {
  if (msg?.id === undefined || msg?.id === null) return null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return ok({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "tianshu-local", version: "0.1.0" } });
    case "tools/list":
      return ok({ tools: SESSION_TOOLS });
    case "tools/call":
      try {
        return ok({ content: [{ type: "text", text: callTool(sessions, id, String(msg.params?.name), msg.params?.arguments ?? {}) }], isError: false });
      } catch (e) {
        return ok({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    case "ping":
      return ok({});
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } };
  }
}
