import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { BUDDY_ACTION_NAMES, BuddyActionResult, BuddyPlan, BuddyUiEffect, type BuddyActionName } from "./buddyActions.js";
import { ConversationCard, LocalFallbackReason } from "./conversations.js";
import { LocalAgentKind } from "./localRunner.js";
import { ModelEffort, ProjectDetailResponse } from "./projects.js";
import { SubSession } from "./workHome.js";

/**
 * 项目对话：电脑在线时在本机跑，不在线时退回云端（设计稿 17.2 第 38 条，方案《项目对话本机跑_架构与分工_2026-11-10》第 3、4 节）。
 *
 * 一段对话一处存全文，仍在 Chat：云端跑的轮次照旧由 Chat 写；本机跑完的一轮，由天枢 api 调 Chat 的「补记一轮」写进同一段（见文末 Chat 那一节），
 * Chat 的轮次 id 就用这里的 turnId，所以伙伴动作的审计、选项框、步骤清单、转达卡都按 turnId 记，读回历史时照现有 runExtras 接到那一轮上。
 *
 * 每一轮在哪跑（11/10 用户定的三处默认）：
 * - 电脑上的天枢网页连得上本机程序 → 交给本机；手机、电脑关着、本机程序没开 → 走云端（网页照旧 POST /api/conversations/project:<id>/messages）。
 * - 本机起不来、本机那家订阅额度用完 → 本机放掉这一轮（finish 带 status = released），网页把同一句改发云端，请求里带 fallback（ConversationMessageRequest.fallback），
 *   读回历史时那一轮标着 fallback，网页在旁边写一行这一轮用的是云端。
 * - 伙伴转来的话、子会话回报（【伙伴转来】【子会话回报】开头的那几轮）是云端自己发的，一律在云端跑。
 * - 本机第一版没有本体、会议、长期记忆这几样（Chat 自带的工具）；要用时那一轮在云端还是有的。
 *
 * 同一段对话同一时间只跑一轮，不管在本机还是云端：
 * - 本机开始一轮时（POST LOCAL_PROJECT_TURNS_PATH）天枢占住；云端在回（Chat 里有 running 的轮次）或别的电脑占着，回 409 TURN_IN_PROGRESS（runningOn 说是哪边）。
 * - 本机占着时，云端发消息（网页、伙伴转来、子会话回报）回 409 TURN_IN_PROGRESS；伙伴转来、子会话回报照旧隔几秒再试，最多等 10 分钟。
 *   电脑上的网页要「中途插话」时：在跑的是本机那一轮，交给本机自己处理（D）；在跑的是云端那一轮，网页先照旧请云端停下（POST …/turns/:runId/stop），再交给本机。
 * - 本机占着时，读历史（GET /api/conversations/project:<id>）多回一个 localTurn（ConversationHistory.localTurn），手机上据此画「正在回答」和本人那一句。
 *   手机上第一版停不了本机那一轮。
 * - 占着要续：本机每 heartbeatSeconds 秒报一次心跳；超过 expiresAfterSeconds 秒没心跳，天枢当这一轮丢了（本机程序挂了），放开给下一轮，之后这一轮的心跳、结束都回 409 LOCAL_TURN_EXPIRED。
 *
 * 鉴权：开始、心跳、结束是本机程序调的（和同步一样，Authorization: Bearer <本机设备令牌>），不在网页的 OpenAPI 里。
 * 本机项目会话里的 Claude Code / Codex 只拿项目钥匙（见下），挂天枢 MCP 用；它调不了开始、结束。
 * 【待 D 确认】开始由本机程序调，而不是网页调：这样上下文直接交到本机、项目钥匙不经过浏览器。网页把本人这句交给本机（D 的本机接口），本机调开始；
 * 开始回 409 时本机把原因回给网页，网页照旧画「正在回答」或改发云端。
 */

const strict = { additionalProperties: false } as const;
const Instant = Type.String({ format: "date-time" });
const Uuid = Type.String({ format: "uuid" });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

// ───────────────────────── 项目钥匙 ─────────────────────────

