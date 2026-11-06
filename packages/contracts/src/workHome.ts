import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { RoleRef } from "./roles.js";
import { WorkerQueueReason, WorkerResources } from "./workers.js";

/**
 * 新首页：伙伴总管线 + 每件 Task 一条 Task 管线 + 子会话（设计《新首页_伙伴总管线与Task管线_2026-11-07》第 2、4、7 节）。
 *
 * - 子会话：本机程序里能对话的会话，只有执行（卡）和探索（专题）两种；规划员、验收员、合回不算子会话，是后台任务。
 * - Task 管线：每人每件 Task 一条单独的伙伴对话，对话 scope 是 plan-task:<taskId>（conversations.ts 的 ConversationScope），
 *   和总管线（global）各是各的历史；接了 Chat 服务时是 Chat 里单独的一段对话，天枢记「Task → 对话」的对应。
 * - 自动开工（第 4.4 节）：管线里定了计划（派活单上选了「就按这个开始」）或伙伴开了探索子会话，云端只记一条「要开工」，
 *   由这台电脑上开着的天枢网页认领后拉起本机程序（和登记拆卡 → 网页开规划员同一条路，云端不指挥本机）；
 *   网页没开（比如在手机上）就一直排着，界面写「等本机上线」，下次在电脑上打开天枢就自己开。
 *
 * 伙伴那一侧的选项框工具 ask_user（给晨星 / Chat 服务，支持之前只有本机子会话里的提问用选项框）：
 * - 参数照天枢自己对话里的 ask_user（conversations.ts 的 AskUserInput）：一次 1–4 题，每题 2–4 个选项 { label ≤ 40, detail? ≤ 120, recommended? }，
 *   推荐的放第一个、每题最多一个 recommended；「自己说」和跳过由界面另给，选项里不写。调用后这一轮结束。
 * - 流：这一轮的 done 事件带 cards: [{ kind: "questions", askId, questions: [{ id, question, options }] }]（ConversationCard 的 questions）；
 *   历史：那条助手消息带同样的 cards，本人的作答消息带 answers（AskAnswerRecord）。
 * - 作答：下一轮请求带 answers（AskAnswerInput：askId + 每题 option 下标或 text），Chat 按自己存的提问卡核对、把这一句原文改写成问答。
 * - 天枢这一侧：转发 answers、把历史里的 cards / answers 原样给网页（chatService.ts），网页用同一个选项框画提问、批准和开工。
 */

const strict = { additionalProperties: false } as const;
const Instant = Type.String({ format: "date-time" });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/**
 * 子会话的状态（左栏的图标）：queued 已排队（空心圈）、running 进行中（转圈）、waiting 等你（强调色小圆点）、done 已完成（勾）、failed 验收没过（叉）。
 * 对到卡和专题上：带岗位还没开工的、本机报等空位或等前面的卡的 → queued；验收中 → running；验收通过 → done；
 * 验收没过、改法还没送回执行方 → failed；等你批准、等你回复、受阻、已暂停 → waiting。
 */
export const SubSessionState = Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("waiting"), Type.Literal("done"), Type.Literal("failed")]);

/**
 * 等你什么（只有 state = waiting 时可能有）：approval 等你批准（本机有权限请求没答）、question 等你回复（一轮做完在等你说话，或执行方在问你）、
 * verdict 验收结果等你拿主意（连续两次没过，受阻）。已暂停（停下了）也是等你（说一句就接着做），为 null。
 */
export const SubSessionWaiting = Type.Union([Type.Literal("approval"), Type.Literal("question"), Type.Literal("verdict")]);

/**
 * 一个子会话。id 是卡的 id（执行事项）或专题的 id，kind 说是哪种。
 * queueReason：state = queued 时在等什么（worker 列表同一套：等开工、等空位、等本机上线、等前面的卡），别的为 null。
 * sessionId：最近一次本机执行（本机会话）的 id，没开过为 null；deviceId 是它在哪台电脑上。网页据此在那台电脑上接实时事件。
 * autoStart：已经登记了要开工、还没有哪台电脑接下（第 4.4 节）。在配对的电脑上开着的网页看到它就认领开工（POST /api/me/session-starts/claim）。
 * updatedAt：最近一次动静（本机报的、卡或专题改的），树上同一格按它排。
 */
