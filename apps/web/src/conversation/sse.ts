import type { TReadScopeParams, TBuddyPlan, TBuddyUiEffect, TConversationCard } from "@warmap/contracts";

export type ConversationEvent = {
  type: "message" | "tool" | "step" | "usage" | "compaction" | "warning" | "error" | "done" | "route" | "thinking" | "escalation" | "recovery" | "scope"
    | "receipt" | "plan" | "ui" | "card";
  /** receipt（17.4，伙伴对话）：本人这条消息 delivered 天枢收下了，read 伙伴读到了。 */
  state?: "delivered" | "read";
  /** plan（17.4）：伙伴这一轮的计划清单，后一条取代前一条。 */
  plan?: TBuddyPlan;
  /** ui（17.4）：伙伴动作在界面上的效果（切外观、打开某处、刷新哪几块）。 */
  ui?: TBuddyUiEffect;
  /** card（17.4）：伙伴这一轮出的卡（转达给同事的 buddy_message）。 */
  card?: TConversationCard;
  /** scope：跨对象读取的范围（三层取用）：params 是读取范围，choices 是点开调整时可选的人；label 复用下面的 label。 */
  params?: TReadScopeParams;
  choices?: { people: { id: string; name: string }[] };
  /** step：步骤 id（同一 id 的后一条取代前一条）；label 是步骤名，status 是 done / active / pending / stopped，result 是这一步读到了什么。 */
  id?: string;
  result?: string;
  /** 这一轮的标识（服务端每个事件都带）：「继续」按它接上这一轮。 */
  runId?: string;
  message?: string;
  code?: string;
  name?: string;
  phase?: string;
  isError?: boolean;
  status?: string;
  /** tool started：这一步在查什么（中文，一行）。 */
  label?: string;
  /** tool completed：这一步实际读到了什么（系统按工具结果生成）。 */
  detail?: string;
  /** thinking：推理摘要里的一句中文要点（没有就不带）。 */
  summary?: string;
  /** message：正文新增的文字；thinking：思考摘要新增的中文正文（Claude 档，逐段追加，没有就不带）。 */
  delta?: string;
  /** route：本轮档位、预计秒数；检索问答与深度档带开场说明。escalation / recovery：notice 是整句提示，expectSeconds 是预计还需秒数。 */
  tier?: "quick" | "grounded" | "deep";
  expectSeconds?: number;
  notice?: string;
  /** recovery：上游出错后正在做什么（重试、换备用模型、精简历史、从断点续写、跳过压缩）。 */
  action?: "retry" | "fallback" | "trim" | "continue" | "skip";
  /** error：能不能接着来——continue 从断点续写，retry 用已查到的材料重答；没有 = 不建议直接再试。 */
  resume?: "continue" | "retry";
  /** error：已写出的部分已经存进这条对话。 */
  partial?: boolean;
  /** done：这一轮用了备用模型或走过恢复时，回答末尾那行说明（与存进历史的相同）。 */
  recoveryNote?: { text: string; detail: string };
};

/** 把 SSE 文本缓冲切成完整事件块，返回剩余未完成缓冲。纯函数，便于独立验证。 */
export function splitSse(buffer: string): { events: string[]; rest: string } {
  const blocks = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const rest = blocks.pop() ?? "";
  return { events: blocks, rest };
}

/** 一个事件块 → 事件；心跳注释、没有 data 行、data 不是完整 JSON 的块都跳过（不让一个坏块打断整轮）。 */
export function parseSseBlock(block: string): ConversationEvent | null {
  const line = block.split("\n").find((candidate) => candidate.startsWith("data:"));
  if (!line) return null;
  try {
    const value = JSON.parse(line.slice(5).trimStart()) as ConversationEvent;
    return value && typeof value === "object" && typeof value.type === "string" ? value : null;
  } catch {
    return null;
  }
}
