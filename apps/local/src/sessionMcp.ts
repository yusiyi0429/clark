import type { TLocalSessionKind } from "@warmap/contracts";
import type { SessionManager } from "./sessions.js";

/**
 * 本会话的 MCP（HTTP，挂在本机程序的 /internal/sessions/:id/mcp）：执行方用它把产出物、证据、交回、专题版本报给本机程序，
 * 本机程序再排进发件箱单向报给云端。用 HTTP 而不是 stdio：不用为每个会话再起一个本机程序进程。
 * 本机程序把地址和本会话密钥写进 --mcp-config 文件（不进命令行）；这些工具预先放行，不弹权限请求。
 * 卡和专题各看到自己那几个：卡交回（hand_back），专题存版本（save_version、set_feishu_url）。
 */
const ADD_ARTIFACT = {
  name: "add_artifact",
  description: "交一个产出物（Markdown、HTML、PDF、Word、纯文本）。文件先写在当前工作目录里，再给相对路径。同名再交记成新一版。返回这份产出的编号（如 A1），交回时用它点名。",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "相对当前工作目录的路径" }, title: { type: "string", description: "给人看的标题" } },
    required: ["path"],
  },
};
const ADD_EVIDENCE = {
  name: "add_evidence",
  description: "交一条证据：一段说明、日志片段、链接（如 PR）、改动摘要。不要贴完整输出。返回这条证据的编号（如 E1），交回时用它点名。",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["note", "log", "link", "diff_summary"] },
      title: { type: "string" }, text: { type: "string" }, url: { type: "string" },
    },
    required: ["kind", "title"],
  },
};
const HAND_BACK = {
  name: "hand_back",
  description: "做完后交回：逐条对照完成标准写达到（met）、部分（partial）还是没达到（unmet），附证据；点名这次交回用哪几份产出和证据（编号）；再写一句总结。交回后由 Agent 验收。",
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
      outputs: { type: "array", items: { type: "string" }, description: "用到的产出和证据的编号（add_artifact、add_evidence 返回的 A1、E1 等）。不填就是上次交回以后交的全部。" },
    },
    required: ["summary", "criteria"],
  },
};
const SAVE_VERSION = {
  name: "save_version",
  description: "专题存一版：先把 Markdown 写进当前工作目录里的一个文件，再给相对路径。kind：outline 提纲、draft 正文、review 评审会的「分歧和建议」。note 写这一版改了什么。返回这是第几版。",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "相对当前工作目录的 .md 文件" },
      kind: { type: "string", enum: ["outline", "draft", "review"] },
      label: { type: "string", description: "这一版的名字，20 字以内，可不填" },
      note: { type: "string", description: "这一版改了什么，200 字以内" },
    },
    required: ["path", "kind"],
  },
};
const SET_FEISHU_URL = {
  name: "set_feishu_url",
  description: "专题的某一版存进本人的飞书以后，报回是第几版和飞书里的地址。",
  inputSchema: {
    type: "object",
    properties: { number: { type: "integer", minimum: 1 }, url: { type: "string", description: "https 开头的飞书地址" } },
    required: ["number", "url"],
  },
};

export const SESSION_MCP_NAME = "tianshu-session";

export function sessionTools(kind: TLocalSessionKind) {
  return kind === "card" ? [ADD_ARTIFACT, ADD_EVIDENCE, HAND_BACK] : [ADD_ARTIFACT, ADD_EVIDENCE, SAVE_VERSION, SET_FEISHU_URL];
}

/** 预先放行的工具名（--allowedTools）。 */
export function sessionToolNames(kind: TLocalSessionKind): string[] {
  return sessionTools(kind).map((t) => `mcp__${SESSION_MCP_NAME}__${t.name}`);
}

function callTool(sessions: SessionManager, id: string, kind: TLocalSessionKind, name: string, input: any): string {
  if (!sessionTools(kind).some((t) => t.name === name)) throw new Error(`这个会话没有 ${name} 这个工具`);
  if (name === "add_artifact" && typeof input?.path === "string") return sessions.addArtifact(id, input);
  if (name === "add_evidence" && ["note", "log", "link", "diff_summary"].includes(input?.kind) && typeof input?.title === "string") {
    if (input.url !== undefined && !/^https?:\/\//.test(String(input.url))) throw new Error("链接只收 http(s)");
    return sessions.addEvidence(id, input);
  }
  if (name === "hand_back" && typeof input?.summary === "string" && Array.isArray(input?.criteria)) {
    const criteria = input.criteria
      .filter((c: any) => Number.isInteger(c?.index) && c.index >= 1 && ["met", "partial", "unmet"].includes(c?.result))
      .map((c: any) => ({ index: c.index, result: c.result, evidence: String(c.evidence ?? "").slice(0, 2000) }));
    const outputs = Array.isArray(input.outputs) ? input.outputs.map(String) : undefined;
    return sessions.handBack(id, { summary: input.summary, criteria, outputs });
  }
  if (name === "save_version" && typeof input?.path === "string" && ["outline", "draft", "review"].includes(input?.kind)) {
    return sessions.saveVersion(id, {
      path: input.path, kind: input.kind,
      label: typeof input.label === "string" ? input.label : undefined, note: typeof input.note === "string" ? input.note : undefined,
    });
  }
  if (name === "set_feishu_url" && Number.isInteger(input?.number) && typeof input?.url === "string") return sessions.setFeishuUrl(id, input);
  throw new Error("工具名或参数不对");
}

/** 处理一条 JSON-RPC 消息；通知（没有 id）返回 null，HTTP 回 202。 */
export function handleMcpMessage(sessions: SessionManager, id: string, msg: any): unknown | null {
  if (msg?.id === undefined || msg?.id === null) return null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const kind = sessions.kindOf(id);
  switch (msg.method) {
    case "initialize":
      return ok({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "tianshu-local", version: "0.1.0" } });
    case "tools/list":
      return ok({ tools: sessionTools(kind) });
    case "tools/call":
      try {
        return ok({ content: [{ type: "text", text: callTool(sessions, id, kind, String(msg.params?.name), msg.params?.arguments ?? {}) }], isError: false });
      } catch (e) {
        return ok({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    case "ping":
      return ok({});
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } };
  }
}