export const SubSession = Type.Object({
  id: Type.String({ minLength: 1 }),
  kind: Type.Union([Type.Literal("card"), Type.Literal("topic")]),
  title: Type.String(),
  state: SubSessionState,
  waiting: Nullable(SubSessionWaiting),
  queueReason: Nullable(WorkerQueueReason),
  role: Nullable(RoleRef),
  sessionId: Nullable(Type.String({ format: "uuid" })),
  deviceId: Nullable(Type.String({ format: "uuid" })),
  autoStart: Type.Boolean(),
  updatedAt: Instant,
}, strict);

/** 一件 Task 下面几个子会话在哪一格：首页 Task 一行的「2 个在跑 · 1 件等你」。waiting 含没过的（failed）。 */
export const HomeTaskSummary = Type.Object({
  running: Type.Integer({ minimum: 0 }),
  waiting: Type.Integer({ minimum: 0 }),
  queued: Type.Integer({ minimum: 0 }),
  done: Type.Integer({ minimum: 0 }),
}, strict);

/**
 * 左栏一件 Task（本人这个月 Mission 下、本人是负责人的 Task，Mission 定好就出现，哪怕还没开始聊）。
 * subtitle：标题下一行小字（完成定义或第一条标准，都没有为 null）。
 * pipeline.conversationId：这件 Task 的管线对话；还没开过为 null（POST /api/me/tasks/:taskId/pipeline 建）。对话的 scope 永远是 plan-task:<taskId>。
 * planning：规划员在拆这件 Task（本机的规划员会话还没结束，或登记了拆卡还没开）。
 */
export const HomeTask = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  missionId: Type.String({ minLength: 1 }),
  name: Type.String(),
  subtitle: Nullable(Type.String()),
  summary: HomeTaskSummary,
  pipeline: Type.Object({ conversationId: Nullable(Type.String({ minLength: 1 })), scope: Type.String({ minLength: 1 }) }, strict),
  planning: Type.Boolean(),
  subSessions: Type.Array(SubSession),
}, strict);

export const HomeMission = Type.Object({
  missionId: Type.String({ minLength: 1 }),
  title: Type.String(),
  tasks: Type.Array(HomeTask),
}, strict);

/**
 * 等你：要本人拿主意的事，跨所有来源，一件一行。
 * approval / question：子会话（或规划员、验收员）在等你批准、等你回复；verdict：卡连续两次验收没过（受阻）；
 * meeting：会议记录要你确认（你是责任人的决策、你负责的行动项、你主持的会要补归属或记录没生成），一场会一行；
 * mission_card：Mission Card 要你做的事（本人确认我的任务，或拍板人那一侧的待办）；role：岗位修改建议（采纳或不要）。
 */
export const WaitingKind = Type.Union([
  Type.Literal("approval"), Type.Literal("question"), Type.Literal("verdict"), Type.Literal("meeting"), Type.Literal("mission_card"), Type.Literal("role"),
]);

/**
 * 去哪儿看：card、topic 是子会话（id 是卡或专题的 id），task 是 Task 管线（id 是 Task id），meeting 是会议（id 是会议 id），
 * mission_card 是个人 Mission Card（id 是任务卡 id，拍板人那一侧没有具体某张卡时是轮次 id，round = true），role 是岗位修改建议（id 是建议 id）。
 */
export const WaitingTarget = Type.Object({
  kind: Type.Union([Type.Literal("card"), Type.Literal("topic"), Type.Literal("task"), Type.Literal("meeting"), Type.Literal("mission_card"), Type.Literal("role")]),
  id: Type.String({ minLength: 1 }),
  round: Type.Optional(Type.Boolean()),
}, strict);

/**
 * 一件等你的事。id 稳定（同一件事每次一样），界面拿它做 key。title 是要你定的事，source 是小字（出自哪个子会话和 Task、哪场会、哪个战场）。
 * taskId：属于哪件 Task（Task 一行的「1 件等你」和 Task 管线里的提醒用），不属于为 null。
 * sessionId、deviceId：子会话那几种（approval、question）是哪个本机会话、在哪台电脑上；在这台电脑上的，网页就地批准、回答（本机程序接口），别处的只能打开看。
 */
export const WaitingItem = Type.Object({
  id: Type.String({ minLength: 1 }),
  kind: WaitingKind,
  title: Type.String({ minLength: 1 }),
  source: Nullable(Type.String()),
  at: Nullable(Instant),
  open: WaitingTarget,
  taskId: Nullable(Type.String({ minLength: 1 })),
  sessionId: Nullable(Type.String({ format: "uuid" })),
  deviceId: Nullable(Type.String({ format: "uuid" })),
}, strict);

