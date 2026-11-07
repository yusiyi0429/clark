import type { JsonSchema, OpenAPIV3 } from "./types/JsonSchemaTypes.js";
import {
  BackgroundItem, BackgroundResponse, ClaimSessionStartsRequest, ClaimSessionStartsResponse, HomeMonthMission, HomeMonthTask, HomeProject, HomeProjectGoal,
  HomeTaskSummary, RouteRequest, RouteResponse, SessionStartView, SubSession, WaitingItem, WaitingTarget, WorkHomeResponse, CardMerge, TaskFeedItem, HomeItem,
  ReleaseSessionStartRequest, NotificationSettings, ClaimedSessionStart,
} from "./workHome.js";
import { CreateProjectRequest, Project, ProjectDetailResponse, ProjectFeedItem, ProjectFeedResponse, ProjectGoal, ProjectGoalLinkedItem, ProjectListResponse,
  ProjectPipelineResponse, UpdateProjectRequest } from "./projects.js";
import { Budget, TaskBudgetResponse } from "./budget.js";
import { SessionAttachment, SessionAttachmentUploadResponse } from "./attachments.js";

/**
 * 新首页（伙伴总管线 + 项目 + 子会话）的 OpenAPI 路径，手工列出，在 openapi.ts 里展开。
 * 伙伴开探索子会话（/internal/me/topics）只给 Chat 服务调，不在这里列。
 */

export const workHomeSchemas: Record<string, JsonSchema> = {
  SubSession, HomeTaskSummary, HomeProjectGoal, HomeProject, HomeMonthTask, HomeMonthMission, WaitingTarget, WaitingItem, WorkHomeResponse,
  BackgroundItem, BackgroundResponse, RouteRequest, RouteResponse,
  SessionStartView, ClaimSessionStartsRequest, ClaimSessionStartsResponse, CardMerge, TaskFeedItem, HomeItem, ReleaseSessionStartRequest,
  Project, ProjectListResponse, CreateProjectRequest, UpdateProjectRequest, ProjectGoal, ProjectDetailResponse, ProjectPipelineResponse, ProjectGoalLinkedItem,
  ProjectFeedItem, ProjectFeedResponse,
  NotificationSettings, Budget, TaskBudgetResponse, ClaimedSessionStart, SessionAttachment, SessionAttachmentUploadResponse,
};

const error = { description: "ApiError 统一错误", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } } };
const errors = (...codes: number[]) => Object.fromEntries(codes.map((code) => [String(code), error]));
const json = (description: string, schema: string) => ({ description, content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } });
const body = (schema: string) => ({ required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } });
const path = (...names: string[]) => names.map((name) => ({ name, in: "path" as const, required: true, schema: { type: "string" } }));

