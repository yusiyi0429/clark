import type { TLocalSessionKind } from "@warmap/contracts";
import type { SessionManager } from "./sessions.js";
import { CARD_TITLE_RULE } from "./cardTitle.js";

/**
 * 本会话的 MCP（HTTP，挂在本机程序的 /internal/sessions/:id/mcp）：执行方用它把产出物、证据、交回、专题版本报给本机程序，
 * 本机程序再排进发件箱单向报给云端。用 HTTP 而不是 stdio：不用为每个会话再起一个本机程序进程。
 * 本机程序把地址和本会话密钥写进 --mcp-config 文件（不进命令行）；这些工具预先放行，不弹权限请求。
 * 各种会话看到自己那几个：卡交回（hand_back），专题存版本（save_version、set_feishu_url），规划员交计划（propose_plan），验收员交结论（submit_verdict）；
 * 卡和专题还有翻更早轮次的 read_earlier_turns（换执行方接着做时用，契约 LocalSessionModelRequest）。
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
      outputs: { type: "array", items: { type: "string" }, description: "用到的产出和证据的编号（add_artifact、add_evidence 返回的 A1、E1 等）。不填就是本会话交过的全部（同一个文件交过几次只算最新一版）。" },
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

const PROPOSE_PLAN = {
  name: "propose_plan",
  description: "交计划和派活单草稿：计划几步（按先后）、风险；派活单 1–8 件，每件写交代（brief）、完成标准（doneDefinition，每行一条、能检查）、对约定第几条（criterionIndex，对不上不填）、技能（role，交代里技能清单的名字）、模型档位（modelTier），要等前面哪几件（after，用到它们的结果时才写）。本人让你改时，改完再交一次。",
  inputSchema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "一句话说怎么拆，500 字以内" },
      steps: {
        type: "array", description: "计划的几步，按先后",
        items: { type: "object", properties: { title: { type: "string" }, detail: { type: "string" } }, required: ["title"] },
      },
      risks: { type: "array", items: { type: "string" } },
      cards: {
        type: "array", minItems: 1, maxItems: 8,
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: CARD_TITLE_RULE },
            brief: { type: "string", description: "交代：做什么、从哪入手" },
            doneDefinition: { type: "string", description: "完成标准，每行一条，500 字以内" },
            criterionIndex: { type: "integer", minimum: 1, description: "对约定第几条" },
            role: { type: "string", description: "技能名字（交代里的技能清单）" },
            modelTier: { type: "string", enum: ["strong", "normal", "light"] },
            why: { type: "string", description: "一句话为什么这么拆" },
            after: {
              type: "array", items: { type: "integer", minimum: 1 },
              description: "要等派活单里哪几件做完（位置，从 1 起，只能写排在前面的）。只在要用到前面几件的结果时才写；互不相干的件不写，好并行做",
            },
            sourceWords: {
              type: "array", items: { type: "string" },
              description: "交代「本人原话」里和这件有关的片段，只能原样摘、不能改写；拿不准就不写",
            },
          },
          required: ["title", "brief", "doneDefinition", "modelTier"],
        },
      },
    },
    required: ["summary", "cards"],
  },
};
const SUBMIT_VERDICT = {
  name: "submit_verdict",
  description: "交验收结论（只交一次）：每条完成标准判一次（index 从 1 起，条数照交代），met 达到、partial 部分、unmet 没达到，写理由（reason）、依据（evidence），没达到的写怎么补（fix）；标准以外的建议放 beyondScope；交代里有「本人原话」时再对一遍原话，对不上的写 sourceWordIssues；summary 一句结论。",
  inputSchema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      criteria: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer", minimum: 1 }, verdict: { type: "string", enum: ["met", "partial", "unmet"] },
            reason: { type: "string" }, evidence: { type: "string" }, fix: { type: "string" },
          },
          required: ["index", "verdict", "reason"],
        },
      },
      beyondScope: { type: "array", items: { type: "string" } },
      sourceWordIssues: {
        type: "array",
        description: "交代里有「本人原话」时，产出和原话明显对不上的地方：quote 原样抄是哪一句，kind 是 missing（漏了原话里明说的）或 extra（做了原话里没要的），reason 为什么。有一条就是没过；对得上就不写",
        items: {
          type: "object",
          properties: { quote: { type: "string" }, kind: { type: "string", enum: ["missing", "extra"] }, reason: { type: "string" } },
          required: ["quote", "kind", "reason"],
        },
      },
    },
    required: ["summary", "criteria"],
  },
};

/** 规划员、验收员换不了执行方，不给。 */
const READ_EARLIER_TURNS = {
  name: "read_earlier_turns",
  description: "翻这个会话更早的轮次：本人说的、执行方回的原样，工具调用一行一个。换过执行方（Claude Code、Codex）接着做时，交代里只带了最近几轮，更早的用它看。从最近的往前翻：before 不填从最新一轮起；填上次返回里最早那一轮的号，接着往前。",
  inputSchema: {
    type: "object",
    properties: {
      before: { type: "integer", minimum: 1, description: "只看第几轮之前的（不含这一轮）" },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "一次看几轮，默认 8" },
    },
  },
};

export const SESSION_MCP_NAME = "tianshu-session";

const TOOLS: Record<TLocalSessionKind, { name: string }[]> = {
  card: [ADD_ARTIFACT, ADD_EVIDENCE, HAND_BACK, READ_EARLIER_TURNS],
  topic: [ADD_ARTIFACT, ADD_EVIDENCE, SAVE_VERSION, SET_FEISHU_URL, READ_EARLIER_TURNS],
  plan: [PROPOSE_PLAN],
  verify: [SUBMIT_VERDICT],
};

export function sessionTools(kind: TLocalSessionKind) {
  return TOOLS[kind];
}

/** 预先放行的工具名（--allowedTools）。 */
export function sessionToolNames(kind: TLocalSessionKind): string[] {
  return sessionTools(kind).map((t) => `mcp__${SESSION_MCP_NAME}__${t.name}`);
}

function callTool(sessions: SessionManager, id: string, kind: TLocalSessionKind, name: string, input: any): string | Promise<string> {
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
  if (name === "propose_plan" && typeof input?.summary === "string" && Array.isArray(input?.cards)) return sessions.proposePlan(id, input);
  if (name === "submit_verdict" && typeof input?.summary === "string" && Array.isArray(input?.criteria)) return sessions.submitVerdict(id, input);
  if (name === "read_earlier_turns") {
    const int = (v: unknown) => (Number.isInteger(v) && (v as number) >= 1 ? (v as number) : undefined);
    return sessions.readEarlierTurns(id, { before: int(input?.before), limit: int(input?.limit) });
  }
  throw new Error("工具名或参数不对");
}

/** 处理一条 JSON-RPC 消息；通知（没有 id）返回 null，HTTP 回 202。 */
export async function handleMcpMessage(sessions: SessionManager, id: string, msg: any): Promise<unknown | null> {
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
        return ok({ content: [{ type: "text", text: await callTool(sessions, id, kind, String(msg.params?.name), msg.params?.arguments ?? {}) }], isError: false });
      } catch (e) {
        return ok({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    case "ping":
      return ok({});
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } };
  }
}
