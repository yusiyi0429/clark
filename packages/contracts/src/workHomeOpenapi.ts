import type { JsonSchema, OpenAPIV3 } from "./types/JsonSchemaTypes.js";
import {
  BackgroundItem, BackgroundResponse, ClaimSessionStartsRequest, ClaimSessionStartsResponse, HomeMonthMission, HomeMonthTask, HomeProject, HomeProjectGoal,
  HomeTaskSummary, RouteRequest, RouteResponse, SessionStartView, SubSession, WaitingItem, WaitingTarget, WorkHomeResponse, CardMerge, TaskFeedItem, HomeItem,
  ReleaseSessionStartRequest, NotificationSettings, ClaimedSessionStart, AppearanceSettings, SessionStopView, ClaimSessionStopsRequest, ClaimSessionStopsResponse,
  SessionStopDoneRequest, SessionCommand, SessionCommandView, ClaimSessionCommandsRequest, ClaimSessionCommandsResponse, SessionCommandDoneRequest,
  MarkWorkSeenRequest, SubSessionKind, UpdateSubSessionRequest, ArchivedSubSession, ArchivedSubSessionListResponse,
} from "./workHome.js";
import { CreateProjectRequest, Project, ProjectDetailResponse, ProjectFeedItem, ProjectFeedResponse, ProjectGoal, ProjectGoalLinkedItem, ProjectHandoverItem,
  ProjectHandoverSummaryItem, ProjectListResponse, ProjectPipelineResponse, ProjectTransferDeclinedItem, UpdateProjectRequest, ProjectBoardResponse, ProjectGoalChangedItem,
  AnswerGoalChangeRequest, SubSessionFeedRef, ProjectSubSessionReportItem, ProjectSubSessionDecisionItem, AutoRelayDecisionRequest, SetGoalDueDateRequest,
  ModelEffort, ConversationModelOption, ConversationModelListResponse, ConversationModelChoice, ProjectPipelineModel, SetProjectPipelineModelRequest } from "./projects.js";
import { CreateProjectTransferRequest, HandoverSecretFinding, HandoverSecretsResponse, HandoverSection, PersonRef, ProjectTransfer,
  UpdateProjectTransferRequest } from "./projectTransfers.js";