/**
 * POST LOCAL_PROJECT_KEY_PATH（本机设备令牌）：给这台电脑上一个项目的项目会话发一把天枢 MCP 钥匙。本机起项目会话时取，经子进程环境变量交给 Claude Code / Codex
 * （同现在挂天枢 MCP 的做法：不写进文件、不进命令行），连的还是 /mcp/me。
 * - 只对「这个人、这个项目、这台电脑」有效：本人还是项目负责人、项目没归档没删、这台电脑没吊销才能用；转交出去、归档、删掉、吊销电脑当场失效。
 *   同一台电脑同一个项目再取一次，旧的那把作废。30 天过期（expiresAt），过期前本机自己再取。钥匙只在这一次返回，天枢只存摘要。
 * - 能用的工具（MCP tools/list）：本机设备令牌能用的那些读工具（执行事项、Task 上下文、约定与对表、联网搜索等，写的照旧不列），加项目动作（PROJECT_MCP_TOOLS）。
 * - 项目动作照本人的伙伴授权，和云端项目对话一样：没完全授权时只列读的和 update_plan、ask_user，写的不列、调了回 BUDDY_NOT_AUTHORIZED；
 *   写动作照旧记审计（buddy_actions），能撤的照旧在「伙伴做过的事」里撤。动作的对象不限于这个项目（同云端：建项目、给别的项目改名也行），
 *   「这个项目」决定的是：按字母找子会话（sub_session_*）在哪个项目里找、审计和选项框记在哪段对话、哪一轮。
 * - 这一轮：项目动作执行时，天枢把这个项目正占着的本机那一轮（没有就是 null）当成这次调用的 runId，选项框、步骤清单、转达卡都记在这一轮上；
 *   没占着时 ask_user 回 409 NO_TURN、update_plan 只记不显示（同云端没带 runId）。
 * 错误：404 PROJECT_NOT_FOUND（没有、不是本人的、归档了、删了），401 设备令牌不对或吊销了。
 */
export const LOCAL_PROJECT_KEY_PATH = "/api/local-runner/project-keys";
export const LocalProjectKeyRequest = Type.Object({ projectId: Uuid }, strict);
export const LocalProjectKeyResponse = Type.Object({
  /** 钥匙本身（Bearer），只这一次给。 */
  token: Type.String({ minLength: 16 }),
  expiresAt: Instant,
  /** 天枢 MCP 的地址（同 /mcp/me 的完整地址）。 */
  mcpUrl: Type.String({ minLength: 1 }),
}, strict);

/**
 * 项目会话的天枢 MCP 里多出的工具：就是给 Chat 用的那套伙伴动作（buddyActions.ts，名字、参数、说明原样），去掉两样，加一个读更早的对话。
 * - 去掉 open_page（只动网页界面，本机那一轮网页直接从本机读）和 message_project（已经在项目对话里，用不着转）。
 * - ask_user（选项框）、update_plan（步骤清单）留着：云端和本机说话口径一致（共用规矩里都是「用 ask_user 出选项框」「用 update_plan 列清单」）。
 *   天枢照云端的做法存下（按这一轮的 turnId），工具结果里带 card / plan（见 ProjectMcpToolResult），本机可以当场转给网页画；读回历史时照旧接在那一轮上。
 *   【待 D 确认】本机项目会话关掉 Claude Code 自带的 AskUserQuestion、TodoWrite（Codex 的对应工具），只用这两个；
 *   ask_user 调完这一轮就结束（规矩里写了），本人的回答作为下一句发来、带 buddyQuestionId（同云端）。
 *   另一种做法：用本机自带的问答和清单（子会话现在的做法），结束时把清单和问题交给天枢存——两边口径就要各写一份，不推荐。
 * - read_earlier_conversation：读更早的对话（开始时只带了最近几轮），见 ReadEarlierConversationParams。
 */
export const PROJECT_MCP_EXCLUDED_ACTIONS = ["open_page", "message_project"] as const;
export const PROJECT_MCP_ACTIONS = BUDDY_ACTION_NAMES.filter((name) => !(PROJECT_MCP_EXCLUDED_ACTIONS as readonly string[]).includes(name)) as BuddyActionName[];
export const READ_EARLIER_CONVERSATION_TOOL = "read_earlier_conversation";
export const PROJECT_MCP_TOOLS = [...PROJECT_MCP_ACTIONS, READ_EARLIER_CONVERSATION_TOOL] as const;

