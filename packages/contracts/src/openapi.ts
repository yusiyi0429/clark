import type { JsonSchema, OpenAPIV3 } from "./types/JsonSchemaTypes.js";
import {
  ActionDescriptor,
  ApiError,
  Card,
  CardCollection,
  ExecuteActionRequest,
  ConversationHistory,
  ConversationMessageRequest,
  ConversationSseEvent,
  ConversationAttachment,
  ConversationAttachmentInfo,
  ConversationAttachmentUploadResponse,
  ConversationSessionList,
  ConversationSessionSummary,
  CreateConversationSessionRequest,
  CreateBattlefieldRequest,
  PatchBattlefieldRequest,
  CreateCapabilityRequest,
  PatchCapabilityRequest,
  StrategyConfigResponse,
  PatchStrategyConfigRequest,
  MissionValue,
  CapabilitySupportRef,
  CapabilityManagementResponse,
  CreateCeoIssueRequest,
  AssignBattlefieldIssueRequest,
  BattlefieldManagementResponse,
  CreateConfigMeetingRequest,
  CreateMeetingRequest,
  DriIssueImportRequest,
  DriMeetingImportRequest,
  HealthResponse,
  IssueDecideInput,
  IssueDecideOverrideInput,
  IssueDismissInput,
  IssueReceipt,
  IssueRestoreInput,
  IssueRevokeReceiptInput,
  ResearchDoc,
  JoinMeetingRequest,
  LoginRequest,
  PeopleDirectoryResponse,
  MonthlyDraftCandidate,
  MonthlyPlanCapability,
  MonthlyPlanCardPayload,
  MonthlyPlanExport,
  MonthlyPlanExportListResponse,
  SignMonthlyPlanRequest,
  DriMonthlyExportDeliveredRequest,
  DriMonthlyExportFailedRequest,
  BattlefieldCardPayload,
  RadarScanResponse,
  ReplaceTranscriptRequest,
  RequestSupplementRequest,
  SessionResponse,
  SignalStateRequest,
  UpdateMeetingDraftRequest,
  EditMeetingDetailsRequest,
  UpdateMonthlyPlanDraftRequest,
  DriMonthlyPlanFeedbackRequest,
  DriMonthlyPlanTodoFeedbackRequest,
  MeetingOutcomeState,
  PostMeetingCandidate,
  StoredTranscript,
  WarmapTranscript,
  MeetingConfirmItemInput,
  MeetingDismissItemInput,
  MeetingRevokeEffectInput,
} from "./index.js";

const errorResponse = {
  description: "ApiError 统一错误",
  content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
} satisfies OpenAPIV3.ResponseObject;

const jsonBody = (schema: JsonSchema) => ({
  required: true,
  content: { "application/json": { schema } },
});

