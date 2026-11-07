import type { JsonSchema, OpenAPIV3 } from "./types/JsonSchemaTypes.js";
import { taskQualityPaths, taskQualitySchemas } from "./taskQualityOpenapi.js";
import { boardPaths, boardSchemas } from "./boardOpenapi.js";
import { workHomePaths, workHomeSchemas } from "./workHomeOpenapi.js";
import { AcceptIssueDraftRequest, IssueDraftResponse } from "./issueDrafts.js";
import {
  RequestStep, RequestPerson, RequestRecipientView, RequestQuestionView, RequestClarification, RequestView, RequestResponse,
  DraftRequestRequest, DraftRequestResponse, RequestListItem, RequestListResponse, PrepareRequestQuestionRequest,
  PrepareRequestQuestionResponse, DraftRequestAnswerResponse, RequestSendInput, RequestAskInput, RequestAnswerInput, ExecuteRequestActionRequest,
} from "./requests.js";
import { MeetingCardConfirmRequest, MeetingCardDraftRequest, MeetingCardOwnerRequest, MeetingCardReviewRequest, MeetingCardReviewResponse, MeetingCardSpeakerRequest, MeetingCardView, MeetingCardWorldChoiceRequest } from "./meetingCard.js";
import { MeetingDecisionView, MeetingMinutesFetchResponse, MeetingMinutesLinkRequest, MeetingWorldAnchorOptionsResponse, MeetingWorldAnchorsRequest, MeetingWorldResponse, MyMeetingCardsResponse } from "./meetingDecisions.js";
import { AttachFeishuMinuteRequest, FeishuMinuteInboxResponse, FeishuMinuteMeetingResponse, OrganizeFeishuMinuteRequest } from "./feishuMinuteInbox.js";
import { ImpactCardView, ImpactCardResponse, ImpactAskRequest, ImpactAskResponse, ImpactIrrelevantRequest } from "./impact.js";
import { UsageResponse, OnboardingStepUsageRequest } from "./usage.js";
import { PersonalProfileView, UpdatePersonalProfileRequest } from "./personalProfile.js";
import { Buddy, BuddyForm, BuddyPersonality } from "./buddy.js";
import { RailBackground, RailBackgroundChoice, SaveRailBackgroundRequest } from "./railBackground.js";
import { PersonAvatarsResponse, SaveAvatarRequest, SavedAvatar } from "./avatar.js";
import { DeliverableDissentRequest, DeliverableItem, DeliverableNote, DeliverableNotePatch, DeliverableReview, DeliverableVersion, ReviewCriterion, TaskDeliverableResponse, TaskDeliverableStatus } from "./deliverables.js";
import { CheckNotifyRequest, CheckNotifyResponse, PutTaskAgreementRequest, TaskAgreementResponse, TaskCheckResponse } from "./agreements.js";
import { ConfirmDocChangeRequest, DocChangeResponse, DocChangeView, DocOwnerAnswerRequest, ImpactBasisChoiceRequest } from "./docChanges.js";
import {
  CollectionField, CollectionEntryView, CollectionRoundView, CollectionView, CollectionResponse, DraftCollectionRequest, DraftCollectionResponse,
  CollectionSendInput, CollectionSaveInput, ExecuteCollectionActionRequest, ScheduleItem, ScheduleListResponse,
} from "./collections.js";
import {
  ActionDescriptor,
  ApiError,
  Card,
  CardCollection,
  ExecuteActionRequest,
  ConversationHistory,
  ConversationMessageRequest,
  ConversationSseEvent,
  ConversationTurnStopResponse,
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
  MyMissionRoundsResponse,
  ExecuteMissionRoundActionRequest,
  MissionRoundDecideInput,
  MissionRoundConfirmInput,
  MissionCardReviewSource, MissionCardReviewReport, MissionCardCoAgentReview, ReturnMissionCardsRequest,
  MonthlyReviewResponse, MonthlyReviewItemResponse, MonthlyReviewPayload, MonthlyReviewItemPayload, MonthlyReviewItemRow,
  MyMonthlyReviewNoticesResponse, MonthlyReviewNotice, ExecuteMonthlyReviewActionRequest, ExecuteMonthlyReviewActionResponse,
  MonthlyReviewComment, CreateMonthlyReviewCommentRequest, CreateMonthlyReviewCommentResponse,
  MonthlyReviewItemUpdateInput, MonthlyReviewResolveSuggestionInput, MonthlyReviewReturnInput, MonthlyReviewUpdateSummaryInput, MonthlyReviewDecideLtcoInput,
  PersonalReviewPayload, PersonalReviewGenerationStep, PersonalReviewBoard, PersonalReviewBoardRow, PersonalReviewBoardResponse, PersonalReviewResponse,
  ExecutePersonalReviewActionRequest, ExecutePersonalReviewActionResponse, PersonalReviewUpdateInput, MonthlyCycle, MonthlyCycleResponse,
  MissionCardFeedbackView, PersonalMissionCardMission, PersonalMissionCardPayload,
  MissionCardClarificationView, MissionCardAnnotationView, MissionCardRevisionView, MissionCardAnnotationsResponse, CreateMissionCardAnnotationRequest, CreateMissionCardAnnotationResponse,
  AnswerMissionCardAnnotationRequest, RetryMissionCardAnnotationRequest, ResolveMissionCardAnnotationRequest, MissionCardRevisionsResponse, SetMissionCardOwnerConfirmationRequest,
  CreateMissionCardFeedbackRequest, CreateMissionCardFeedbackResponse, MissionCardGroupView,
  MarkMissionCardReadRequest, MarkMissionCardReadResponse,
  MissionCardCorrectionView, MissionCardCorrectionAccess, CreateMissionCardCorrectionRequest, DecideMissionCardCorrectionRequest, MissionCardCorrectionResponse,
  CapabilitySupportRef,
  CapabilityManagementResponse,
  CreateCeoIssueRequest,
  AssignBattlefieldIssueRequest,
  BattlefieldManagementResponse,
  CreateConfigMeetingRequest,
  CreateMeetingRequest,
  MeetingBookingRequest,
  MeetingDraftStatusResponse,
  DriIssueImportRequest,
  DriMeetingImportRequest,
  HealthResponse,
  IssueDecideInput,
  IssueDecideOverrideInput,
  IssueDismissInput,
  IssueReceipt,
  IssueDecisionHistory,
  MeetingDecisionHistoryResponse,
  IssueRestoreInput,
  IssueRevokeReceiptInput,
  ResearchDoc,
  JoinMeetingRequest,
  LoginRequest,
  LoginResponse,
  DemoEntryResponse,
  ChangePasscodeRequest,
  PeopleDirectoryResponse,
  PersonDirectoryResponse,
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
  SetViewRequest,
  AddThreadMembersRequest,
  ThreadMembersResponse,
  ThreadCandidatesResponse,
  UnreadThreadItem,
  UnreadThreadsResponse,
  MemberMeetingItem,
  MemberMeetingsResponse,
  FeishuCalendarEventsResponse,
  MeetingTranscriptTurnView,
  MeetingTranscriptPage,
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
  MeetingRecording,
  StartMeetingRecordingResponse,
  MarkThreadReadRequest,
  MarkThreadReadResponse,
  PostThreadMessageRequest,
  ThreadMessage,
  ThreadMessageList,
  ThreadView,
  TaskView,
  TaskProgressEntry,
  TaskProgressSource,
  TaskProgressLink,
  TaskLatestProgress,
  AppendTaskProgressRequest,
  MissionCardItemsResponse,
  PersonalTokenClient,
  PersonalTokenView,
  ListPersonalTokensResponse,
  CreatePersonalTokenRequest,
  CreatePersonalTokenResponse,
  AdminOverviewResponse, AdminActionRequest,
  CollectorStatusResponse,
  WorkBasisResponse, UpdateWorkBasisRequest, ScheduleMigrationResponse, UpdateScheduleMigrationRequest,
  WeeklyReviewBoardResponse, WeeklyReviewResponse, ExecuteWeeklyReviewActionRequest, ExecuteWeeklyReviewActionResponse, WeeklyReviewUpdateInput,
  ProgressOverviewResponse,
  BattlefieldSummariesResponse,
  OAuthConsentRequest,
  OAuthConsentResponse,
  OAuthConsentDecisionResponse,
  MeHomeResponse,
  HomePlanDay,
  HomePlanGate,
  HomePlanMark,
  HomePlanTask,
  HomePlanMission,
  HomePlanActivity,
  HomePlanResponse,
  PlanCalendarResponse,
  BattlefieldProgressResponse,
  CreatePlanMarkRequest,
  PatchPlanMarkRequest,
  MemberWork,
  MemberBattlefieldResponse,
  PatchMyTaskRequest,
  ReturnMyTaskRequest,
  StandaloneMyTaskRequest,
  TaskStandardCheck,
  TaskSubmission,
  TaskAcceptance,
  AcceptMyTaskRequest,
  ReopenMyTaskRequest,
  ReturnTaskAcceptanceRequest,
  TaskAcceptanceDraft,
  TaskPerson,
  TaskMissionRef,
  CreateMyTaskRequest,
  TaskDetailResponse,
  PutMyTaskNoteRequest,
  PutMyTaskNoteResponse,
  AddTaskCollaboratorsRequest,
  MonthPlanGroup,
  MonthPlanResponse,
  SaveMonthPlanRequest,
  NotificationList,
  MarkNotificationsSeenRequest,
  VoiceprintStatus,
  PersonalMemoryItem,
  PersonalMemoryList,
  PartnerMemoryList,
  CreateMemoryImportRequest,
  MemoryImport,
  MemoryImportDetail,
  MemoryImportList,
  ConfirmMemoryImportRequest,
  UpdatePersonalMemoryItemRequest,
  DictationResult,
  DictationSessionResponse,
  DictationPolishRequest,
  DictationPolishResponse,
  OnboardingResponse,
  CompleteOnboardingResponse,
  SeenMarkKey,
  SeenMarksResponse,
  MyRadar,
  PutMyRadarRequest,
  PersonalSignal,
  PersonalSignalBrief,
  PersonalSignalList,
  MyRadarScanAccepted,
  MemberRadarBrief,
  CompanyRadarSettings,
  PutCompanyRadarRequest,
  RadarDirection,
  RadarSourceSetting,
  PersonalRadarRun,
  MaterialView,
  MaterialListResponse,
  AddMaterialLinkRequest,
  MaterialRevisionView,
  MaterialBlock,
  MaterialDetailResponse,
  MaterialAnnotationView, CreateMaterialAnnotationRequest, CreateMaterialAnnotationResponse, MaterialRemovedView,
  RestoreMaterialRemovedRequest, MaterialEditProposalView, DecideMaterialEditProposalRequest, DecideMaterialAnnotationRequest,
  WeeklyProgressResponse,
  WorldSourceView,
  FeishuAuthConfigResponse,
  FeishuCodeLoginRequest,
  FeishuConnectionResponse,
  WechatConnection,
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
      ...taskQualityPaths,
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
      "/api/auth/demo": {
        get: {
          operationId: "getDemoEntry", summary: "演示入口是否可用（只在时间机器里注册）",
          responses: { "200": { description: "演示账号", content: { "application/json": { schema: { $ref: "#/components/schemas/DemoEntryResponse" } } } }, "404": errorResponse },
        },
        post: {
          operationId: "enterDemo", summary: "免口令进入演示账号（只在时间机器里注册）",
          responses: { "200": { description: "已登录", content: { "application/json": { schema: { $ref: "#/components/schemas/LoginResponse" } } } }, "403": errorResponse, "404": errorResponse },
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
      "/api/auth/feishu/config": {
        get: {
          operationId: "getFeishuAuthConfig", summary: "飞书免登是否可用，以及前端调 requestAccess 需要的 appId",
          responses: { "200": { description: "飞书配置", content: { "application/json": { schema: { $ref: "#/components/schemas/FeishuAuthConfigResponse" } } } } },
        },
      },
      "/api/me/feishu": {
        get: {
          operationId: "getMyFeishuConnection",
          summary: "本人的飞书连好了没有（授权有效、带着会后拿妙记要的权限）；没接飞书时 enabled=false",
          responses: {
            "200": { description: "飞书连接状态", content: { "application/json": { schema: { $ref: "#/components/schemas/FeishuConnectionResponse" } } } },
            "401": errorResponse,
          },
        },
        delete: {
          operationId: "disconnectMyFeishu",
          summary: "断开本人的飞书：删掉飞书账号的关联和授权（天枢里已有的会议、妙记不动）；之后飞书推送、拿妙记都停，要用再连",
          responses: { "204": { description: "已断开（没连过也是 204）" }, "401": errorResponse, "403": errorResponse },
        },
      },
      "/api/me/wechat": {
        get: {
          operationId: "getMyWechatConnection",
          summary: "本人的微信 ClawBot 连接状态（等扫码时带二维码内容）；没接微信时 404",
          responses: {
            "200": { description: "微信连接状态", content: { "application/json": { schema: { $ref: "#/components/schemas/WechatConnection" } } } },
            "401": errorResponse,
          },
        },
        delete: {
          operationId: "disconnectMyWechat",
          summary: "断开本人的微信 ClawBot",
          responses: { "204": { description: "已断开" }, "401": errorResponse },
        },
      },
      "/api/me/wechat/connect": {
        post: {
          operationId: "connectMyWechat",
          summary: "开始连接微信：要一张绑定二维码，后台等本人扫码确认；正在等扫码时沿用同一张",
          responses: {
            "200": { description: "微信连接状态", content: { "application/json": { schema: { $ref: "#/components/schemas/WechatConnection" } } } },
            "401": errorResponse,
            "503": errorResponse,
          },
        },
      },
      "/api/auth/feishu/start": {
        get: {
          operationId: "startFeishuAuth",
          summary: "浏览器打开：已登录直接跳到 next；否则写 state cookie 后跳飞书授权页。飞书消息里的深链接都指向这里。connect=1：已登录的人也去授权，连接飞书",
          parameters: [
            { name: "next", in: "query", required: false, schema: { type: "string" }, description: "登录后回到的站内路径，只接受以 / 开头的相对路径" },
            { name: "connect", in: "query", required: false, schema: { type: "string", enum: ["1"] }, description: "已登录的人连接飞书：授权完回到 next，不换会话" },
          ],
          responses: { "302": { description: "跳到 next 或飞书授权页" }, "404": errorResponse, "429": errorResponse },
        },
      },
      "/api/auth/feishu/callback": {
        get: {
          operationId: "completeFeishuAuth",
          summary: "飞书授权回调：校验 state，换 token，按已关联的人员建会话；关联不到时给出说明页",
          parameters: [
            { name: "code", in: "query", required: false, schema: { type: "string" } },
            { name: "state", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "已登录并带 Set-Cookie，页面自动跳到 next", content: { "text/html": { schema: { type: "string" } } } },
            "400": { description: "state 不符或缺 code", content: { "text/html": { schema: { type: "string" } } } },
            "403": { description: "飞书账号还没有关联天枢人员", content: { "text/html": { schema: { type: "string" } } } },
            "404": errorResponse,
            "502": { description: "飞书接口暂时不可用", content: { "text/html": { schema: { type: "string" } } } },
          },
        },
      },
      "/api/auth/feishu/code": {
        post: {
          operationId: "loginWithFeishuCode",
          summary: "在飞书客户端里打开：用 requestAccess 拿到的 code 换 token 并建会话",
          requestBody: jsonBody({ $ref: "#/components/schemas/FeishuCodeLoginRequest" }),
          responses: {
            "200": { description: "已登录", content: { "application/json": { schema: { $ref: "#/components/schemas/LoginResponse" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
            "429": errorResponse,
            "502": errorResponse,
          },
        },
      },
      "/api/auth/view": {
        post: {
          operationId: "setSessionView",
          summary: "同时是 CEO 和 DRI 的人切换当前视角（工单 07）；重签会话；不能切换的人 403",
          requestBody: jsonBody({ $ref: "#/components/schemas/SetViewRequest" }),
          responses: {
            "200": { description: "切换后的会话", content: { "application/json": { schema: { $ref: "#/components/schemas/SessionResponse" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
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
      "/api/people/directory": {
        get: {
          operationId: "listPersonDirectory",
          summary: "人员名册（CEO 和成员）：真人的 personId 和名字，约会议选参会人用",
          responses: {
            "200": { description: "人员名册", content: { "application/json": { schema: { $ref: "#/components/schemas/PersonDirectoryResponse" } } } },
            "401": errorResponse,
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
      "/api/issues/{id}/history": {
        get: {
          operationId: "getIssueDecisionHistory",
          summary: "议题有效历史分层：仍有效的历史决定、此后执行变化、本次待判断、已失效决定（只读）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "议题有效历史", content: { "application/json": { schema: { $ref: "#/components/schemas/IssueDecisionHistory" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/meetings/{id}/history": {
        get: {
          operationId: "getMeetingDecisionHistory",
          summary: "会议每个关联议题的有效历史分层（只读）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "会议关联议题的有效历史", content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingDecisionHistoryResponse" } } } },
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
          operationId: "getPersonalMissionCard", summary: "读取可见的任务卡正文、版本、意见和本轮动作",
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
      "/api/mission-cards/{cardId}/annotations": {
        get: { operationId: "getMissionCardAnnotations", summary: "读取正文批注、澄清问题和修改记录", parameters: [{ name: "cardId", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "批注与记录", content: { "application/json": { schema: { $ref: "#/components/schemas/MissionCardAnnotationsResponse" } } } }, "401": errorResponse, "404": errorResponse } },
        post: { operationId: "createMissionCardAnnotation", summary: "保存选区批注并交给 Co-Agent 处理", parameters: [{ name: "cardId", in: "path", required: true, schema: { type: "string" } }], requestBody: jsonBody({ $ref: "#/components/schemas/CreateMissionCardAnnotationRequest" }), responses: { "200": { description: "已保存的批注", content: { "application/json": { schema: { $ref: "#/components/schemas/CreateMissionCardAnnotationResponse" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse } },
      },
      "/api/mission-cards/{cardId}/owner-confirmation": {
        post: { operationId: "setMissionCardOwnerConfirmation", summary: "本人完成审核或取消确认；最后一人完成时自动汇总", parameters: [{ name: "cardId", in: "path", required: true, schema: { type: "string" } }], requestBody: jsonBody({ $ref: "#/components/schemas/SetMissionCardOwnerConfirmationRequest" }), responses: { "200": { description: "最新任务卡", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse } },
      },
      "/api/mission-cards/{cardId}/annotations/{annotationId}/resolve": {
        post: { operationId: "resolveMissionCardAnnotation", summary: "保留备注并明确终止待改意图，记录原因", parameters: [{ name: "cardId", in: "path", required: true, schema: { type: "string" } }, { name: "annotationId", in: "path", required: true, schema: { type: "string" } }], requestBody: jsonBody({ $ref: "#/components/schemas/ResolveMissionCardAnnotationRequest" }), responses: { "200": { description: "已保留的备注", content: { "application/json": { schema: { $ref: "#/components/schemas/CreateMissionCardAnnotationResponse" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse } },
      },
      "/api/mission-cards/{cardId}/annotations/{annotationId}/answer": {
        post: { operationId: "answerMissionCardAnnotation", summary: "明确修改意图并继续处理", parameters: [{ name: "cardId", in: "path", required: true, schema: { type: "string" } }, { name: "annotationId", in: "path", required: true, schema: { type: "string" } }], requestBody: jsonBody({ $ref: "#/components/schemas/AnswerMissionCardAnnotationRequest" }), responses: { "200": { description: "已回答的问题", content: { "application/json": { schema: { $ref: "#/components/schemas/CreateMissionCardAnnotationResponse" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse } },
      },
      "/api/mission-cards/{cardId}/annotations/{annotationId}/retry": {
        post: { operationId: "retryMissionCardAnnotation", summary: "重试未完成的批注修改", parameters: [{ name: "cardId", in: "path", required: true, schema: { type: "string" } }, { name: "annotationId", in: "path", required: true, schema: { type: "string" } }], requestBody: jsonBody({ $ref: "#/components/schemas/RetryMissionCardAnnotationRequest" }), responses: { "200": { description: "重试的批注", content: { "application/json": { schema: { $ref: "#/components/schemas/CreateMissionCardAnnotationResponse" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse } },
      },
      "/api/mission-cards/{cardId}/revisions": {
        get: { operationId: "getMissionCardRevisions", summary: "读取任务字段修改前后与依据", parameters: [{ name: "cardId", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "修改记录", content: { "application/json": { schema: { $ref: "#/components/schemas/MissionCardRevisionsResponse" } } } }, "401": errorResponse, "404": errorResponse } },
      },
      "/api/mission-cards/{cardId}/corrections": {
        post: {
          operationId: "createPersonalMissionCardCorrection", summary: "已确定的本月任务卡：非拍板人申请更正，拍板人直接更正并写回；按 clientId 幂等",
          parameters: [{ name: "cardId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/CreateMissionCardCorrectionRequest" }),
          responses: { "200": { description: "更正记录", content: { "application/json": { schema: { $ref: "#/components/schemas/MissionCardCorrectionResponse" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/mission-cards/{cardId}/corrections/{correctionId}/decision": {
        post: {
          operationId: "decidePersonalMissionCardCorrection", summary: "拍板人采纳（写回、版本 +1）或不采纳（须写原因）一条更正申请",
          parameters: [{ name: "cardId", in: "path", required: true, schema: { type: "string" } }, { name: "correctionId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/DecideMissionCardCorrectionRequest" }),
          responses: { "200": { description: "处理后的更正记录", content: { "application/json": { schema: { $ref: "#/components/schemas/MissionCardCorrectionResponse" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse },
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
      "/api/me/mission-cards": {
        get: {
          operationId: "getMyMissionRounds", summary: "读取尚未确认的 Mission Card 通知，跨月保留；Owner 只见本人，当前拍板人见全部卡",
          responses: {
            "200": { description: "本月 Mission Card 通知分组", content: { "application/json": { schema: { $ref: "#/components/schemas/MyMissionRoundsResponse" } } } },
            "401": errorResponse,
          },
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
          summary: "战场 DRI 重试起草、交给本人确认、延长本人确认与确认任务组合；版本冲突返回 latestCard",
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
      "/api/mission-rounds/{roundId}/return-cards": {
        post: { operationId: "returnMissionCards", summary: "战场 DRI 退回受影响的任务卡，保留其他人的本人确认",
          parameters: [{ name: "roundId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/ReturnMissionCardsRequest" }),
          responses: { "200": { description: "当前任务组合进度", content: { "application/json": { schema: { $ref: "#/components/schemas/CardCollection" } } } },
            "400": errorResponse, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse } },
      },
      "/api/monthly-reviews/{period}": {
        get: {
          operationId: "getMonthlyReview", summary: "CEO 读取某月复盘总览；当月还没有复盘时 review 为 null 并带开启动作",
          parameters: [{ name: "period", in: "path", required: true, schema: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$" } }],
          responses: { "200": { description: "月度复盘总览", content: { "application/json": { schema: { $ref: "#/components/schemas/MonthlyReviewResponse" } } } }, "401": errorResponse, "403": errorResponse },
        },
      },
      "/api/monthly-review-items/{itemId}": {
        get: {
          operationId: "getMonthlyReviewItem", summary: "负责人或 CEO 读取一项复盘；其他人 404",
          parameters: [{ name: "itemId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "复盘项", content: { "application/json": { schema: { $ref: "#/components/schemas/MonthlyReviewItemResponse" } } } }, "401": errorResponse, "404": errorResponse },
        },
      },
      "/api/monthly-review-items/{itemId}/comments": {
        post: {
          operationId: "createMonthlyReviewComment", summary: "讨论与补充：负责人、CEO 与本单元当月 Mission 负责人在确认前发言；按 clientId 幂等",
          parameters: [{ name: "itemId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/CreateMonthlyReviewCommentRequest" }),
          responses: { "200": { description: "新评论", content: { "application/json": { schema: { $ref: "#/components/schemas/CreateMonthlyReviewCommentResponse" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/me/monthly-reviews": {
        get: {
          operationId: "getMyMonthlyReviewNotices", summary: "按复盘当前状态现算的本人待办通知（负责人与 CEO）",
          responses: { "200": { description: "复盘通知", content: { "application/json": { schema: { $ref: "#/components/schemas/MyMonthlyReviewNoticesResponse" } } } }, "401": errorResponse },
        },
      },
      "/api/monthly-reviews/actions/execute": {
        post: {
          operationId: "executeMonthlyReviewAction", summary: "执行复盘动作；幂等重放返回当前视图，版本冲突 409 VERSION_CONFLICT",
          requestBody: jsonBody({ $ref: "#/components/schemas/ExecuteMonthlyReviewActionRequest" }),
          responses: { "200": { description: "动作对象的最新视图", content: { "application/json": { schema: { $ref: "#/components/schemas/ExecuteMonthlyReviewActionResponse" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/monthly-cycle": {
        get: {
          operationId: "getMonthlyCycle", summary: "当前月度经营周期的总倒计时（从个人复盘收集起 72 小时到签发下月任务卡）；全员可读，没有周期时 cycle 为 null",
          responses: { "200": { description: "月度周期", content: { "application/json": { schema: { $ref: "#/components/schemas/MonthlyCycleResponse" } } } }, "401": errorResponse },
        },
      },
      "/api/personal-reviews/board": {
        get: {
          operationId: "getPersonalReviewBoard", summary: "个人复盘看板：进行中的月末复盘里每人的提交状态（全员可见，不含内容）；没有进行中的复盘时 board 为 null",
          responses: { "200": { description: "个人复盘看板", content: { "application/json": { schema: { $ref: "#/components/schemas/PersonalReviewBoardResponse" } } } }, "401": errorResponse },
        },
      },
      "/api/personal-reviews/{personalReviewId}": {
        get: {
          operationId: "getPersonalReview", summary: "本人或 CEO 读取一份个人复盘；其他人 404",
          parameters: [{ name: "personalReviewId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "个人复盘", content: { "application/json": { schema: { $ref: "#/components/schemas/PersonalReviewResponse" } } } }, "401": errorResponse, "404": errorResponse },
        },
      },
      "/api/personal-reviews/actions/execute": {
        post: {
          operationId: "executePersonalReviewAction", summary: "执行个人复盘动作；幂等重放返回当前视图，版本冲突 409 VERSION_CONFLICT",
          requestBody: jsonBody({ $ref: "#/components/schemas/ExecutePersonalReviewActionRequest" }),
          responses: { "200": { description: "个人复盘与看板的最新视图", content: { "application/json": { schema: { $ref: "#/components/schemas/ExecutePersonalReviewActionResponse" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/requests/draft": {
        post: {
          operationId: "draftRequest", summary: "发起人一句话，Agent 起草请求（标题、说明、接收人候选）并自查歧义；带 requestId 时按回答重写同一份草稿",
          requestBody: jsonBody({ $ref: "#/components/schemas/DraftRequestRequest" }),
          responses: { "200": { description: "草稿与处理步骤", content: { "application/json": { schema: { $ref: "#/components/schemas/DraftRequestResponse" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse, "503": errorResponse },
        },
      },
      "/api/requests/{id}": {
        get: {
          operationId: "getRequest", summary: "读一条请求；只有发起人和接收人看得到，打开即把这条请求的通知标为已读",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "请求", content: { "application/json": { schema: { $ref: "#/components/schemas/RequestResponse" } } } }, "401": errorResponse, "404": errorResponse },
        },
      },
      "/api/requests/{id}/questions/prepare": {
        post: {
          operationId: "prepareRequestQuestion", summary: "接收人提问前：先在说明和已有问答里找答案，找不到就整理成问题等本人确认；不写库",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/PrepareRequestQuestionRequest" }),
          responses: { "200": { description: "处理步骤与结果", content: { "application/json": { schema: { $ref: "#/components/schemas/PrepareRequestQuestionResponse" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse },
        },
      },
      "/api/requests/{id}/questions/{questionId}/answer-draft": {
        post: {
          operationId: "draftRequestAnswer", summary: "发起人的 Agent 起草回答（存为草稿，发起人确认后才发出）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "questionId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "回答草稿", content: { "application/json": { schema: { $ref: "#/components/schemas/DraftRequestAnswerResponse" } } } }, "401": errorResponse, "404": errorResponse, "409": errorResponse, "503": errorResponse },
        },
      },
      "/api/requests/actions/execute": {
        post: {
          operationId: "executeRequestAction", summary: "request.send / ask / answer / mark_done；send 校验 actionId 里的版本，发出的就是预览那一版",
          requestBody: jsonBody({ $ref: "#/components/schemas/ExecuteRequestActionRequest" }),
          responses: { "200": { description: "请求的最新视图", content: { "application/json": { schema: { $ref: "#/components/schemas/RequestResponse" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/me/requests": {
        get: {
          operationId: "listMyRequests", summary: "我收到的（inbox）或我发出的（sent）请求，最近 100 条",
          parameters: [{ name: "box", in: "query", required: true, schema: { type: "string", enum: ["inbox", "sent"] } }],
          responses: { "200": { description: "请求列表", content: { "application/json": { schema: { $ref: "#/components/schemas/RequestListResponse" } } } }, "400": errorResponse, "401": errorResponse },
        },
      },
      "/api/requests/{id}/impact": {
        get: {
          operationId: "getRequestImpactCard", summary: "kind = impact 的请求对应的影响卡；只有收卡的人看得到",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "影响卡", content: { "application/json": { schema: { $ref: "#/components/schemas/ImpactCardResponse" } } } }, "401": errorResponse, "404": errorResponse },
        },
      },
      "/api/impact-cards/{id}/ask": {
        post: {
          operationId: "askImpactCard", summary: "在影响卡上追问：Agent 结合这条决定和本人手上的事回答，问答留在卡上",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/ImpactAskRequest" }),
          responses: { "200": { description: "处理步骤与带回答的影响卡", content: { "application/json": { schema: { $ref: "#/components/schemas/ImpactAskResponse" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse, "503": errorResponse },
        },
      },
      "/api/impact-cards/{id}/irrelevant": {
        post: {
          operationId: "markImpactCardIrrelevant", summary: "「和我无关」：卡收起，反馈回流成质量信号；重复点幂等",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/ImpactIrrelevantRequest" }),
          responses: { "200": { description: "影响卡", content: { "application/json": { schema: { $ref: "#/components/schemas/ImpactCardResponse" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse },
        },
      },
      "/api/impact-cards/{id}/basis": {
        post: {
          operationId: "chooseImpactCardBasis", summary: "文档变更影响卡：切换到新版，或继续用旧版到某天并写理由；更新本人的工作依据清单",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/ImpactBasisChoiceRequest" }),
          responses: { "200": { description: "影响卡", content: { "application/json": { schema: { $ref: "#/components/schemas/ImpactCardResponse" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/requests/{id}/doc-change": {
        get: {
          operationId: "getRequestDocChange", summary: "kind = doc_change 的请求对应的文档变更；只有作者和被问的旧文档负责人看得到",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "文档变更", content: { "application/json": { schema: { $ref: "#/components/schemas/DocChangeResponse" } } } }, "401": errorResponse, "404": errorResponse },
        },
      },
      "/api/doc-changes/{id}/confirm": {
        post: {
          operationId: "confirmDocChange", summary: "作者勾选新文档修订或取代了哪几份（空即都不是），确认后推影响卡",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/ConfirmDocChangeRequest" }),
          responses: { "200": { description: "文档变更", content: { "application/json": { schema: { $ref: "#/components/schemas/DocChangeResponse" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/doc-changes/{id}/ask-owners": {
        post: {
          operationId: "askDocChangeOwners", summary: "作者确认不了：改问候选旧文档的负责人「你的《A》还有效吗？」",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "文档变更", content: { "application/json": { schema: { $ref: "#/components/schemas/DocChangeResponse" } } } }, "401": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/doc-changes/{id}/owner-answer": {
        post: {
          operationId: "answerDocChangeOwner", summary: "旧文档负责人回答还有效或已被取代；已被取代时推影响卡",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/DocOwnerAnswerRequest" }),
          responses: { "200": { description: "文档变更", content: { "application/json": { schema: { $ref: "#/components/schemas/DocChangeResponse" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/collections/draft": {
        post: {
          operationId: "draftCollection", summary: "③ 信息收集：发起人一句话，Agent 起草收什么、发给谁、截止；带 collectionId 时按改过的原话重写同一份草稿",
          requestBody: jsonBody({ $ref: "#/components/schemas/DraftCollectionRequest" }),
          responses: { "200": { description: "草稿与处理步骤", content: { "application/json": { schema: { $ref: "#/components/schemas/DraftCollectionResponse" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse, "422": errorResponse, "503": errorResponse },
        },
      },
      "/api/collections/{id}": {
        get: {
          operationId: "getCollection", summary: "收集任务：草稿或最近一轮的汇总；只有发起人看得到",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "收集任务", content: { "application/json": { schema: { $ref: "#/components/schemas/CollectionResponse" } } } }, "401": errorResponse, "404": errorResponse },
        },
      },
      "/api/requests/{id}/collection": {
        get: {
          operationId: "getRequestCollection", summary: "kind = collection 的请求对应的那一轮：发起人看汇总和每人状态，接收人只看自己那一行",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "这一轮", content: { "application/json": { schema: { $ref: "#/components/schemas/CollectionResponse" } } } }, "401": errorResponse, "404": errorResponse },
        },
      },
      "/api/collections/actions/execute": {
        post: {
          operationId: "executeCollectionAction", summary: "collection.send / save / confirm / stop；send 校验 actionId 里的版本，发出的就是预览那一版",
          requestBody: jsonBody({ $ref: "#/components/schemas/ExecuteCollectionActionRequest" }),
          responses: { "200": { description: "收集任务的最新视图", content: { "application/json": { schema: { $ref: "#/components/schemas/CollectionResponse" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/me/schedules": {
        get: {
          operationId: "listMySchedules", summary: "设置里的定时任务区：每周固定的收集任务、每周五起草周复盘、上手时搬过来的本机定时任务",
          responses: { "200": { description: "定时任务", content: { "application/json": { schema: { $ref: "#/components/schemas/ScheduleListResponse" } } } }, "401": errorResponse },
        },
      },
      "/api/me/meeting-cards": {
        get: {
          operationId: "listMyMeetingCards", summary: "通知栏的会后确认：等我确认的决策和行动项（一条一条），和我主持或创建的会里写入失败的会议记录（一场会一条）",
          responses: { "200": { description: "待处理的会议记录", content: { "application/json": { schema: { $ref: "#/components/schemas/MyMeetingCardsResponse" } } } }, "401": errorResponse },
        },
      },
      "/api/me/feishu-minutes": {
        get: {
          operationId: "listMyFeishuMinutes", summary: "我在飞书里直接开的会待整理：只列我是所有者、近 7 天、还没对上天枢会议的视频会议妙记",
          responses: { "200": { description: "待整理的妙记", content: { "application/json": { schema: { $ref: "#/components/schemas/FeishuMinuteInboxResponse" } } } }, "401": errorResponse },
        },
      },
      "/api/me/feishu-minutes/{token}/organize": {
        post: {
          operationId: "organizeFeishuMinute", summary: "妙记所有者用这份妙记新建一场会（别人 404 MINUTE_NOT_FOUND）；已整理过的再整理返回同一个 meetingId；400 INVALID_INPUT / ANCHOR_NOT_FOUND / INVALID_CEO / INVALID_PARTICIPANT，409 MINUTE_NOT_PENDING / MINUTE_TAKEN",
          parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/OrganizeFeishuMinuteRequest" }),
          responses: { "200": { description: "妙记所在的会", content: { "application/json": { schema: { $ref: "#/components/schemas/FeishuMinuteMeetingResponse" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/me/feishu-minutes/{token}/attach": {
        post: {
          operationId: "attachFeishuMinute", summary: "妙记所有者把妙记记到建议的那场天枢里约好的会（别人 404 MINUTE_NOT_FOUND）；已记到同一场会的再记返回同一个 meetingId；409 MINUTE_NOT_PENDING / SUGGESTION_CHANGED / MINUTE_TAKEN",
          parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/AttachFeishuMinuteRequest" }),
          responses: { "200": { description: "妙记所在的会", content: { "application/json": { schema: { $ref: "#/components/schemas/FeishuMinuteMeetingResponse" } } } }, "401": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/me/feishu-minutes/{token}/ignore": {
        post: {
          operationId: "ignoreFeishuMinute", summary: "妙记所有者忽略这份妙记，不再提示（别人 404 MINUTE_NOT_FOUND）；已忽略的再忽略 204；409 MINUTE_NOT_PENDING",
          parameters: [{ name: "token", in: "path", required: true, schema: { type: "string" } }],
          responses: { "204": { description: "已忽略" }, "401": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/meetings/{id}/minutes": {
        post: {
          operationId: "readMeetingMinutesLink", summary: "主持人或创建人贴飞书妙记链接，按这个妙记读逐字稿（别人一律 404）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/MeetingMinutesLinkRequest" }),
          responses: { "200": { description: "读完之后的妙记状态", content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingMinutesFetchResponse" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/meetings/{id}/minutes/refetch": {
        post: {
          operationId: "refetchMeetingMinutes", summary: "主持人或创建人再读一次妙记（等待中、没拿到、读取失败时）；已读完 409",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "读完之后的妙记状态", content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingMinutesFetchResponse" } } } }, "401": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/meetings/{id}/card": {
        get: {
          operationId: "getMeetingRecordCard", summary: "会议卡：草稿（读时目标变过就刷新差异）、行动项、确认版与同步回执；主持人、创建人、CEO、实际参会人能读，别人 404",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "会议卡", content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingCardView" } } } }, "401": errorResponse, "404": errorResponse },
        },
      },
      "/api/meetings/{id}/card/draft": {
        put: {
          operationId: "saveMeetingCardDraft", summary: "主持人或创建人整份保存会议卡草稿；draftVersion 过期 409 DRAFT_CHANGED（带 view），校验不过 400（fieldErrors 按字段路径）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/MeetingCardDraftRequest" }),
          responses: { "200": { description: "保存后的会议卡", content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingCardView" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/meetings/{id}/card/speakers": {
        post: {
          operationId: "assignMeetingCardSpeaker",
          summary: "主持人或创建人指定一位没对上人的说话人：对到某人（卡里的原名换成这个人、加进参会人），或选「不是天枢里的人」保留原名；draftVersion 过期 409 DRAFT_CHANGED（带 view）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/MeetingCardSpeakerRequest" }),
          responses: { "200": { description: "指定后的会议卡", content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingCardView" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/meetings/{id}/card/confirm": {
        post: {
          operationId: "confirmMeetingCard",
          summary: "主持人或创建人整卡确认：冻结一个确认版本并排写本体（选了不写入只留天枢）；draftVersion 过期 409 DRAFT_CHANGED（带 view），同一草稿再确认不出新版本；已有确认版时 kind 必填（400 KIND_REQUIRED），没有实际时间或在将来 400 OCCURRED_AT_REQUIRED；逐条确认的会议卡冻结前不能整卡确认（409 REVIEW_PER_ITEM）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/MeetingCardConfirmRequest" }),
          responses: { "200": { description: "确认后的会议卡", content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingCardView" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse, "503": errorResponse },
        },
      },
      "/api/meetings/{id}/card/reviews": {
        post: {
          operationId: "reviewMeetingCardItem",
          summary: "逐条确认一条决策或行动项：只有责任人本人能点（没有负责人的行动项由主持人点），别人 404；没有责任人的决策要先补归属（409 OWNER_REQUIRED）；reject 要写原因（400 REASON_REQUIRED）；已处理过 409 ALREADY_REVIEWED，冻结后的决策 409 CARD_FROZEN（都带 view）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/MeetingCardReviewRequest" }),
          responses: { "200": { description: "处理后的会议卡（点的人读不了会议卡时 view 为 null）", content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingCardReviewResponse" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/meetings/{id}/card/owners": {
        post: {
          operationId: "assignMeetingDecisionOwner",
          summary: "冻结前主持人给没有责任人的决策补归属（只能选参会人），补上后由那个人确认；别人 404；不是参会人 400 NOT_PARTICIPANT；已有责任人 409 OWNER_SET；已处理过 409 ALREADY_REVIEWED；冻结后 409 CARD_FROZEN",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/MeetingCardOwnerRequest" }),
          responses: { "200": { description: "补归属后的会议卡", content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingCardReviewResponse" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/meetings/{id}/card/world": {
        put: {
          operationId: "setMeetingCardWorldChoice",
          summary: "冻结前主持人或创建人改「不写进本体」；冻结后 409 CARD_FROZEN",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/MeetingCardWorldChoiceRequest" }),
          responses: { "200": { description: "改后的会议卡", content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingCardView" } } } }, "401": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/meetings/{id}/card/retry": {
        post: {
          operationId: "retryMeetingCardSync", summary: "主持人或创建人重试当前确认版的会议事件写入（失败或还在等的）；已写成或选了不写入 409",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "重排后的会议卡", content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingCardView" } } } }, "401": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/meetings/{id}/world": {
        get: {
          operationId: "getMeetingWorld", summary: "这场会在本体里：挂点、会议记录状态（主持人、创建人和 CEO）、每条生效的决定落到哪；参会人只看挂点和落点",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "这场会在本体里", content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingWorldResponse" } } } }, "401": errorResponse, "404": errorResponse },
        },
      },
      "/api/meetings/{id}/world-anchors": {
        put: {
          operationId: "setMeetingWorldAnchors", summary: "主持人或 CEO 改会议挂到的 LTO、本月 PO、Mission、责任单元；null 回到自动",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/MeetingWorldAnchorsRequest" }),
          responses: { "200": { description: "这场会在本体里的最新状态", content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingWorldResponse" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse },
        },
      },
      "/api/meetings/{id}/world-anchor-options": {
        get: {
          operationId: "listMeetingWorldAnchorOptions", summary: "改挂点时可选的对象：本月 PO、LTO（本体读得到时）、本月 Mission、责任单元",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "可选的挂点", content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingWorldAnchorOptionsResponse" } } } }, "401": errorResponse, "404": errorResponse },
        },
      },
      "/api/meetings": {
        post: {
          operationId: "bookMeeting", summary: "预约建会：带起止、挂点、是否不写进本体；成员只能给自己建，CEO 从 DRI 里指定主持人；带 draftId 时同一张会议卡只建一场",
          requestBody: jsonBody({ $ref: "#/components/schemas/MeetingBookingRequest" }),
          responses: {
            "200": { description: "新建的会议卡", content: { "application/json": { schema: { type: "object", required: ["card"], additionalProperties: false, properties: { card: { $ref: "#/components/schemas/Card" } } } } } },
            "400": errorResponse, "401": errorResponse, "403": errorResponse, "409": errorResponse,
          },
        },
      },
      "/api/meeting-drafts/{draftId}": {
        get: {
          operationId: "getMeetingDraftStatus", summary: "对话里的一张会议卡约好没有：本人用这张卡建的会，没约为 null",
          parameters: [{ name: "draftId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "这张会议卡建的会", content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingDraftStatusResponse" } } } }, "400": errorResponse, "401": errorResponse },
        },
      },
      "/api/world-anchor-options": {
        get: {
          operationId: "listWorldAnchorOptions", summary: "预约时可选的挂点：本月 PO、LTO（本体读得到时）、本月 Mission、责任单元",
          parameters: [{ name: "period", in: "query", required: true, schema: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$" } }],
          responses: { "200": { description: "可选的挂点", content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingWorldAnchorOptionsResponse" } } } }, "400": errorResponse, "401": errorResponse },
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
      "/api/conversations/{scope}/turns/{runId}/stream": {
        get: {
          operationId: "followConversationTurn",
          parameters: [{ name: "scope", in: "path", required: true, schema: { type: "string" } }, { name: "runId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          summary: "接上首页对话里还在写（或刚写完）的那一轮：先补发这一轮已有的事件，再跟着往下写到结束（切走、刷新、断线回来）",
          responses: {
            "200": {
              description: "SSE 事件流（与发送消息的事件相同）；x-turn-started-at 是这一轮开始的时刻（毫秒）",
              headers: { "x-turn-started-at": { schema: { type: "string" } } },
              content: { "text/event-stream": { schema: { $ref: "#/components/schemas/ConversationSseEvent" } } },
            },
            "204": { description: "这一轮不在这里（没有在写、服务重启过或不是首页 Chat 对话）" },
            "401": errorResponse,
          },
        },
      },
      "/api/conversations/{scope}/turns/{runId}/stop": {
        post: {
          operationId: "stopConversationTurn",
          parameters: [{ name: "scope", in: "path", required: true, schema: { type: "string" } }, { name: "runId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          summary: "本人点「停止」：请服务端停下这一轮（首页 Chat 对话；断开连接不再算停止）。天枢自己的对话由断开连接停下，这里不做事",
          responses: {
            "200": { description: "停下后这一轮的状态", content: { "application/json": { schema: { $ref: "#/components/schemas/ConversationTurnStopResponse" } } } },
            "204": { description: "不是首页 Chat 对话，由断开连接停下" },
            "401": errorResponse,
            "404": errorResponse,
            "502": errorResponse,
            "503": errorResponse,
          },
        },
      },
      "/api/issue-drafts/{id}": {
        get: {
          operationId: "getIssueDraft", summary: "CEO 读首页对话里的一条转议题建议（初稿、能对上的议题、可挂的战场）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "转议题建议", content: { "application/json": { schema: { $ref: "#/components/schemas/IssueDraftResponse" } } } }, "401": errorResponse, "403": errorResponse, "404": errorResponse },
        },
      },
      "/api/issue-drafts/{id}/accept": {
        post: {
          operationId: "acceptIssueDraft", summary: "开议题（按确认后的初稿与位置新建）或接到已有议题；相关那段首页对话带进议题页，首页留一行留痕；重放返回原结果",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/AcceptIssueDraftRequest" }),
          responses: { "200": { description: "转议题建议的最新视图", content: { "application/json": { schema: { $ref: "#/components/schemas/IssueDraftResponse" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/issue-drafts/{id}/decline": {
        post: {
          operationId: "declineIssueDraft", summary: "不用：这个话题之后不再建议转议题",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "转议题建议的最新视图", content: { "application/json": { schema: { $ref: "#/components/schemas/IssueDraftResponse" } } } }, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse },
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
      "/api/threads/{objectType}/{objectId}/members": {
        post: {
          operationId: "addThreadMembers",
          parameters: threadParameters,
          summary: "拉人进群（工单 08）：群成员都能拉；议题第一次由 CEO 拉人时建群；被拉即加入，Co-Agent 在后台写进群介绍",
          requestBody: jsonBody({ $ref: "#/components/schemas/AddThreadMembersRequest" }),
          responses: {
            "200": { description: "群成员", content: { "application/json": { schema: { $ref: "#/components/schemas/ThreadMembersResponse" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/threads/{objectType}/{objectId}/leave": {
        post: {
          operationId: "leaveThread",
          parameters: threadParameters,
          summary: "自己退出群；对象的主人（执行事项推进人、会议主持人、议题群里的 CEO）不能退，返回 409",
          responses: {
            "204": { description: "已退出" },
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/threads/{objectType}/{objectId}/candidates": {
        get: {
          operationId: "listThreadCandidates",
          parameters: threadParameters,
          summary: "可以拉进这个群的人；群成员（议题未建群时为 CEO）才能读",
          responses: {
            "200": { description: "候选人", content: { "application/json": { schema: { $ref: "#/components/schemas/ThreadCandidatesResponse" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/me/threads/unread": {
        get: {
          operationId: "listMyUnreadThreads",
          summary: "我所在各群的未读条数（只列有未读的），给通知栏「群聊新消息」用",
          responses: {
            "200": { description: "有未读的群", content: { "application/json": { schema: { $ref: "#/components/schemas/UnreadThreadsResponse" } } } },
            "401": errorResponse,
          },
        },
      },
      "/api/me/meetings": {
        get: {
          operationId: "listMyMeetings",
          summary: "我在群里、还没开完的会，按开始时间排，给成员通知栏「会议安排」用",
          responses: {
            "200": { description: "会议安排", content: { "application/json": { schema: { $ref: "#/components/schemas/MemberMeetingsResponse" } } } },
            "401": errorResponse,
          },
        },
      },
      "/api/me/feishu-events": {
        get: {
          operationId: "listMyFeishuEvents",
          summary: "本人飞书主日历里接下来 7 天的日程（只读，和「会议安排」排在一起）；天枢约的会、取消的、拒绝的不列，没连飞书时为空",
          responses: {
            "200": { description: "飞书日程", content: { "application/json": { schema: { $ref: "#/components/schemas/FeishuCalendarEventsResponse" } } } },
            "401": errorResponse,
          },
        },
      },
      "/api/me/cards/issues/{id}": {
        get: {
          operationId: "getMemberIssueCard",
          summary: "被拉进议题群的成员读议题：同一种卡片信封，actions 为空，去掉 CEO 专用内容；非群成员 404",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "只读的议题卡片", content: { "application/json": { schema: { $ref: "#/components/schemas/Card" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/me/cards/meetings/{id}": {
        get: {
          operationId: "getMemberMeetingCard",
          summary: "会议群成员读会议：同一种卡片信封，actions 为空，去掉 CEO 专用内容；非群成员 404",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "只读的会议卡片", content: { "application/json": { schema: { $ref: "#/components/schemas/Card" } } } },
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
        delete: {
          operationId: "resetOnboarding",
          summary: "本人重看首次引导：删掉自己的「看过」记录（工单 07）",
          responses: {
            "204": { description: "已清除" },
            "401": errorResponse,
            "403": errorResponse,
          },
        },
      },
      "/api/me/seen-marks": {
        get: {
          operationId: "getSeenMarks",
          summary: "我看过的更新与演示：按看过时间排序，跨设备同步",
          responses: {
            "200": { description: "看过的标记", content: { "application/json": { schema: { $ref: "#/components/schemas/SeenMarksResponse" } } } },
            "401": errorResponse,
          },
        },
      },
      "/api/me/seen-marks/{key}": {
        post: {
          operationId: "markSeen",
          summary: "本人记一次看过某版本更新卡或产品演示（幂等，需要同站 Origin）",
          parameters: [{ name: "key", in: "path", required: true, schema: SeenMarkKey as JsonSchema }],
          responses: {
            "200": { description: "看过的标记", content: { "application/json": { schema: { $ref: "#/components/schemas/SeenMarksResponse" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
          },
        },
        delete: {
          operationId: "clearSeenMark",
          summary: "本人清掉一条看过标记，便于测试时重看",
          parameters: [{ name: "key", in: "path", required: true, schema: SeenMarkKey as JsonSchema }],
          responses: {
            "204": { description: "已清除" },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
          },
        },
      },
      "/api/me/home": {
        get: {
          operationId: "getMyHome",
          summary: "成员工作台：参与的战场、本月任务卡、执行事项，以及开着时的个人雷达小组件",
          responses: {
            "200": { description: "我的执行事项", content: { "application/json": { schema: { $ref: "#/components/schemas/MeHomeResponse" } } } },
            "401": errorResponse,
          },
        },
      },
      "/api/me/home-plan": {
        get: {
          operationId: "getMyHomePlan",
          summary: "成员首页的 Mission 计划：本月 Mission、签定关口、计划点、Task 与分好三栏的执行事项；本月没有 Mission 时回退到最近一个有的月份",
          responses: {
            "200": { description: "首页计划", content: { "application/json": { schema: { $ref: "#/components/schemas/HomePlanResponse" } } } },
            "401": errorResponse,
            "403": errorResponse,
          },
        },
      },
      "/api/me/plan-calendar": {
        get: {
          operationId: "getMyPlanCalendar",
          summary: "成员首页月历翻到别的月份：那个月的每一天（工作日按节假日日历）和落在那个月的签定关口",
          parameters: [{ name: "month", in: "query", required: true, schema: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$" } }],
          responses: {
            "200": { description: "那个月的月历", content: { "application/json": { schema: { $ref: "#/components/schemas/PlanCalendarResponse" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
          },
        },
      },
      "/api/plan-tasks/{taskId}/deliverable": {
        get: {
          operationId: "getTaskDeliverable",
          summary: "本人 Mission 下一个 Task 的交付物：按哪几条标准评、各版本的材料、评审报告、交付和版本说明（新的版本在前）",
          parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "交付物", content: { "application/json": { schema: { $ref: "#/components/schemas/TaskDeliverableResponse" } } } },
            "401": errorResponse, "403": errorResponse, "404": errorResponse,
          },
        },
      },
      "/api/plan-tasks/{taskId}/deliverable/versions": {
        post: {
          operationId: "createDeliverableVersion",
          summary: "传一个新版本并开始评审（multipart：files 若干份 PDF/Word/Markdown/HTML/图片；links 是 JSON 数组；statement 是附的一句话或现状说明；keep 是 JSON 数组，沿用上一版里的哪几样）",
          parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: { "multipart/form-data": { schema: { type: "object", properties: {
              files: { type: "array", items: { type: "string", format: "binary" } },
              links: { type: "string" }, statement: { type: "string" }, keep: { type: "string" },
            } } } },
          },
          responses: {
            "201": { description: "新版本（评审已排队）", content: { "application/json": { schema: { $ref: "#/components/schemas/DeliverableVersion" } } } },
            "400": errorResponse, "401": errorResponse, "403": errorResponse, "404": errorResponse, "413": errorResponse,
          },
        },
      },
      "/api/plan-tasks/{taskId}/deliverable/items/{itemId}": {
        get: {
          operationId: "readDeliverableItem",
          summary: "打开交付物里的一份文件或图片（原文件）",
          parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }, { name: "itemId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "原文件" }, "401": errorResponse, "403": errorResponse, "404": errorResponse },
        },
      },
      "/api/plan-tasks/{taskId}/deliverable/versions/{versionId}/review": {
        post: {
          operationId: "retryDeliverableReview",
          summary: "评审没做完时重新评审这一版",
          parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }, { name: "versionId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "这一版", content: { "application/json": { schema: { $ref: "#/components/schemas/DeliverableVersion" } } } }, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/plan-tasks/{taskId}/deliverable/versions/{versionId}/criteria/{index}/dissent": {
        post: {
          operationId: "dissentDeliverableCriterion",
          summary: "本人不同意某一条的判定：写一句为什么，带着这句话重评这一条",
          parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }, { name: "versionId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
            { name: "index", in: "path", required: true, schema: { type: "integer", minimum: 1 } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/DeliverableDissentRequest" }),
          responses: { "200": { description: "这一版", content: { "application/json": { schema: { $ref: "#/components/schemas/DeliverableVersion" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/plan-tasks/{taskId}/deliverable/versions/{versionId}/deliver": {
        post: {
          operationId: "deliverDeliverableVersion",
          summary: "交付这一版：最新一版、参考评审跑完就能交付，不看达没达到；没有可对照标准的 Task 不收交付；交付后伙伴写版本说明",
          parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }, { name: "versionId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "这一版", content: { "application/json": { schema: { $ref: "#/components/schemas/DeliverableVersion" } } } }, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/plan-tasks/{taskId}/deliverable/versions/{versionId}/withdraw": {
        post: {
          operationId: "withdrawDeliverableVersion",
          summary: "撤回交付",
          parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }, { name: "versionId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "这一版", content: { "application/json": { schema: { $ref: "#/components/schemas/DeliverableVersion" } } } }, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/plan-tasks/{taskId}/deliverable/versions/{versionId}/note": {
        patch: {
          operationId: "patchDeliverableNote",
          summary: "改版本说明里的几句，或者不要这段",
          parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }, { name: "versionId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/DeliverableNotePatch" }),
          responses: { "200": { description: "这一版", content: { "application/json": { schema: { $ref: "#/components/schemas/DeliverableVersion" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/plan-tasks/{taskId}/agreement": {
        get: {
          operationId: "getTaskAgreement",
          summary: "一个 Task 的约定：每条标准用什么证明、谁来认，这次不包括什么；先读本体，没有再读天枢 11 月的补充，两样都没有只给标准原文；标出来源和标准有没有改过（负责人、Mission 负责人、战场负责人、CEO、约定里的认可人能看）",
          parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "约定", content: { "application/json": { schema: { $ref: "#/components/schemas/TaskAgreementResponse" } } } },
            "401": errorResponse, "403": errorResponse, "404": errorResponse,
          },
        },
        put: {
          operationId: "putTaskAgreement",
          summary: "存 11 月的补充（负责人、Mission 负责人）：整份覆盖、留修改记录；约定来自本体时 409 AGREEMENT_FROM_WORLD，没有标准时 409 NO_CRITERIA，认可人不在人员目录 400 UNKNOWN_PERSON",
          parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/PutTaskAgreementRequest" }),
          responses: {
            "200": { description: "存好后的约定", content: { "application/json": { schema: { $ref: "#/components/schemas/TaskAgreementResponse" } } } },
            "400": errorResponse, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse,
          },
        },
      },
      "/api/plan-tasks/{taskId}/check": {
        get: {
          operationId: "checkTask",
          summary: "对表（不调模型）：约定和最新一版的参考评审摆在一起，每条标出有证据、差、评审中、还没交付物、要 X 确认之一，顶上一句结论（还不能交 / 可以交）；评审的「下次可以做」单独附在后面",
          parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "对表结果", content: { "application/json": { schema: { $ref: "#/components/schemas/TaskCheckResponse" } } } },
            "401": errorResponse, "403": errorResponse, "404": errorResponse,
          },
        },
      },
      "/api/plan-tasks/{taskId}/check/notify": {
        post: {
          operationId: "notifyCheckAcceptor",
          summary: "「请 X 看」（负责人）：给这一条约定的认可人推一条飞书私聊，带 Task 的链接；同一条一天最多推一次。personId 和约定里的认可人对不上 400 NOT_ACCEPTOR；这一条还不是「要 X 确认」409 NOT_AWAITING_ACCEPTOR；认可人没关联飞书 409 ACCEPTOR_NOT_ON_FEISHU；飞书没接 503 FEISHU_NOT_CONFIGURED",
          parameters: [{ name: "taskId", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/CheckNotifyRequest" }),
          responses: {
            "200": { description: "推了，或今天已经推过", content: { "application/json": { schema: { $ref: "#/components/schemas/CheckNotifyResponse" } } } },
            "400": errorResponse, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse, "503": errorResponse,
          },
        },
      },
      "/api/me/battlefield-progress": {
        get: {
          operationId: "getMyBattlefieldProgress",
          summary: "成员的战场进展：按我所在的战场分组（本月没有战场时按我本月 Mission 的业务域）；需要搭把手的事和每人一张卡",
          responses: {
            "200": { description: "战场进展", content: { "application/json": { schema: { $ref: "#/components/schemas/BattlefieldProgressResponse" } } } },
            "401": errorResponse,
            "403": errorResponse,
          },
        },
      },
      "/api/me/plan-marks": {
        post: {
          operationId: "createMyPlanMark",
          summary: "在本人的 Mission 下加一个计划点（只存天枢本地）：日期要在该 Mission 的月份里，一个 Mission 下最多 20 个",
          requestBody: jsonBody({ $ref: "#/components/schemas/CreatePlanMarkRequest" }),
          responses: {
            "200": { description: "新建的计划点", content: { "application/json": { schema: { $ref: "#/components/schemas/HomePlanMark" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/me/plan-marks/{id}": {
        patch: {
          operationId: "patchMyPlanMark",
          summary: "拖到别的日子或改名（至少带一个字段，不能换 Mission）；别人的点按不存在算",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/PatchPlanMarkRequest" }),
          responses: {
            "200": { description: "改后的计划点", content: { "application/json": { schema: { $ref: "#/components/schemas/HomePlanMark" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
          },
        },
        delete: {
          operationId: "deleteMyPlanMark",
          summary: "删掉一个计划点",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "204": { description: "已删除" },
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/me/battlefields/{id}": {
        get: {
          operationId: "getMyBattlefield",
          summary: "成员可参与的战场：目标、本月任务卡与制定轮次",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "成员战场详情", content: { "application/json": { schema: { $ref: "#/components/schemas/MemberBattlefieldResponse" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/me/radar": {
        get: {
          operationId: "getMyRadar",
          summary: "本人雷达（仅成员）：开关、方向、来源及读法、最近一次扫描、未读数与建议；从没保存过时 enabled=false、updatedAt=null",
          responses: {
            "200": { description: "本人雷达", content: { "application/json": { schema: { $ref: "#/components/schemas/MyRadar" } } } },
            "401": errorResponse,
            "403": errorResponse,
          },
        },
        put: {
          operationId: "putMyRadar",
          summary: "保存本人雷达设置（仅成员）：方向与来源先规范化再存；只写设置，不触发扫描",
          requestBody: jsonBody({ $ref: "#/components/schemas/PutMyRadarRequest" }),
          responses: {
            "200": { description: "规范化后的本人雷达", content: { "application/json": { schema: { $ref: "#/components/schemas/MyRadar" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
          },
        },
      },
      "/api/me/radar/signals": {
        get: {
          operationId: "listMyRadarSignals",
          summary: "本人的个人信号（不含已隐藏），按收集时间倒序；默认 50 条",
          parameters: [{ name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } }],
          responses: {
            "200": { description: "个人信号列表", content: { "application/json": { schema: { $ref: "#/components/schemas/PersonalSignalList" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
          },
        },
      },
      "/api/me/radar/signals/{id}": {
        get: {
          operationId: "getMyRadarSignal",
          summary: "读取本人的一条个人信号；不是 UUID、不存在、属于别人一律 404 SIGNAL_NOT_FOUND",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "个人信号", content: { "application/json": { schema: { $ref: "#/components/schemas/PersonalSignal" } } } },
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/me/radar/signals/{id}/state": {
        patch: {
          operationId: "setMyRadarSignalState",
          summary: "独立设置本人个人信号的 read、saved、dismissed；状态没变不写",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/SignalStateRequest" }),
          responses: {
            "200": { description: "更新后的个人信号", content: { "application/json": { schema: { $ref: "#/components/schemas/PersonalSignal" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/me/radar/scan": {
        post: {
          operationId: "scanMyRadar",
          summary: "排队扫描一次本人雷达；没开 409 RADAR_DISABLED，正在扫 409 RADAR_SCAN_IN_PROGRESS，今天已收满 409 RADAR_DAILY_CAP_REACHED，10 分钟冷却 429 带 retry-after",
          responses: {
            "202": { description: "已排队", content: { "application/json": { schema: { $ref: "#/components/schemas/MyRadarScanAccepted" } } } },
            "401": errorResponse,
            "403": errorResponse,
            "409": errorResponse,
            "429": errorResponse,
          },
        },
      },
      "/api/config/radar": {
        get: {
          operationId: "getCompanyRadarSettings",
          summary: "公司雷达的手工方向与媒体来源（CEO）；自动方向只读",
          responses: {
            "200": { description: "公司雷达设置", content: { "application/json": { schema: { $ref: "#/components/schemas/CompanyRadarSettings" } } } },
            "401": errorResponse,
            "403": errorResponse,
          },
        },
        put: {
          operationId: "putCompanyRadarSettings",
          summary: "替换公司雷达的手工方向与媒体来源（CEO）；其余方向、网站与公众号不动，不触发公司扫描",
          requestBody: jsonBody({ $ref: "#/components/schemas/PutCompanyRadarRequest" }),
          responses: {
            "200": { description: "保存后的公司雷达设置", content: { "application/json": { schema: { $ref: "#/components/schemas/CompanyRadarSettings" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
          },
        },
      },
      "/api/me/tasks": {
        post: {
          operationId: "createMyTask",
          summary: "点「+」新建执行事项：推进人是本人，missionId 为 null 是独立事项；按 (本人, clientId) 幂等",
          requestBody: jsonBody({ $ref: "#/components/schemas/CreateMyTaskRequest" }),
          responses: {
            "200": { description: "新建的执行事项", content: { "application/json": { schema: { $ref: "#/components/schemas/TaskView" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/materials/{objectType}/{objectId}": {
        get: {
          operationId: "listMaterials",
          summary: "对象的材料（工单 09）；群成员能读（议题未建群时为 CEO），其他人 404",
          parameters: [
            { name: "objectType", in: "path", required: true, schema: { type: "string", enum: ["issue", "task", "meeting"] } },
            { name: "objectId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "材料列表", content: { "application/json": { schema: { $ref: "#/components/schemas/MaterialListResponse" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
        post: {
          operationId: "uploadMaterial",
          summary: "上传一份材料（PDF、Word、Markdown、HTML，单个 20 MB，每个对象最多 30 份）",
          parameters: [
            { name: "objectType", in: "path", required: true, schema: { type: "string", enum: ["issue", "task", "meeting"] } },
            { name: "objectId", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" } } },
              },
            },
          },
          responses: {
            "201": { description: "新材料", content: { "application/json": { schema: { $ref: "#/components/schemas/MaterialView" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
            "413": errorResponse,
          },
        },
      },
      "/api/materials/{objectType}/{objectId}/links": {
        post: {
          operationId: "addMaterialLink",
          summary: "执行事项里贴一条外部链接（只收 http/https，不抓外部页面）；会议、议题 400；计入 30 份上限",
          parameters: [
            { name: "objectType", in: "path", required: true, schema: { type: "string", enum: ["issue", "task", "meeting"] } },
            { name: "objectId", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: jsonBody({ $ref: "#/components/schemas/AddMaterialLinkRequest" }),
          responses: {
            "201": { description: "新链接材料", content: { "application/json": { schema: { $ref: "#/components/schemas/MaterialView" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/materials/{objectType}/{objectId}/{materialId}": {
        get: {
          operationId: "getMaterial",
          summary: "一份材料的某一版（默认最新）和它相对上一版的标注、改动记录",
          parameters: [
            { name: "objectType", in: "path", required: true, schema: { type: "string", enum: ["issue", "task", "meeting"] } },
            { name: "objectId", in: "path", required: true, schema: { type: "string" } },
            { name: "materialId", in: "path", required: true, schema: { type: "string" } },
            { name: "version", in: "query", required: false, schema: { type: "integer", minimum: 1 } },
          ],
          responses: {
            "200": { description: "材料详情", content: { "application/json": { schema: { $ref: "#/components/schemas/MaterialDetailResponse" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
        delete: {
          operationId: "deleteMaterial",
          summary: "主人删自己的材料（软删）；不是主人 403",
          parameters: [
            { name: "objectType", in: "path", required: true, schema: { type: "string", enum: ["issue", "task", "meeting"] } },
            { name: "objectId", in: "path", required: true, schema: { type: "string" } },
            { name: "materialId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "204": { description: "已删" },
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/materials/{objectType}/{objectId}/{materialId}/annotations": {
        post: {
          operationId: "createMaterialAnnotation",
          summary: "选中材料里的一段文字写批注；默认只保存（noted），intent=edit「立即修改」只给上传者和对象负责人、只限 Markdown / HTML，排队让 Co-Agent 按批注改（同一份材料按顺序一条条改），其他人 403；按 clientId 幂等",
          parameters: [
            { name: "objectType", in: "path", required: true, schema: { type: "string", enum: ["issue", "task", "meeting"] } },
            { name: "objectId", in: "path", required: true, schema: { type: "string" } },
            { name: "materialId", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: jsonBody({ $ref: "#/components/schemas/CreateMaterialAnnotationRequest" }),
          responses: { "200": { description: "批注", content: { "application/json": { schema: { $ref: "#/components/schemas/CreateMaterialAnnotationResponse" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "404": errorResponse },
        },
      },
      "/api/materials/{objectType}/{objectId}/{materialId}/annotations/{annotationId}/decide": {
        post: {
          operationId: "decideMaterialAnnotation",
          summary: "上传者或对象负责人处理一条保存着的批注：采用（进原队列让 Co-Agent 按批注改，记下采用人）或不采用（原因可不填）；PDF / Word 400，其他人 403，已处理 409",
          parameters: [
            { name: "objectType", in: "path", required: true, schema: { type: "string", enum: ["issue", "task", "meeting"] } },
            { name: "objectId", in: "path", required: true, schema: { type: "string" } },
            { name: "materialId", in: "path", required: true, schema: { type: "string" } },
            { name: "annotationId", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: jsonBody({ $ref: "#/components/schemas/DecideMaterialAnnotationRequest" }),
          responses: { "200": { description: "处理后的批注", content: { "application/json": { schema: { $ref: "#/components/schemas/CreateMaterialAnnotationResponse" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/materials/{objectType}/{objectId}/{materialId}/restore": {
        post: {
          operationId: "restoreMaterialRemoved",
          summary: "把垃圾篓里的一段插回原位，存成新的一版；只有上传者和对象负责人，其他人 403；version 不是最新 409",
          parameters: [
            { name: "objectType", in: "path", required: true, schema: { type: "string", enum: ["issue", "task", "meeting"] } },
            { name: "objectId", in: "path", required: true, schema: { type: "string" } },
            { name: "materialId", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: jsonBody({ $ref: "#/components/schemas/RestoreMaterialRemovedRequest" }),
          responses: { "200": { description: "恢复后的最新详情", content: { "application/json": { schema: { $ref: "#/components/schemas/MaterialDetailResponse" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/materials/{objectType}/{objectId}/{materialId}/proposals/{proposalId}": {
        post: {
          operationId: "decideMaterialEditProposal",
          summary: "对 Co-Agent 的修改提议点「按这个改」或「忽略」；提议对象本人处理，不能改的人提的建议上传者和对象负责人都能处理；材料已被改过则 409（提议变 stale）",
          parameters: [
            { name: "objectType", in: "path", required: true, schema: { type: "string", enum: ["issue", "task", "meeting"] } },
            { name: "objectId", in: "path", required: true, schema: { type: "string" } },
            { name: "materialId", in: "path", required: true, schema: { type: "string" } },
            { name: "proposalId", in: "path", required: true, schema: { type: "string" } },
          ],
          requestBody: jsonBody({ $ref: "#/components/schemas/DecideMaterialEditProposalRequest" }),
          responses: { "200": { description: "处理后的最新详情", content: { "application/json": { schema: { $ref: "#/components/schemas/MaterialDetailResponse" } } } }, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/materials/{objectType}/{objectId}/{materialId}/file": {
        get: {
          operationId: "downloadMaterial",
          summary: "下载（attachment）：原件；Agent 写的材料下载当前版 .md；HTML 材料下载当前版 .html",
          parameters: [
            { name: "objectType", in: "path", required: true, schema: { type: "string", enum: ["issue", "task", "meeting"] } },
            { name: "objectId", in: "path", required: true, schema: { type: "string" } },
            { name: "materialId", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "文件字节", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/materials/{objectType}/{objectId}/{materialId}/preview": {
        get: {
          operationId: "previewMaterial",
          summary: "PDF inline、Word 清理后的 HTML、HTML 材料指定版本的源码（带沙箱 CSP，不持久化）",
          parameters: [
            { name: "objectType", in: "path", required: true, schema: { type: "string", enum: ["issue", "task", "meeting"] } },
            { name: "objectId", in: "path", required: true, schema: { type: "string" } },
            { name: "materialId", in: "path", required: true, schema: { type: "string" } },
            { name: "version", in: "query", required: false, schema: { type: "integer", minimum: 1 }, description: "只对 HTML 材料有效；缺省为当前版本" },
          ],
          responses: {
            "200": {
              description: "预览体",
              content: {
                "application/pdf": { schema: { type: "string", format: "binary" } },
                "text/html": { schema: { type: "string" } },
              },
            },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/mcp-oauth/requests/{id}": {
        get: {
          operationId: "readOAuthConsent", summary: "读取本人浏览器中的 MCP 授权请求",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "200": { description: "授权信息", content: { "application/json": { schema: { $ref: "#/components/schemas/OAuthConsentResponse" } } } }, "400": errorResponse, "401": errorResponse },
        },
        post: {
          operationId: "decideOAuthConsent", summary: "允许或拒绝 MCP 连接授权",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/OAuthConsentRequest" }),
          responses: { "200": { description: "返回工具的回调地址", content: { "application/json": { schema: { $ref: "#/components/schemas/OAuthConsentDecisionResponse" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "409": errorResponse },
        },
      },
      "/api/me/profile": {
        get: {
          operationId: "getPersonalProfile", summary: "读取本人的可选个人资料",
          responses: { "200": { description: "本人资料", content: { "application/json": { schema: { $ref: "#/components/schemas/PersonalProfileView" } } } }, "401": errorResponse },
        },
        patch: {
          operationId: "updatePersonalProfile", summary: "本人填写或清空可选性别字段",
          requestBody: jsonBody({ $ref: "#/components/schemas/UpdatePersonalProfileRequest" }),
          responses: { "200": { description: "保存后的本人资料", content: { "application/json": { schema: { $ref: "#/components/schemas/PersonalProfileView" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse },
        },
      },
      "/api/me/buddy": {
        get: {
          operationId: "getBuddy", summary: "读取本人的伙伴；还没选过时是 null",
          responses: { "200": { description: "本人的伙伴", content: { "application/json": { schema: { anyOf: [{ $ref: "#/components/schemas/Buddy" }, { type: "null" }] } } } }, "401": errorResponse },
        },
        put: {
          operationId: "saveBuddy", summary: "本人给伙伴起名字、选外形和性格",
          requestBody: jsonBody({ $ref: "#/components/schemas/Buddy" }),
          responses: { "200": { description: "保存后的伙伴", content: { "application/json": { schema: { $ref: "#/components/schemas/Buddy" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse },
        },
      },
      "/api/me/rail-background": {
        get: {
          operationId: "getRailBackground", summary: "读取本人给左边通知栏选的背景；没选过是雾蓝（mist）",
          responses: { "200": { description: "本人的通知栏背景", content: { "application/json": { schema: { $ref: "#/components/schemas/RailBackground" } } } }, "401": errorResponse },
        },
        put: {
          operationId: "saveRailBackground", summary: "本人换通知栏背景：选一张预设，或上传自己的图",
          requestBody: jsonBody({ $ref: "#/components/schemas/SaveRailBackgroundRequest" }),
          responses: { "200": { description: "保存后的通知栏背景", content: { "application/json": { schema: { $ref: "#/components/schemas/RailBackground" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "413": errorResponse },
        },
      },
      "/api/me/rail-background/image": {
        get: {
          operationId: "getRailBackgroundImage", summary: "本人上传的那张通知栏背景图（地址带 ?v=imageVersion，可长期缓存）",
          parameters: [{ name: "v", in: "query", required: false, schema: { type: "string" } }],
          responses: { "200": { description: "图片", content: { "image/jpeg": { schema: { type: "string", format: "binary" } }, "image/png": { schema: { type: "string", format: "binary" } }, "image/webp": { schema: { type: "string", format: "binary" } } } }, "401": errorResponse, "404": errorResponse },
        },
      },
      "/api/me/avatar": {
        put: {
          operationId: "saveMyAvatar", summary: "本人换头像：网页裁好的 256×256 图",
          requestBody: jsonBody({ $ref: "#/components/schemas/SaveAvatarRequest" }),
          responses: { "200": { description: "保存后的头像版本", content: { "application/json": { schema: { $ref: "#/components/schemas/SavedAvatar" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "413": errorResponse },
        },
        delete: {
          operationId: "deleteMyAvatar", summary: "本人删掉头像照片，回到单字",
          responses: { "204": { description: "已删掉" }, "401": errorResponse, "403": errorResponse },
        },
      },
      "/api/people/avatars": {
        get: {
          operationId: "listPersonAvatars", summary: "传过头像照片的人：personId → 头像版本；不在里面的人显示单字",
          responses: { "200": { description: "头像版本", content: { "application/json": { schema: { $ref: "#/components/schemas/PersonAvatarsResponse" } } } }, "401": errorResponse },
        },
      },
      "/api/people/{personId}/avatar": {
        get: {
          operationId: "getPersonAvatar", summary: "某个人的头像照片（地址带 ?v=version，可长期缓存）",
          parameters: [{ name: "personId", in: "path", required: true, schema: { type: "string" } }, { name: "v", in: "query", required: false, schema: { type: "string" } }],
          responses: { "200": { description: "图片", content: { "image/jpeg": { schema: { type: "string", format: "binary" } }, "image/png": { schema: { type: "string", format: "binary" } }, "image/webp": { schema: { type: "string", format: "binary" } } } }, "401": errorResponse, "404": errorResponse },
        },
      },
      "/api/me/tokens": {
        get: {
          operationId: "listPersonalTokens", summary: "列出本人未撤销的个人 MCP 令牌",
          responses: { "200": { description: "令牌列表", content: { "application/json": { schema: { $ref: "#/components/schemas/ListPersonalTokensResponse" } } } }, "401": errorResponse },
        },
        post: {
          operationId: "createPersonalToken", summary: "创建个人 MCP 令牌，明文只返回一次",
          requestBody: jsonBody({ $ref: "#/components/schemas/CreatePersonalTokenRequest" }),
          responses: { "200": { description: "新令牌", content: { "application/json": { schema: { $ref: "#/components/schemas/CreatePersonalTokenResponse" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "409": errorResponse },
        },
      },
      "/api/collector/heartbeat": {
        post: {
          operationId: "collectorHeartbeat", summary: "本机采集器已下线：旧版采集器的心跳一律 410，不鉴权、不记录",
          responses: { "410": errorResponse },
        },
      },
      "/api/collector/reports": {
        post: {
          operationId: "collectorReport", summary: "本机采集器已下线：旧版采集器的上报一律 410，不鉴权、不记录",
          responses: { "410": errorResponse },
        },
      },
      "/api/admin/overview": {
        get: {
          operationId: "getAdminOverview", summary: "管理员视图：顶部计数、人 × 来源、失败列表、质量信号；只有运行数据。非管理员 404",
          responses: { "200": { description: "管理员视图", content: { "application/json": { schema: { $ref: "#/components/schemas/AdminOverviewResponse" } } } }, "404": errorResponse },
        },
      },
      "/api/admin/actions": {
        post: {
          operationId: "executeAdminAction", summary: "管理员操作：给本人发提醒（走送达通道）、标记已接手 / 已解决、重试 dead 的后台任务；都记进 admin_incidents，按 clientId 幂等。非管理员 404",
          requestBody: jsonBody({ $ref: "#/components/schemas/AdminActionRequest" }),
          responses: { "200": { description: "操作后的管理员视图", content: { "application/json": { schema: { $ref: "#/components/schemas/AdminOverviewResponse" } } } }, "400": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/admin/usage": {
        get: {
          operationId: "getAdminUsage", summary: "使用周报：谁在用、频率、关键路径漏斗和中断点、本周问题台账、和上周对比；week 不传为本周（现算）。非管理员 404",
          parameters: [{ name: "week", in: "query", required: false, schema: { type: "string", format: "date" }, description: "周一（北京时间），如 2026-10-19" }],
          responses: { "200": { description: "可选的各周与所选那一周的周报", content: { "application/json": { schema: { $ref: "#/components/schemas/UsageResponse" } } } }, "400": errorResponse, "404": errorResponse },
        },
      },
      "/api/admin/usage/markdown": {
        get: {
          operationId: "getAdminUsageMarkdown", summary: "使用周报导出 Markdown（贴到飞书）；week 不传为本周（现算）。非管理员 404",
          parameters: [{ name: "week", in: "query", required: false, schema: { type: "string", format: "date" }, description: "周一（北京时间），如 2026-10-19" }],
          responses: { "200": { description: "Markdown 周报", content: { "text/markdown": { schema: { type: "string" } } } }, "400": errorResponse, "404": errorResponse },
        },
      },
      "/api/me/usage/onboarding-step": {
        post: {
          operationId: "recordOnboardingStep", summary: "上手流程打开了哪一步（使用周报的上手漏斗）；一人一步一天只记一次",
          requestBody: jsonBody({ $ref: "#/components/schemas/OnboardingStepUsageRequest" }),
          responses: { "204": { description: "已记下" }, "400": errorResponse, "401": errorResponse },
        },
      },
      "/api/me/collector/status": {
        get: {
          operationId: "getCollectorStatus", summary: "本人的采集器：连上的设备、最近一次完整盘点、盘点到的条数（上手流程轮询）",
          responses: { "200": { description: "采集器状态", content: { "application/json": { schema: { $ref: "#/components/schemas/CollectorStatusResponse" } } } }, "401": errorResponse },
        },
      },
      "/api/me/work-basis": {
        get: {
          operationId: "getWorkBasis", summary: "工作依据清单：本人在依据的整份文档候选（天枢材料、飞书文档、链接）与已确认的",
          responses: { "200": { description: "候选", content: { "application/json": { schema: { $ref: "#/components/schemas/WorkBasisResponse" } } } }, "401": errorResponse },
        },
        put: {
          operationId: "updateWorkBasis", summary: "本人确认工作依据：勾选的入库并记下当时的修订号，候选里没勾的移出",
          requestBody: jsonBody({ $ref: "#/components/schemas/UpdateWorkBasisRequest" }),
          responses: { "200": { description: "候选", content: { "application/json": { schema: { $ref: "#/components/schemas/WorkBasisResponse" } } } }, "400": errorResponse, "401": errorResponse },
        },
      },
      "/api/me/schedule-migration": {
        get: {
          operationId: "getScheduleMigration", summary: "搬家清单：本机清单里找到的定时任务，以及哪些已经搬进定时任务区",
          responses: { "200": { description: "候选", content: { "application/json": { schema: { $ref: "#/components/schemas/ScheduleMigrationResponse" } } } }, "401": errorResponse },
        },
        put: {
          operationId: "updateScheduleMigration", summary: "本人确认搬家：勾选的写进定时任务区，候选里没勾的移出",
          requestBody: jsonBody({ $ref: "#/components/schemas/UpdateScheduleMigrationRequest" }),
          responses: { "200": { description: "候选", content: { "application/json": { schema: { $ref: "#/components/schemas/ScheduleMigrationResponse" } } } }, "400": errorResponse, "401": errorResponse },
        },
      },
      "/api/weekly-reviews/board": {
        get: {
          operationId: "getWeeklyReviewBoard", summary: "周复盘名单：看得到的人（本人、同战场、CEO 看全部）这一周的状态；不带 week 取本周",
          parameters: [{ name: "week", in: "query", required: false, schema: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } }],
          responses: { "200": { description: "周复盘名单", content: { "application/json": { schema: { $ref: "#/components/schemas/WeeklyReviewBoardResponse" } } } }, "400": errorResponse, "401": errorResponse },
        },
      },
      "/api/weekly-reviews/{weeklyReviewId}": {
        get: {
          operationId: "getWeeklyReview", summary: "读一份周复盘：本人、同战场的人、CEO；别人提交前看不到正文；其余 404",
          parameters: [{ name: "weeklyReviewId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "周复盘", content: { "application/json": { schema: { $ref: "#/components/schemas/WeeklyReviewResponse" } } } }, "401": errorResponse, "404": errorResponse },
        },
      },
      "/api/weekly-reviews/actions/execute": {
        post: {
          operationId: "executeWeeklyReviewAction", summary: "执行周复盘动作（修改、提交、重新生成）；幂等重放返回当前视图，版本冲突 409 VERSION_CONFLICT",
          requestBody: jsonBody({ $ref: "#/components/schemas/ExecuteWeeklyReviewActionRequest" }),
          responses: { "200": { description: "周复盘的最新视图", content: { "application/json": { schema: { $ref: "#/components/schemas/ExecuteWeeklyReviewActionResponse" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse, "503": errorResponse },
        },
      },
      "/api/progress": {
        get: {
          operationId: "getProgressOverview", summary: "全局进展：红线（比预期慢、按截止日做不完）、按计划在走、没有 Task 基线的人的进展摘要；CEO 看全部，其他人看同一战场的人",
          responses: { "200": { description: "全局进展", content: { "application/json": { schema: { $ref: "#/components/schemas/ProgressOverviewResponse" } } } }, "401": errorResponse },
        },
      },
      "/api/progress/battlefield-summaries": {
        get: {
          operationId: "getBattlefieldSummaries", summary: "战场进展汇总：每个战场每天一份 Agent 汇总（对照本期目标、各 Mission 推进、卡点）；今天这份还没有时当场开始整理；CEO 看全部战场，其他人看自己所在的战场",
          responses: { "200": { description: "战场进展汇总", content: { "application/json": { schema: { $ref: "#/components/schemas/BattlefieldSummariesResponse" } } } }, "401": errorResponse },
        },
      },
      "/api/me/tokens/{id}": {
        delete: {
          operationId: "revokePersonalToken", summary: "撤销本人令牌",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          responses: { "204": { description: "已撤销" }, "401": errorResponse, "404": errorResponse },
        },
      },
      "/api/me/tasks/{id}/progress": {
        post: {
          operationId: "appendTaskProgress", summary: "推进人或在职协作者手写进展，按 clientEventId 幂等",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/AppendTaskProgressRequest" }),
          responses: { "200": { description: "进展记录", content: { "application/json": { schema: { $ref: "#/components/schemas/TaskProgressEntry" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse },
        },
      },
      "/api/mission-cards/{cardId}/items": {
        get: {
          operationId: "getMissionCardItems", summary: "卡主人、当轮拍板人及 CEO 读取任务卡各任务下的执行事项摘要",
          parameters: [{ name: "cardId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "个人任务下的执行事项", content: { "application/json": { schema: { $ref: "#/components/schemas/MissionCardItemsResponse" } } } }, "401": errorResponse, "404": errorResponse },
        },
      },
      "/api/me/plan": {
        get: {
          operationId: "getMyMonthPlan",
          summary: "整月一张计划图：本人任务卡上的每项个人任务一组、最后一组独立事项；period 默认公司当前月",
          parameters: [{ name: "period", in: "query", required: false, schema: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$" } }],
          responses: {
            "200": { description: "本月计划", content: { "application/json": { schema: { $ref: "#/components/schemas/MonthPlanResponse" } } } },
            "400": errorResponse,
            "401": errorResponse,
          },
        },
        put: {
          operationId: "saveMyMonthPlan",
          summary: "保存计划：只传改过的组和字段，日期可不定；组内顺序即先后，没列出的已有事项保留在后面；列出的事项已不在该组时 409 PLAN_STALE",
          requestBody: jsonBody({ $ref: "#/components/schemas/SaveMonthPlanRequest" }),
          responses: {
            "200": { description: "保存后的本月计划", content: { "application/json": { schema: { $ref: "#/components/schemas/MonthPlanResponse" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/me/tasks/{id}/note": {
        put: {
          operationId: "putMyTaskNote",
          summary: "非推进的成员写自己的私人批注；null 删除；推进人写判断而不是批注",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/PutMyTaskNoteRequest" }),
          responses: {
            "200": { description: "我的批注", content: { "application/json": { schema: { $ref: "#/components/schemas/PutMyTaskNoteResponse" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/me/tasks/{id}/collaborators": {
        post: {
          operationId: "addTaskCollaborators",
          summary: "推进人邀请协作者：写成员与事项群组、给每人发通知；已是成员的忽略；不转移推进责任",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/AddTaskCollaboratorsRequest" }),
          responses: {
            "200": { description: "更新后的执行事项", content: { "application/json": { schema: { $ref: "#/components/schemas/TaskView" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
          },
        },
      },
      "/api/me/tasks/{id}": {
        get: {
          operationId: "getMyTask",
          summary: "执行事项详情：推进人和在职协作者可读，其他人 404；选项只给推进人",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "执行事项详情", content: { "application/json": { schema: { $ref: "#/components/schemas/TaskDetailResponse" } } } },
            "401": errorResponse,
            "404": errorResponse,
          },
        },
        delete: {
          operationId: "deleteMyTask",
          summary: "推进人删除未启动的自建或计划事项，连同事项群组；会后分派的不能删，只能退回",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, { name: "version", in: "query", required: true, schema: { type: "integer", minimum: 1 } }],
          responses: {
            "204": { description: "已删除" },
            "401": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
        patch: {
          operationId: "patchMyTask",
          summary: "推进人改标题、日期、完成标准、判断或所属个人任务（状态只能改未启动/进行中，完成走验收）；不是推进人 404 TASK_NOT_FOUND，version 不一致 409 带 latestTask",
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
      "/api/me/tasks/{id}/accept": {
        post: {
          operationId: "acceptMyTask",
          summary: "推进人验收：逐条对完成标准，每条都确认达到才完成（有没达到的走退回，没写完成标准的先写）；选交付结果、写一句结论；状态变完成，清掉待验收的提交",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/AcceptMyTaskRequest" }),
          responses: {
            "200": { description: "已完成的执行事项", content: { "application/json": { schema: { $ref: "#/components/schemas/TaskView" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/me/tasks/{id}/acceptance-draft": {
        post: {
          operationId: "draftMyTaskAcceptance",
          summary: "推进人打开验收时，请我的 Agent 对照完成标准、材料和进展起草（只读，最多 30 秒）；起草不出来 503，手填照样能验收",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "验收草稿", content: { "application/json": { schema: { $ref: "#/components/schemas/TaskAcceptanceDraft" } } } },
            "401": errorResponse,
            "403": errorResponse,
            "404": errorResponse,
            "409": errorResponse,
            "503": errorResponse,
          },
        },
      },
      "/api/me/tasks/{id}/acceptance-return": {
        post: {
          operationId: "returnMyTaskAcceptance",
          summary: "推进人逐条对完成标准时有没达到的：写明哪几条没达到、为什么，退回接着做；清掉外部工具的提交，状态不变",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/ReturnTaskAcceptanceRequest" }),
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
      "/api/me/tasks/{id}/reopen": {
        post: {
          operationId: "reopenMyTask",
          summary: "推进人重新打开已完成的事项：状态回进行中，清掉验收记录",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/ReopenMyTaskRequest" }),
          responses: {
            "200": { description: "重新打开的执行事项", content: { "application/json": { schema: { $ref: "#/components/schemas/TaskView" } } } },
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
      "/api/me/tasks/{id}/standalone": {
        post: {
          operationId: "standaloneMyTask",
          summary: "待归位的事项本人确认不属于任何 Mission（写一句为什么），之后按本人的独立事项算",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/StandaloneMyTaskRequest" }),
          responses: {
            "200": { description: "确认后的执行事项", content: { "application/json": { schema: { $ref: "#/components/schemas/TaskView" } } } },
            "400": errorResponse,
            "401": errorResponse,
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
      "/api/me/dictation": {
        post: {
          operationId: "dictate",
          summary: "输入框语音转文字（multipart：audio 单段浏览器录音）：火山录音文件极速版一次返回文字，录音不落库；CEO 与成员都可用",
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: { type: "object", required: ["audio"], properties: { audio: { type: "string", format: "binary" } } },
              },
            },
          },
          responses: {
            "200": { description: "转好的文字（没听到人声时为空串）", content: { "application/json": { schema: { $ref: "#/components/schemas/DictationResult" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
            "413": errorResponse,
            "502": errorResponse,
            "503": errorResponse,
          },
        },
      },
      "/api/me/dictation/session": {
        post: {
          operationId: "createDictationSession",
          summary: "实时听写签发：返回签好的一次性腾讯实时识别 wss 地址（30 秒内握手有效，SecretKey 不下发）；每人每分钟最多 6 次；响应 no-store；缺配置 503 DICTATION_REALTIME_NOT_CONFIGURED（前端退回录完再转）",
          responses: {
            "200": { description: "签好的地址与采音参数", content: { "application/json": { schema: { $ref: "#/components/schemas/DictationSessionResponse" } } } },
            "401": errorResponse,
            "403": errorResponse,
            "429": errorResponse,
            "503": errorResponse,
          },
        },
      },
      "/api/me/dictation/polish": {
        post: {
          operationId: "polishDictation",
          summary: "听写后的轻度整理（去口头填充词和残句、处理改口、修明显的同音错字、理顺语序、补标点；已经干净的句子不送模型）。mode=sentence（缺省）逐句、不分点，超时默认 1.2 秒；mode=full 整段、列举时按「1. 」分行，超时按字数放宽（封顶 4 秒）。未配置、失败、超时或没通过防护时回原文 polished:false，仍是 200；原文超过 2000 字 413",
          requestBody: jsonBody({ $ref: "#/components/schemas/DictationPolishRequest" }),
          responses: {
            "200": { description: "整理后的文字（或原文）", content: { "application/json": { schema: { $ref: "#/components/schemas/DictationPolishResponse" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "403": errorResponse,
            "413": errorResponse,
          },
        },
      },
      "/api/me/memory/personal": {
        get: {
          operationId: "listPersonalMemory", summary: "列出本人的个人记忆（只有本人可见）；status 缺省 active，all 含已替代与已忘掉的；q 按标题、正文、原话搜索；anchor 带上对象现在的标题",
          parameters: [
            { name: "status", in: "query", required: false, schema: { type: "string", enum: ["active", "superseded", "forgotten", "all"] } },
            { name: "q", in: "query", required: false, schema: { type: "string", maxLength: 200 } },
          ],
          responses: { "200": { description: "本人个人记忆", content: { "application/json": { schema: { $ref: "#/components/schemas/PersonalMemoryList" } } } }, "400": errorResponse, "401": errorResponse, "503": errorResponse },
        },
      },
      "/api/me/memory/partner": {
        get: {
          operationId: "listPartnerMemory", summary: "首页伙伴（独立 Chat 服务）记住的本人的事，只读；没接 Chat 时 available=false。Chat 连不上或拒绝时按天枢的错误格式回（如 503 CHAT_UNAVAILABLE）",
          responses: { "200": { description: "伙伴记住的（现行的，最近更新的在前）", content: { "application/json": { schema: { $ref: "#/components/schemas/PartnerMemoryList" } } } }, "401": errorResponse, "500": errorResponse, "502": errorResponse, "503": errorResponse },
        },
      },
      "/api/me/memory/personal/items/{id}": {
        patch: {
          operationId: "updatePersonalMemoryItem", summary: "本人改一条个人记忆的标题或正文；已替代或已忘掉的 409",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/UpdatePersonalMemoryItemRequest" }),
          responses: { "200": { description: "改后的条目", content: { "application/json": { schema: { $ref: "#/components/schemas/PersonalMemoryItem" } } } }, "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse, "503": errorResponse },
        },
        delete: {
          operationId: "forgetPersonalMemoryItem", summary: "本人忘掉一条个人记忆：不再装进对话，后台提炼也不再学回来，之后能恢复；purge=1 彻底删除（204，不能恢复，被它替代的旧条目改成已忘掉）",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "purge", in: "query", required: false, schema: { type: "string", enum: ["1"] } },
          ],
          responses: { "200": { description: "忘掉后的条目", content: { "application/json": { schema: { $ref: "#/components/schemas/PersonalMemoryItem" } } } }, "204": { description: "已彻底删除" }, "400": errorResponse, "401": errorResponse, "404": errorResponse, "409": errorResponse, "503": errorResponse },
        },
      },
      "/api/me/memory/personal/items/{id}/restore": {
        post: {
          operationId: "restorePersonalMemoryItem", summary: "本人恢复一条忘掉的个人记忆，重新装进对话；不是已忘掉的 409",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "恢复后的条目", content: { "application/json": { schema: { $ref: "#/components/schemas/PersonalMemoryItem" } } } }, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse, "503": errorResponse },
        },
      },
      "/api/me/memory/imports": {
        post: {
          operationId: "createMemoryImport",
          summary: "导入别的 AI 工具的记忆：登录态（粘贴、上传 Claude 导出包，zip 用 base64）或 collector 个人令牌（本机 Claude Code、Codex 记忆文件，须已同意采集）。当场读取、拆分，后台分类、去重找冲突，停在等你确认",
          requestBody: jsonBody({ $ref: "#/components/schemas/CreateMemoryImportRequest" }),
          responses: {
            "202": { description: "已收下，五步的当前状态", content: { "application/json": { schema: { $ref: "#/components/schemas/MemoryImport" } } } },
            "400": errorResponse, "401": errorResponse, "403": errorResponse, "413": errorResponse, "503": errorResponse,
          },
        },
        get: {
          operationId: "listMemoryImports", summary: "本人最近 20 次记忆导入（不含候选）",
          responses: { "200": { description: "导入记录", content: { "application/json": { schema: { $ref: "#/components/schemas/MemoryImportList" } } } }, "401": errorResponse, "503": errorResponse },
        },
      },
      "/api/me/memory/imports/{id}": {
        get: {
          operationId: "getMemoryImport", summary: "一次导入的步骤、计数和全部候选（确认页只列 conflict、uncertain 两组）",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "导入详情", content: { "application/json": { schema: { $ref: "#/components/schemas/MemoryImportDetail" } } } }, "401": errorResponse, "404": errorResponse, "503": errorResponse },
        },
        delete: {
          operationId: "discardMemoryImport", summary: "确认前丢弃本次导入，候选一起删掉；已确认的 409",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "204": { description: "已丢弃" }, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse, "503": errorResponse },
        },
      },
      "/api/me/memory/imports/{id}/confirm": {
        post: {
          operationId: "confirmMemoryImport", summary: "本人确认：checked 里的条目写进个人记忆；冲突按 resolutions（缺省保留旧的）。还没整理完或已确认过的 409",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: jsonBody({ $ref: "#/components/schemas/ConfirmMemoryImportRequest" }),
          responses: { "200": { description: "确认后的导入", content: { "application/json": { schema: { $ref: "#/components/schemas/MemoryImport" } } } }, "400": errorResponse, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse, "503": errorResponse },
        },
      },
      "/api/me/memory/imports/{id}/retry": {
        post: {
          operationId: "retryMemoryImport", summary: "停住的导入从停住那一步接着做；没停住的 409",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "重新开始后的导入", content: { "application/json": { schema: { $ref: "#/components/schemas/MemoryImport" } } } }, "401": errorResponse, "403": errorResponse, "404": errorResponse, "409": errorResponse, "503": errorResponse },
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
      "/api/ontology/weekly-progress": {
        get: {
          operationId: "getOntologyWeeklyProgress",
          summary: "本体来拉某一 ISO 周（北京时间周一 00:00 起）成员写进执行事项的进展；Bearer ONTOLOGY_SERVICE_TOKEN，未配置时 503",
          parameters: [
            { name: "week", in: "query", required: false, schema: { type: "string", pattern: "^\\d{4}-W(0[1-9]|[1-4]\\d|5[0-3])$" }, description: "如 2026-W40；缺省为本周" },
          ],
          responses: {
            "200": { description: "按人、事项分组的本周进展", content: { "application/json": { schema: { $ref: "#/components/schemas/WeeklyProgressResponse" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "503": errorResponse,
          },
        },
      },
      "/api/ontology/objects/{id}": {
        get: {
          operationId: "getWorldSource",
          summary: "出处卡：按本人在 COMPANY_WORLD_ACCESS_FILE 里被授权的域读一个本体对象当前这一版（类型、标题、版本、状态、负责人、当前进展）；只读",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", minLength: 1, maxLength: 128 }, description: "本体对象 id（不带 @版本）" }],
          responses: {
            "200": { description: "本体对象当前这一版", content: { "application/json": { schema: { $ref: "#/components/schemas/WorldSourceView" } } } },
            "401": errorResponse,
            "404": errorResponse,
            "503": errorResponse,
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
        get: {
          operationId: "getMeetingTranscriptPage",
          summary: "逐字稿按发言段分页读；只给 CEO 和实际参会的人，其他人和不存在的会一样 404 NOT_FOUND",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "from", in: "query", required: false, schema: { type: "string" }, description: "从这一段起（上一页的 nextTurn）" },
            { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 500, default: 200 } },
          ],
          responses: {
            "200": { description: "一页发言段", content: { "application/json": { schema: { $ref: "#/components/schemas/MeetingTranscriptPage" } } } },
            "400": errorResponse,
            "401": errorResponse,
            "404": errorResponse,
          },
        },
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
      ...boardPaths,
      ...workHomePaths,
    },
    components: {
      schemas: {
        ...taskQualitySchemas,
        Card: Card as JsonSchema,
        CardCollection: CardCollection as JsonSchema,
        ActionDescriptor: ActionDescriptor as JsonSchema,
        ApiError: ApiError as JsonSchema,
        LoginRequest: LoginRequest as JsonSchema,
        LoginResponse: LoginResponse as JsonSchema,
        DemoEntryResponse: DemoEntryResponse as JsonSchema,
        FeishuAuthConfigResponse: FeishuAuthConfigResponse as JsonSchema,
        FeishuCodeLoginRequest: FeishuCodeLoginRequest as JsonSchema,
        FeishuConnectionResponse: FeishuConnectionResponse as JsonSchema,
        WechatConnection: WechatConnection as JsonSchema,
        ChangePasscodeRequest: ChangePasscodeRequest as JsonSchema,
        SessionResponse: SessionResponse as JsonSchema,
        PeopleDirectoryResponse: PeopleDirectoryResponse as JsonSchema,
        PersonDirectoryResponse: PersonDirectoryResponse as JsonSchema,
        ExecuteActionRequest: ExecuteActionRequest as JsonSchema,
        ConversationHistory: ConversationHistory as JsonSchema,
        ConversationMessageRequest: ConversationMessageRequest as JsonSchema,
        ConversationSseEvent: ConversationSseEvent as JsonSchema,
        ConversationTurnStopResponse: ConversationTurnStopResponse as JsonSchema,
        IssueDraftResponse: IssueDraftResponse as JsonSchema,
        AcceptIssueDraftRequest: AcceptIssueDraftRequest as JsonSchema,
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
        MyMissionRoundsResponse: MyMissionRoundsResponse as JsonSchema,
        ExecuteMissionRoundActionRequest: ExecuteMissionRoundActionRequest as JsonSchema,
        MissionRoundDecideInput: MissionRoundDecideInput as JsonSchema,
        MissionRoundConfirmInput: MissionRoundConfirmInput as JsonSchema,
        MissionCardReviewSource: MissionCardReviewSource as JsonSchema,
        MissionCardReviewReport: MissionCardReviewReport as JsonSchema,
        MissionCardCoAgentReview: MissionCardCoAgentReview as JsonSchema,
        ReturnMissionCardsRequest: ReturnMissionCardsRequest as JsonSchema,
        MonthlyReviewResponse: MonthlyReviewResponse as JsonSchema,
        MonthlyReviewItemResponse: MonthlyReviewItemResponse as JsonSchema,
        MonthlyReviewPayload: MonthlyReviewPayload as JsonSchema,
        MonthlyReviewItemPayload: MonthlyReviewItemPayload as JsonSchema,
        MonthlyReviewItemRow: MonthlyReviewItemRow as JsonSchema,
        MyMonthlyReviewNoticesResponse: MyMonthlyReviewNoticesResponse as JsonSchema,
        MonthlyReviewNotice: MonthlyReviewNotice as JsonSchema,
        ExecuteMonthlyReviewActionRequest: ExecuteMonthlyReviewActionRequest as JsonSchema,
        ExecuteMonthlyReviewActionResponse: ExecuteMonthlyReviewActionResponse as JsonSchema,
        MonthlyReviewItemUpdateInput: MonthlyReviewItemUpdateInput as JsonSchema,
        PersonalReviewPayload: PersonalReviewPayload as JsonSchema,
        PersonalReviewGenerationStep: PersonalReviewGenerationStep as JsonSchema,
        PersonalReviewBoard: PersonalReviewBoard as JsonSchema,
        PersonalReviewBoardRow: PersonalReviewBoardRow as JsonSchema,
        PersonalReviewBoardResponse: PersonalReviewBoardResponse as JsonSchema,
        PersonalReviewResponse: PersonalReviewResponse as JsonSchema,
        ExecutePersonalReviewActionRequest: ExecutePersonalReviewActionRequest as JsonSchema,
        ExecutePersonalReviewActionResponse: ExecutePersonalReviewActionResponse as JsonSchema,
        PersonalReviewUpdateInput: PersonalReviewUpdateInput as JsonSchema,
        MonthlyCycle: MonthlyCycle as JsonSchema,
        MonthlyCycleResponse: MonthlyCycleResponse as JsonSchema,
        MonthlyReviewComment: MonthlyReviewComment as JsonSchema,
        CreateMonthlyReviewCommentRequest: CreateMonthlyReviewCommentRequest as JsonSchema,
        CreateMonthlyReviewCommentResponse: CreateMonthlyReviewCommentResponse as JsonSchema,
        MonthlyReviewResolveSuggestionInput: MonthlyReviewResolveSuggestionInput as JsonSchema,
        MonthlyReviewReturnInput: MonthlyReviewReturnInput as JsonSchema,
        MonthlyReviewUpdateSummaryInput: MonthlyReviewUpdateSummaryInput as JsonSchema,
        MonthlyReviewDecideLtcoInput: MonthlyReviewDecideLtcoInput as JsonSchema,
        MissionCardFeedbackView: MissionCardFeedbackView as JsonSchema,
        MissionCardClarificationView: MissionCardClarificationView as JsonSchema,
        MissionCardAnnotationView: MissionCardAnnotationView as JsonSchema,
        MissionCardRevisionView: MissionCardRevisionView as JsonSchema,
        MissionCardAnnotationsResponse: MissionCardAnnotationsResponse as JsonSchema,
        CreateMissionCardAnnotationRequest: CreateMissionCardAnnotationRequest as JsonSchema,
        CreateMissionCardAnnotationResponse: CreateMissionCardAnnotationResponse as JsonSchema,
        AnswerMissionCardAnnotationRequest: AnswerMissionCardAnnotationRequest as JsonSchema,
        RetryMissionCardAnnotationRequest: RetryMissionCardAnnotationRequest as JsonSchema,
        ResolveMissionCardAnnotationRequest: ResolveMissionCardAnnotationRequest as JsonSchema,
        SetMissionCardOwnerConfirmationRequest: SetMissionCardOwnerConfirmationRequest as JsonSchema,
        MissionCardRevisionsResponse: MissionCardRevisionsResponse as JsonSchema,
        PersonalMissionCardMission: PersonalMissionCardMission as JsonSchema,
        PersonalMissionCardPayload: PersonalMissionCardPayload as JsonSchema,
        CreateMissionCardFeedbackRequest: CreateMissionCardFeedbackRequest as JsonSchema,
        CreateMissionCardFeedbackResponse: CreateMissionCardFeedbackResponse as JsonSchema,
        MissionCardGroupView: MissionCardGroupView as JsonSchema,
        MarkMissionCardReadRequest: MarkMissionCardReadRequest as JsonSchema,
        MarkMissionCardReadResponse: MarkMissionCardReadResponse as JsonSchema,
        MissionCardCorrectionView: MissionCardCorrectionView as JsonSchema,
        MissionCardCorrectionAccess: MissionCardCorrectionAccess as JsonSchema,
        CreateMissionCardCorrectionRequest: CreateMissionCardCorrectionRequest as JsonSchema,
        DecideMissionCardCorrectionRequest: DecideMissionCardCorrectionRequest as JsonSchema,
        MissionCardCorrectionResponse: MissionCardCorrectionResponse as JsonSchema,
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
        IssueDecisionHistory: IssueDecisionHistory as JsonSchema,
        MeetingDecisionHistoryResponse: MeetingDecisionHistoryResponse as JsonSchema,
        IssueDecideInput: IssueDecideInput as JsonSchema,
        IssueDecideOverrideInput: IssueDecideOverrideInput as JsonSchema,
        IssueDismissInput: IssueDismissInput as JsonSchema,
        IssueRestoreInput: IssueRestoreInput as JsonSchema,
        IssueRevokeReceiptInput: IssueRevokeReceiptInput as JsonSchema,
        DriMeetingImportRequest: DriMeetingImportRequest as JsonSchema,
        CreateMeetingRequest: CreateMeetingRequest as JsonSchema,
        MeetingBookingRequest: MeetingBookingRequest as JsonSchema,
        MeetingDraftStatusResponse: MeetingDraftStatusResponse as JsonSchema,
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
        ThreadView: ThreadView as JsonSchema,
        SetViewRequest: SetViewRequest as JsonSchema,
        AddThreadMembersRequest: AddThreadMembersRequest as JsonSchema,
        ThreadMembersResponse: ThreadMembersResponse as JsonSchema,
        ThreadCandidatesResponse: ThreadCandidatesResponse as JsonSchema,
        UnreadThreadItem: UnreadThreadItem as JsonSchema,
        UnreadThreadsResponse: UnreadThreadsResponse as JsonSchema,
        MemberMeetingItem: MemberMeetingItem as JsonSchema,
        MemberMeetingsResponse: MemberMeetingsResponse as JsonSchema,
        FeishuCalendarEventsResponse: FeishuCalendarEventsResponse as JsonSchema,
        MeetingTranscriptTurnView: MeetingTranscriptTurnView as JsonSchema,
        MeetingTranscriptPage: MeetingTranscriptPage as JsonSchema,
        ThreadMessage: ThreadMessage as JsonSchema,
        ThreadMessageList: ThreadMessageList as JsonSchema,
        PostThreadMessageRequest: PostThreadMessageRequest as JsonSchema,
        MarkThreadReadRequest: MarkThreadReadRequest as JsonSchema,
        MarkThreadReadResponse: MarkThreadReadResponse as JsonSchema,
        TaskView: TaskView as JsonSchema,
        TaskProgressSource: TaskProgressSource as JsonSchema,
        TaskProgressLink: TaskProgressLink as JsonSchema,
        TaskProgressEntry: TaskProgressEntry as JsonSchema,
        TaskLatestProgress: TaskLatestProgress as JsonSchema,
        AppendTaskProgressRequest: AppendTaskProgressRequest as JsonSchema,
        MissionCardItemsResponse: MissionCardItemsResponse as JsonSchema,
        PersonalTokenClient: PersonalTokenClient as JsonSchema,
        PersonalTokenView: PersonalTokenView as JsonSchema,
        OAuthConsentRequest: OAuthConsentRequest as JsonSchema,
        OAuthConsentResponse: OAuthConsentResponse as JsonSchema,
        OAuthConsentDecisionResponse: OAuthConsentDecisionResponse as JsonSchema,
        MaterialView: MaterialView as JsonSchema,
        MaterialListResponse: MaterialListResponse as JsonSchema,
        AddMaterialLinkRequest: AddMaterialLinkRequest as JsonSchema,
        MaterialRevisionView: MaterialRevisionView as JsonSchema,
        MaterialBlock: MaterialBlock as JsonSchema,
        MaterialDetailResponse: MaterialDetailResponse as JsonSchema,
        MaterialAnnotationView: MaterialAnnotationView as JsonSchema,
        CreateMaterialAnnotationRequest: CreateMaterialAnnotationRequest as JsonSchema,
        CreateMaterialAnnotationResponse: CreateMaterialAnnotationResponse as JsonSchema,
        MaterialRemovedView: MaterialRemovedView as JsonSchema,
        RestoreMaterialRemovedRequest: RestoreMaterialRemovedRequest as JsonSchema,
        MaterialEditProposalView: MaterialEditProposalView as JsonSchema,
        DecideMaterialEditProposalRequest: DecideMaterialEditProposalRequest as JsonSchema,
        DecideMaterialAnnotationRequest: DecideMaterialAnnotationRequest as JsonSchema,
        WeeklyProgressResponse: WeeklyProgressResponse as JsonSchema,
        WorldSourceView: WorldSourceView as JsonSchema,
        ListPersonalTokensResponse: ListPersonalTokensResponse as JsonSchema,
        PersonalProfileView: PersonalProfileView as JsonSchema,
        UpdatePersonalProfileRequest: UpdatePersonalProfileRequest as JsonSchema,
        Buddy: Buddy as JsonSchema,
        BuddyForm: BuddyForm as JsonSchema,
        BuddyPersonality: BuddyPersonality as JsonSchema,
        RailBackground: RailBackground as JsonSchema,
        RailBackgroundChoice: RailBackgroundChoice as JsonSchema,
        SaveRailBackgroundRequest: SaveRailBackgroundRequest as JsonSchema,
        SaveAvatarRequest: SaveAvatarRequest as JsonSchema,
        SavedAvatar: SavedAvatar as JsonSchema,
        PersonAvatarsResponse: PersonAvatarsResponse as JsonSchema,
        CreatePersonalTokenRequest: CreatePersonalTokenRequest as JsonSchema,
        CreatePersonalTokenResponse: CreatePersonalTokenResponse as JsonSchema,
        AdminOverviewResponse: AdminOverviewResponse as JsonSchema,
        AdminActionRequest: AdminActionRequest as JsonSchema,
        UsageResponse: UsageResponse as JsonSchema,
        OnboardingStepUsageRequest: OnboardingStepUsageRequest as JsonSchema,
        CollectorStatusResponse: CollectorStatusResponse as JsonSchema,
        WorkBasisResponse: WorkBasisResponse as JsonSchema,
        UpdateWorkBasisRequest: UpdateWorkBasisRequest as JsonSchema,
        ScheduleMigrationResponse: ScheduleMigrationResponse as JsonSchema,
        UpdateScheduleMigrationRequest: UpdateScheduleMigrationRequest as JsonSchema,
        WeeklyReviewBoardResponse: WeeklyReviewBoardResponse as JsonSchema,
        WeeklyReviewResponse: WeeklyReviewResponse as JsonSchema,
        ExecuteWeeklyReviewActionRequest: ExecuteWeeklyReviewActionRequest as JsonSchema,
        ExecuteWeeklyReviewActionResponse: ExecuteWeeklyReviewActionResponse as JsonSchema,
        WeeklyReviewUpdateInput: WeeklyReviewUpdateInput as JsonSchema,
        ProgressOverviewResponse: ProgressOverviewResponse as JsonSchema,
        BattlefieldSummariesResponse: BattlefieldSummariesResponse as JsonSchema,
        TaskPerson: TaskPerson as JsonSchema,
        TaskMissionRef: TaskMissionRef as JsonSchema,
        CreateMyTaskRequest: CreateMyTaskRequest as JsonSchema,
        TaskDetailResponse: TaskDetailResponse as JsonSchema,
        PutMyTaskNoteRequest: PutMyTaskNoteRequest as JsonSchema,
        PutMyTaskNoteResponse: PutMyTaskNoteResponse as JsonSchema,
        AddTaskCollaboratorsRequest: AddTaskCollaboratorsRequest as JsonSchema,
        MonthPlanGroup: MonthPlanGroup as JsonSchema,
        MonthPlanResponse: MonthPlanResponse as JsonSchema,
        SaveMonthPlanRequest: SaveMonthPlanRequest as JsonSchema,
        MeHomeResponse: MeHomeResponse as JsonSchema,
        HomePlanDay: HomePlanDay as JsonSchema,
        HomePlanGate: HomePlanGate as JsonSchema,
        HomePlanMark: HomePlanMark as JsonSchema,
        HomePlanTask: HomePlanTask as JsonSchema,
        TaskDeliverableStatus: TaskDeliverableStatus as JsonSchema,
        TaskDeliverableResponse: TaskDeliverableResponse as JsonSchema,
        DeliverableVersion: DeliverableVersion as JsonSchema,
        DeliverableItem: DeliverableItem as JsonSchema,
        DeliverableReview: DeliverableReview as JsonSchema,
        ReviewCriterion: ReviewCriterion as JsonSchema,
        DeliverableNote: DeliverableNote as JsonSchema,
        DeliverableDissentRequest: DeliverableDissentRequest as JsonSchema,
        DeliverableNotePatch: DeliverableNotePatch as JsonSchema,
        TaskAgreementResponse: TaskAgreementResponse as JsonSchema,
        PutTaskAgreementRequest: PutTaskAgreementRequest as JsonSchema,
        TaskCheckResponse: TaskCheckResponse as JsonSchema,
        CheckNotifyRequest: CheckNotifyRequest as JsonSchema,
        CheckNotifyResponse: CheckNotifyResponse as JsonSchema,
        HomePlanMission: HomePlanMission as JsonSchema,
        HomePlanActivity: HomePlanActivity as JsonSchema,
        HomePlanResponse: HomePlanResponse as JsonSchema,
        PlanCalendarResponse: PlanCalendarResponse as JsonSchema,
        BattlefieldProgressResponse: BattlefieldProgressResponse as JsonSchema,
        CreatePlanMarkRequest: CreatePlanMarkRequest as JsonSchema,
        PatchPlanMarkRequest: PatchPlanMarkRequest as JsonSchema,
        MemberWork: MemberWork as JsonSchema,
        MemberBattlefieldResponse: MemberBattlefieldResponse as JsonSchema,
        MyRadar: MyRadar as JsonSchema,
        PutMyRadarRequest: PutMyRadarRequest as JsonSchema,
        PersonalSignal: PersonalSignal as JsonSchema,
        PersonalSignalBrief: PersonalSignalBrief as JsonSchema,
        PersonalSignalList: PersonalSignalList as JsonSchema,
        MyRadarScanAccepted: MyRadarScanAccepted as JsonSchema,
        MemberRadarBrief: MemberRadarBrief as JsonSchema,
        CompanyRadarSettings: CompanyRadarSettings as JsonSchema,
        PutCompanyRadarRequest: PutCompanyRadarRequest as JsonSchema,
        RadarDirection: RadarDirection as JsonSchema,
        RadarSourceSetting: RadarSourceSetting as JsonSchema,
        PersonalRadarRun: PersonalRadarRun as JsonSchema,
        PatchMyTaskRequest: PatchMyTaskRequest as JsonSchema,
        ReturnMyTaskRequest: ReturnMyTaskRequest as JsonSchema,
        StandaloneMyTaskRequest: StandaloneMyTaskRequest as JsonSchema,
        TaskStandardCheck: TaskStandardCheck as JsonSchema,
        TaskSubmission: TaskSubmission as JsonSchema,
        TaskAcceptance: TaskAcceptance as JsonSchema,
        AcceptMyTaskRequest: AcceptMyTaskRequest as JsonSchema,
        ReopenMyTaskRequest: ReopenMyTaskRequest as JsonSchema,
        ReturnTaskAcceptanceRequest: ReturnTaskAcceptanceRequest as JsonSchema,
        TaskAcceptanceDraft: TaskAcceptanceDraft as JsonSchema,
        NotificationList: NotificationList as JsonSchema,
        MarkNotificationsSeenRequest: MarkNotificationsSeenRequest as JsonSchema,
        MeetingRecording: MeetingRecording as JsonSchema,
        StartMeetingRecordingResponse: StartMeetingRecordingResponse as JsonSchema,
        VoiceprintStatus: VoiceprintStatus as JsonSchema,
        PersonalMemoryItem: PersonalMemoryItem as JsonSchema,
        CreateMemoryImportRequest: CreateMemoryImportRequest as JsonSchema,
        MemoryImport: MemoryImport as JsonSchema,
        MemoryImportDetail: MemoryImportDetail as JsonSchema,
        MemoryImportList: MemoryImportList as JsonSchema,
        ConfirmMemoryImportRequest: ConfirmMemoryImportRequest as JsonSchema,
        PersonalMemoryList: PersonalMemoryList as JsonSchema,
        PartnerMemoryList: PartnerMemoryList as JsonSchema,
        UpdatePersonalMemoryItemRequest: UpdatePersonalMemoryItemRequest as JsonSchema,
        DictationResult: DictationResult as JsonSchema,
        DictationSessionResponse: DictationSessionResponse as JsonSchema,
        DictationPolishRequest: DictationPolishRequest as JsonSchema,
        DictationPolishResponse: DictationPolishResponse as JsonSchema,
        OnboardingResponse: OnboardingResponse as JsonSchema,
        CompleteOnboardingResponse: CompleteOnboardingResponse as JsonSchema,
        SeenMarksResponse: SeenMarksResponse as JsonSchema,
        RequestStep: RequestStep as JsonSchema,
        RequestPerson: RequestPerson as JsonSchema,
        RequestRecipientView: RequestRecipientView as JsonSchema,
        RequestQuestionView: RequestQuestionView as JsonSchema,
        RequestClarification: RequestClarification as JsonSchema,
        RequestView: RequestView as JsonSchema,
        RequestResponse: RequestResponse as JsonSchema,
        DraftRequestRequest: DraftRequestRequest as JsonSchema,
        DraftRequestResponse: DraftRequestResponse as JsonSchema,
        RequestListItem: RequestListItem as JsonSchema,
        RequestListResponse: RequestListResponse as JsonSchema,
        PrepareRequestQuestionRequest: PrepareRequestQuestionRequest as JsonSchema,
        PrepareRequestQuestionResponse: PrepareRequestQuestionResponse as JsonSchema,
        DraftRequestAnswerResponse: DraftRequestAnswerResponse as JsonSchema,
        RequestSendInput: RequestSendInput as JsonSchema,
        RequestAskInput: RequestAskInput as JsonSchema,
        RequestAnswerInput: RequestAnswerInput as JsonSchema,
        ExecuteRequestActionRequest: ExecuteRequestActionRequest as JsonSchema,
        MeetingDecisionView: MeetingDecisionView as JsonSchema,
        MyMeetingCardsResponse: MyMeetingCardsResponse as JsonSchema,
        FeishuMinuteInboxResponse: FeishuMinuteInboxResponse as JsonSchema,
        OrganizeFeishuMinuteRequest: OrganizeFeishuMinuteRequest as JsonSchema,
        AttachFeishuMinuteRequest: AttachFeishuMinuteRequest as JsonSchema,
        FeishuMinuteMeetingResponse: FeishuMinuteMeetingResponse as JsonSchema,
        MeetingWorldResponse: MeetingWorldResponse as JsonSchema,
        MeetingCardView: MeetingCardView as JsonSchema,
        MeetingCardDraftRequest: MeetingCardDraftRequest as JsonSchema,
        MeetingCardConfirmRequest: MeetingCardConfirmRequest as JsonSchema,
        MeetingCardSpeakerRequest: MeetingCardSpeakerRequest as JsonSchema,
        MeetingCardReviewRequest: MeetingCardReviewRequest as JsonSchema,
        MeetingCardOwnerRequest: MeetingCardOwnerRequest as JsonSchema,
        MeetingCardReviewResponse: MeetingCardReviewResponse as JsonSchema,
        MeetingCardWorldChoiceRequest: MeetingCardWorldChoiceRequest as JsonSchema,
        MeetingMinutesLinkRequest: MeetingMinutesLinkRequest as JsonSchema,
        MeetingMinutesFetchResponse: MeetingMinutesFetchResponse as JsonSchema,
        MeetingWorldAnchorsRequest: MeetingWorldAnchorsRequest as JsonSchema,
        MeetingWorldAnchorOptionsResponse: MeetingWorldAnchorOptionsResponse as JsonSchema,
        ImpactCardView: ImpactCardView as JsonSchema,
        ImpactCardResponse: ImpactCardResponse as JsonSchema,
        ImpactAskRequest: ImpactAskRequest as JsonSchema,
        ImpactAskResponse: ImpactAskResponse as JsonSchema,
        ImpactIrrelevantRequest: ImpactIrrelevantRequest as JsonSchema,
        ImpactBasisChoiceRequest: ImpactBasisChoiceRequest as JsonSchema,
        DocChangeView: DocChangeView as JsonSchema,
        DocChangeResponse: DocChangeResponse as JsonSchema,
        ConfirmDocChangeRequest: ConfirmDocChangeRequest as JsonSchema,
        DocOwnerAnswerRequest: DocOwnerAnswerRequest as JsonSchema,
        CollectionField: CollectionField as JsonSchema,
        CollectionEntryView: CollectionEntryView as JsonSchema,
        CollectionRoundView: CollectionRoundView as JsonSchema,
        CollectionView: CollectionView as JsonSchema,
        CollectionResponse: CollectionResponse as JsonSchema,
        DraftCollectionRequest: DraftCollectionRequest as JsonSchema,
        DraftCollectionResponse: DraftCollectionResponse as JsonSchema,
        CollectionSendInput: CollectionSendInput as JsonSchema,
        CollectionSaveInput: CollectionSaveInput as JsonSchema,
        ExecuteCollectionActionRequest: ExecuteCollectionActionRequest as JsonSchema,
        ScheduleItem: ScheduleItem as JsonSchema,
        ScheduleListResponse: ScheduleListResponse as JsonSchema,
        ...boardSchemas,
        ...workHomeSchemas,
      },
    },
  };
}