/**
 * 项目动作的工具结果（MCP 的 text 内容是它的 JSON）：同 Chat 拿到的 BuddyActionResult，多带这一下要画的东西：
 * card 是出的卡（ask_user 的选项框、send_message 的转达卡），plan 是 update_plan 交的整张清单（写动作做成后天枢自动打勾的那一版也在这里），
 * ui 是做完这个动作界面上要跟着变的（同云端对话流的 ui 事件，按先后；没有就不带）：本机原样转给网页，网页据此重读那几块。
 * 这三样只在这个项目有一轮本机的在跑时才有（都按那一轮记）。出错时 isError = true，内容是 { code, message }（同云端的错误码和中文）。
 */
export const ProjectMcpToolResult = Type.Object({
  ...BuddyActionResult.properties,
  card: Type.Optional(ConversationCard),
  plan: Type.Optional(BuddyPlan),
  ui: Type.Optional(Type.Array(BuddyUiEffect)),
}, strict);

/** 一轮对话（开始时带的最近几轮、read_earlier_conversation 读到的都是这个）。 */
export const ProjectTurnRecord = Type.Object({
  /** 这一轮的 id（Chat 的轮次 id；本机跑的就是当时的 turnId）。本机据此知道哪几轮项目会话自己已经有了。 */
  runId: Type.String({ minLength: 1 }),
  at: Instant,
  ranOn: Type.Union([Type.Literal("cloud"), Type.Literal("local")]),
  /** 在哪跑、用的什么，给人看的一句（「本机 · Claude Code · Opus 5.5」「云端 · claude-opus-5-5」）；不知道为 null。 */
  source: Nullable(Type.String()),
  /** 本人那句不是本人在网页里说的：buddy 伙伴转来、report 子会话回报、feishu / wechat 在飞书、微信里说的。 */
  via: Type.Optional(Type.Union([Type.Literal("buddy"), Type.Literal("report"), Type.Literal("feishu"), Type.Literal("wechat")])),
  user: Type.String(),
  /** 助手的回答（没写完的是已写出的部分）。 */
  assistant: Type.String(),
  status: Type.Union([Type.Literal("completed"), Type.Literal("aborted"), Type.Literal("failed")]),
  /** 这一轮在天枢里做成的写动作（审计里的 summary，按先后）。 */
  actions: Type.Array(Type.String()),
}, strict);

/**
 * read_earlier_conversation 的参数：beforeRunId 之前的 turns 轮（默认 10，最多 20）；不带 beforeRunId 从最新一轮往前读。
 * 结果：{ turns: ProjectTurnRecord[]（从早到晚）, earlier: 再往前还有几轮 }。
 */
export const ReadEarlierConversationParams = Type.Object({
  beforeRunId: Type.Optional(Type.String({ minLength: 1 })),
  turns: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
}, strict);
export const ReadEarlierConversationResult = Type.Object({ turns: Type.Array(ProjectTurnRecord), earlier: Type.Integer({ minimum: 0 }) }, strict);

// ───────────────────────── 本机一轮：开始、心跳、结束 ─────────────────────────

/** 执行方和模型：执行方、给人看的模型名（「Opus 5.5」）、模型 id（有就带）、思考程度（有就带）。来源那一句由天枢拼：「本机 · Claude Code · Opus 5.5」。 */
export const LocalProjectExecutor = Type.Object({
  agent: LocalAgentKind,
  modelLabel: Type.String({ minLength: 1, maxLength: 60 }),
  modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  effort: Type.Optional(ModelEffort),
}, strict);

/**
 * POST LOCAL_PROJECT_TURNS_PATH（本机设备令牌）：本机要开始项目对话的一轮。
 * - clientTurnId：本机给这一轮起的 id，重试沿用；同一个 id 再来回同一轮（不重复占），内容不一样回 409 IDEMPOTENCY_CONFLICT。
 * - message：本人这一句（第一版只有文字；带附件的这一句网页改发云端）。buddyQuestionId：这一句是在回答哪个选项框（同 ConversationMessageRequest.buddyQuestionId），
 *   那张标 answered，这段对话里其余还开着的标 dismissed（同云端）。
 * 项目对话还没建时先建（同 POST /api/me/projects/:projectId/pipeline）。
 * 错误：404 PROJECT_NOT_FOUND；409 TURN_IN_PROGRESS（body 多一个 runningOn：cloud 云端在回、local 别的电脑或这台电脑的另一轮占着）；
 * 409 CHAT_NOT_CONNECTED（没接 Chat 服务，存不下这一轮，网页照旧走云端）。
 */
