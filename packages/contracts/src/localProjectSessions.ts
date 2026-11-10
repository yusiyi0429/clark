import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { BuddyUiEffect } from "./buddyActions.js";
import { ConversationCard, LocalFallbackReason } from "./conversations.js";
import { LocalAgentKind, LocalEffort, LocalRun, LocalSessionEvent } from "./localRunner.js";

/**
 * 本机的项目会话（设计稿 17.2 第 38 条，方案《项目对话本机跑_架构与分工_2026-11-10》3.3、3.4）：电脑上的天枢网页连得上本机程序时，
 * 项目对话的一轮在本人电脑上跑（本人的 Claude Code / Codex 订阅，能来回换）。这里是网页 ↔ 本机程序（127.0.0.1）这一段；
 * 本机程序 ↔ 天枢 api 那一段（项目钥匙、一轮的开始 / 心跳 / 结束、项目会话的天枢 MCP 工具、共用规矩）在 projectLocalTurns.ts（B）。
 *
 * 一轮怎么走：
 * 1. 网页把本人这一句交给本机：POST /v1/project-sessions/:projectId/turns。手机、连不上本机的照旧直接发云端，不经这里。
 * 2. 本机用设备令牌向天枢取项目钥匙（本机存着，过期前自己再取）、开始这一轮（占住这段对话，拿到 turnId、最近几轮、项目情况、共用规矩），
 *    拉起（或续上）这个项目的项目会话，把这一句交给执行方，回 started。从收到到回，通常一两秒；执行方要新拉起时再多几秒。
 * 3. 这一轮的实时内容网页从本机读：GET /v1/project-sessions/:projectId/events（同子会话的事件流）。
 * 4. 这一轮做完、被停下或出错：本机向天枢结束这一轮（天枢写进对话历史），事件流记 project_turn_end；之后网页照旧从天枢读历史。
 * 5. 本机没跑成（起不来、这家订阅额度用完）：回 started 之前就知道的回 outcome cloud（已经向天枢占了这一轮的，本机先放掉）；
 *    回了 started 以后才碰到的，在事件流里报 project_turn_end（status released）。两种情况网页都把同一句改发云端（ConversationMessageRequest.fallback = reason）。
 *
 * 项目会话是什么：
 * - 一个项目在一台电脑上一个，长期用同一个会话号（sessionId）；工作目录是这个项目在这台电脑上绑的文件夹（没绑就是本机给它的专用目录）。
 *   一轮做完进程留着等下一句；空着太久本机会关掉它，下一句来了续上，对网页没有差别。不在 GET /v1/sessions 里，不排队，也不占「本机同时跑几个」的位置（LocalSlots 不算它）。
 * - 角色提示是天枢给的项目对话共用规矩（开始一轮时带回的 rules），每一轮开始时换成最新的。
 * - 工具：天枢 MCP（名字 tianshu，经本机程序转发；项目钥匙留在本机程序里，不进会话的环境变量、文件和命令行），里面是项目动作和「读更早的对话」
 *   （PROJECT_MCP_TOOLS）加设备令牌能用的读工具。项目动作预先放行、不逐个来问本人批准：能做什么由天枢按本人的伙伴授权定、照旧记审计，和云端项目对话一样。
 *   执行方自带的工具只给读的（读文件、搜索、联网搜索）：不给写文件、跑命令、开子 agent；Claude Code 自带的 AskUserQuestion、TodoWrite 关掉
 *   （选项框用天枢的 ask_user，步骤清单用 update_plan）；Codex 以只读沙箱起。所以项目会话里没有权限请求、没有执行方自己的提问（permission_request、question 这几种事件不会有）。
 *   长活照规矩拆卡、派给子会话做。
 *   【待用户定】项目会话能不能动这个项目的文件夹：现在定的是只读（推荐，和云端的项目对话最接近，不会卡在等批准上）；
 *   另一种是和子会话一样能写能跑命令、逐步来问（网页的项目对话里要多画批准框）；再一种是文件夹也不给读。
 * - 换模型、换执行方：这一句带 modelProfileId（本机的模型配置，GET /v1/models）就从这一轮起用它，本机记着，以后不带就照用；是另一家的模型配置就是换执行方。
 *   项目会话一句一轮，换都发生在两轮之间：会话号、事件流不变，事件流记 notice（同子会话：换执行方 harness_changed，同一家换模型 model_changed）。
 * - 接上下文（和子会话 Claude Code ↔ Codex 互换同一套，回答 B 在 LocalProjectTurnStartResponse 上标的那条：同意）：两家各留自己的对话，本机记着每家的对话里已经有哪几轮（按 turnId）。
 *   开始这一轮时，天枢给的最近几轮（context.recent）里它没有的那几轮（上一轮在云端跑的、换执行方之前另一家跑的）原样接在这一句前面交给它；
 *   更早的它用 read_earlier_conversation 自己翻。不调模型写摘要。
 * - 本人在这一轮还在跑时又发来一句（中途插话）：本机先停下在跑的那一轮（按 aborted 结束，已写出的部分照记进对话），再开始新的一轮，回新的 started。
 *   【待 B、W 确认】这样一句话对一轮，对话历史里每一句都在；另一种是把这句插进正在跑的那一轮（同子会话），但那一轮在天枢里只记得下第一句。
 * - 本机暂停（托盘「暂停全部」）时不开新的一轮，回 outcome cloud（local_unavailable）。
 *
 * 【待 B 确认】本机这边照 projectLocalTurns.ts 做，下面几处是本机的理解，不对请指出：
 * 1. 项目钥匙留在本机程序里、天枢 MCP 经本机转发（同现在子会话挂天枢 MCP 的做法），比「经子进程环境变量交给执行方」更严，天枢那边不用改。
 * 2. 项目动作在本机不逐个问本人批准（见上）。
 * 3. 项目动作的工具结果（ProjectMcpToolResult）请多带一项 ui（BuddyUiEffect 的数组：做完这个动作界面上要刷新哪几块、切外观），
 *    本机原样转成 project_ui 事件；现在的结果里没有，本机那一轮做了拆卡、开工这些以后网页不知道该重读哪块。
 * 4. 结束时的 answer：这一轮执行方说的各段话按先后接起来（段和段之间空一行），超过 10 万字截掉后面的。工具过程不进 answer。
 * 5. released 的时机：开始以后执行方起不来（local_unavailable），或这一轮碰到这家订阅额度用完（local_quota，不管已经说到哪了）。
 *    开始之前就知道起不来、额度用完的，本机不调「开始」，直接让网页走云端。
 * 6. 结束报不上去（断网）时本机隔几秒再报，一直报到这一轮过期（expiresAfterSeconds）；过期了这一轮的回答没进对话历史，事件流记 project_turn_synced（state lost）。
 */

