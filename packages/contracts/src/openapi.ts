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
  CreateBattlefieldRequest,
  PatchBattlefieldRequest,
  CreateCapabilityRequest,
  PatchCapabilityRequest,
  StrategyConfigResponse,
  PatchStrategyConfigRequest,
  MissionAnchor,
  MissionCardPayload,
  CreateMissionRequest,
  MissionEditInput,
  MissionManagementResponse,
  MissionCardField,
  MissionCardRow,
  MissionRoundPhase,
  MissionRoundSummary,
  MissionRoundDraftPayload,
  ExecuteMissionRoundActionRequest,
  MissionRoundDecideInput,
  MissionRoundConfirmInput,
  MissionCardFeedbackView, PersonalMissionCardMission, PersonalMissionCardPayload,
  CreateMissionCardFeedbackRequest, CreateMissionCardFeedbackResponse, MissionCardGroupView,
  MarkMissionCardReadRequest, MarkMissionCardReadResponse,
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
  LoginResponse,
  ChangePasscodeRequest,
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
  MeetingRecording,
  StartMeetingRecordingResponse,
  MarkThreadReadRequest,
  MarkThreadReadResponse,
  PostThreadMessageRequest,
  ThreadMessage,
  ThreadMessageList,
  ThreadView,
  TaskView,
  MeHomeResponse,
  PatchMyTaskRequest,
  ReturnMyTaskRequest,
  NotificationList,
  MarkNotificationsSeenRequest,
  VoiceprintStatus,
  OnboardingResponse,
  CompleteOnboardingResponse,
} from "./index.js";

const errorResponse = {
  description: "ApiError 统一错误",
  content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
} satisfies OpenAPIV3.ResponseObject;

const jsonBody = (schema: JsonSchema) => ({
  required: true,
  content: { "application/json": { schema } },
});