export const LOCAL_PROJECT_TURNS_PATH = "/api/local-runner/project-turns";
export const LocalProjectTurnStartRequest = Type.Object({
  projectId: Uuid,
  clientTurnId: Uuid,
  message: Type.String({ minLength: 1, maxLength: 20_000 }),
  buddyQuestionId: Type.Optional(Uuid),
  executor: LocalProjectExecutor,
}, strict);

/**
 * 开始的回答：
 * - turnId：这一轮的 id（以后心跳、结束、读历史都用它；也是写进 Chat 的那一轮的 id）。scope 是 project:<projectId>。
 * - context：接上下文用。recent 是最近几轮（最多 8 轮、总共约 4 万字以内，从早到晚，不含这一轮），原样带过去；earlier 是更早还有几轮，要用时用 read_earlier_conversation 翻。
 *   project 是项目情况：项目和目标（同 GET /api/me/projects/:projectId）、这个项目里的子会话（同首页的 SubSession，带字母和状态）。
 *   【待 D 确认】项目会话一直开着时，recent 里它自己已经有的那几轮（runId 对得上）不用再塞；上一轮在云端、或刚换了执行方时才把 recent 交给它。和子会话 Claude ↔ Codex 互换用同一套。
 * - rules：项目对话的共用规矩（PROJECT_CONVERSATION_RULES），放进本机项目会话的角色提示里。天枢改了规矩，下一轮开始时就是新的。
 * - lease：心跳间隔和多久没心跳算丢了。
 */
export const LocalProjectTurnStartResponse = Type.Object({
  turnId: Uuid,
  scope: Type.String({ minLength: 1 }),
  startedAt: Instant,
  context: Type.Object({
    recent: Type.Array(ProjectTurnRecord),
    earlier: Type.Integer({ minimum: 0 }),
    project: Type.Object({ ...ProjectDetailResponse.properties, subSessions: Type.Array(SubSession) }, strict),
  }, strict),
  rules: Type.String({ minLength: 1 }),
  lease: Type.Object({ heartbeatSeconds: Type.Integer({ minimum: 1 }), expiresAfterSeconds: Type.Integer({ minimum: 1 }) }, strict),
}, strict);
export const LocalProjectTurnBusy = Type.Object({
  code: Type.Literal("TURN_IN_PROGRESS"),
  message: Type.String(),
  runningOn: Type.Union([Type.Literal("cloud"), Type.Literal("local")]),
}, strict);

/**
 * POST LOCAL_PROJECT_TURNS_PATH/:turnId/heartbeat（本机设备令牌，空 body {}）：还在跑，204。
 * 过了 expiresAfterSeconds 没心跳、已经被放开的回 409 LOCAL_TURN_EXPIRED；已经结束的回 409 LOCAL_TURN_FINISHED；不是这台电脑的 404。
 */
export const LocalProjectTurnParams = Type.Object({ turnId: Uuid }, strict);

/**
 * POST LOCAL_PROJECT_TURNS_PATH/:turnId/finish（本机设备令牌）：这一轮结束了。天枢把它写进 Chat（本人那句、助手的回答、来源、这一轮做成的动作），放开这段对话。
 * - status：completed 答完；aborted 本人停下（answer 是已写出的部分）；failed 出错停住（answer 是已写出的部分，errorCode 一个短码）；
 *   released 没跑成（本机起不来、额度用完）：不写进 Chat、这一轮当没发生，reason 说为什么，网页把同一句改发云端（带 fallback = reason）。
 *   这一轮里已经做成的写动作照旧留在审计里，released 时网页提醒一句「有几件已经做了」由 W 定。
 * - answer：助手的回答全文（Markdown，最多 10 万字）；released 时不带。
 * 做过的动作不用本机报：天枢按这一轮的审计（buddy_actions）转成文字一起写进 Chat（Chat 拼进给模型看的历史，网页不画）。
 * 回 200 LocalProjectTurnFinishResponse。重复结束同一轮回同样的结果（幂等）。409 LOCAL_TURN_EXPIRED：已经因为没心跳被放开，这一轮的回答不再写进去（本机丢掉）。
 * 写进 Chat 失败（Chat 连不上、Chat 那边刚好有一轮在跑）时天枢自己隔几秒再写，最多 10 分钟，结束接口不等它：recorded 为 false，读历史时这一轮先按 localTurn 显示。
 */