const strict = { additionalProperties: false } as const;
const Instant = Type.String({ format: "date-time" });
const Uuid = Type.String({ format: "uuid" });
/** 本机模型配置的 id（同 localRunner.ts 的 Id）。 */
const ProfileId = Type.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_-]+$" });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

// ───────────────────────── 项目会话 ─────────────────────────

/** idle：没有一轮在跑，等下一句（进程开着或已经关了，下一句来了续上）；starting：在取钥匙、占这一轮、拉起执行方；running：这一轮在跑。 */
export const LocalProjectSessionStatus = Type.Union([Type.Literal("idle"), Type.Literal("starting"), Type.Literal("running")]);

/** 正在本机跑的那一轮。startSeq 是这一轮第一条事件（project_turn_start）的序号，网页从它读这一轮的实时内容（events?after=startSeq-1）。 */
export const LocalProjectSessionTurn = Type.Object({
  /** 天枢给这一轮的 id（结束后对话历史里那一轮的 runId 就是它）。 */
  turnId: Uuid,
  /** 网页给这一句起的号（LocalProjectSessionTurnRequest.clientTurnId）。 */
  clientTurnId: Uuid,
  message: Type.String(),
  startedAt: Instant,
  startSeq: Type.Integer({ minimum: 1 }),
}, strict);

export const LocalProjectSession = Type.Object({
  projectId: Uuid,
  /** 本机给这个项目会话的号（事件里的 sessionId；Claude Code 的会话号也是它）。 */
  sessionId: Uuid,
  agent: LocalAgentKind,
  modelProfileId: ProfileId,
  modelLabel: Type.String(),
  /** 本人选的思考程度；不带是这个模型的默认档。实际跑的看 run.effort。 */
  effort: Type.Optional(LocalEffort),
  /** 最近一次拉起时定的跑法（同子会话摘要的 run）：底部胶囊写「本机 · ${run.actual?.modelName ?? run.modelName}」。还没拉起过不带。 */
  run: Type.Optional(LocalRun),
  cwd: Type.String(),
  status: LocalProjectSessionStatus,
  /** 正在跑的那一轮；没有为 null。 */
  turn: Nullable(LocalProjectSessionTurn),
  lastSeq: Type.Integer({ minimum: 0 }),
  updatedAt: Instant,
}, strict);

