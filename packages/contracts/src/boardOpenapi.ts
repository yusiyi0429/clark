import type { JsonSchema, OpenAPIV3 } from "./types/JsonSchemaTypes.js";
import { CreateLocalDeviceRequest, CreateLocalDeviceResponse, LocalDeviceListResponse, LocalDeviceView, LocalOutputView, LocalRunBrief, LocalRunView } from "./localDevices.js";
import {
  AcceptCardDraftsRequest, AcceptCardDraftsResponse, AddPendingDeliverableRequest, CardBoardResponse, CardBriefResponse, CardDetailResponse, CardDraftView,
  CardHandbackView, CardPlanView, CardTaskView, CreateCardPlanRequest, CreateVersionFromPendingRequest, OverruleCardHandbackRequest, PatchCardRequest,
  PendingDeliverableItem,
} from "./taskCards.js";
import { TaskCard } from "./taskCardView.js";
import {
  CreateTopicRequest, PatchTopicRequest, ResearchTopicView, TopicBriefResponse, TopicDetailResponse, TopicListResponse, TopicVersionSummary, TopicVersionView,
} from "./topics.js";

/**
 * 执行看板、本机设备、调研专题（V2）的 OpenAPI 路径，手工列出，在 openapi.ts 里展开。
 * 本机程序的同步接收端（POST /api/local-runner/sync）用本机程序自己的契约（localRunner.ts），网页不调，不在这里列。
 */

export const boardSchemas: Record<string, JsonSchema> = {
  TaskCard, CardTaskView, CardPlanView, CardDraftView, PendingDeliverableItem, CardBoardResponse, CreateCardPlanRequest, AcceptCardDraftsRequest,
  AcceptCardDraftsResponse, PatchCardRequest, CardHandbackView, CardDetailResponse, CardBriefResponse, OverruleCardHandbackRequest,
  AddPendingDeliverableRequest, CreateVersionFromPendingRequest,
  LocalDeviceView, CreateLocalDeviceRequest, CreateLocalDeviceResponse, LocalDeviceListResponse, LocalRunBrief, LocalRunView, LocalOutputView,
  ResearchTopicView, TopicVersionSummary, TopicVersionView, TopicListResponse, CreateTopicRequest, PatchTopicRequest, TopicDetailResponse, TopicBriefResponse,
};

const error = { description: "ApiError 统一错误", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } } };
const errors = (...codes: number[]) => Object.fromEntries(codes.map((code) => [String(code), error]));
const json = (description: string, schema: string) => ({ description, content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } });
const body = (schema: string) => ({ required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } });
const path = (...names: string[]) => names.map((name) => ({ name, in: "path" as const, required: true, schema: { type: "string" } }));

