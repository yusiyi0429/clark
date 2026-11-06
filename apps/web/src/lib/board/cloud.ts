/**
 * 新骨架要的云端接口（V2 设计第 5.1 节，契约 taskCards.ts、topics.ts、localDevices.ts，见 boardOpenapi.ts）。
 * 后端实现还在做，接口可能暂时 404：读的当成「还没有」，写的报一句「没成功」。
 */
import type {
  TAcceptCardDraftsRequest, TCardBoardResponse, TCardBriefResponse, TCardDetailResponse, TCardPlanBriefResponse, TCardPlanView, TCardSplitListResponse, TCardSplitRequestView, TCardTaskView,
  TCreateLocalDeviceRequest, TCreateLocalDeviceResponse, TLocalDeviceView, TPatchCardRequest, TResearchTopicView,
  TTopicBriefResponse, TTopicDetailResponse, TTopicVersionView, TWorkersResponse,
  TBackgroundResponse, TClaimSessionStartsResponse, TRouteResponse, TTaskFeedResponse, TTaskPipelineResponse, TWorkHomeResponse,
} from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";

export class CloudError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}

type Result<T> = { data?: T; error?: unknown; response: Response };

/** 401 去登录；不成功抛 CloudError（带服务端的话）。 */
async function unwrap<T>(call: Promise<Result<T>>): Promise<T> {
  let result: Result<T>;
  try {
    result = await call;
  } catch {
    throw new CloudError(0, "连不上天枢，请稍后再试");
  }
  const { data, error, response } = result;
  if (response.status === 401) {
    window.location.assign(`/access?next=${encodeURIComponent(window.location.pathname)}`);
    throw new CloudError(401, "登录过期了");
  }
  if (!response.ok || data === undefined) {
    const body = (error ?? {}) as { message?: string; code?: string };
    throw new CloudError(response.status, body.message ?? "没成功，请重试", body.code);
  }
  return data;
}
/** 读：接口还没有（404）时返回 null。 */
async function maybe<T>(call: Promise<Result<T>>): Promise<T | null> {
  try {
    return await unwrap(call);
  } catch (error) {
    if (error instanceof CloudError && error.status === 404) return null;
    throw error;
  }
}

const id = (value: string) => ({ path: { id: value } });
const task = (taskId: string) => ({ path: { taskId } });

// ── 看板 ──
export const readBoard = (taskId: string) => maybe<TCardBoardResponse>(browserApi.GET("/api/plan-tasks/{taskId}/cards", { params: task(taskId) }));
export const planCards = (taskId: string, hint?: string) => unwrap<TCardPlanView>(browserApi.POST("/api/plan-tasks/{taskId}/card-plans", { params: task(taskId), body: hint ? { hint } : {} }) as Promise<Result<TCardPlanView>>);
/** start：新首页第 4.4 节，交给 Agent 的卡同时登记要开工（配对的电脑上的网页认领后开）。 */
export const acceptDrafts = (taskId: string, drafts: TAcceptCardDraftsRequest["drafts"], start = false) =>
  unwrap(browserApi.POST("/api/plan-tasks/{taskId}/card-drafts/accept", { params: task(taskId), body: { drafts, ...(start ? { start } : {}) } })).then((data) => data.cards as TCardTaskView[]);
export const dismissDraft = (draftId: string) => unwrap(browserApi.POST("/api/card-drafts/{id}/dismiss", { params: id(draftId) }));
export const shipPending = (taskId: string, statement?: string) =>
  unwrap(browserApi.POST("/api/plan-tasks/{taskId}/deliverable/versions/from-pending", { params: task(taskId), body: statement ? { statement } : {} }));
export const addTopicVersionToPending = (taskId: string, topicVersionId: string) =>
  unwrap(browserApi.POST("/api/plan-tasks/{taskId}/deliverable/pending", { params: task(taskId), body: { topicVersionId } }));

// ── 拆卡（第 21 节）：登记了还没开工的拆卡，真正去拆的是本人电脑上的规划员 ──
export const listSplits = () => maybe<TCardSplitListResponse>(browserApi.GET("/api/me/card-splits") as Promise<Result<TCardSplitListResponse>>).then((data) => data?.requests ?? []);
export const registerSplit = (taskId: string) => unwrap<TCardSplitRequestView>(browserApi.POST("/api/plan-tasks/{taskId}/card-splits", { params: task(taskId) }) as Promise<Result<TCardSplitRequestView>>);
/** 规划员开起来以后把登记去掉（回 204，没有回包）。 */
export const removeSplit = (splitId: string) => unwrap(browserApi.DELETE("/api/me/card-splits/{id}", { params: id(splitId) }))
  .then(() => undefined, (error: unknown) => { if (!(error instanceof CloudError && error.status === 204)) throw error; });
export const planBrief = (taskId: string) => unwrap<TCardPlanBriefResponse>(browserApi.GET("/api/plan-tasks/{taskId}/plan-brief", { params: task(taskId) }) as Promise<Result<TCardPlanBriefResponse>>);