const threadParameters = [
  { name: "objectType", in: "path" as const, required: true, schema: { type: "string", enum: ["issue", "signal", "task", "meeting"] } },
  { name: "objectId", in: "path" as const, required: true, schema: { type: "string" } },
];

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
          summary: "登录 ID + 4 位口令登录；仍是初始码时不签发会话，返回 mustChangePasscode",
          requestBody: jsonBody({ $ref: "#/components/schemas/LoginRequest" }),
          responses: {
            "200": {
              description: "已登录，或需要先设置口令",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/LoginResponse" } },
              },
            },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
            "423": errorResponse,
            "429": errorResponse,
          },
        },
      },
      "/api/auth/passcode": {
        post: {
          operationId: "changePasscode",
          summary: "校验当前口令后换成新的 4 位口令，并签发会话",
          requestBody: jsonBody({ $ref: "#/components/schemas/ChangePasscodeRequest" }),
          responses: {
            "200": {
              description: "口令已更新并登录",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/LoginResponse" } },
              },
            },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
            "423": errorResponse,
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
          summary: "查询当前登录状态与身份",
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
      "/api/cards/battlefields/{id}": {
        get: {
          operationId: "getBattlefieldCard",
          summary: "单个战场 Card（二级页：待决策 / 进展），与列表同一份投影",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Battlefield Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/cards/missions": {
        get: {
          operationId: "listMissionCards",
          summary: "Mission Card 列表：按 period desc、能力域 sortOrder、code 排序",
          responses: {
            "200": { description: "Mission Cards", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "401": errorResponse,
          },
        },
      },
      "/api/cards/missions/{id}": {
        get: {
          operationId: "getMissionCard",
          summary: "单个 Mission Card：详情页与编辑锚点",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Mission Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/mission-cards/{cardId}": {
        get: {
          operationId: "getPersonalMissionCard", summary: "读取可见的个人卡正文、版本、意见和本轮动作",
          parameters: [{ name: "cardId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Personal Mission Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } }, "401": errorResponse, "404": errorResponse },
        },
      },
      "/api/mission-cards/{cardId}/feedback": {
        post: {
          operationId: "createPersonalMissionCardFeedback", summary: "发表公开评论、引用或修改建议；按 clientId 幂等",
          parameters: [{ name: "cardId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/CreateMissionCardFeedbackRequest" }),
          responses: { "200": { description: "公开意见", content: { "application/json": { schema: { $ref: "#/components/schemas/CreateMissionCardFeedbackResponse" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/mission-cards/{cardId}/group": {
        get: {
          operationId: "getPersonalMissionCardGroup", summary: "公开意见、开场、阶段分隔线及未读；after 只过滤意见，系统事件始终返回",
          parameters: [{ name: "cardId", in: "path", required: true, schema: { type: "string" } }, { name: "after", in: "query", required: false, schema: { type: "integer", minimum: 0 } }],
          responses: { "200": { description: "事项群组", content: { "application/json": { schema: { $ref: "#/components/schemas/MissionCardGroupView" } } } }, "401": errorResponse, "404": errorResponse },
        },
      },
      "/api/mission-cards/{cardId}/group/read": {
        post: {
          operationId: "markPersonalMissionCardRead", summary: "已读位置只增不减，最多到本卡最后一条公开意见",
          parameters: [{ name: "cardId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/MarkMissionCardReadRequest" }),
          responses: { "200": { description: "已读状态", content: { "application/json": { schema: { $ref: "#/components/schemas/MarkMissionCardReadResponse" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse },
        },
      },
      "/api/mission-rounds/{roundId}": {
        get: {
          operationId: "getMissionRound",
          summary: "读取本人可见的 Mission Card 轮次摘要和动作",
          parameters: [{ name: "roundId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "Mission round Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/mission-rounds/actions/execute": {
        post: {
          operationId: "executeMissionRoundAction",
          summary: "拍板人整理个人卡草稿、统一开放或重开；版本冲突返回 latestCard",
          requestBody: jsonBody({ $ref: "#/components/schemas/ExecuteMissionRoundActionRequest" }),
          responses: {
            "200": { description: "当前 Mission round Card；同一动作重放不重复写入", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
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
      "/api/conversations/{scope}/attachments": {
        post: {
          operationId: "uploadConversationAttachments",
          parameters: [{ name: "scope", in: "path", required: true, schema: { type: "string" } }],
          summary: "上传附件到本人在该 scope 的主对话（没有则创建；multipart files，PDF/DOCX/Markdown）；元数据随消息发送时内嵌入库",
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
      "/api/threads/{objectType}/{objectId}": {
        get: {
          operationId: "getThread",
          parameters: threadParameters,
          summary: "打开对象群组：成员、最近消息、读到哪里与未读数；非成员 404",
          responses: {
            "200": { description: "群组视图", content: { "application/json": { schema: { $ref: "#/components/schemas/ThreadView" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/threads/{objectType}/{objectId}/messages": {
        get: {
          operationId: "listThreadMessages",
          parameters: [...threadParameters, { name: "after", in: "query", required: false, schema: { type: "integer", minimum: 0 } }],
          summary: "取 after 之后的新消息（轮询用，一次最多 200 条）；非成员 404",
          responses: {
            "200": { description: "新消息", content: { "application/json": { schema: { $ref: "#/components/schemas/ThreadMessageList" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
        post: {
          operationId: "postThreadMessage",
          parameters: threadParameters,
          summary: "在群组里发一条纯文字消息（可附带引用片段）；非成员 404",
          requestBody: jsonBody({ $ref: "#/components/schemas/PostThreadMessageRequest" }),
          responses: {
            "201": { description: "已发出的消息", content: { "application/json": { schema: { $ref: "#/components/schemas/ThreadMessage" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/threads/{objectType}/{objectId}/read": {
        post: {
          operationId: "markThreadRead",
          parameters: threadParameters,
          summary: "记下读到哪条（只增不减，不超过群里最后一条）；非成员 404",
          requestBody: jsonBody({ $ref: "#/components/schemas/MarkThreadReadRequest" }),
          responses: {
            "200": { description: "读到的位置与剩余未读", content: { "application/json": { schema: { $ref: "#/components/schemas/MarkThreadReadResponse" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/me/onboarding": {
        get: {
          operationId: "getOnboarding",
          summary: "本人首次登录引导：按角色投影真实目标、工作、声纹状态与下一件事",
          responses: {
            "200": { description: "引导数据", content: { "application/json": { schema: { $ref: "#/components/schemas/OnboardingResponse" } } } },
            "401": errorResponse,
          },
        },
      },
      "/api/me/onboarding/complete": {
        post: {
          operationId: "completeOnboarding",
          summary: "本人完成或跳过引导（幂等，需要同站 Origin）",
          responses: {
            "200": { description: "已看过引导", content: { "application/json": { schema: { $ref: "#/components/schemas/CompleteOnboardingResponse" } } } },
            "401": errorResponse,
            "403": errorResponse,
          },
        },
      },
      "/api/me/home": {
        get: {
          operationId: "getMyHome",
          summary: "成员工作台：我负责的执行事项（全部状态，新到旧）",
          responses: {
            "200": { description: "我的执行事项", content: { "application/json": { schema: { $ref: "#/components/schemas/MeHomeResponse" } } } },
            "401": errorResponse,
          },
        },
      },
      "/api/me/tasks/{id}": {
        patch: {
          operationId: "patchMyTask",
          summary: "负责人改执行事项状态；不是负责人 404 TASK_NOT_FOUND，version 不一致 409 带 latestTask",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/PatchMyTaskRequest" }),
          responses: {
            "200": { description: "更新后的执行事项", content: { "application/json": { schema: { $ref: "#/components/schemas/TaskView" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/me/tasks/{id}/return": {
        post: {
          operationId: "returnMyTask",
          summary: "负责人写原因退回执行事项，并通知会议主持人（主持人退回自己的不通知）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/ReturnMyTaskRequest" }),
          responses: {
            "200": { description: "已退回的执行事项", content: { "application/json": { schema: { $ref: "#/components/schemas/TaskView" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/me/notifications": {
        get: {
          operationId: "listMyNotifications",
          summary: "我的通知：未读在前，最近 50 条，文案按对象当前状态组合",
          responses: {
            "200": { description: "通知列表", content: { "application/json": { schema: { $ref: "#/components/schemas/NotificationList" } } } },
            "401": errorResponse,
          },
        },
      },
      "/api/me/seen": {
        post: {
          operationId: "markMyNotificationsSeen",
          summary: "把我的这些通知标为已读；别人的 id 忽略",
          requestBody: jsonBody({ $ref: "#/components/schemas/MarkNotificationsSeenRequest" }),
          responses: {
            "204": { description: "已标记" },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
          },
        },
      },
      "/api/me/voiceprint": {
        get: {
          operationId: "getMyVoiceprint",
          summary: "本人声纹状态：录没录、什么时候录的、服务器是否配好腾讯云声纹",
          responses: {
            "200": { description: "声纹状态", content: { "application/json": { schema: { $ref: "#/components/schemas/VoiceprintStatus" } } } },
            "401": errorResponse,
          },
        },
        post: {
          operationId: "enrollMyVoiceprint",
          summary: "本人录入或重录声纹（multipart：audio 单个音频文件约 20–40 秒 + consent=true）；只用于会后预填说话人，不自动确认",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["audio", "consent"],
                  properties: {
                    audio: { type: "string", format: "binary" },
                    /** 必须是 "true"：录之前单独征得的同意。 */
                    consent: { type: "string", enum: ["true"] },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "录入后的声纹状态", content: { "application/json": { schema: { $ref: "#/components/schemas/VoiceprintStatus" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
            "413": errorResponse,
            "502": errorResponse,
            "503": errorResponse,
          },
        },
        delete: {
          operationId: "deleteMyVoiceprint",
          summary: "本人删除声纹：腾讯云与库里一起删；没有声纹时同样 204",
          responses: {
            "204": { description: "已删除" },
            "401": errorResponse,
            "403": errorResponse,
            "502": errorResponse,
            "503": errorResponse,
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
      "/api/config/missions": {
        post: {
          operationId: "createMission",
          summary: "CEO 首次登记 Mission（slug id，写入 Organization Fact）",
          requestBody: jsonBody({ $ref: "#/components/schemas/CreateMissionRequest" }),
          responses: {
            "201": { description: "新登记的 Mission Card", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "409": errorResponse,
          },
        },
        get: {
          operationId: "getMissionManagement",
          summary: "Mission 配置页一次投影（只读 Mission 正面集合）",
          responses: {
            "200": { description: "Mission 列表", content: { "application/json": { schema: { $ref: "#/components/schemas/MissionManagementResponse" } } } },
            "401": errorResponse,
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
                    /** 计划结束时间；省略或空串表示开始后 60 分钟。 */
                    endsAt: { type: "string" },
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
      "/api/meetings/{id}/recordings": {
        post: {
          operationId: "startMeetingRecording",
          summary: "CEO 开始会议录音（scheduled only）；已有在途录音时返回那一份",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "201": { description: "新建的录音", content: { "application/json": { schema: { $ref: "#/components/schemas/StartMeetingRecordingResponse" } } } },
            "200": { description: "已有在途录音（任一非 done/failed 状态），返回它", content: { "application/json": { schema: { $ref: "#/components/schemas/StartMeetingRecordingResponse" } } } },
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/meetings/{id}/recordings/{recordingId}": {
        get: {
          operationId: "getMeetingRecording",
          summary: "CEO 查询录音与识别进度",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "recordingId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "录音当前状态", content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingRecording" } } } },
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/meetings/{id}/recordings/{recordingId}/chunks/{seq}": {
        put: {
          operationId: "putMeetingRecordingChunk",
          summary: "CEO 上传一片录音（原始字节，seq 从 0 起按录制顺序）；同一 seq 重传幂等，单片上限 20 MiB",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "recordingId", in: "path", required: true, schema: { type: "string" } },
            { name: "seq", in: "path", required: true, schema: { type: "integer", minimum: 0, maximum: 99999 } },
          ],
          requestBody: {
            required: true,
            content: {
              "audio/webm": { schema: { type: "string", format: "binary" } },
              "application/octet-stream": { schema: { type: "string", format: "binary" } },
            },
          },
          responses: {
            "200": { description: "收下后的录音状态", content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingRecording" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
            "413": errorResponse,
          },
        },
      },
      "/api/meetings/{id}/recordings/{recordingId}/finish": {
        post: {
          operationId: "finishMeetingRecording",
          summary: "CEO 结束录音并在后台转码、上传、识别，完成后写成会议记录候选（source.format = volc_asr）；重复调用返回当前状态",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "recordingId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "202": { description: "已交给后台流水线", content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingRecording" } } } },
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
            "503": errorResponse,
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
        LoginResponse: LoginResponse as JsonSchema,
        ChangePasscodeRequest: ChangePasscodeRequest as JsonSchema,
        SessionResponse: SessionResponse as JsonSchema,
        PeopleDirectoryResponse: PeopleDirectoryResponse as JsonSchema,
        ExecuteActionRequest: ExecuteActionRequest as JsonSchema,
        ConversationHistory: ConversationHistory as JsonSchema,
        ConversationMessageRequest: ConversationMessageRequest as JsonSchema,
        ConversationSseEvent: ConversationSseEvent as JsonSchema,
        CreateBattlefieldRequest: CreateBattlefieldRequest as JsonSchema,
        PatchBattlefieldRequest: PatchBattlefieldRequest as JsonSchema,
        CreateCapabilityRequest: CreateCapabilityRequest as JsonSchema,
        PatchCapabilityRequest: PatchCapabilityRequest as JsonSchema,
        StrategyConfigResponse: StrategyConfigResponse as JsonSchema,
        PatchStrategyConfigRequest: PatchStrategyConfigRequest as JsonSchema,
        MissionAnchor: MissionAnchor as JsonSchema,
        MissionCardPayload: MissionCardPayload as JsonSchema,
        CreateMissionRequest: CreateMissionRequest as JsonSchema,
        MissionEditInput: MissionEditInput as JsonSchema,
        MissionManagementResponse: MissionManagementResponse as JsonSchema,
        MissionCardField: MissionCardField as JsonSchema,
        MissionCardRow: MissionCardRow as JsonSchema,
        MissionRoundPhase: MissionRoundPhase as JsonSchema,
        MissionRoundSummary: MissionRoundSummary as JsonSchema,
        MissionRoundDraftPayload: MissionRoundDraftPayload as JsonSchema,
        ExecuteMissionRoundActionRequest: ExecuteMissionRoundActionRequest as JsonSchema,
        MissionRoundDecideInput: MissionRoundDecideInput as JsonSchema,
        MissionRoundConfirmInput: MissionRoundConfirmInput as JsonSchema,
        MissionCardFeedbackView: MissionCardFeedbackView as JsonSchema,
        PersonalMissionCardMission: PersonalMissionCardMission as JsonSchema,
        PersonalMissionCardPayload: PersonalMissionCardPayload as JsonSchema,
        CreateMissionCardFeedbackRequest: CreateMissionCardFeedbackRequest as JsonSchema,
        CreateMissionCardFeedbackResponse: CreateMissionCardFeedbackResponse as JsonSchema,
        MissionCardGroupView: MissionCardGroupView as JsonSchema,
        MarkMissionCardReadRequest: MarkMissionCardReadRequest as JsonSchema,
        MarkMissionCardReadResponse: MarkMissionCardReadResponse as JsonSchema,
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
        ThreadView: ThreadView as JsonSchema,
        ThreadMessage: ThreadMessage as JsonSchema,
        ThreadMessageList: ThreadMessageList as JsonSchema,
        PostThreadMessageRequest: PostThreadMessageRequest as JsonSchema,
        MarkThreadReadRequest: MarkThreadReadRequest as JsonSchema,
        MarkThreadReadResponse: MarkThreadReadResponse as JsonSchema,
        TaskView: TaskView as JsonSchema,
        MeHomeResponse: MeHomeResponse as JsonSchema,
        PatchMyTaskRequest: PatchMyTaskRequest as JsonSchema,
        ReturnMyTaskRequest: ReturnMyTaskRequest as JsonSchema,
        NotificationList: NotificationList as JsonSchema,
        MarkNotificationsSeenRequest: MarkNotificationsSeenRequest as JsonSchema,
        MeetingRecording: MeetingRecording as JsonSchema,
        StartMeetingRecordingResponse: StartMeetingRecordingResponse as JsonSchema,
        VoiceprintStatus: VoiceprintStatus as JsonSchema,
        OnboardingResponse: OnboardingResponse as JsonSchema,
        CompleteOnboardingResponse: CompleteOnboardingResponse as JsonSchema,
      },
    },
  };
}