import { Budget, TaskBudgetResponse } from "./budget.js";
import { BuddyAuditEntry, BuddyAuditListResponse, BuddyAuthority, BuddyMessageDraft, TrashItem, TrashListResponse, UpdateBuddyAuthorityRequest } from "./buddyActions.js";
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
  ProjectFeedItem, ProjectFeedResponse, ProjectBoardResponse, ProjectGoalChangedItem, AnswerGoalChangeRequest, SubSessionFeedRef, ProjectSubSessionReportItem, ProjectSubSessionDecisionItem, AutoRelayDecisionRequest, SetGoalDueDateRequest, ProjectHandoverItem, ProjectHandoverSummaryItem, ProjectTransferDeclinedItem,
  PersonRef, HandoverSection, ProjectTransfer, CreateProjectTransferRequest, UpdateProjectTransferRequest, HandoverSecretFinding, HandoverSecretsResponse,
  NotificationSettings, AppearanceSettings, SessionStopView, ClaimSessionStopsRequest, ClaimSessionStopsResponse, SessionStopDoneRequest,
  SessionCommand, SessionCommandView, ClaimSessionCommandsRequest, ClaimSessionCommandsResponse, SessionCommandDoneRequest, MarkWorkSeenRequest,
  SubSessionKind, UpdateSubSessionRequest, ArchivedSubSession, ArchivedSubSessionListResponse,
  ModelEffort, ConversationModelOption, ConversationModelListResponse, ConversationModelChoice, ProjectPipelineModel, SetProjectPipelineModelRequest,
  BuddyAuthority, UpdateBuddyAuthorityRequest, BuddyAuditEntry, BuddyAuditListResponse, BuddyMessageDraft, TrashItem, TrashListResponse, Budget, TaskBudgetResponse, ClaimedSessionStart, SessionAttachment, SessionAttachmentUploadResponse,
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
  "/api/me/appearance": {
    get: {
      operationId: "getAppearance",
      summary: "本人的外观（「偏好」）：跟随系统 / 浅色 / 深色，缺省跟随系统",
      responses: { "200": json("外观", "AppearanceSettings"), ...errors(401) },
    },
    put: {
      operationId: "updateAppearance",
      summary: "改本人的外观（换设备一样）",
      requestBody: body("AppearanceSettings"),
      responses: { "200": json("改好的外观", "AppearanceSettings"), ...errors(400, 401) },
    },
  },
  "/api/me/buddy-authority": {
    get: {
      operationId: "getBuddyAuthority",
      summary: "伙伴代本人做事的授权（17.4）：full 完全授权，none 只能读（缺省）",
      responses: { "200": json("授权", "BuddyAuthority"), ...errors(401) },
    },
    put: {
      operationId: "updateBuddyAuthority",
      summary: "打开或关掉伙伴的授权（引导里的「同意」、偏好里的开关）",
      requestBody: body("UpdateBuddyAuthorityRequest"),
      responses: { "200": json("改好的授权", "BuddyAuthority"), ...errors(400, 401) },
    },
  },
  "/api/me/buddy-actions/log": {
    get: {
      operationId: "listBuddyActions",
      summary: "伙伴代本人做过的写动作（新的在前，最近 100 条），能撤的带 undoable",
      responses: { "200": json("审计", "BuddyAuditListResponse"), ...errors(401) },
    },
  },
  "/api/me/buddy-actions/log/{id}/undo": {
    post: {
      operationId: "undoBuddyAction",
      summary: "撤销伙伴做的一个动作；不能撤、撤过了、对象已经变了 409 NOT_UNDOABLE",
      parameters: path("id"),
      responses: { "200": json("撤销后的这条", "BuddyAuditEntry"), ...errors(401, 404, 409) },
    },
  },
  "/api/me/buddy-messages/{id}": {
    get: {
      operationId: "getBuddyMessage",
      summary: "伙伴要转达给同事的一句话（对话里的 buddy_message 卡）",
      parameters: path("id"),
      responses: { "200": json("这句话", "BuddyMessageDraft"), ...errors(401, 404) },
    },
  },
  "/api/me/buddy-messages/{id}/send": {
    post: {
      operationId: "sendBuddyMessage",
      summary: "发出：天枢机器人转达给收件人（开头「{本人}请我转达：」）；收不到的列在 failed；不是草稿 409",
      parameters: path("id"),
      responses: { "200": json("发出后的这句话", "BuddyMessageDraft"), ...errors(401, 404, 409, 429) },
    },
  },
  "/api/me/buddy-messages/{id}/cancel": {
    post: {
      operationId: "cancelBuddyMessage",
      summary: "不发了；不是草稿 409",
      parameters: path("id"),
      responses: { "200": json("取消后的这句话", "BuddyMessageDraft"), ...errors(401, 404, 409) },
    },
  },
  "/api/me/trash": {
    get: {
      operationId: "listTrash",
      summary: "回收站：删掉的子会话，purgeAt 以后真删",
      responses: { "200": json("回收站", "TrashListResponse"), ...errors(401) },
    },
  },
  "/api/me/trash/{kind}/{id}/restore": {
    post: {
      operationId: "restoreTrashItem",
      summary: "从回收站恢复一个子会话（204）；已经真删了 404",
      parameters: [{ name: "kind", in: "path", required: true, schema: { type: "string", enum: ["card", "topic"] } }, ...path("id")],
      responses: { "204": { description: "恢复了" }, ...errors(401, 404) },
    },
  },
  "/api/me/session-stops/claim": {
    post: {
      operationId: "claimSessionStops",
      summary: "认领这台电脑上要停掉的本机会话（17.4 伙伴的 stop_sub_session）",
      requestBody: body("ClaimSessionStopsRequest"),
      responses: { "200": json("要停的", "ClaimSessionStopsResponse"), ...errors(400, 401, 404) },
    },
  },
  "/api/me/session-stops/{id}/done": {
    post: {
      operationId: "finishSessionStop",
      summary: "报停掉的结果（stopped / not_running）；不是这台电脑认领的 404",
      parameters: path("id"),
      requestBody: body("SessionStopDoneRequest"),
      responses: { "204": { description: "记下了" }, ...errors(400, 401, 404) },
    },
  },
  "/api/me/projects/{projectId}/goals/{taskId}/due-date": {
    put: {
      operationId: "setProjectGoalDueDate",
      summary: "给挂在这个项目上的一件 Task 存验收截止日（null 不存了，退回 Mission 的节点）；没挂在这个项目上 404",
      parameters: path("projectId", "taskId"),
      requestBody: body("SetGoalDueDateRequest"),
      responses: { "200": json("这条挂接", "ProjectGoal"), ...errors(400, 401, 403, 404) },
    },
  },
  "/api/me/projects/{projectId}/auto-relay": {
    post: {
      operationId: "decideAutoRelay",
      summary: "答「等你」里的自动接力（18 节第 12 条）：continue 清零恢复，stop 收起那一条、等本人说话再恢复；没停着 409",
      parameters: path("projectId"),
      requestBody: body("AutoRelayDecisionRequest"),
      responses: { "204": { description: "记下了" }, ...errors(400, 401, 403, 404, 409) },
    },
  },
  "/api/me/work-seen": {
    post: {
      operationId: "markWorkSeen",
      summary: "本人打开了一个子会话或项目对话：记下看过的时间，左栏蓝点（unseen）消失；幂等（17.2 第 25 条）",
      requestBody: body("MarkWorkSeenRequest"),
      responses: { "204": { description: "记下了" }, ...errors(400, 401, 403) },
    },
  },
  "/api/me/sub-sessions/{kind}/{id}": {
    patch: {
      operationId: "updateSubSession",
      summary: "子会话「…」菜单（17.2 第 35 条）：改名、归档（archived: true）、恢复（archived: false）；在跑时归档 409 SUB_SESSION_RUNNING；专题名超 60 字 400",
      parameters: [{ name: "kind", in: "path", required: true, schema: { type: "string", enum: ["card", "topic"] } }, ...path("id")],
      requestBody: body("UpdateSubSessionRequest"),
      responses: { "204": { description: "改好了" }, ...errors(400, 401, 403, 404, 409) },
    },
    delete: {
      operationId: "deleteSubSession",
      summary: "删掉一个子会话：先进回收站，30 天内能恢复，之后彻底删掉撤不回；在跑 409 SUB_SESSION_RUNNING",
      parameters: [{ name: "kind", in: "path", required: true, schema: { type: "string", enum: ["card", "topic"] } }, ...path("id")],
      responses: { "204": { description: "进回收站了" }, ...errors(401, 403, 404, 409) },
    },
  },
  "/api/me/sub-sessions/archived": {
    get: {
      operationId: "listArchivedSubSessions",
      summary: "归档了的子会话（新归档的在前），带原来的项目和字母",
      responses: { "200": json("归档了的子会话", "ArchivedSubSessionListResponse"), ...errors(401, 403) },
    },
  },
  "/api/me/session-commands/claim": {
    post: {
      operationId: "claimSessionCommands",
      summary: "认领这台电脑上要对本机会话做的事（18 节第 10 条：项目主管线按字母转话、重开、回答问题、批准）",
      requestBody: body("ClaimSessionCommandsRequest"),
      responses: { "200": json("要做的", "ClaimSessionCommandsResponse"), ...errors(400, 401, 404) },
    },
  },
  "/api/me/session-commands/{id}/done": {
    post: {
      operationId: "finishSessionCommand",
      summary: "报做的结果（done / not_running / expired / failed）；不是这台电脑认领的 404",
      parameters: path("id"),
      requestBody: body("SessionCommandDoneRequest"),
      responses: { "204": { description: "记下了" }, ...errors(400, 401, 404) },
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
    delete: {
      operationId: "deleteProject",
      summary: "删掉项目（17.2 第 35 条，撤不回）：项目、项目对话、挂接、字母和汇报删掉，子会话进回收站，自己做的事项留到「其他」；只有负责人能删；有在跑的 409 PROJECT_BUSY，正在转交 409 PROJECT_TRANSFERRING",
      parameters: path("projectId"),
      responses: { "204": { description: "删掉了" }, ...errors(401, 403, 404, 409) },
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
  "/api/me/projects/{projectId}/pipeline/model": {
    get: {
      operationId: "getProjectPipelineModel",
      summary: "这个项目对话选的模型和思考程度（17.2 第 36 条）；没选为 null（照 Chat 的默认）",
      parameters: path("projectId"),
      responses: { "200": json("现在选的", "ProjectPipelineModel"), ...errors(401, 403, 404, 502, 503) },
    },
    put: {
      operationId: "setProjectPipelineModel",
      summary: "给这个项目对话选模型和思考程度，null 回到默认；不在列表里或思考程度不支持 400 INVALID_MODEL_CHOICE；没接 Chat 409 CHAT_NOT_CONNECTED",
      parameters: path("projectId"),
      requestBody: body("SetProjectPipelineModelRequest"),
      responses: { "200": json("改好的", "ProjectPipelineModel"), ...errors(400, 401, 403, 404, 409, 502, 503) },
    },
  },
  "/api/me/conversation-models": {
    get: {
      operationId: "listConversationModels",
      summary: "项目对话能选的模型和各自支持的思考程度（17.2 第 36 条）；默认的排第一；没接 Chat 为空",
      responses: { "200": json("能选的模型", "ConversationModelListResponse"), ...errors(401, 403, 502, 503) },
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
  "/api/me/projects/{projectId}/goal-changes/{id}": {
    post: {
      operationId: "answerGoalChange",
      summary: "答月中 Task 改了或取消了的选项框（16.4）：停掉或留着和它有关的子会话",
      parameters: path("projectId", "id"),
      requestBody: body("AnswerGoalChangeRequest"),
      responses: { "200": json("答完的那一行", "ProjectGoalChangedItem"), ...errors(400, 401, 403, 404, 409) },
    },
  },
  "/api/me/projects/{projectId}/board": {
    get: {
      operationId: "getProjectBoard",
      summary: "没挂 Task 的项目拆卡（16.3）：项目里不挂 Task 的卡、还没处理的派活单草稿、最近一次计划",
      parameters: path("projectId"),
      responses: { "200": json("项目看板", "ProjectBoardResponse"), ...errors(401, 403, 404) },
    },
  },
  "/api/me/projects/{projectId}/card-splits": {
    post: {
      operationId: "registerProjectCardSplit",
      summary: "登记拆这个项目（16.3，没挂 Task 也能拆）：只记下来，网页在本人电脑上开规划员；已有一条没开工的回那一条（200）。可以带本人在输入框里的话（16.8 原话）",
      parameters: path("projectId"),
      requestBody: { required: false, content: { "application/json": { schema: { $ref: "#/components/schemas/RegisterCardSplitRequest" } } } },
      responses: { "200": json("已有的登记", "CardSplitRequestView"), "201": json("新登记", "CardSplitRequestView"), ...errors(401, 403, 404, 409) },
    },
  },
  "/api/me/projects/{projectId}/plan-brief": {
    get: {
      operationId: "getProjectPlanBrief",
      summary: "拆项目的规划员交代（16.3）：项目名、目标历史、已有的卡；每件派活单自带完成标准",
      parameters: path("projectId"),
      responses: { "200": json("交代", "CardPlanBriefResponse"), ...errors(401, 403, 404) },
    },
  },
  "/api/me/projects/{projectId}/card-drafts/accept": {
    post: {
      operationId: "acceptProjectCardDrafts",
      summary: "把项目的派活单草稿放进看板（16.3）：卡挂项目、不挂 Task；start=true 时交给 Agent 的卡同时登记要开工",
      parameters: path("projectId"),
      requestBody: body("AcceptCardDraftsRequest"),
      responses: { "200": json("放进去的卡", "AcceptCardDraftsResponse"), ...errors(400, 401, 403, 404, 409) },
    },
  },
  "/api/me/projects/{projectId}/transfers": {
    post: {
      operationId: "startProjectTransfer",
      summary: "转给…（16.7，项目负责人）：发起一份转交（准备交接），云端先拼一份交接说明；给自己 400，人员目录里没有 404，已有没了结的或项目归档了 409",
      parameters: path("projectId"),
      requestBody: body("CreateProjectTransferRequest"),
      responses: { "201": json("准备中的转交", "ProjectTransfer"), ...errors(400, 401, 403, 404, 409) },
    },
  },
  "/api/me/project-transfers/{id}": {
    get: {
      operationId: "getProjectTransfer",
      summary: "一份转交（原负责人和接手人都能看；接手人的只读预览）",
      parameters: path("id"),
      responses: { "200": json("转交", "ProjectTransfer"), ...errors(401, 403, 404) },
    },
    patch: {
      operationId: "updateProjectTransfer",
      summary: "改交接说明、带不带对话、在跑的会话等做完还是停掉、本机检查还是直接转、本机检查结果（原负责人，准备中）；存检查结果时按它重拼「代码在哪」",
      parameters: path("id"),
      requestBody: body("UpdateProjectTransferRequest"),
      responses: { "200": json("改好的转交", "ProjectTransfer"), ...errors(400, 401, 403, 404, 409) },
    },
  },
  "/api/me/project-transfers/{id}/send": {
    post: {
      operationId: "sendProjectTransfer",
      summary: "发出（原负责人，准备中）：交接说明里像密钥的地方挡住（422，标出哪一段第几行）",
      parameters: path("id"),
      responses: { "200": json("发出的转交", "ProjectTransfer"), "422": json("交接说明里有像密钥的", "HandoverSecretsResponse"), ...errors(400, 401, 403, 404, 409) },
    },
  },
  "/api/me/project-transfers/{id}/withdraw": {
    post: {
      operationId: "withdrawProjectTransfer",
      summary: "撤回（原负责人，准备中或已发出、还没接手）",
      parameters: path("id"),
      responses: { "200": json("撤回的转交", "ProjectTransfer"), ...errors(401, 403, 404, 409) },
    },
  },
  "/api/me/project-transfers/{id}/accept": {
    post: {
      operationId: "acceptProjectTransfer",
      summary: "接手（接手人，已发出）：项目换成本人负责，原负责人那边归档、只读；对话从分隔线开始，第一条是交接说明；管线先不自己开子会话",
      parameters: path("id"),
      responses: { "200": json("接手了的转交", "ProjectTransfer"), ...errors(401, 403, 404, 409) },
    },
  },
  "/api/me/project-transfers/{id}/decline": {
    post: {
      operationId: "declineProjectTransfer",
      summary: "不接（接手人，已发出）：项目留在原负责人那边，他的项目对话里一行「{名字}没接」",
      parameters: path("id"),
      responses: { "200": json("没接的转交", "ProjectTransfer"), ...errors(401, 403, 404, 409) },
    },
  },
  "/api/me/project-transfers/{id}/history": {
    get: {
      operationId: "getProjectTransferHistory",
      summary: "带上了对话记录时，接手人读原负责人那段项目对话（只读，画在分隔线上面）；没带 404。原负责人读自己那段走 /api/conversations/{scope}/messages",
      parameters: path("id"),
      responses: { "200": json("原来的对话", "ConversationHistory"), ...errors(401, 403, 404) },
    },
  },
  "/api/me/sub-sessions/{kind}/{id}/start": {
    delete: {
      operationId: "cancelSubSessionStart",
      summary: "停掉还在云端排队、没有电脑接下的子会话（登记了要开工的那条了结掉，卡和专题留着）；没有在排的 404。电脑上已经在跑的照旧经本机程序停",
      parameters: [{ name: "kind", in: "path", required: true, schema: { type: "string", enum: ["card", "topic"] } }, ...path("id")],
      responses: { "204": { description: "停掉了" }, ...errors(401, 403, 404) },
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