// ── 卡 ──
export const readCard = (cardId: string) => maybe<TCardDetailResponse>(browserApi.GET("/api/me/cards/{id}", { params: id(cardId) }));
export const patchCard = (cardId: string, body: TPatchCardRequest) => unwrap(browserApi.PATCH("/api/me/cards/{id}", { params: id(cardId), body })) as Promise<unknown>;
export const cardBrief = (cardId: string) => unwrap<TCardBriefResponse>(browserApi.GET("/api/me/cards/{id}/brief", { params: id(cardId) }));
const handback = (cardId: string, handbackId: string) => ({ path: { id: cardId, handbackId } });
export const overrule = (cardId: string, handbackId: string, reason: string) =>
  unwrap(browserApi.POST("/api/me/cards/{id}/handbacks/{handbackId}/overrule", { params: handback(cardId, handbackId), body: { reason } }));
export const retryAcceptance = (cardId: string, handbackId: string) => unwrap(browserApi.POST("/api/me/cards/{id}/handbacks/{handbackId}/retry", { params: handback(cardId, handbackId) }));
export const markReturned = (cardId: string, handbackId: string) => unwrap(browserApi.POST("/api/me/cards/{id}/handbacks/{handbackId}/returned", { params: handback(cardId, handbackId) }));

// ── worker（跨 Task）──
export const readWorkers = () => maybe<TWorkersResponse>(browserApi.GET("/api/me/workers") as Promise<Result<TWorkersResponse>>);

// ── 本机设备 ──
export const listDevices = () => maybe(browserApi.GET("/api/me/local-devices")).then((data) => (data?.devices ?? []) as TLocalDeviceView[]);
export const createDevice = (body: TCreateLocalDeviceRequest) => unwrap<TCreateLocalDeviceResponse>(browserApi.POST("/api/me/local-devices", { body }) as Promise<Result<TCreateLocalDeviceResponse>>);
/** 回 204，没有回包。 */
export const revokeDevice = (deviceId: string) => unwrap(browserApi.DELETE("/api/me/local-devices/{id}", { params: id(deviceId) }))
  .then(() => undefined, (error: unknown) => { if (!(error instanceof CloudError && error.status === 204)) throw error; });

// ── 调研专题 ──
export const listTopics = (status: "active" | "archived" = "active") =>
  maybe(browserApi.GET("/api/me/topics", { params: { query: { status } } })).then((data) => (data?.topics ?? []) as TResearchTopicView[]);
export const createTopic = (body: { title: string; planTaskId?: string }) => unwrap<TResearchTopicView>(browserApi.POST("/api/me/topics", { body }) as Promise<Result<TResearchTopicView>>);
export const readTopic = (topicId: string) => maybe<TTopicDetailResponse>(browserApi.GET("/api/me/topics/{id}", { params: id(topicId) }));
export const patchTopic = (topicId: string, body: { title?: string; status?: "active" | "archived" }) => unwrap(browserApi.PATCH("/api/me/topics/{id}", { params: id(topicId), body }));
export const readTopicVersion = (topicId: string, number: number) =>
  unwrap<TTopicVersionView>(browserApi.GET("/api/me/topics/{id}/versions/{number}", { params: { path: { id: topicId, number } } }) as Promise<Result<TTopicVersionView>>);
/** critics：评审会用的挑刺岗位 id（本人点的），不传用团队里的前三个。 */
export const topicBrief = (topicId: string, critics?: string[]) =>
  unwrap<TTopicBriefResponse>(browserApi.GET("/api/me/topics/{id}/brief", { params: { path: { id: topicId }, ...(critics?.length ? { query: { critics: critics.join(",") } } : {}) } }) as Promise<Result<TTopicBriefResponse>>);

// ── 新首页（workHome.ts）：B 的实现到之前这几个读接口是 404，网页回落到上面几份数据自己拼（lib/home/derive.ts）──
export const readWorkHome = () => maybe<TWorkHomeResponse>(browserApi.GET("/api/me/work-home") as Promise<Result<TWorkHomeResponse>>);
export const readBackground = (scope: string) => maybe<TBackgroundResponse>(browserApi.GET("/api/me/background", { params: { query: { scope } } }) as Promise<Result<TBackgroundResponse>>);
export const readTaskFeed = (taskId: string) => maybe<TTaskFeedResponse>(browserApi.GET("/api/me/tasks/{taskId}/feed", { params: task(taskId) }) as Promise<Result<TTaskFeedResponse>>);
/** Task 管线的对话（第一次打开时建）；收发走现有对话接口，scope 是 plan-task:<taskId>。 */
export const openPipeline = (taskId: string) => maybe<TTaskPipelineResponse>(browserApi.POST("/api/me/tasks/{taskId}/pipeline", { params: task(taskId) }) as Promise<Result<TTaskPipelineResponse>>);
export const routeMessage = (text: string) => maybe<TRouteResponse>(browserApi.POST("/api/me/route", { body: { text } }) as Promise<Result<TRouteResponse>>);
/** 认领「要开工」：一条只给一处；本机起不来就 release 放回去。 */
export const claimStarts = (deviceId: string) => maybe<TClaimSessionStartsResponse>(browserApi.POST("/api/me/session-starts/claim", { body: { deviceId } }) as Promise<Result<TClaimSessionStartsResponse>>);
export const releaseStart = (startId: string) => unwrap(browserApi.POST("/api/me/session-starts/{id}/release", { params: id(startId) }))
  .then(() => undefined, (error: unknown) => { if (!(error instanceof CloudError && error.status === 204)) throw error; });