export const LocalProjectTurnFinishRequest = Type.Object({
  status: Type.Union([Type.Literal("completed"), Type.Literal("aborted"), Type.Literal("failed"), Type.Literal("released")]),
  answer: Type.Optional(Type.String({ maxLength: 100_000 })),
  errorCode: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
  reason: Type.Optional(LocalFallbackReason),
}, strict);
export const LocalProjectTurnFinishResponse = Type.Object({ turnId: Uuid, recorded: Type.Boolean() }, strict);

// ───────────────────────── 共用规矩 ─────────────────────────

/**
 * 项目对话的共用规矩：Chat 里给项目对话的那几段（csl-actions src/prompt.ts 的 BUDDY_ACTION_RULES，加上项目对话专有的），整理成一份，本机项目会话放进角色提示。
 * Chat 那份是抄过去的，两边改一处要跟着改另一处。工具名、参数、每个动作怎么用写在各工具的说明里（两边是同一份），这里只写说话和做事的口径。
 */
export const PROJECT_CONVERSATION_RULES = `# 你是谁
你是本人在天枢里的一个项目对话：管这一个项目，帮本人把话想清楚、把活派出去、把进展说清楚。项目的长活由这个项目里的子会话（卡、专题，按字母 A、B、C 叫）去做，你负责安排、跟进和回报。

# 每一轮都要短
先用一句话回应本人，再去做。写代码、长调研这类要花时间的活，用 split_cards 拆卡或用 start_sub_session、sub_session_restart 交给子会话去做，不在一轮里自己长时间做；本人插话时，已经派出去的活照常跑。
要改子会话手上的活、给它补一句话，用 sub_session_tell 按字母转给它；它在问问题、等批准时，本人表了态才用 sub_session_answer、sub_session_approve 替本人答，本人没说就不替本人选、不批。
要知道项目里有哪些子会话、各自到哪一步，用 read_work_home 或 read_project 读，不凭记忆说。

# 代本人在天枢里做事
来自天枢的动作（读首页和项目、开工或停掉子会话、拆卡、建项目和转交、发消息等）由天枢按本人自己的权限执行。本人要你在天枢里做本人能做的事时，直接调用对应动作，不说做不到，也不让本人自己去点。动作做成后照返回的 summary 用一句话告诉本人做了什么；undoable=true 时可以顺带说能撤销。没有成功返回，不说已经做了。
要做两步以上的事时，先用 update_plan 交一张完整清单，每做完一步再交一次整张清单（做完的标 completed，正在做的标 in_progress）；聊天和只做一步的事不交清单。
开工前要本人拍板、或者有几种做法可选时，用 ask_user 出选项框，不把问题写成一段话让本人自己组织回答；建项目、拆卡之前一定先问清现实（在哪个文件夹、哪个目录开工，是不是从别处迁过来的，要不要连 GitHub，做成的样子是不是本人要的）。调完 ask_user 这一轮就结束，等本人回答。
用 send_message 给同事发消息时，天枢会先出一张卡让本人确认，本人点「发出」才发；回答里说已经起好、请本人看一眼再发，不说已经发出。
本人没有授权时，动作里只有读的，只能帮本人看；动作返回 BUDDY_NOT_AUTHORIZED、DAILY_LIMIT 或其他错误时，按返回的错误说明照实告诉本人没做成和原因，不换别的动作绕过。动作没有返回结果（网络断了、工具出错）时，说这一步结果还没确认，请本人到天枢看一眼，不说做成也不说没做成，不重复调用同一个写动作。

# 对话里的几种话
以「【伙伴转来】」开头的，是本人在伙伴那边说、伙伴转给这个项目的话，照本人的话办，做完、出问题或要本人拿主意时在这里说。
以「【子会话回报】」开头的，是某个子会话停了、天枢替本人发来的报告：说一句这意味着什么、下一步怎么办，该转话、重开、换人做的直接安排；要本人拿主意的用 ask_user 问。
更早的对话没带全时，要用到再用 read_earlier_conversation 往前翻，不猜以前说过什么。

# 怎么说话
用自然、平实的中文，第一句进入正题，不客套、不用模型腔。先给明确的判断或做了什么，再按需要说理由和下一步；简单确认不为变长而扩写。工具过程和处理状态不拼进回答。给本人的文字不写 CEO、DRI 等内部缩写。`;