export const boardPaths: OpenAPIV3.Document["paths"] = {
  "/api/plan-tasks/{taskId}/cards": {
    get: {
      operationId: "getCardBoard",
      summary: "Task 页看板（Task 负责人）：本人挂在这个 Task 下的卡（带 card）、没处理的草稿、最近一次拆卡、准备中的东西和下一版的号",
      parameters: path("taskId"),
      responses: { "200": json("看板", "CardBoardResponse"), ...errors(401, 403, 404) },
    },
  },
  "/api/plan-tasks/{taskId}/card-plans": {
    post: {
      operationId: "createCardPlan",
      summary: "拆卡（Task 负责人）：伙伴出 3–8 张草稿卡，后台跑；已有一次在排队或在跑时返回那一次",
      parameters: path("taskId"),
      requestBody: body("CreateCardPlanRequest"),
      responses: { "200": json("已有一次在跑", "CardPlanView"), "202": json("已排队", "CardPlanView"), ...errors(400, 401, 403, 404) },
    },
  },
  "/api/plan-tasks/{taskId}/card-drafts/accept": {
    post: {
      operationId: "acceptCardDrafts",
      summary: "放进看板（Task 负责人）：草稿变成执行事项，挂这个 Task 和它的 Mission",
      parameters: path("taskId"),
      requestBody: body("AcceptCardDraftsRequest"),
      responses: { "200": json("建出来的卡", "AcceptCardDraftsResponse"), ...errors(400, 401, 403, 404, 409) },
    },
  },
  "/api/card-drafts/{id}/dismiss": {
    post: {
      operationId: "dismissCardDraft",
      summary: "不要这张草稿（Task 负责人）",
      parameters: path("id"),
      responses: { "204": { description: "已去掉" }, ...errors(401, 403, 404, 409) },
    },
  },
  "/api/me/cards/{id}": {
    get: {
      operationId: "getCard",
      summary: "卡的详情（推进人）：卡、交代、完成标准、最近 5 次本机执行、交回和验收、产出",
      parameters: path("id"),
      responses: { "200": json("卡的详情", "CardDetailResponse"), ...errors(401, 403, 404) },
    },
    patch: {
      operationId: "patchCard",
      summary: "改执行方、模型、交代、对哪条标准（推进人）；version 不一致 409 带 latestTask",
      parameters: path("id"),
      requestBody: body("PatchCardRequest"),
      responses: { "200": json("改好的卡", "CardTaskView"), ...errors(400, 401, 403, 404, 409) },
    },
  },
  "/api/me/cards/{id}/brief": {
    get: {
      operationId: "getCardBrief",
      summary: "开工时交给本机的交代（推进人）：markdown 原样作为本机会话的第一句话",
      parameters: path("id"),
      responses: { "200": json("交代", "CardBriefResponse"), ...errors(401, 403, 404) },
    },
  },
  "/api/me/cards/{id}/handbacks/{handbackId}/overrule": {
    post: {
      operationId: "overruleCardHandback",
      summary: "推翻 Agent 验收（推进人）：通过的变回进行中、从准备中拿掉；没过的算通过",
      parameters: path("id", "handbackId"),
      requestBody: body("OverruleCardHandbackRequest"),
      responses: { "200": json("卡的详情", "CardDetailResponse"), ...errors(400, 401, 403, 404, 409) },
    },
  },
  "/api/me/cards/{id}/handbacks/{handbackId}/retry": {
    post: {
      operationId: "retryCardHandback",
      summary: "验收本身出错了（failed），重排一次（推进人）",
      parameters: path("id", "handbackId"),
      responses: { "200": json("卡的详情", "CardDetailResponse"), ...errors(401, 403, 404, 409) },
    },
  },
  "/api/me/cards/{id}/handbacks/{handbackId}/returned": {
    post: {
      operationId: "markCardHandbackReturned",
      summary: "网页已经把没过的改法送到本机，记一笔（推进人）；已经记过的照样返回",
      parameters: path("id", "handbackId"),
      responses: { "200": json("卡的详情", "CardDetailResponse"), ...errors(401, 403, 404, 409) },
    },
  },
  "/api/plan-tasks/{taskId}/deliverable/pending": {
    post: {
      operationId: "addPendingDeliverable",
      summary: "把挂在这个 Task 上的专题的一版放进下一版（Task 负责人）",
      parameters: path("taskId"),
      requestBody: body("AddPendingDeliverableRequest"),
      responses: { "201": json("准备中的一样", "PendingDeliverableItem"), ...errors(400, 401, 403, 404, 409) },
    },
  },
  "/api/plan-tasks/{taskId}/deliverable/pending/{id}": {
    delete: {
      operationId: "removePendingDeliverable",
      summary: "从准备中拿出来（Task 负责人）",
      parameters: path("taskId", "id"),
      responses: { "204": { description: "已拿出" }, ...errors(401, 403, 404) },
    },
  },
  "/api/plan-tasks/{taskId}/deliverable/versions/from-pending": {
    post: {
      operationId: "createDeliverableVersionFromPending",
      summary: "出下一版（Task 负责人）：准备中的各样连同上一版的全部材料建成新一版，评审自动开始",
      parameters: path("taskId"),
      requestBody: body("CreateVersionFromPendingRequest"),
      responses: { "201": json("新版本（评审已排队）", "DeliverableVersion"), ...errors(400, 401, 403, 404, 409, 413) },
    },
  },
  "/api/me/local-outputs/{id}": {
    get: {
      operationId: "readLocalOutput",
      summary: "打开本机传上来的一份产出（本人）；HTML 照材料预览加 CSP sandbox",
      parameters: path("id"),
      responses: { "200": { description: "原文件", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } }, ...errors(401, 404) },
    },
  },
  "/api/me/local-devices": {
    get: {
      operationId: "listLocalDevices",
      summary: "本人配对过、没吊销的本机设备",
      responses: { "200": json("设备", "LocalDeviceListResponse"), ...errors(401) },
    },
    post: {
      operationId: "createLocalDevice",
      summary: "配对时建设备令牌（本人）：同一台电脑再配对换一把新的、旧的立刻失效；令牌只回这一次",
      requestBody: body("CreateLocalDeviceRequest"),
      responses: { "201": json("设备和令牌", "CreateLocalDeviceResponse"), ...errors(400, 401) },
    },
  },
  "/api/me/local-devices/{id}": {
    delete: {
      operationId: "revokeLocalDevice",
      summary: "吊销一台设备（本人）：它的令牌立刻失效",
      parameters: path("id"),
      responses: { "204": { description: "已吊销" }, ...errors(401, 404) },
    },
  },
  "/api/me/topics": {
    get: {
      operationId: "listTopics",
      summary: "本人的调研专题（默认没归档的，status=archived 看归档的）",
      parameters: [{ name: "status", in: "query", required: false, schema: { type: "string", enum: ["active", "archived"] } }],
      responses: { "200": json("专题", "TopicListResponse"), ...errors(400, 401) },
    },
    post: {
      operationId: "createTopic",
      summary: "新建调研专题（本人），可挂本人 Mission 下的一个 Task",
      requestBody: body("CreateTopicRequest"),
      responses: { "201": json("新专题", "ResearchTopicView"), ...errors(400, 401, 404) },
    },
  },
  "/api/me/topics/{id}": {
    get: {
      operationId: "getTopic",
      summary: "专题详情（本人）：各版本（不带正文）、最新一版正文、最近 5 次本机执行",
      parameters: path("id"),
      responses: { "200": json("专题", "TopicDetailResponse"), ...errors(401, 404) },
    },
    patch: {
      operationId: "patchTopic",
      summary: "改标题、归档或取消归档（本人）",
      parameters: path("id"),
      requestBody: body("PatchTopicRequest"),
      responses: { "200": json("专题", "ResearchTopicView"), ...errors(400, 401, 404) },
    },
  },
  "/api/me/topics/{id}/versions/{number}": {
    get: {
      operationId: "getTopicVersion",
      summary: "专题的某一版，带正文（本人）",
      parameters: [...path("id"), { name: "number", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
      responses: { "200": json("这一版", "TopicVersionView"), ...errors(401, 404) },
    },
  },
  "/api/me/topics/{id}/brief": {
    get: {
      operationId: "getTopicBrief",
      summary: "开专题时交给本机的交代（本人）：markdown 原样作为本机会话的第一句话",
      parameters: path("id"),
      responses: { "200": json("交代", "TopicBriefResponse"), ...errors(401, 404) },
    },
  },
};
