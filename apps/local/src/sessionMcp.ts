import { createInterface } from "node:readline";

/**
 * 本会话的 MCP（stdio）：执行方用它把产出物、证据、交回报给本机程序，本机程序再排进发件箱单向报给云端。
 * 由本机程序写进 --mcp-config，以 `tianshu-local mcp-session` 启动；回连本机时出示本会话的密钥。
 * 这些工具预先放行（--allowedTools），不会弹权限请求。
 */
const TOOLS = [
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
];

export async function runSessionMcp(): Promise<void> {
  const port = process.env.TIANSHU_LOCAL_PORT;
  const sessionId = process.env.TIANSHU_SESSION_ID;
  const secret = process.env.TIANSHU_SESSION_SECRET ?? "";
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let req: { id?: number | string; method?: string; params?: any };
    try { req = JSON.parse(line); } catch { continue; }
    if (req.id === undefined) continue; // 通知不用回
    const reply = (result: unknown) => send({ jsonrpc: "2.0", id: req.id, result });
    switch (req.method) {
      case "initialize":
        reply({ protocolVersion: req.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "tianshu-local", version: "0.1.0" } });
        break;
      case "tools/list":
        reply({ tools: TOOLS });
        break;
      case "tools/call": {
        let text: string;
        let isError = false;
        try {
          const res = await fetch(`http://127.0.0.1:${port}/internal/sessions/${sessionId}/report`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-tianshu-session-secret": secret },
            body: JSON.stringify({ tool: req.params?.name, input: req.params?.arguments ?? {} }),
          });
          const body = (await res.json()) as { text?: string; error?: { message: string } };
          isError = !res.ok;
          text = body.text ?? body.error?.message ?? `本机程序返回 ${res.status}`;
        } catch (e) {
          isError = true;
          text = `连不上天枢本机程序：${e instanceof Error ? e.message : String(e)}`;
        }
        reply({ content: [{ type: "text", text }], isError });
        break;
      }
      case "ping":
        reply({});
        break;
      default:
        send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "method not found" } });
    }
  }
}