/** GET /v1/project-sessions/:projectId：这个项目在这台电脑上的项目会话；还没在本机跑过为 null（模型菜单用 GET /v1/models 里默认的那个）。 */
export const LocalProjectSessionResponse = Type.Object({ session: Nullable(LocalProjectSession) }, strict);

// ───────────────────────── 一轮：开始、停下 ─────────────────────────

/**
 * POST /v1/project-sessions/:projectId/turns：本人在项目对话里说了一句，交给本机跑。
 * - clientTurnId：网页给这一句起的号，重试沿用（同一个号再来回同一个结果，不会开两轮）；本机原样作为天枢「开始一轮」的 clientTurnId。
 * - message：本人这一句（第一版只有文字；带附件的这一句网页直接发云端）。buddyQuestionId：这一句是在回答哪个选项框（同云端）。
 * - modelProfileId、effort：从这一轮起用哪个模型配置、思考程度（effort 为 null 是回到这个模型的默认档）；不带就照上一轮的，第一轮不带用默认的模型配置。
 * 错误（LocalRunnerError）：400 validation（没有这个模型配置、思考程度这个模型没有）；404 not_found（天枢说没有这个项目、不是本人的、归档了）。
 */
export const LocalProjectSessionTurnRequest = Type.Object({
  clientTurnId: Uuid,
  message: Type.String({ minLength: 1, maxLength: 20_000 }),
  buddyQuestionId: Type.Optional(Uuid),
  modelProfileId: Type.Optional(ProfileId),
  effort: Type.Optional(Nullable(LocalEffort)),
}, strict);

/**
 * 回 200，三种结果：
 * - started：本机接下了，这一轮在跑。实时内容读事件流（从 session.turn.startSeq 起）。
 * - cloud：本机没跑、也没占这一轮，网页把同一句改发云端（POST /api/conversations/project:<id>/messages，fallback = reason）。
 *   local_unavailable：执行方没装、没登录、版本太旧、起不来，本机没连上天枢、被暂停，或天枢说存不下这一轮（没接对话服务）；local_quota：这家订阅额度用完了。
 *   message 是给人看的一句原因（如「Codex 还没登录」），网页可以不显示。
 * - busy：这段对话有一轮在别处跑着（天枢回 409 TURN_IN_PROGRESS）：runningOn cloud 是云端在回，local 是别的电脑占着。网页照云端的 409 处理
 *   （画「正在回答」；云端在回、本人要插话时先请云端停下再发一次）。这台电脑自己在跑的那一轮不回 busy：本机先停下它再开始新的（见文件头）。
 */
export const LocalProjectSessionTurnResponse = Type.Union([
  Type.Object({ outcome: Type.Literal("started"), turnId: Uuid, session: LocalProjectSession }, strict),
  Type.Object({ outcome: Type.Literal("cloud"), reason: LocalFallbackReason, message: Type.String() }, strict),
  Type.Object({ outcome: Type.Literal("busy"), runningOn: Type.Union([Type.Literal("cloud"), Type.Literal("local")]), message: Type.String() }, strict),
]);

/**
 * POST /v1/project-sessions/:projectId/stop（体 {}）：本人停下正在本机跑的这一轮。这一轮按 aborted 结束（已写出的部分照记进对话），项目会话留着。
 * 回停下以后的项目会话；没有在跑的一轮也回 200（原样）；这个项目没有项目会话回 404。
 */
export const LocalProjectSessionStopResponse = Type.Object({ session: LocalProjectSession }, strict);

// ───────────────────────── 事件流 ─────────────────────────

const ev = <T extends string, P extends Record<string, TSchema>>(type: T, props: P) => Type.Object({
  seq: Type.Integer({ minimum: 1 }),
  at: Instant,
  sessionId: Uuid,
  type: Type.Literal(type),
  ...props,
}, strict);

/** 这一轮开始了：天枢占住了、这一句交给执行方了。紧跟着是这一句的 user_message（source web，messageId 是 clientTurnId）。 */
export const LocalProjectSessionTurnStartEvent = ev("project_turn_start", { turnId: Uuid, clientTurnId: Uuid });

/**
 * 这一轮在本机结束了（执行方的 turn_end 之后马上报，不等天枢收下）：
 * - completed 答完；aborted 本人停下、或本人又发来一句被顶掉；failed 出错停住（errorCode 是短码，同 turn_end 的 errorKind：auth、api、other）。这三种已写出的部分都记进对话。
 * - released 没跑成、这一轮当没发生（reason：local_unavailable 执行方起不来，local_quota 这家订阅额度用完）：网页把同一句改发云端（fallback = reason）。
 *   已经显示出来的那部分回答网页收掉；这一轮里已经做成的动作还在审计里，提醒不提醒由网页定。
 */
