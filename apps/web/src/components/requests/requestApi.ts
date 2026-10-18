import type {
  TActionDescriptor, TConfirmDocChangeRequest, TDocChangeView, TDocOwnerAnswerRequest, TDraftRequestAnswerResponse, TDraftRequestResponse, TImpactBasisChoiceRequest,
  TImpactCardView, TPrepareRequestQuestionResponse, TRequestClarification, TRequestView,
} from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";

/** 送达通道（⑨ 传话）的浏览器端调用：失败统一抛 RequestApiError，文案用服务端给的那句。 */
export class RequestApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

/** 通知栏、列表和详情之间互相提醒重读。 */
export const REQUESTS_CHANGED = "requests-changed";
const changed = () => window.dispatchEvent(new Event(REQUESTS_CHANGED));

function settle<T>(result: { data?: T; response: Response; error?: unknown }, fallback: string): T {
  if (result.response.status === 401) { window.location.assign("/access"); throw new RequestApiError("登录已过期", 401); }
  if (!result.response.ok || !result.data) {
    const failure = result.error as { message?: string; code?: string } | undefined;
    const message = failure?.code === "VERSION_CONFLICT" ? "内容刚更新过，已换成最新的，请再看一遍" : failure?.message ?? fallback;
    throw new RequestApiError(message, result.response.status, failure?.code);
  }
  return result.data;
}

export async function draftRequest(prompt: string, requestId?: string, clarifications?: TRequestClarification[]): Promise<TDraftRequestResponse> {
  const result = settle(await browserApi.POST("/api/requests/draft", { body: { prompt, ...(requestId ? { requestId } : {}), ...(clarifications ? { clarifications } : {}) } }), "起草没有成功，请重试");
  changed();
  return result;
}

export async function readRequest(id: string): Promise<TRequestView> {
  return settle(await browserApi.GET("/api/requests/{id}", { params: { path: { id } } }), "没有读到这条请求").request;
}

export async function prepareQuestion(id: string, question: string): Promise<TPrepareRequestQuestionResponse> {
  return settle(await browserApi.POST("/api/requests/{id}/questions/prepare", { params: { path: { id } }, body: { question } }), "没有查成，请重试");
}

export async function draftAnswer(id: string, questionId: string): Promise<TDraftRequestAnswerResponse> {
  return settle(await browserApi.POST("/api/requests/{id}/questions/{questionId}/answer-draft", { params: { path: { id, questionId } } }), "起草没有成功，请重试或直接写");
}

export async function runRequestAction(action: TActionDescriptor, input?: unknown): Promise<TRequestView> {
  const result = settle(await browserApi.POST("/api/requests/actions/execute", { body: { actionId: action.actionId, ...(input === undefined ? {} : { input }) } }), "没有成功，请重试");
  changed();
  return result.request;
}

/** ⑧ 文档变更：作者确认、改问负责人、负责人回答；影响卡上切换或继续用旧版。 */
export async function readDocChange(requestId: string): Promise<TDocChangeView> {
  return settle(await browserApi.GET("/api/requests/{id}/doc-change", { params: { path: { id: requestId } } }), "没有读到这次文档变更").docChange;
}

export async function confirmDocChange(id: string, body: TConfirmDocChangeRequest): Promise<TDocChangeView> {
  const result = settle(await browserApi.POST("/api/doc-changes/{id}/confirm", { params: { path: { id } }, body }), "没有成功，请重试").docChange;
  changed();
  return result;
}

export async function askDocChangeOwners(id: string): Promise<TDocChangeView> {
  const result = settle(await browserApi.POST("/api/doc-changes/{id}/ask-owners", { params: { path: { id } } }), "没有成功，请重试").docChange;
  changed();
  return result;
}

export async function answerDocChangeOwner(id: string, body: TDocOwnerAnswerRequest): Promise<TDocChangeView> {
  const result = settle(await browserApi.POST("/api/doc-changes/{id}/owner-answer", { params: { path: { id } }, body }), "没有成功，请重试").docChange;
  changed();
  return result;
}

export async function chooseImpactBasis(cardId: string, body: TImpactBasisChoiceRequest): Promise<TImpactCardView> {
  const result = settle(await browserApi.POST("/api/impact-cards/{id}/basis", { params: { path: { id: cardId } }, body }), "没有成功，请重试").card;
  changed();
  return result;
}

export const requestError = (cause: unknown, fallback: string) => cause instanceof RequestApiError ? cause.message : fallback;
