import { AsyncLocalStorage } from "node:async_hooks";
import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AnchorView } from "./conversationAnchor.js";

/** 锚点在上下文包里的上限（UTF-8 字节）。超了只留聚焦项并标 more，其余用 read_anchor 分页展开。 */
export const ANCHOR_BUDGET_BYTES = 8192;

/**
 * 组装每轮的上下文包（JSON）：anchor 在最前，本人原话 message 在最后，长参考不会把当前问题埋住；
 * parts 是其余按需出现的段（currentObject、references、personalMemory、globalContext…），值为 undefined 的不出现。
 * 同一个函数组装两份：存进 Pi 历史的那份不带 anchor 与 currentObject（页面正文）；发给模型的那份带上，由 provider 边界临时换进去。
 */
export function composeTurnContext(turn: { anchor?: AnchorView; message: string; parts: Record<string, unknown> }): string {
  let anchor = turn.anchor;
  if (anchor && Buffer.byteLength(JSON.stringify(anchor)) > ANCHOR_BUDGET_BYTES) {
    const focus = anchor.focus?.handle;
    anchor = { ...anchor, items: anchor.items.filter((item) => item.handle === focus), more: true };
  }
  const parts = Object.fromEntries(Object.entries(turn.parts).filter(([, value]) => value !== undefined));
  return JSON.stringify({ ...(anchor ? { anchor } : {}), ...parts, message: turn.message });
}

type ToolBody = Pick<Extract<Context["messages"][number], { role: "toolResult" }>, "toolName" | "content">;
/**
 * 这一轮发给模型时要临时换进去的东西（PR #12 TurnContext）。prompt 是存进 Pi 历史的那条用户消息原文，live 是带锚点正文的那份；
 * toolResults 是本轮 read_anchor 展开的正文（历史里只有标记），resumed 是「继续」时按引用重新读回的上一轮展开。
 */
export type ProviderTurn = { systemPrompt: string; prompt: string; live: string; toolResults: Map<string, ToolBody>; resumed: Map<string, ToolBody> };

const textOf = (message: Context["messages"][number]) => message.role !== "user" ? undefined
  : typeof message.content === "string" ? message.content : message.content.map((block) => (block.type === "text" ? block.text : "")).join("");

/**
 * 对这一次请求的 Context.messages 副本临时注入：本轮那条用户消息换成带锚点正文的 live，本轮与「继续」的 read_anchor 结果换回正文。
 * 不改 Pi 的 entries，所以锚点正文不进历史、压缩与记忆提炼。不是主对话的请求（后台压缩等，系统提示不同）原样放行；
 * 主对话请求里找不到本轮那条用户消息就不发（不发没有锚点的降级请求）。
 */
export function injectTurnContext(context: Context, turn: ProviderTurn): Context {
  // pi 会在应用的系统提示后面补一行工作目录，所以按前缀认主对话。
  if (!context.systemPrompt?.startsWith(turn.systemPrompt)) return context;
  const messages = [...context.messages];
  let index = messages.length - 1;
  while (index >= 0 && textOf(messages[index]) !== turn.prompt) index -= 1;
  if (index < 0) throw Object.assign(new Error("本轮用户消息不在这次请求里，未发出没有锚点的请求"), { code: "TURN_CONTEXT_MISSING" });
  const current = messages[index] as Extract<Context["messages"][number], { role: "user" }>;
  messages[index] = { ...current, content: typeof current.content === "string" ? turn.live : [{ type: "text", text: turn.live }] };
  messages.forEach((entry, position) => {
    if (entry.role !== "toolResult") return;
    // 工具调用 id 可能在更早的轮次里重复：本轮的只换本轮之后的，「继续」读回的只换本轮之前的。
    const body = (position > index ? turn.toolResults : turn.resumed).get(entry.toolCallId);
    if (body?.toolName === entry.toolName) messages[position] = { ...entry, content: structuredClone(body.content) };
  });
  return { ...context, messages };
}

type StreamFn = (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
/** provider dispatch 边界的包装：AsyncLocalStorage 按轮隔离共享运行时里的并发请求，不用模块级的「当前轮」。 */
export function withTurnContext<T extends StreamFn>(store: AsyncLocalStorage<ProviderTurn>, inner: T): T {
  return ((model, context, options) => {
    const turn = store.getStore();
    return inner(model, turn ? injectTurnContext(context, turn) : context, options);
  }) as T;
}