/**
 * GET /api/me/work-home（DRI 工作台）：左栏的树和首页的「等你」一次给全。
 * missions：本人这个月的 Mission（没有时回退到最近一个月，和本月页一样），每个下面是本人负责的 Task；
 * other.subSessions：不归任何 Task（或 Task 不在这个月的树上）的子会话，左栏最下面一组「其他」；
 * 子会话列没完成的，和这个月完成的。waiting：等你，最新的在前。
 */
export const WorkHomeResponse = Type.Object({
  missions: Type.Array(HomeMission),
  other: Type.Object({ subSessions: Type.Array(SubSession) }, strict),
  waiting: Type.Array(WaitingItem),
}, strict);

/**
 * 后台任务：不用对话的那些。plan 规划员拆卡、verify 验收员验收、merge 合回（只在本机，云端不列）、
 * subagent 子会话里 Claude Code 开的子 agent、command 子会话里的后台命令（本机程序报的 background 同步条目）。
 */
export const BackgroundKind = Type.Union([Type.Literal("plan"), Type.Literal("verify"), Type.Literal("merge"), Type.Literal("subagent"), Type.Literal("command")]);

/** queued 已排队（本机等空位）、running 进行中、done 完成、failed 失败、stopped 被停了（本人点停止，或会话停了没交结果）。 */
export const BackgroundState = Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("done"), Type.Literal("failed"), Type.Literal("stopped")]);

/**
 * 一个后台任务。id：plan:<会话 id>、verify:<会话 id>、bg:<会话 id>:<Claude Code 的 task_id>，在列表里唯一。
 * sessionId 是哪个本机会话（规划员、验收员是它自己，子 agent 和后台命令是开它的那个子会话），itemId 是本机的后台任务 id（只有 subagent、command）。
 * stoppable：这一项现在能停（还在跑）。停只能在 deviceId 那台电脑上经本机程序停（规划员、验收员停会话，子 agent 和后台命令用 stopBackground），云端和手机只显示。
 * taskId、cardId、topicId：挂在哪件 Task、哪张卡、哪个专题。
 */
export const BackgroundItem = Type.Object({
  id: Type.String({ minLength: 1 }),
  title: Type.String(),
  kind: BackgroundKind,
  state: BackgroundState,
  startedAt: Nullable(Instant),
  finishedAt: Nullable(Instant),
  stoppable: Type.Boolean(),
  sessionId: Nullable(Type.String({ format: "uuid" })),
  itemId: Nullable(Type.String({ minLength: 1 })),
  deviceId: Nullable(Type.String({ format: "uuid" })),
  taskId: Nullable(Type.String({ minLength: 1 })),
  cardId: Nullable(Type.String({ minLength: 1 })),
  topicId: Nullable(Type.String({ format: "uuid" })),
}, strict);

/**
 * GET /api/me/background?scope=…：右栏跟着展示区走，看哪条对话就列哪条开出去的后台任务。
 * scope：main（首页和总管线：本人全部）、task:<taskId>（Task 管线和 Task 详情：这件 Task 的规划员，加它下面各子会话的）、
 * card:<卡 id>（这张卡的验收员和它会话里的子 agent、后台命令）、topic:<专题 id>（这个专题会话里的）。
 * items：进行中的（按开始时间）在前，然后是今天（公司时区）结束的（新的在前）。resources 是右栏第一行：本机在不在线、几个位置用了几个、今天的花费（同 /api/me/workers）。
 * 云端的数据给手机用；在配对的电脑上，网页以本机程序的实时事件为准，合并进来。
 */
export const BackgroundResponse = Type.Object({
  items: Type.Array(BackgroundItem),
  resources: WorkerResources,
}, strict);
export const BackgroundQuery = Type.Object({
  scope: Type.String({ pattern: "^(main|task:.{1,128}|card:[0-9a-fA-F-]{36}|topic:[0-9a-fA-F-]{36})$" }),
}, strict);

/**
 * POST /api/me/tasks/:taskId/pipeline（Task 负责人）：这件 Task 的管线对话，第一次打开时建，以后都返回同一条（201 新建、200 已有）。
 * 收发消息、接上、停止都走现有的对话接口，scope 用这里给的 plan-task:<taskId>（/api/conversations/{scope}/messages 等）。
 * conversationId 是 Chat 服务里那段对话的 id（没接 Chat 时是天枢自己的对话 id），只作标识，网页不用拿它调 Chat。
 */
export const TaskPipelineResponse = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  conversationId: Type.String({ minLength: 1 }),
  scope: Type.String({ minLength: 1 }),
}, strict);

