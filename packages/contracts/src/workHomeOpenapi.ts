import type { JsonSchema, OpenAPIV3 } from "./types/JsonSchemaTypes.js";
import {
  BackgroundItem, BackgroundResponse, ClaimSessionStartsRequest, ClaimSessionStartsResponse, HomeMission, HomeTask, HomeTaskSummary, RouteRequest, RouteResponse,
  SessionStartView, SubSession, TaskPipelineResponse, WaitingItem, WaitingTarget, WorkHomeResponse, CardMerge, TaskFeedItem, TaskFeedResponse, HomeItem, ReleaseSessionStartRequest,
  NotificationSettings,
} from "./workHome.js";

/**
 * 新首页（伙伴总管线 + Task 管线 + 子会话）的 OpenAPI 路径，手工列出，在 openapi.ts 里展开。
 * 伙伴开探索子会话（/internal/me/topics）只给 Chat 服务调，不在这里列。
 */

export const workHomeSchemas: Record<string, JsonSchema> = {
  SubSession, HomeTaskSummary, HomeTask, HomeMission, WaitingTarget, WaitingItem, WorkHomeResponse,
  BackgroundItem, BackgroundResponse, TaskPipelineResponse, RouteRequest, RouteResponse,
  SessionStartView, ClaimSessionStartsRequest, ClaimSessionStartsResponse, CardMerge, TaskFeedItem, TaskFeedResponse, HomeItem, ReleaseSessionStartRequest,
  NotificationSettings,
};

const error = { description: "ApiError 统一错误", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } } };
const errors = (...codes: number[]) => Object.fromEntries(codes.map((code) => [String(code), error]));
const json = (description: string, schema: string) => ({ description, content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } });
const body = (schema: string) => ({ required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } });
const path = (...names: string[]) => names.map((name) => ({ name, in: "path" as const, required: true, schema: { type: "string" } }));

export const workHomePaths: OpenAPIV3.Document["paths"] = {
  "/api/me/notification-settings": {
    get: {
      operationId: "getNotificationSettings",
      summary: "本人的通知开关（「偏好」）：飞书通知，缺省开",
      responses: { "200": json("通知开关", "NotificationSettings"), ...errors(401) },
    },
    put: {
      operationId: "updateNotificationSettings",
      summary: "改本人的通知开关",
      requestBody: body("NotificationSettings"),
      responses: { "200": json("改好的通知开关", "NotificationSettings"), ...errors(400, 401, 403) },
    },
  },
  "/api/me/work-home": {
    get: {
      operationId: "getWorkHome",
      summary: "新首页（DRI 工作台）：Mission → 本人负责、没了结的 Task → 子会话（卡、专题）的树，不归任何 Task 的「其他」，和跨来源的「等你」；不按月份硬切",
      responses: { "200": json("首页", "WorkHomeResponse"), ...errors(401, 403) },
    },
  },
  "/api/me/background": {
    get: {
      operationId: "getBackground",
      summary: "后台任务（右栏）：scope=main | resources | task:<taskId> | card:<卡 id> | topic:<专题 id>；规划员、验收员、子会话里的子 agent 和后台命令，加资源摘要（resources 只要资源块）",
      parameters: [{ name: "scope", in: "query", required: true, schema: { type: "string" } }],
      responses: { "200": json("后台任务", "BackgroundResponse"), ...errors(400, 401, 403, 404) },
    },
  },
  "/api/me/tasks/{taskId}/pipeline": {
    post: {
      operationId: "openTaskPipeline",
      summary: "这件 Task 的管线对话（Task 负责人）：第一次打开时建，以后都返回同一条；收发消息走 /api/conversations/{scope}，scope 是 plan-task:<taskId>",
      parameters: path("taskId"),
      responses: { "200": json("已有的管线", "TaskPipelineResponse"), "201": json("新建的管线", "TaskPipelineResponse"), ...errors(401, 403, 404, 502, 503) },
    },
  },
  "/api/me/tasks/{taskId}/feed": {
    get: {
      operationId: "getTaskFeed",
      summary: "Task 管线里的验收行（Task 负责人）：卡验收过了（带合回结果）、受阻、约定都达到、合回后推翻开了返工卡，从旧到新；网页按时间插进 Task 管线",
      parameters: path("taskId"),
      responses: { "200": json("验收行", "TaskFeedResponse"), ...errors(401, 403, 404) },
    },
  },
  "/api/me/route": {
    post: {
      operationId: "routeMessage",
      summary: "首页「自动」发给谁：句子里提到了哪件 Task 的名字或标准里的词就发给那件 Task 的管线，分不出来或没提到发给伙伴；不用模型",
      requestBody: body("RouteRequest"),
      responses: { "200": json("发给谁", "RouteResponse"), ...errors(400, 401, 403) },
    },
  },
  "/api/me/session-starts/claim": {
    post: {
      operationId: "claimSessionStarts",
      summary: "认领还没人接的「要开工」（配对的电脑上开着的网页）：回这次认领到的卡和专题，一条只给一处；网页随后交给本机程序",
      requestBody: body("ClaimSessionStartsRequest"),
      responses: { "200": json("认领到的", "ClaimSessionStartsResponse"), ...errors(400, 401, 403, 404) },
    },
  },
  "/api/me/session-starts/{id}/release": {
    post: {
      operationId: "releaseSessionStart",
      summary: "本机没开起来：把这台电脑认领的那条放回去，下次再认领（别处已经重新认领的不动，回 404）",
      parameters: path("id"),
      requestBody: body("ReleaseSessionStartRequest"),
      responses: { "204": { description: "放回去了" }, ...errors(401, 403, 404) },
    },
  },
};