export const workHomePaths: OpenAPIV3.Document["paths"] = {
  "/api/me/sub-sessions/{kind}/{id}/attachments": {
    post: {
      operationId: "uploadSubSessionAttachments",
      summary: "子会话（卡、专题，本人的）的附件存到云端（multipart files，新首页 14.5）：类型见 attachments.ts，每个不超过 30 MB，一次合计不超过 100 MB；回执的 id 随给本机程序的那句话带上（LocalSendMessageRequest.attachments）",
      parameters: [{ name: "kind", in: "path", required: true, schema: { type: "string", enum: ["card", "topic"] } }, ...path("id")],
      requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", properties: { files: { type: "array", items: { type: "string", format: "binary" } } } } } } },
      responses: { "200": json("存好的附件", "SessionAttachmentUploadResponse"), ...errors(400, 401, 403, 404, 413) },
    },
  },
  "/api/me/session-attachments/{id}": {
    get: {
      operationId: "getSessionAttachment",
      summary: "子会话附件的原文件（本人的；气泡里的缩略图、下载）",
      parameters: path("id"),
      responses: { "200": { description: "文件原样" }, ...errors(401, 404) },
    },
  },
  "/api/me/budget-default": {
    get: {
      operationId: "getBudgetDefault",
      summary: "本人新 Task 的缺省预算（「偏好」，设计 11.3）：没设过是自动",
      responses: { "200": json("缺省预算", "Budget"), ...errors(401) },
    },
    put: {
      operationId: "updateBudgetDefault",
      summary: "改本人新 Task 的缺省预算；设预算时至少一项上限",
      requestBody: body("Budget"),
      responses: { "200": json("改好的缺省预算", "Budget"), ...errors(400, 401, 403) },
    },
  },
  "/api/me/tasks/{taskId}/budget": {
    get: {
      operationId: "getTaskBudget",
      summary: "这件 Task 的预算（Task 负责人）；没单独设过时是本人的缺省（inherited=true）",
      parameters: path("taskId"),
      responses: { "200": json("Task 的预算", "TaskBudgetResponse"), ...errors(401, 403, 404) },
    },
    put: {
      operationId: "updateTaskBudget",
      summary: "改这件 Task 的预算（Task 负责人）；设预算时至少一项上限",
      parameters: path("taskId"),
      requestBody: body("Budget"),
      responses: { "200": json("改好的预算", "TaskBudgetResponse"), ...errors(400, 401, 403, 404) },
    },
  },
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
      summary: "新首页 v2（DRI 工作台，第 16 节）：没归档的项目（挂着的目标、子会话、事项）、「本月」按 Mission 列这个月的 Task 和挂在哪个项目、「其他」和跨来源的「等你」",
      responses: { "200": json("首页", "WorkHomeResponse"), ...errors(401, 403) },
    },
  },
  "/api/me/background": {
    get: {
      operationId: "getBackground",
      summary: "后台任务（右栏）：scope=main | resources | project:<项目 id> | task:<taskId> | card:<卡 id> | topic:<专题 id>；规划员、验收员、子会话里的子 agent 和后台命令，加资源摘要（resources 只要资源块）",
      parameters: [{ name: "scope", in: "query", required: true, schema: { type: "string" } }],
      responses: { "200": json("后台任务", "BackgroundResponse"), ...errors(400, 401, 403, 404) },
    },
  },
  "/api/me/projects": {
    get: {
      operationId: "listProjects",
      summary: "本人全部项目（含归档的）：没归档的在前，各自按最近动静从近到远",
      responses: { "200": json("项目", "ProjectListResponse"), ...errors(401, 403) },
    },
    post: {
      operationId: "createProject",
      summary: "建一个项目；带 taskId 时顺手把这件本人负责的 Task 挂上来（原来挂在别处就移过来）",
      requestBody: body("CreateProjectRequest"),
      responses: { "201": json("建好的项目", "Project"), ...errors(400, 401, 403, 404) },
    },
  },
  "/api/me/projects/{projectId}": {
    get: {
      operationId: "getProject",
      summary: "项目详情：目标历史（每月挂过的 Task 和判定，月份从近到远）；当前 Task 的标准、约定、交付物照 Task 详情的接口按 taskId 读",
      parameters: path("projectId"),
      responses: { "200": json("项目详情", "ProjectDetailResponse"), ...errors(401, 403, 404) },
    },
    patch: {
      operationId: "updateProject",
      summary: "改名、归档（archived: true）、恢复（archived: false）",
      parameters: path("projectId"),
      requestBody: body("UpdateProjectRequest"),
      responses: { "200": json("改好的项目", "Project"), ...errors(400, 401, 403, 404) },
    },
  },
  "/api/me/projects/{projectId}/goals/{taskId}": {
    put: {
      operationId: "linkProjectGoal",
      summary: "把一件本人负责的 Task 挂到这个项目（原来挂在别处就移过来）；归档了的项目不能挂（409）",
      parameters: path("projectId", "taskId"),
      responses: { "200": json("这条挂接", "ProjectGoal"), ...errors(401, 403, 404, 409) },
    },
    delete: {
      operationId: "unlinkProjectGoal",
      summary: "把这件 Task 从项目上取下来，回到「本月」里没挂的状态",
      parameters: path("projectId", "taskId"),
      responses: { "204": { description: "取下来了" }, ...errors(401, 403, 404) },
    },
  },
  "/api/me/projects/{projectId}/pipeline": {
    post: {
      operationId: "openProjectPipeline",
      summary: "这个项目的对话：第一次打开时建，以后都返回同一条；收发消息走 /api/conversations/{scope}，scope 是 project:<projectId>",
      parameters: path("projectId"),
      responses: { "200": json("已有的项目对话", "ProjectPipelineResponse"), "201": json("新建的项目对话", "ProjectPipelineResponse"), ...errors(401, 403, 404, 502, 503) },
    },
  },
  "/api/me/projects/{projectId}/feed": {
    get: {
      operationId: "getProjectFeed",
      summary: "项目对话里按时间插的行：挂上新目标（分隔线）、卡验收过了（带合回结果）、受阻、约定都达到、合回后推翻开了返工卡，从旧到新",
      parameters: path("projectId"),
      responses: { "200": json("项目动态", "ProjectFeedResponse"), ...errors(401, 403, 404) },
    },
  },
  "/api/me/route": {
    post: {
      operationId: "routeMessage",
      summary: "首页「自动」发给谁：句子里提到了哪个项目的名字、或它挂着的 Task 的名字和标准里的词就发给那个项目，分不出来或没提到发给伙伴；不用模型",
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