/** POST /api/me/route：首页输入框选「自动」时，这一句发给谁。 */
export const RouteRequest = Type.Object({ text: Type.String({ minLength: 1, maxLength: 20_000 }) }, strict);

/**
 * 发给谁：main 是伙伴的总管线；{ taskId } 是那件 Task 的管线。先不用模型：句子里提到了哪件 Task 名字或标准里的词，就发给那件；
 * 提到的词几件 Task 都有、分不出来，或什么都没提到，发给伙伴。
 */
export const RouteResponse = Type.Object({
  target: Type.Union([Type.Literal("main"), Type.Object({ taskId: Type.String({ minLength: 1 }) }, strict)]),
}, strict);

/**
 * 一条「要开工」（第 4.4 节）：卡（kind = card，cardId）或专题（kind = topic，topicId）。taskId 是挂的 Task（专题可以不挂）。
 * 来自管线里定了的计划（派活单上选了「就按这个开始」，接受草稿时带 start: true）或伙伴开的探索子会话。
 */
export const SessionStartView = Type.Object({
  id: Type.String({ format: "uuid" }),
  kind: Type.Union([Type.Literal("card"), Type.Literal("topic")]),
  cardId: Nullable(Type.String({ format: "uuid" })),
  topicId: Nullable(Type.String({ format: "uuid" })),
  taskId: Nullable(Type.String({ minLength: 1 })),
  requestedAt: Instant,
}, strict);

/**
 * POST /api/me/session-starts/claim：配对的电脑上开着的网页认领还没人接的「要开工」，回的就是这次认领到的（别的标签页、别的电脑同时认领，一条只给一处）。
 * deviceId 是这台电脑的本机程序 id（本机 GET /v1/status），要是本人没吊销的设备。网页拿到后照常取交代、一批交给本机程序；
 * 本机报上第一条这张卡或专题的执行，这条就了结。开不起来（本机拒了）时 POST /api/me/session-starts/:id/release 放回去；
 * 认领了 5 分钟还没了结的，别处可以再认领（网页认领后关掉了）。
 */
export const ClaimSessionStartsRequest = Type.Object({ deviceId: Type.String({ format: "uuid" }) }, strict);
export const ClaimSessionStartsResponse = Type.Object({ starts: Type.Array(SessionStartView) }, strict);

/**
 * 伙伴开探索子会话（工具 open_topic，/internal/me/topics，照 /internal 的 INTERNAL_CHAT_TOKEN 加 X-Owner-Id，不进公开 OpenAPI）：
 * 建一个专题并登记要开工，不用本人同意。planTaskId 是归到哪件 Task（本人负责的）；不归任何 Task 不带，子会话挂在「其他」。
 */
export const BuddyOpenTopicRequest = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 60 }),
  planTaskId: Type.Optional(Type.String({ minLength: 1 })),
}, strict);
export const BuddyOpenTopicResponse = Type.Object({ topicId: Type.String({ format: "uuid" }), start: SessionStartView }, strict);

export type TSubSessionState = Static<typeof SubSessionState>;
export type TSubSessionWaiting = Static<typeof SubSessionWaiting>;
export type TSubSession = Static<typeof SubSession>;
export type THomeTaskSummary = Static<typeof HomeTaskSummary>;
export type THomeTask = Static<typeof HomeTask>;
export type THomeMission = Static<typeof HomeMission>;
export type TWaitingKind = Static<typeof WaitingKind>;
export type TWaitingTarget = Static<typeof WaitingTarget>;
export type TWaitingItem = Static<typeof WaitingItem>;
export type TWorkHomeResponse = Static<typeof WorkHomeResponse>;
export type TBackgroundKind = Static<typeof BackgroundKind>;
export type TBackgroundState = Static<typeof BackgroundState>;
export type TBackgroundItem = Static<typeof BackgroundItem>;
export type TBackgroundResponse = Static<typeof BackgroundResponse>;
export type TBackgroundQuery = Static<typeof BackgroundQuery>;
export type TTaskPipelineResponse = Static<typeof TaskPipelineResponse>;
export type TRouteRequest = Static<typeof RouteRequest>;
export type TRouteResponse = Static<typeof RouteResponse>;
export type TSessionStartView = Static<typeof SessionStartView>;
export type TClaimSessionStartsRequest = Static<typeof ClaimSessionStartsRequest>;
export type TClaimSessionStartsResponse = Static<typeof ClaimSessionStartsResponse>;
export type TBuddyOpenTopicRequest = Static<typeof BuddyOpenTopicRequest>;
export type TBuddyOpenTopicResponse = Static<typeof BuddyOpenTopicResponse>;