// ───────────────────────── Chat 的「补记一轮」（csl-actions，只本地提交） ─────────────────────────

/**
 * 天枢 api 调 Chat：POST /conversations/:id/recorded-turns（照现有 Chat 鉴权：Bearer INTERNAL_CHAT_TOKEN、x-owner-id、x-viewer-role）。
 * 把在别处跑完的一轮写进这段对话：一行 turn、本人和助手两条消息（answer 为空时只有本人那条），带来源和这一轮做成的动作。
 * - runId：这一轮的 id，天枢给（就是 turnId），Chat 的 turns.id 就用它；clientRequestId 同 /turns 的幂等键（天枢用 local:<turnId>）。
 *   同一个 clientRequestId 再来回同一轮（duplicate = true）；换了内容回 409 IDEMPOTENCY_CONFLICT；runId 已被别的轮次用了回 409 RUN_ID_TAKEN。
 * - 一段对话同一时间只跑一轮的保护照旧：这段对话有 running 的轮次时回 409 TURN_RUNNING（天枢隔几秒再写）。
 * - status 同 Chat 轮次的终态；startedAt、finishedAt 记成这一轮的 created_at、finished_at。
 * - source：{ kind: "local", label: "本机 · Claude Code · Opus 5.5" }，存在轮次上，读历史时这一轮的两条消息、runs 都带 source；云端自己跑的不带。
 * - actions：这一轮在天枢里做成的写动作（name 动作名，summary 天枢给的一句话），存在轮次上；给模型看的历史里拼在助手那条后面
 *   （「（这一轮在本机跑，做了：……）」），读历史的接口不拼。
 * 回 200 RecordedTurnResponse。对话不存在、不是这个人的 404。
 */
export const ChatRecordedTurnRequest = Type.Object({
  runId: Uuid,
  clientRequestId: Type.String({ minLength: 1, maxLength: 200 }),
  message: Type.String({ minLength: 1, maxLength: 100_000 }),
  answer: Type.String({ maxLength: 100_000 }),
  status: Type.Union([Type.Literal("completed"), Type.Literal("aborted"), Type.Literal("failed")]),
  errorCode: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
  startedAt: Instant,
  finishedAt: Instant,
  source: Type.Object({ kind: Type.Literal("local"), label: Type.String({ minLength: 1, maxLength: 80 }) }, strict),
  actions: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 60 }), summary: Type.String({ minLength: 1, maxLength: 300 }) }, strict),
    { maxItems: 50 }),
}, strict);
export const ChatRecordedTurnResponse = Type.Object({
  runId: Uuid,
  userMessageId: Uuid,
  assistantMessageId: Nullable(Uuid),
  duplicate: Type.Boolean(),
}, strict);

export type TLocalProjectKeyRequest = Static<typeof LocalProjectKeyRequest>;
export type TLocalProjectKeyResponse = Static<typeof LocalProjectKeyResponse>;
export type TProjectMcpToolResult = Static<typeof ProjectMcpToolResult>;
export type TProjectTurnRecord = Static<typeof ProjectTurnRecord>;
export type TReadEarlierConversationParams = Static<typeof ReadEarlierConversationParams>;
export type TReadEarlierConversationResult = Static<typeof ReadEarlierConversationResult>;
export type TLocalProjectExecutor = Static<typeof LocalProjectExecutor>;
export type TLocalProjectTurnStartRequest = Static<typeof LocalProjectTurnStartRequest>;
export type TLocalProjectTurnStartResponse = Static<typeof LocalProjectTurnStartResponse>;
export type TLocalProjectTurnBusy = Static<typeof LocalProjectTurnBusy>;
export type TLocalProjectTurnFinishRequest = Static<typeof LocalProjectTurnFinishRequest>;
export type TLocalProjectTurnFinishResponse = Static<typeof LocalProjectTurnFinishResponse>;
export type TChatRecordedTurnRequest = Static<typeof ChatRecordedTurnRequest>;
export type TChatRecordedTurnResponse = Static<typeof ChatRecordedTurnResponse>;
