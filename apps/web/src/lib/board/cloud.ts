/**
 * 新骨架要的云端接口（V2 设计第 5.1 节，契约 taskCards.ts、topics.ts、localDevices.ts，见 boardOpenapi.ts）。
 * 后端实现还在做，接口可能暂时 404：读的当成「还没有」，写的报一句「没成功」。
 */
import type {
  TBudget, TAcceptCardDraftsRequest, TCardBoardResponse, TCardBriefResponse, TCardDetailResponse, TCardPlanBriefResponse, TCardPlanView, TCardSplitListResponse, TCardSplitRequestView, TCardTaskView,
  TCreateLocalDeviceRequest, TCreateLocalDeviceResponse, TLocalDeviceView, TPatchCardRequest, TResearchTopicView,
  TTopicBriefResponse, TTopicDetailResponse, TTopicVersionView, TWorkersResponse,
  TBackgroundResponse, TClaimSessionStartsResponse, TRouteResponse, TWorkHomeResponse,
  TProject, TProjectDetailResponse, TProjectFeedResponse, TProjectGoal, TProjectListResponse, TProjectPipelineResponse, TUpdateProjectRequest,
  THandoverSecretFinding, TProjectTransfer, TUpdateProjectTransferRequest, TConversationHistory, TProjectBoardResponse,
} from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";