export const LocalProjectSessionTurnEndEvent = ev("project_turn_end", {
  turnId: Uuid,
  status: Type.Union([Type.Literal("completed"), Type.Literal("aborted"), Type.Literal("failed"), Type.Literal("released")]),
  errorCode: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
  reason: Type.Optional(LocalFallbackReason),
});

/**
 * 这一轮报给天枢的结果（project_turn_end 之后，报上去或确定报不上去时来一条；released 的也来）：
 * recorded 已经写进对话历史，网页重读历史就有；pending 天枢收下了、还在往对话里写（它自己会补写，读历史时这一轮先按 localTurn 显示）；
 * lost 没报上去、这一轮在天枢那边过期了：回答没进对话历史，网页留着这一轮的实时内容并提示没存上。
 */
export const LocalProjectSessionTurnSyncedEvent = ev("project_turn_synced", {
  turnId: Uuid,
  state: Type.Union([Type.Literal("recorded"), Type.Literal("pending"), Type.Literal("lost")]),
});

/** 这一轮出了一张卡（项目动作的工具结果里带的 card）：ask_user 的选项框、send_message 的转达卡。形状同云端对话流的 card 事件，网页用同一个组件画。 */
export const LocalProjectSessionCardEvent = ev("project_card", { turnId: Uuid, card: ConversationCard });

/** 项目动作做完，界面上要跟着变的（同云端对话流的 ui 事件）：刷新哪几块、切外观。【待 B 确认】要天枢在工具结果里带 ui。 */
export const LocalProjectSessionUiEvent = ev("project_ui", { turnId: Uuid, ui: BuddyUiEffect });

/**
 * GET /v1/project-sessions/:projectId/events（text/event-stream）：同 GET /v1/sessions/:id/events（每条 `id: <seq>` + `data: <JSON>`，
 * 断线带 Last-Event-ID 或 ?after=<seq> 重连）。这个项目还没有项目会话回 404。
 *
 * 事件是子会话的那几种加上面五种。项目会话里会有的：
 * - status（只有 idle、starting、running）、agent_info、notice（harness_changed、model_changed、api_retry、auth_required 等）；
 * - user_message（本人这一句，source web）、receipt、assistant_text、turn_end；
 * - tool_call、tool_result：项目动作的 name 是 mcp__tianshu__<动作名>（如 mcp__tianshu__split_cards），过程行照云端按动作名画；
 * - plan：update_plan 交的清单（entries 同云端的 BuddyPlan.entries，progress 本机算）；Codex 自带的计划工具报的也转成这一种。
 * 不会有的：permission_request、permission_resolved、permission_mode、question、question_resolved、background、artifact、handback、version、verdict。
 */
export const LocalProjectSessionEvent = Type.Union([
  ...LocalSessionEvent.anyOf,
  LocalProjectSessionTurnStartEvent, LocalProjectSessionTurnEndEvent, LocalProjectSessionTurnSyncedEvent, LocalProjectSessionCardEvent, LocalProjectSessionUiEvent,
]);

export type TLocalProjectSessionStatus = Static<typeof LocalProjectSessionStatus>;
export type TLocalProjectSessionTurn = Static<typeof LocalProjectSessionTurn>;
export type TLocalProjectSession = Static<typeof LocalProjectSession>;
export type TLocalProjectSessionResponse = Static<typeof LocalProjectSessionResponse>;
export type TLocalProjectSessionTurnRequest = Static<typeof LocalProjectSessionTurnRequest>;
export type TLocalProjectSessionTurnResponse = Static<typeof LocalProjectSessionTurnResponse>;
export type TLocalProjectSessionStopResponse = Static<typeof LocalProjectSessionStopResponse>;
export type TLocalProjectSessionEvent = Static<typeof LocalProjectSessionEvent>;

/**
 * 项目会话的本机路由（方法 + 路径，都要口令），形状同 LOCAL_RUNNER_ROUTES；网页客户端和本机程序共用。
 * 单放一张表：LOCAL_RUNNER_ROUTES 里的每一条本机都已经实现了，这几条等本机实现后才通（没实现的本机回 404）。
 */
export const LOCAL_PROJECT_SESSION_ROUTES = {
  getProjectSession: { method: "GET", path: "/v1/project-sessions/:projectId", auth: true },
  startProjectTurn: { method: "POST", path: "/v1/project-sessions/:projectId/turns", auth: true },
  stopProjectTurn: { method: "POST", path: "/v1/project-sessions/:projectId/stop", auth: true },
  projectSessionEvents: { method: "GET", path: "/v1/project-sessions/:projectId/events", auth: true },
} as const;
