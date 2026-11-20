import type { TChatView, TCorrectChatMessageRequest, TMainLine, TOwnerChatMessageRequest, TSendChatMessageRequest } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";

/** 同事对话变了（发了一句、伙伴替本人问了）：读对话的地方跟着重读。 */
export const COLLEAGUE_CHATS_CHANGED = "colleague-chats-changed";
/** with：我去问他的伙伴；from：他来问我的伙伴。 */
export const chatHref = (side: "with" | "from", personId: string) => `/me/work/chats/${side}/${encodeURIComponent(personId)}`;

/** 出错时带上服务端的 code（PERSON_NOT_FOUND 这类调用方要分开处理的）。 */
function result<T>(data: T | undefined, response: Response, error: unknown, fallback: string): T {
  if (response.status === 401) { window.location.assign("/access"); throw new Error("登录已过期"); }
  if (!response.ok || !data) {
    const body = error as { message?: string; code?: string } | undefined;
    throw Object.assign(new Error(body?.message || fallback), { code: body?.code });
  }
  return data;
}

export async function sendChatMessage(personId: string, body: TSendChatMessageRequest): Promise<TChatView> {
  const { data, response, error } = await browserApi.POST("/api/me/colleague-chats/with/{personId}/messages", { params: { path: { personId } }, body });
  return result(data, response, error, "没有发出去，请重试").chat;
}

export async function readChat(side: "with" | "from", personId: string, signal?: AbortSignal): Promise<TChatView> {
  const options = { params: { path: { personId } }, signal, cache: "no-store" as const };
  const { data, response, error } = side === "with"
    ? await browserApi.GET("/api/me/colleague-chats/with/{personId}", options)
    : await browserApi.GET("/api/me/colleague-chats/from/{personId}", options);
  return result(data, response, error, "没有读到这段对话").chat;
}

/** 读到最新（主人读时伙伴的话标成他看过）；回 204，没有正文。 */
export async function markChatRead(chatId: string): Promise<void> {
  const { response, error } = await browserApi.POST("/api/me/colleague-chats/{chatId}/read", { params: { path: { chatId } } });
  if (!response.ok) result(undefined, response, error, "没有标成已读");
}

export async function retryChatAnswer(chatId: string, messageId: string): Promise<TChatView> {
  const { data, response, error } = await browserApi.POST("/api/me/colleague-chats/{chatId}/messages/{messageId}/retry", { params: { path: { chatId, messageId } } });
  return result(data, response, error, "没有重试上，请再点一次").chat;
}

export async function askChatOwner(chatId: string, messageId: string): Promise<TChatView> {
  const { data, response, error } = await browserApi.POST("/api/me/colleague-chats/{chatId}/messages/{messageId}/ask-owner", { params: { path: { chatId, messageId } } });
  return result(data, response, error, "没有转给本人，请重试").chat;
}

export async function ownerReply(chatId: string, body: TOwnerChatMessageRequest): Promise<TChatView> {
  const { data, response, error } = await browserApi.POST("/api/me/colleague-chats/{chatId}/owner-messages", { params: { path: { chatId } }, body });
  return result(data, response, error, "没有发出去，请重试").chat;
}

export async function correctMessage(chatId: string, messageId: string, body: TCorrectChatMessageRequest): Promise<TChatView> {
  const { data, response, error } = await browserApi.POST("/api/me/colleague-chats/{chatId}/messages/{messageId}/correct", { params: { path: { chatId, messageId } }, body });
  return result(data, response, error, "没有改上，请重试").chat;
}

export async function retractMessage(chatId: string, messageId: string): Promise<TChatView> {
  const { data, response, error } = await browserApi.POST("/api/me/colleague-chats/{chatId}/messages/{messageId}/retract", { params: { path: { chatId, messageId } } });
  return result(data, response, error, "没有收回，请重试").chat;
}

export async function listMainLines(signal?: AbortSignal): Promise<TMainLine[]> {
  const { data, response, error } = await browserApi.GET("/api/me/colleague-chats/main-lines", { signal, cache: "no-store" });
  return result(data, response, error, "没有读到同事对话").items;
}