export class CloudError extends Error {
  /** body：服务端回的原样（交接说明里有像密钥的，findings 在这里）。 */
  constructor(readonly status: number, message: string, readonly code?: string, readonly body?: unknown) { super(message); }
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
    throw new CloudError(response.status, body.message ?? "没成功，请重试", body.code, error);
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
/** start：新首页第 4.4 节，交给 Agent 的卡同时登记要开工（配对的电脑上的网页认领后开）。budget：开工框上方选的预算（11.3），带了就存成这件 Task 的预算。 */
export const acceptDrafts = (taskId: string, drafts: TAcceptCardDraftsRequest["drafts"], start = false, budget?: TAcceptCardDraftsRequest["budget"]) =>
  unwrap(browserApi.POST("/api/plan-tasks/{taskId}/card-drafts/accept", { params: task(taskId), body: { drafts, ...(start ? { start } : {}), ...(budget ? { budget } : {}) } })).then((data) => data.cards as TCardTaskView[]);
/** 这件 Task 现在的预算（11.3；没单独设过时是本人的缺省，inherited）：开工框的模式分段从它开始。 */
export const readTaskBudget = (taskId: string) => maybe(browserApi.GET("/api/me/tasks/{taskId}/budget", { params: task(taskId) }));
/** 改这件 Task 的预算（Task 详情里「预算」那一行，11.3）。 */
export const saveTaskBudget = (taskId: string, budget: TBudget) => unwrap(browserApi.PUT("/api/me/tasks/{taskId}/budget", { params: task(taskId), body: budget }));
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
// ── 项目（第 16 节，projects.ts）──
const project = (projectId: string) => ({ path: { projectId } });
export const listProjects = () => unwrap<TProjectListResponse>(browserApi.GET("/api/me/projects") as Promise<Result<TProjectListResponse>>);
/** 建一个项目；带 taskId 时顺手把这件 Task 挂上来（「挂到… → 新建」）。 */
export const createProject = (name: string, taskId?: string) =>
  unwrap<TProject>(browserApi.POST("/api/me/projects", { body: taskId ? { name, taskId } : { name } }) as Promise<Result<TProject>>);
export const readProject = (projectId: string) => maybe<TProjectDetailResponse>(browserApi.GET("/api/me/projects/{projectId}", { params: project(projectId) }) as Promise<Result<TProjectDetailResponse>>);
/** 改名、归档（archived: true）、恢复（archived: false）。 */
export const updateProject = (projectId: string, body: TUpdateProjectRequest) =>
  unwrap<TProject>(browserApi.PATCH("/api/me/projects/{projectId}", { params: project(projectId), body }) as Promise<Result<TProject>>);
/** 把一件 Task 挂到这个项目（原来挂在别处就移过来）。 */
export const attachGoal = (projectId: string, taskId: string) =>
  unwrap<TProjectGoal>(browserApi.PUT("/api/me/projects/{projectId}/goals/{taskId}", { params: { path: { projectId, taskId } } }) as Promise<Result<TProjectGoal>>);
/** 项目对话（第一次打开时建）；收发走现有对话接口，scope 是 project:<projectId>。 */
export const openProjectPipeline = (projectId: string) =>
  maybe<TProjectPipelineResponse>(browserApi.POST("/api/me/projects/{projectId}/pipeline", { params: project(projectId) }) as Promise<Result<TProjectPipelineResponse>>);
// ── 项目转交（16.7，projectTransfers.ts）──
const transfer = (transferId: string) => ({ path: { id: transferId } });
type TransferCall = Promise<Result<TProjectTransfer>>;
/** 转给…：发起一份（准备交接），云端先写一份交接说明。 */
export const startTransfer = (projectId: string, toPersonId: string) =>
  unwrap<TProjectTransfer>(browserApi.POST("/api/me/projects/{projectId}/transfers", { params: project(projectId), body: { toPersonId } }) as TransferCall);
export const readTransfer = (transferId: string) => maybe<TProjectTransfer>(browserApi.GET("/api/me/project-transfers/{id}", { params: transfer(transferId) }) as TransferCall);
/** 改交接说明、带不带对话、两个选择、本机检查结果（准备中）。 */
export const updateTransfer = (transferId: string, body: TUpdateProjectTransferRequest) =>
  unwrap<TProjectTransfer>(browserApi.PATCH("/api/me/project-transfers/{id}", { params: transfer(transferId), body }) as TransferCall);
/** 交接说明里像密钥的地方（发出时回 422 SECRET_IN_NOTE）：哪一段第几行、命中那一截。不是这种错为 null。 */
export const secretFindings = (error: unknown): THandoverSecretFinding[] | null =>
  error instanceof CloudError && error.code === "SECRET_IN_NOTE" ? (error.body as { findings?: THandoverSecretFinding[] } | undefined)?.findings ?? [] : null;
export const sendTransfer = (transferId: string) => unwrap<TProjectTransfer>(browserApi.POST("/api/me/project-transfers/{id}/send", { params: transfer(transferId) }) as TransferCall);
export const withdrawTransfer = (transferId: string) => unwrap<TProjectTransfer>(browserApi.POST("/api/me/project-transfers/{id}/withdraw", { params: transfer(transferId) }) as TransferCall);
export const acceptTransfer = (transferId: string) => unwrap<TProjectTransfer>(browserApi.POST("/api/me/project-transfers/{id}/accept", { params: transfer(transferId) }) as TransferCall);
export const declineTransfer = (transferId: string) => unwrap<TProjectTransfer>(browserApi.POST("/api/me/project-transfers/{id}/decline", { params: transfer(transferId) }) as TransferCall);
/** 带上了对话记录时，接手人读原来那段项目对话；没带回 404（null）。 */
export const readTransferHistory = (transferId: string) =>
  maybe<TConversationHistory>(browserApi.GET("/api/me/project-transfers/{id}/history", { params: transfer(transferId) }) as Promise<Result<TConversationHistory>>);
/** 停掉还在云端排队、没有电脑接下的子会话（转交时选了「停掉」；回 204，没有在排的 404 也算停了）。电脑上已经在跑的经本机程序停。 */
export const cancelStart = (kind: "card" | "topic", subId: string) => unwrap(browserApi.DELETE("/api/me/sub-sessions/{kind}/{id}/start", { params: { path: { kind, id: subId } } }))
  .then(() => undefined, (error: unknown) => { if (!(error instanceof CloudError && (error.status === 204 || error.status === 404))) throw error; });
// ── 没挂 Task 的项目拆卡（16.3，projects.ts 的 ProjectBoardResponse）──
/** 拆卡的对象：一件 Task，或一个没挂 Task 的项目。 */
export type PlanTarget = { taskId: string } | { projectId: string };
/** 看板、拆卡失败这些按它记：Task 是 taskId，项目是 project:<projectId>。 */
export const planKey = (target: PlanTarget) => ("taskId" in target ? target.taskId : `project:${target.projectId}`);
export const registerProjectSplit = (projectId: string) =>
  unwrap<TCardSplitRequestView>(browserApi.POST("/api/me/projects/{projectId}/card-splits", { params: project(projectId) }) as Promise<Result<TCardSplitRequestView>>);
/** 登记拆卡（伙伴或页面上的「拆一下」）：配对的电脑上开着的网页认领后开规划员。 */
export const registerPlan = (target: PlanTarget) => ("taskId" in target ? registerSplit(target.taskId) : registerProjectSplit(target.projectId));
export const projectPlanBrief = (projectId: string) =>
  unwrap<TCardPlanBriefResponse>(browserApi.GET("/api/me/projects/{projectId}/plan-brief", { params: project(projectId) }) as Promise<Result<TCardPlanBriefResponse>>);
/** 项目里不挂 Task 的卡、还没处理的草稿、最近一次计划；接口没上为 null。 */
export const readProjectBoard = (projectId: string) =>
  maybe<TProjectBoardResponse>(browserApi.GET("/api/me/projects/{projectId}/board", { params: project(projectId) }) as Promise<Result<TProjectBoardResponse>>);
/** 放进看板（不挂 Task：不带预算，开工用本人的缺省预算）。 */
export const acceptProjectDrafts = (projectId: string, drafts: TAcceptCardDraftsRequest["drafts"], start = false) =>
  unwrap(browserApi.POST("/api/me/projects/{projectId}/card-drafts/accept", { params: project(projectId), body: { drafts, ...(start ? { start } : {}) } })).then((data) => data.cards as TCardTaskView[]);
export const readProjectFeed = (projectId: string) =>
  maybe<TProjectFeedResponse>(browserApi.GET("/api/me/projects/{projectId}/feed", { params: project(projectId) }) as Promise<Result<TProjectFeedResponse>>);
export const routeMessage = (text: string) => maybe<TRouteResponse>(browserApi.POST("/api/me/route", { body: { text } }) as Promise<Result<TRouteResponse>>);
/** 认领「要开工」：一条只给一处；本机起不来就 release 放回去（带认领它的这台电脑，只放回这台认领的那条；别处已经重新认领的回 404，照常忽略）。 */
export const claimStarts = (deviceId: string) => maybe<TClaimSessionStartsResponse>(browserApi.POST("/api/me/session-starts/claim", { body: { deviceId } }) as Promise<Result<TClaimSessionStartsResponse>>);
export const releaseStart = (startId: string, deviceId: string) => unwrap(browserApi.POST("/api/me/session-starts/{id}/release", { params: id(startId), body: { deviceId } }))
  .then(() => undefined, (error: unknown) => { if (!(error instanceof CloudError && error.status === 204)) throw error; });