export function buildOpenApiDocument(): OpenAPIV3.Document {
  return {
    openapi: "3.1.0",
    info: {
      title: "CEO WarMap API",
      version: "0.1.0",
      description: "Card envelope、Action、鉴权与健康的公开契约",
    },
    servers: [{ url: "/" }],
    paths: {
      "/api/auth/login": {
        post: {
          operationId: "login",
          summary: "CEO 登录，签发 HttpOnly session cookie",
          requestBody: jsonBody({ $ref: "#/components/schemas/LoginRequest" }),
          responses: {
            "200": {
              description: "已登录",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/SessionResponse" } },
              },
            },
            "401": errorResponse,
            "429": errorResponse,
          },
        },
      },
      "/api/auth/logout": {
        post: {
          operationId: "logout",
          summary: "注销当前 session",
          responses: {
            "200": {
              description: "已注销",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/SessionResponse" } },
              },
            },
          },
        },
      },
      "/api/auth/session": {
        get: {
          operationId: "getSession",
          summary: "查询当前登录状态",
          responses: {
            "200": {
              description: "登录状态",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/SessionResponse" } },
              },
            },
          },
        },
      },
      "/api/people": {
        get: {
          operationId: "listPeople",
          summary: "只读人员目录（Meeting 创建表单使用）",
          responses: {
            "200": {
              description: "人员目录",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/PeopleDirectoryResponse" } },
              },
            },
          },
        },
      },
      "/api/cards/home": {
        get: {
          operationId: "getHomeCards",
          summary: "首页 Card 集合（无副作用）",
          responses: {
            "200": {
              description: "Card 集合",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } },
              },
            },
            "401": errorResponse,
          },
        },
      },
      "/api/cards/issues/{id}": {
        get: {
          operationId: "getIssueCard",
          summary: "读取 Issue Card",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Issue Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/cards/meetings": {
        get: {
          operationId: "listMeetingCards",
          summary: "读取 Meeting Card 列表（用于加入已有 scheduled Meeting）",
          responses: {
            "200": { description: "Meeting Cards", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "401": errorResponse,
          },
        },
      },
      "/api/cards/meetings/{id}": {
        get: {
          operationId: "getMeetingCard",
          summary: "读取 Meeting 详情 Card",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Meeting Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/cards/notifications": {
        get: {
          operationId: "listNotificationCards",
          summary: "会前通知与月度通知：与详情同一 projector 的投影",
          responses: {
            "200": { description: "通知 Card 集合", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "401": errorResponse,
          },
        },
      },
      "/api/cards/monthly-plans": {
        get: {
          operationId: "listMonthlyPlanCards",
          summary: "读取 MonthlyPlan Card 列表",
          responses: {
            "200": { description: "MonthlyPlan Cards", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "401": errorResponse,
          },
        },
      },
      "/api/cards/monthly-plans/{id}": {
        get: {
          operationId: "getMonthlyPlanCard",
          summary: "读取 MonthlyPlan 详情 Card",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "MonthlyPlan Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/cards/battlefields": {
        get: {
          operationId: "listBattlefieldCards",
          summary: "战场 Card：正面确认目标，背面按 battlefieldId 投影普通待办与最新 feedback",
          responses: {
            "200": { description: "Battlefield Cards", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "401": errorResponse,
          },
        },
      },
      "/api/cards/radar": {
        get: {
          operationId: "getRadarCard",
          summary: "读取 Radar 配置、最近运行和来源状态",
          responses: {
            "200": { description: "Radar Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "401": errorResponse,
          },
        },
      },
      "/api/cards/signals": {
        get: {
          operationId: "listSignalCards",
          summary: "读取 Signal Card 列表",
          responses: {
            "200": { description: "Signal Cards", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "401": errorResponse,
          },
        },
      },
      "/api/cards/signals/{id}": {
        get: {
          operationId: "getSignalCard",
          summary: "读取 Signal 详情 Card",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Signal Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/radar/scans/manual": {
        post: {
          operationId: "runManualRadarScan",
          summary: "运行一次与 scheduled 共用管线的手动 Radar 扫描",
          responses: {
            "200": { description: "扫描结果", content: { "application/json": { schema: { $ref: "#/components/schemas/RadarScanResponse" } } } },
            "401": errorResponse,
            "403": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/signals/{id}/state": {
        patch: {
          operationId: "setSignalState",
          summary: "独立设置 Signal read、saved、dismissed 状态",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/SignalStateRequest" }),
          responses: {
            "200": { description: "更新后的 Signal Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/conversations/{scope}/messages": {
        get: {
          operationId: "getConversationMessages",
          parameters: [{ name: "scope", in: "path", required: true, schema: { type: "string" } }],
          summary: "读取独立 scope 的原始 Conversation 消息",
          responses: {
            "200": { description: "Conversation 历史", content: { "application/json": { schema: { $ref: "#/components/schemas/ConversationHistory" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
        post: {
          operationId: "sendConversationMessage",
          parameters: [{ name: "scope", in: "path", required: true, schema: { type: "string" } }],
          summary: "发送消息并通过 SSE 返回 Pi 运行事件",
          requestBody: jsonBody({ $ref: "#/components/schemas/ConversationMessageRequest" }),
          responses: {
            "200": { description: "SSE 事件流", content: { "text/event-stream": { schema: { $ref: "#/components/schemas/ConversationSseEvent" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/conversations/{scope}/sessions": {
        get: {
          operationId: "listConversationSessions",
          parameters: [{ name: "scope", in: "path", required: true, schema: { type: "string" } }],
          summary: "列出 scope 内未删除的 Conversation 会话",
          responses: {
            "200": { description: "会话列表（最早未删除者为默认会话）", content: { "application/json": { schema: { $ref: "#/components/schemas/ConversationSessionList" } } } },
            "401": errorResponse,
          },
        },
        post: {
          operationId: "createConversationSession",
          parameters: [{ name: "scope", in: "path", required: true, schema: { type: "string" } }],
          summary: "在 scope 内新建 Conversation 会话",
          requestBody: jsonBody({ $ref: "#/components/schemas/CreateConversationSessionRequest" }),
          responses: {
            "201": { description: "新建的会话摘要", content: { "application/json": { schema: { $ref: "#/components/schemas/ConversationSessionSummary" } } } },
            "400": errorResponse,
            "401": errorResponse,
          },
        },
      },
      "/api/conversations/{scope}/sessions/{sessionId}": {
        delete: {
          operationId: "deleteConversationSession",
          parameters: [
            { name: "scope", in: "path", required: true, schema: { type: "string" } },
            { name: "sessionId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          summary: "删除会话（含消息与附件原件）；运行中拒绝",
          responses: {
            "204": { description: "已删除" },
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/conversations/{scope}/sessions/{sessionId}/messages": {
        get: {
          operationId: "getConversationSessionMessages",
          parameters: [
            { name: "scope", in: "path", required: true, schema: { type: "string" } },
            { name: "sessionId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          summary: "读取指定会话的原始 Conversation 消息",
          responses: {
            "200": { description: "会话消息历史", content: { "application/json": { schema: { $ref: "#/components/schemas/ConversationHistory" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
        post: {
          operationId: "sendConversationSessionMessage",
          parameters: [
            { name: "scope", in: "path", required: true, schema: { type: "string" } },
            { name: "sessionId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          summary: "在指定会话发送消息并通过 SSE 返回 Pi 运行事件",
          requestBody: jsonBody({ $ref: "#/components/schemas/ConversationMessageRequest" }),
          responses: {
            "200": { description: "SSE 事件流", content: { "text/event-stream": { schema: { $ref: "#/components/schemas/ConversationSseEvent" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/conversations/{scope}/sessions/{sessionId}/attachments": {
        post: {
          operationId: "uploadConversationAttachments",
          parameters: [
            { name: "scope", in: "path", required: true, schema: { type: "string" } },
            { name: "sessionId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
          ],
          summary: "上传会话附件（multipart files，PDF/DOCX/Markdown）；元数据随消息发送时内嵌入库",
          requestBody: {
            content: { "multipart/form-data": { schema: { type: "object", properties: { files: { type: "array", items: { type: "string", format: "binary" } } } } } },
          },
          responses: {
            "200": { description: "已解析附件的可见信息（发消息时按 id 引用）", content: { "application/json": { schema: { $ref: "#/components/schemas/ConversationAttachmentUploadResponse" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
            "413": errorResponse,
          },
        },
      },
      "/api/actions/execute": {
        post: {
          operationId: "executeAction",
          summary: "执行 Action：fingerprint 幂等优先，再校验 version",
          requestBody: jsonBody({ $ref: "#/components/schemas/ExecuteActionRequest" }),
          responses: {
            "200": {
              description: "执行成功或幂等重放，返回当前 Card",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } },
              },
            },
            "401": errorResponse,
            "404": errorResponse,
            "409": {
              description: "version 冲突，携带 latestCard",
              content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
            },
          },
        },
      },
      "/api/config/strategy": {
        get: {
          operationId: "getStrategyConfig",
          summary: "CEO 读取公司长期目标（LTCO）配置",
          responses: {
            "200": { description: "长期目标配置", content: { "application/json": { schema: { $ref: "#/components/schemas/StrategyConfigResponse" } } } },
            "401": errorResponse,
          },
        },
        patch: {
          operationId: "patchStrategyConfig",
          summary: "CEO 更新公司长期目标（LTCO），version+1",
          requestBody: jsonBody({ $ref: "#/components/schemas/PatchStrategyConfigRequest" }),
          responses: {
            "200": { description: "更新后的长期目标配置", content: { "application/json": { schema: { $ref: "#/components/schemas/StrategyConfigResponse" } } } },
            "400": errorResponse,
            "401": errorResponse,
          },
        },
      },
      "/api/config/battlefields": {
        post: {
          operationId: "createBattlefield",
          summary: "CEO 注册战场（slug id，写入 Organization Fact 注册表）",
          requestBody: jsonBody({ $ref: "#/components/schemas/CreateBattlefieldRequest" }),
          responses: {
            "201": { description: "新注册的 Battlefield Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "409": errorResponse,
          },
        },
        get: {
          operationId: "getBattlefieldManagement",
          summary: "战场管理页数据：战场列表与可选议题（仅 pending，排除 capability 级）",
          responses: {
            "200": { description: "整页展示数据", content: { "application/json": { schema: { $ref: "#/components/schemas/BattlefieldManagementResponse" } } } },
            "401": errorResponse,
          },
        },
      },
      "/api/config/capabilities": {
        post: {
          operationId: "createCapability",
          summary: "CEO 注册公司能力（写入 Organization Fact 注册表）",
          requestBody: jsonBody({ $ref: "#/components/schemas/CreateCapabilityRequest" }),
          responses: {
            "201": { description: "新注册的 Capability Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "409": errorResponse,
          },
        },
        get: {
          operationId: "getCapabilityManagement",
          summary: "能力管理页列表投影（只读注册表行）",
          responses: {
            "200": { description: "能力列表", content: { "application/json": { schema: { $ref: "#/components/schemas/CapabilityManagementResponse" } } } },
            "401": errorResponse,
          },
        },
      },
      "/api/config/capabilities/{id}": {
        patch: {
          operationId: "patchCapability",
          summary: "CEO 编辑能力（部分字段，id 稳定，version+1，改名 slug 冲突 409）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/PatchCapabilityRequest" }),
          responses: {
            "200": { description: "更新后的 Capability Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/config/issues": {
        post: {
          operationId: "createCeoIssue",
          summary: "CEO 直接新建 pending Issue，照常触发预研",
          requestBody: jsonBody({ $ref: "#/components/schemas/CreateCeoIssueRequest" }),
          responses: {
            "201": { description: "创建的 pending Issue Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "400": errorResponse,
            "401": errorResponse,
          },
        },
      },
      "/api/config/meetings": {
        post: {
          operationId: "createConfigMeeting",
          summary: "CEO 新建 scheduled Meeting（multipart：字段 + 可选会前材料 files）",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["title", "scheduledAt", "leadDriId"],
                  properties: {
                    title: { type: "string" },
                    scheduledAt: { type: "string" },
                    leadDriId: { type: "string" },
                    /** 议题 id 的 JSON 字符串数组；省略或空串表示不并入议题。 */
                    issueIds: { type: "string" },
                    files: { type: "array", items: { type: "string", format: "binary" } },
                  },
                },
              },
            },
          },
          responses: {
            "201": { description: "创建的 scheduled Meeting Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "413": errorResponse,
          },
        },
      },
      "/api/config/battlefields/{id}": {
        delete: {
          operationId: "deleteBattlefield",
          summary: "CEO 删除战场：关联议题移出并归一化，同步删除指向它的 ontology anchor",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "204": { description: "已删除" },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
        patch: {
          operationId: "patchBattlefield",
          summary: "CEO 编辑战场（部分字段，id 稳定，version+1，改名 slug 冲突 409）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/PatchBattlefieldRequest" }),
          responses: {
            "200": { description: "更新后的 Battlefield Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/config/battlefields/{id}/issues": {
        post: {
          operationId: "assignBattlefieldIssue",
          summary: "CEO 把 pending 议题加入战场（集合归一化）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/AssignBattlefieldIssueRequest" }),
          responses: {
            "200": { description: "更新后的 Issue Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/config/battlefields/{id}/issues/{issueId}": {
        delete: {
          operationId: "unassignBattlefieldIssue",
          summary: "CEO 把 pending 议题移出战场（集合归一化）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "issueId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "更新后的 Issue Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/dri/issues": {
        post: {
          operationId: "importDriIssue",
          summary: "DRI 服务导入 Issue（red 必须提供 decisionBy 与 reason）",
          requestBody: jsonBody({ $ref: "#/components/schemas/DriIssueImportRequest" }),
          responses: {
            "200": { description: "同 externalId 同内容：返回原 Issue Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "201": { description: "创建的 pending Issue Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/dri/meetings": {
        post: {
          operationId: "importDriMeeting",
          summary: "DRI 服务导入 Meeting 元数据（稳定 Person 目录）",
          requestBody: jsonBody({ $ref: "#/components/schemas/DriMeetingImportRequest" }),
          responses: {
            "200": { description: "同 externalId 同内容：返回原 Meeting Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "201": { description: "创建的 scheduled Meeting Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/dri/monthly-feedback": {
        post: {
          operationId: "importDriMonthlyFeedback",
          summary: "DRI 服务追加叙述性月度 feedback（externalId 幂等）",
          requestBody: jsonBody({ $ref: "#/components/schemas/DriMonthlyPlanFeedbackRequest" }),
          responses: {
            "200": { description: "同 externalId 同内容：返回原 MonthlyPlan Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "201": { description: "追加反馈后的 MonthlyPlan Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "409": errorResponse,
            "422": errorResponse,
          },
        },
      },
      "/api/dri/todo-feedback": {
        post: {
          operationId: "importDriMonthlyTodoFeedback",
          summary: "DRI 服务追加 todo 叙述性 feedback，不修改执行状态",
          requestBody: jsonBody({ $ref: "#/components/schemas/DriMonthlyPlanTodoFeedbackRequest" }),
          responses: {
            "200": { description: "同 externalId 同内容：返回原 MonthlyPlan Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "201": { description: "追加反馈后的 MonthlyPlan Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "409": errorResponse,
            "422": errorResponse,
          },
        },
      },
      "/api/dri/monthly-exports": {
        get: {
          operationId: "listDriMonthlyExports",
          summary: "DRI 待外发/已外发的普通 todo（真实 pending_export/delivered 状态）",
          parameters: [
            { name: "status", in: "query", required: false, schema: { type: "string", enum: ["pending_export", "delivered", "failed"] } },
          ],
          responses: {
            "200": { description: "导出记录", content: { "application/json": { schema: { $ref: "#/components/schemas/MonthlyPlanExportListResponse" } } } },
            "401": errorResponse,
          },
        },
      },
      "/api/dri/monthly-exports/{effectRef}/delivered": {
        post: {
          operationId: "markDriMonthlyExportDelivered",
          summary: "外部渠道回执：标记普通 todo 已送达",
          parameters: [{ name: "effectRef", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/DriMonthlyExportDeliveredRequest" }),
          responses: {
            "200": { description: "更新后的导出记录", content: { "application/json": { schema: { $ref: "#/components/schemas/MonthlyPlanExportListResponse" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/dri/monthly-exports/{effectRef}/failed": {
        post: {
          operationId: "markDriMonthlyExportFailed",
          summary: "外部渠道回执：标记普通 todo 外发失败，不自动重试",
          parameters: [{ name: "effectRef", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/DriMonthlyExportFailedRequest" }),
          responses: {
            "200": { description: "更新后的导出记录", content: { "application/json": { schema: { $ref: "#/components/schemas/MonthlyPlanExportListResponse" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/dri/monthly-exports/{effectRef}/re-export": {
        post: {
          operationId: "reexportDriMonthlyExport",
          summary: "显式再导出：failed → pending_export（不自动重试）",
          parameters: [{ name: "effectRef", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "更新后的导出记录", content: { "application/json": { schema: { $ref: "#/components/schemas/MonthlyPlanExportListResponse" } } } },
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/dri/meetings/{id}/transcript": {
        post: {
          operationId: "importDriMeetingTranscript",
          summary: "集成客户端导入 warmap-transcript.v1（同一导入边界）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/WarmapTranscript" }),
          responses: {
            "200": { description: "导入成功后的 held Meeting Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
            "413": errorResponse,
          },
        },
      },
      "/api/meetings/{id}/transcript": {
        post: {
          operationId: "importMeetingTranscript",
          summary: "CEO Web 上传 warmap-transcript.v1（multipart 单文件）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["file"],
                  properties: { file: { type: "string", format: "binary" } },
                },
              },
            },
          },
          responses: {
            "200": { description: "导入成功后的 held Meeting Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
            "413": errorResponse,
          },
        },
      },
      "/api/meetings/{id}/transcript-candidate": {
        post: {
          operationId: "uploadMeetingTranscriptCandidate",
          summary: "CEO Web 上传妙记 Markdown，生成待确认的 Transcript 候选（multipart 单文件，不改状态、不跑会后抽取）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["file"],
                  properties: { file: { type: "string", format: "binary" } },
                },
              },
            },
          },
          responses: {
            "200": { description: "生成候选后的 scheduled Meeting Card（含 transcriptCandidate 投影）", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
            "413": errorResponse,
          },
        },
      },
      "/api/meetings/{id}/materials": {
        post: {
          operationId: "replaceMeetingMaterials",
          summary: "CEO 替换 scheduled Meeting 的整个会前材料集（multipart 多文件 files）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["files"],
                  properties: { files: { type: "array", items: { type: "string", format: "binary" } } },
                },
              },
            },
          },
          responses: {
            "200": { description: "替换成功后的 Meeting Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
            "413": errorResponse,
          },
        },
      },
      "/api/meetings/{id}/materials/supplement": {
        post: {
          operationId: "appendSupplementMaterial",
          summary: "CEO 把会外收到的补充材料文件归档到已记录的补充请求（scheduled only；不改预审）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["files", "requestId"],
                  properties: {
                    files: { type: "string", format: "binary" },
                    requestId: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "追加成功（含 sha256 幂等重放）后的 Meeting Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
            "413": errorResponse,
          },
        },
      },
      "/api/meetings/{id}/materials/{materialId}/preview": {
        get: {
          operationId: "previewMeetingMaterial",
          summary: "CEO 鉴权预览：PDF inline、Markdown 纯文本、DOCX 按需 sanitize HTML（不持久化）",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "materialId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "按 mimeType 返回预览体",
              content: {
                "application/pdf": { schema: { type: "string", format: "binary" } },
                "text/html": { schema: { type: "string" } },
                "text/plain": { schema: { type: "string" } },
              },
            },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/meetings/{id}/materials/{materialId}/download": {
        get: {
          operationId: "downloadMeetingMaterial",
          summary: "CEO 鉴权下载材料原件（attachment）",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "materialId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "材料原件字节", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/healthz": {
        get: {
          operationId: "health",
          summary: "健康检查，无副作用",
          responses: {
            "200": {
              description: "健康状态",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/HealthResponse" } },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Card: Card as JsonSchema,
        CardCollection: CardCollection as JsonSchema,
        ActionDescriptor: ActionDescriptor as JsonSchema,
        ApiError: ApiError as JsonSchema,
        LoginRequest: LoginRequest as JsonSchema,
        SessionResponse: SessionResponse as JsonSchema,
        PeopleDirectoryResponse: PeopleDirectoryResponse as JsonSchema,
        ExecuteActionRequest: ExecuteActionRequest as JsonSchema,
        ConversationHistory: ConversationHistory as JsonSchema,
        ConversationMessageRequest: ConversationMessageRequest as JsonSchema,
        ConversationSseEvent: ConversationSseEvent as JsonSchema,
        ConversationSessionSummary: ConversationSessionSummary as JsonSchema,
        ConversationSessionList: ConversationSessionList as JsonSchema,
        CreateConversationSessionRequest: CreateConversationSessionRequest as JsonSchema,
        CreateBattlefieldRequest: CreateBattlefieldRequest as JsonSchema,
        PatchBattlefieldRequest: PatchBattlefieldRequest as JsonSchema,
        CreateCapabilityRequest: CreateCapabilityRequest as JsonSchema,
        PatchCapabilityRequest: PatchCapabilityRequest as JsonSchema,
        StrategyConfigResponse: StrategyConfigResponse as JsonSchema,
        PatchStrategyConfigRequest: PatchStrategyConfigRequest as JsonSchema,
        MissionValue: MissionValue as JsonSchema,
        CapabilitySupportRef: CapabilitySupportRef as JsonSchema,
        CapabilityManagementResponse: CapabilityManagementResponse as JsonSchema,
        CreateCeoIssueRequest: CreateCeoIssueRequest as JsonSchema,
        CreateConfigMeetingRequest: CreateConfigMeetingRequest as JsonSchema,
        AssignBattlefieldIssueRequest: AssignBattlefieldIssueRequest as JsonSchema,
        BattlefieldManagementResponse: BattlefieldManagementResponse as JsonSchema,
        ConversationAttachment: ConversationAttachment as JsonSchema,
        ConversationAttachmentInfo: ConversationAttachmentInfo as JsonSchema,
        ConversationAttachmentUploadResponse: ConversationAttachmentUploadResponse as JsonSchema,
        HealthResponse: HealthResponse as JsonSchema,
        RadarScanResponse: RadarScanResponse as JsonSchema,
        SignalStateRequest: SignalStateRequest as JsonSchema,
        DriIssueImportRequest: DriIssueImportRequest as JsonSchema,
        ResearchDoc: ResearchDoc as JsonSchema,
        IssueReceipt: IssueReceipt as JsonSchema,
        IssueDecideInput: IssueDecideInput as JsonSchema,
        IssueDecideOverrideInput: IssueDecideOverrideInput as JsonSchema,
        IssueDismissInput: IssueDismissInput as JsonSchema,
        IssueRestoreInput: IssueRestoreInput as JsonSchema,
        IssueRevokeReceiptInput: IssueRevokeReceiptInput as JsonSchema,
        DriMeetingImportRequest: DriMeetingImportRequest as JsonSchema,
        CreateMeetingRequest: CreateMeetingRequest as JsonSchema,
        JoinMeetingRequest: JoinMeetingRequest as JsonSchema,
        UpdateMeetingDraftRequest: UpdateMeetingDraftRequest as JsonSchema,
        EditMeetingDetailsRequest: EditMeetingDetailsRequest as JsonSchema,
        RequestSupplementRequest: RequestSupplementRequest as JsonSchema,
        MonthlyPlanCardPayload: MonthlyPlanCardPayload as JsonSchema,
        MonthlyPlanCapability: MonthlyPlanCapability as JsonSchema,
        MonthlyPlanExport: MonthlyPlanExport as JsonSchema,
        MonthlyPlanExportListResponse: MonthlyPlanExportListResponse as JsonSchema,
        SignMonthlyPlanRequest: SignMonthlyPlanRequest as JsonSchema,
        DriMonthlyExportDeliveredRequest: DriMonthlyExportDeliveredRequest as JsonSchema,
        DriMonthlyExportFailedRequest: DriMonthlyExportFailedRequest as JsonSchema,
        BattlefieldCardPayload: BattlefieldCardPayload as JsonSchema,
        MonthlyDraftCandidate: MonthlyDraftCandidate as JsonSchema,
        UpdateMonthlyPlanDraftRequest: UpdateMonthlyPlanDraftRequest as JsonSchema,
        DriMonthlyPlanFeedbackRequest: DriMonthlyPlanFeedbackRequest as JsonSchema,
        DriMonthlyPlanTodoFeedbackRequest: DriMonthlyPlanTodoFeedbackRequest as JsonSchema,
        WarmapTranscript: WarmapTranscript as JsonSchema,
        StoredTranscript: StoredTranscript as JsonSchema,
        PostMeetingCandidate: PostMeetingCandidate as JsonSchema,
        MeetingOutcomeState: MeetingOutcomeState as JsonSchema,
        ReplaceTranscriptRequest: ReplaceTranscriptRequest as JsonSchema,
        MeetingConfirmItemInput: MeetingConfirmItemInput as JsonSchema,
        MeetingDismissItemInput: MeetingDismissItemInput as JsonSchema,
        MeetingRevokeEffectInput: MeetingRevokeEffectInput as JsonSchema,
      },
    },
  };
}
