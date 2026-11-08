import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { CardSourceWordIssue } from "./taskCardView.js";
import { Budget } from "./budget.js";
import { LocalPermissionBrief, LocalPermissionMode, LocalQuestionRequestView } from "./localRunner.js";
import { PersonRef, ProjectTransfer } from "./projectTransfers.js";
import { RoleRef } from "./roles.js";
import { WorkerQueueReason, WorkerResources } from "./workers.js";

/**
 * 新首页：伙伴总管线 + 项目（每月目标挂在项目上，第 16 节）+ 子会话（设计《新首页_伙伴总管线与Task管线_2026-11-07》第 2、4、7、16 节）。
 *
 * - 子会话：本机程序里能对话的会话，只有执行（卡）和探索（专题）两种；规划员、验收员、合回不算子会话，是后台任务。
 * - 项目对话（第 16 节，替换原来的 Task 管线）：每个项目一条单独的伙伴对话，scope 是 project:<projectId>（conversations.ts 的 ConversationScope），
 *   和总管线（global）各是各的历史；接了 Chat 服务时是 Chat 里单独的一段对话，天枢记「项目 → 对话」的对应。项目和每月目标见 projects.ts。
 * - 自动开工（第 4.4 节）：管线里定了计划（派活单上选了「就按这个开始」）或伙伴开了探索子会话，云端只记一条「要开工」，
 *   由这台电脑上开着的天枢网页认领后拉起本机程序（和登记拆卡 → 网页开规划员同一条路，云端不指挥本机）；
 *   网页没开（比如在手机上）就一直排着，界面写「等本机上线」，下次在电脑上打开天枢就自己开。
 * - 验收在项目对话（第 4.5、16.3 节）：本机验收员自动验；过了、受阻、约定都达到这几件事，网页按时间插进项目对话（GET /api/me/projects/:projectId/feed），
 *   总管线只看各项目的汇总（summary 的 doneToday、needsYou）。验收过的卡本机自动合回，合不了的等你合（子会话 waiting = merge）。
 * - 不按月份硬切（11/07 用户定）：月份只是检查点。项目常驻；项目下的目标是挂着的「没了结」的 Task：本月 Mission 下本人负责的，
 *   加之前月份里本人负责、还没了结、在天枢里动过的。了结 = 本人确认完成（completedAt）、到此为止、或已延续成新月份的一件 Task。
 *   子会话、项目对话、后台任务都不看月份。
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
 * 对到卡和专题上：带岗位还没开工的、本机报等空位或等前面的卡的 → queued；验收中 → running；验收通过（已合回，或不用合）→ done；
 * 验收通过但没能自动合回 → waiting（merge）；验收没过、改法还没送回执行方 → failed；等你批准、等你回复、受阻、已暂停 → waiting。
 * 卡的会话停下了或异常退出了（还没交回、没在等额度）算已暂停；连续两次异常退出也是已暂停（不是验收没过）。
 * 一轮做完停下、没在问你（本机报 idle 不带 question）也是已暂停（网页写「已停下」），不是等你：卡照常交回进验收，单独开的子会话等你想接着时说一句。
 * 专题没有「完成」：会话停下了、异常退出了都算已暂停（waiting），归档后不列。
 * done 的子会话网页收进 Task 下面折叠的「已完成 N」，不删，点开还能看。
 */
export const SubSessionState = Type.Union([Type.Literal("queued"), Type.Literal("running"), Type.Literal("waiting"), Type.Literal("done"), Type.Literal("failed")]);

/**
 * 等你什么（只有 state = waiting 时可能有）：approval 等你批准（本机有权限请求没答）、question 执行方在问你（本机报 idle 带 question；一轮做完停下不算）、
 * verdict 验收结果等你拿主意（连续两次验收没过，受阻）、merge 验收过了但本机没能自动合回，等你合（「合进 main / 先不合」）。
 * 已暂停（停下了）也是等你（说一句就接着做），为 null。
 */
export const SubSessionWaiting = Type.Union([Type.Literal("approval"), Type.Literal("question"), Type.Literal("verdict"), Type.Literal("merge")]);

/**
 * 卡验收过以后的合回（第 4.5 节，本机程序报的 merge 同步条目 LocalMergeSync；同一次交回报了几条时以本机序号最大的那条为准）：
 * merged 已合进 baseBranch（commit 是合并后主文件夹上的提交）；needs_merge 没合，reason 说为什么（同本机契约 LocalMergeHoldReason：
 * base_not_checked_out 主文件夹不在原分支上、dirty 主文件夹有没提交的改动、conflict 有冲突、auto_merge_off 本人关了「验收过就合回」、
 * not_ready 卡还在跑或有后台任务在跑、交回以后又改过、工作树不在了等，message 写明是哪种），等你在这台电脑上合。
 * 卡不在工作树里做、或本机还没报，为 null。
 */
export const CardMerge = Type.Object({
  state: Type.Union([Type.Literal("merged"), Type.Literal("needs_merge")]),
  commit: Nullable(Type.String()),
  baseBranch: Nullable(Type.String()),
  reason: Nullable(Type.Union([Type.Literal("base_not_checked_out"), Type.Literal("dirty"), Type.Literal("conflict"), Type.Literal("auto_merge_off"),
    Type.Literal("not_ready")])),
  message: Nullable(Type.String()),
  at: Instant,
}, strict);

/**
 * 一个子会话。id 是卡的 id（执行事项）或专题的 id，kind 说是哪种。
 * queueReason：state = queued 时在等什么（worker 列表同一套：等开工、等空位、等本机上线、等前面的卡），别的为 null。
 * sessionId：最近一次本机执行（本机会话）的 id，没开过为 null；deviceId 是它在哪台电脑上。网页据此在那台电脑上接实时事件。
 * autoStart：已经登记了要开工、还没有哪台电脑接下（第 4.4 节）。在配对的电脑上开着的网页看到它就认领开工（POST /api/me/session-starts/claim）。
 * updatedAt：最近一次动静（本机报的、卡或专题改的），树上同一格按它排。
 * merge：只有卡，最近一次验收通过的交回合回到哪了（见 CardMerge）；专题、还没过的卡为 null。
 * holdUntil：queueReason = quota（订阅额度用完，停着等恢复）时恢复的时间，界面「等额度恢复 · HH:MM」；读不到或不在等为 null。
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
  merge: Nullable(CardMerge),
  holdUntil: Nullable(Instant),
}, strict);

/**
 * 一件 Task 下面几个子会话在哪一格：首页 Task 一行的「2 个在跑 · 1 件等你」。waiting 含没过的（failed）。
 * 总管线的汇总（第 4.5 节，首页 Task 行和伙伴的汇总都用）：doneToday 今天（公司时区）验收通过的子会话数；needsYou 等你里归这件 Task 的条数。
 */
export const HomeTaskSummary = Type.Object({
  running: Type.Integer({ minimum: 0 }),
  waiting: Type.Integer({ minimum: 0 }),
  queued: Type.Integer({ minimum: 0 }),
  done: Type.Integer({ minimum: 0 }),
  doneToday: Type.Integer({ minimum: 0 }),
  needsYou: Type.Integer({ minimum: 0 }),
}, strict);

/**
 * 自己做的执行事项（设计 9.10）：没有岗位、不交给 Agent 的事项，也挂在 Task 下面（行首是本人小头像），不算子会话、不能对话，点开是事项详情。
 * status 照执行事项（退回的不列）；dueDate 是截止日（YYYY-MM-DD，没写为 null）；awaitingAcceptance 是交了在等验收。
 */
export const HomeItem = Type.Object({
  id: Type.String({ format: "uuid" }),
  title: Type.String(),
  status: Type.Union([Type.Literal("not_started"), Type.Literal("in_progress"), Type.Literal("done")]),
  dueDate: Nullable(Type.String()),
  awaitingAcceptance: Type.Boolean(),
  updatedAt: Instant,
}, strict);

const Period = Type.String({ pattern: "^\\d{4}-(0[1-9]|1[0-2])$" });

/**
 * 项目行上的一件目标：挂着、没了结的 Task（本月的，加之前月份没了结的；本月的了结了照样列，completedAt 不为 null）。
 * 16.2 副标题「{月} 月 · {Task 名} · {截止} 验收」、项目页目标条的「名字、截止、标准 1/3」用它。
 * dueDate 是验收截止日（YYYY-MM-DD）：本体的 Task 没有截止日，取所在 Mission 的验收时间点（同首页「本月」：今天以后最近的那个，都过了取最后一个）；
 *   Mission 没写验收时间点时取它所在月份的最后一天。
 * criteriaMet / criteriaTotal：标准几条达到（每条至少一张对它的卡、最近一次有结论的交回算通过）/ 一共几条（本体没写标准时是完成定义那一条，都没有为 0）。
 * criteria 是标准原文（目标条点开逐条看）；completedAt 是本人确认完成的时间。
 * responsible（16.7）：Task 的负责人不是本人时是那个人（项目交接过来、Task 跟着项目走、负责人还是原来的人，目标条上画他的头像），是本人为 null。
 *   别人负责的那几件本体读不到标准时 criteria 为空、criteriaTotal 为 0。
 */
export const HomeProjectGoal = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  missionId: Type.String({ minLength: 1 }),
  name: Type.String(),
  period: Period,
  dueDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  criteria: Type.Array(Type.String()),
  criteriaMet: Type.Integer({ minimum: 0 }),
  criteriaTotal: Type.Integer({ minimum: 0 }),
  completedAt: Nullable(Instant),
  responsible: Nullable(PersonRef),
}, strict);

/**
 * 左栏一个项目（16.2，没归档的）：
 * - goals：挂着的目标（见 HomeProjectGoal），截止早的在前；空的就是「本月没有目标」。
 * - budget：挂着的 Task 里预算用到 80% 以上的（本机报的 budget 条目，取用得最多的那件），副标题优先写「预算 {percent}%」（--warning）；没有为 null。
 * - 副标题按这个顺序取第一个有的：budget → goals[0] →「本月没有目标 · {lastActivityAt}」。
 * - summary、planning、subSessions、items 的规矩同原来的 Task 行：子会话、事项是这个项目里的（挂着的 Task 下的，和直接放在项目里的）。
 * - pipeline.conversationId：项目对话，还没开过为 null（POST /api/me/projects/:projectId/pipeline 建）；scope 永远是 project:<projectId>。
 * - lastActivityAt：最近一次动静（子会话、事项、挂接、建项目），排序和副标题用。
 * - transfer（16.7）：正在转交的那一份（preparing、sent），副标题在 sent 时优先写「等 {名字} 接手」；没有为 null。
 */
export const HomeProject = Type.Object({
  projectId: Type.String({ format: "uuid" }),
  name: Type.String(),
  goals: Type.Array(HomeProjectGoal),
  budget: Nullable(Type.Object({ state: Type.Union([Type.Literal("warning"), Type.Literal("exhausted")]), percent: Type.Integer({ minimum: 0 }),
    taskId: Type.String({ minLength: 1 }) }, strict)),
  lastActivityAt: Instant,
  summary: HomeTaskSummary,
  pipeline: Type.Object({ conversationId: Nullable(Type.String({ minLength: 1 })), scope: Type.String({ minLength: 1 }) }, strict),
  planning: Type.Boolean(),
  subSessions: Type.Array(SubSession),
  items: Type.Array(HomeItem),
  transfer: Nullable(ProjectTransfer),
}, strict);

/** 首页「本月」里的一件 Task（16.4）：project 是挂在哪个项目（点了进项目）；没挂上为 null，网页画「挂到…」（选现有项目或新建）。 */
export const HomeMonthTask = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  name: Type.String(),
  completedAt: Nullable(Instant),
  project: Nullable(Type.Object({ projectId: Type.String({ format: "uuid" }), name: Type.String() }, strict)),
}, strict);
/** 「本月」按 Mission 分组：本人这个月的 Mission（本月没有就是本人最近一个月的，同「看得见的 Mission」），下面是本人负责的 Task。没有 Task 的 Mission 也列。 */
export const HomeMonthMission = Type.Object({
  missionId: Type.String({ minLength: 1 }),
  title: Type.String(),
  period: Period,
  tasks: Type.Array(HomeMonthTask),
}, strict);

/**
 * 等你：要本人拿主意、不拿就有事卡住的，才进来（设计 9.6）；只是让你知道的（群消息、协作进展、文档变更、雷达、第一次没过）不进。一件一行。
 * approval / question：子会话（或规划员、验收员）在等你批准、等你回复；verdict：卡连续两次验收没过（受阻）；
 * merge：卡验收过了但本机没能自动合回，等你在那台电脑上合（open 是卡，deviceId 是那台电脑）；
 * plan_start：规划员出了派活单，计划等你开工（open 是项目对话，就地「开工」= 接受草稿带 start）；
 * meeting：会议记录要你确认（你是责任人的决策、你负责的行动项、你主持的会要补归属或记录没生成），一场会一行；
 * mission_card：Mission Card 要你做的事（本人确认我的任务，或拍板人那一侧的待办），dueAt 是本人确认截止的时间；
 * acceptance：请你认可——别人的 Task 有一条约定由你来认，负责人请你看了（person 是对方，open 是只读的 Task 详情）；
 * role：岗位修改建议（采纳或不要）；
 * month：月份这个检查点要你做的（month.step：review 复盘、finalize 新月份的草稿到了待敲定、continue 之前月份还有没了结的 Task；open 是月份页）；
 * device：没有在线的电脑而有活在等本机（要开工的、等本机上线的），open 是连接页；这台电脑本机程序的状态（未配对、暂停中等）网页自己看本机程序，不靠这一条；
 * transfer（16.7）：别人把项目交给你（sent，to 是本人），title「{原负责人}把「{项目}」交给你」，person 是原负责人，open 是那份转交（只读预览，「接手」「不接」）；
 * quota：额度用完或预算到了，有活停着等你定：订阅额度用完时一台电脑一条「Claude 订阅额度用完 · HH:MM 恢复」，source 写停着几件，
 *   open 是连接页，dueAt 是恢复的时间（到点本机自己接着做；要不要换网关模型、开额外额度由你定）。预算（设计 11.4）以后再加。
 */
export const WaitingKind = Type.Union([
  Type.Literal("approval"), Type.Literal("question"), Type.Literal("verdict"), Type.Literal("meeting"), Type.Literal("mission_card"), Type.Literal("role"),
  Type.Literal("merge"), Type.Literal("plan_start"), Type.Literal("acceptance"), Type.Literal("month"), Type.Literal("device"), Type.Literal("quota"),
  Type.Literal("transfer"), Type.Literal("goal_changed"),
]);

/**
 * 去哪儿看：card、topic 是子会话（id 是卡或专题的 id），project 是项目对话（id 是项目 id），meeting 是会议（id 是会议 id），
 * mission_card 是个人 Mission Card（id 是任务卡 id，拍板人那一侧没有具体某张卡时是轮次 id，round = true），role 是岗位修改建议（id 是建议 id），
 * task_detail 是 Task 详情（别人的 Task 只读，id 是 Task id），month 是月份页（id 是 YYYY-MM），connections 是连接页（id 固定 "this_computer"），
 * transfer 是一份项目转交（id 是转交 id，GET /api/me/project-transfers/:id）。
 * focus（设计 14.3）：子会话（卡、专题、规划员、验收员）的提问和批准由项目对话转达，kind = project 时带上是哪个框：sessionId 是那个本机会话，
 * requestId 是那次提问或批准（同 WaitingItem.question / permission 的 requestId；老版本本机程序没报时为 null，定位到那个会话最新的框）。
 * 网页落在项目对话的那个框上，焦点放在推荐的选项上。不在任何项目里的子会话照旧打开子会话（card / topic），不带 focus。
 */
export const WaitingTarget = Type.Object({
  kind: Type.Union([Type.Literal("card"), Type.Literal("topic"), Type.Literal("project"), Type.Literal("meeting"), Type.Literal("mission_card"), Type.Literal("role"),
    Type.Literal("task_detail"), Type.Literal("month"), Type.Literal("connections"), Type.Literal("transfer")]),
  id: Type.String({ minLength: 1 }),
  round: Type.Optional(Type.Boolean()),
  focus: Type.Optional(Type.Object({ sessionId: Type.String({ format: "uuid" }), requestId: Nullable(Type.String({ minLength: 1 })) }, strict)),
}, strict);

/**
 * 能不能就地答（设计 9.6、5.7「等你在手机上」）：
 * inline 在这一行就能答，走云端，手机上也能（开工、岗位建议的采纳 / 不要）；
 * inline_local 在这一行答，但要本机程序办（批准、回答、合回）：只在 deviceId 那台电脑上画按钮，单选题才就地答（题目在本机，网页自己判断），
 *   手机和别的电脑上画「等你 · {deviceName}」，点开是只读摘要；
 * open 点开去答（受阻、会后确认、Mission Card、请你认可、月份、电脑、额度、项目转交）。
 */
export const WaitingAnswer = Type.Union([Type.Literal("inline"), Type.Literal("inline_local"), Type.Literal("open")]);

/**
 * 一件等你的事。id 稳定（同一件事每次一样），界面拿它做 key。title 是要你定的事，source 是小字（出自哪件 Task、哪场会、哪个战场）。
 * 子会话的提问和批准（approval、question）source 只写项目名（14.3），不在项目里的写子会话的名字。
 * taskId：属于哪件 Task，不属于为 null；projectId：属于哪个项目（项目行的「1 件等你」和项目对话里的提醒用），不属于为 null。
 * sessionId、deviceId、deviceName：子会话那几种（approval、question、merge）是哪个本机会话、在哪台电脑上；在这台电脑上的，网页就地批准、回答、合回（本机程序接口），别处的只能打开看。
 * dueAt：有截止时间的（Mission Card 本人确认截止、复盘窗口关闭）写上，网页离截止不到 24 小时换警告档；没有为 null。
 * person：acceptance 是请你认可的那个人（负责人），transfer 是交给你的那个人，别的为 null。month：只有 kind = month 有（step、period）。
 * question、permission（新首页 9.6、5.4.4）：只有真在问、真在等批准才进「等你」，一轮做完停下的不进（卡照常交回进验收，子会话「已停下」）。
 *   question：kind = question 时本机报的原样提问（LocalQuestionRequestView），title 是第一个问题的原话；只有一个问题、单选、最多 3 个选项时就地答，
 *   在那台电脑上用本机程序 POST /v1/sessions/:sessionId/questions/:requestId 回答。
 *   permission：kind = approval 时在等批准的那一步（LocalPermissionBrief），title 是它给人看的那一行（「运行 pnpm test」），就地「批准」，
 *   有越界路径（outsidePaths）时只能点进去「允许这一次」。老版本的本机程序不报这两样时为 null，标题退回「等你回复」「等你批准」。别的种类都为 null。
 */
export const WaitingItem = Type.Object({
  id: Type.String({ minLength: 1 }),
  kind: WaitingKind,
  title: Type.String({ minLength: 1 }),
  source: Nullable(Type.String()),
  at: Nullable(Instant),
  open: WaitingTarget,
  taskId: Nullable(Type.String({ minLength: 1 })),
  projectId: Nullable(Type.String({ format: "uuid" })),
  sessionId: Nullable(Type.String({ format: "uuid" })),
  deviceId: Nullable(Type.String({ format: "uuid" })),
  deviceName: Nullable(Type.String()),
  dueAt: Nullable(Instant),
  answer: WaitingAnswer,
  person: Nullable(Type.Object({ personId: Type.String({ minLength: 1 }), name: Type.String() }, strict)),
  month: Nullable(Type.Object({ step: Type.Union([Type.Literal("review"), Type.Literal("finalize"), Type.Literal("continue")]), period: Period }, strict)),
  question: Nullable(LocalQuestionRequestView),
  permission: Nullable(LocalPermissionBrief),
}, strict);

/**
 * GET /api/me/work-home（DRI 工作台，第 16 节的 v2）：左栏的项目、首页的「本月」和「等你」一次给全。伙伴的汇总读同一份（/internal/me/work-home，INTERNAL_CHAT_TOKEN 加 X-Owner-Id）。
 * period：现在是哪个月（公司时区，YYYY-MM）。
 * projects：没归档的项目（16.2 排序）：有等你的在前（summary.needsYou > 0），然后是有目标的、按最早的截止日，最后按最近动静从近到远。不按 Mission 分组。
 * archivedCount：归档了几个（左栏「已归档 N」，点开读 GET /api/me/projects）。
 * month：「本月」（16.4），替换原来的「各 Mission 的 Task」。
 * other.subSessions：不在任何项目里的子会话（上线前留下的），加挂在了结了的 Task 下、还没完成的；other.items：没挂 Mission 的待归位事项（9.10），新的在前。
 * waiting：等你。排序（设计 9.6）：先是卡住正在跑的活的（approval、question、quota），再是有截止时间的（dueAt 早的在前），其余按 at 新的在前。
 */
export const WorkHomeResponse = Type.Object({
  period: Period,
  projects: Type.Array(HomeProject),
  archivedCount: Type.Integer({ minimum: 0 }),
  month: Type.Object({ missions: Type.Array(HomeMonthMission) }, strict),
  other: Type.Object({ subSessions: Type.Array(SubSession), items: Type.Array(HomeItem) }, strict),
  waiting: Type.Array(WaitingItem),
}, strict);

/**
 * 项目对话（原 Task 管线）里网页按时间插的一行（第 4.5 节，从卡和交回现算，不另存事件）。id 稳定，网页按它去重；at 是这件事发生的时间。
 * - card_passed：一张卡验收过了（含本人「仍然通过」），met / total 几条达到，merge 是合回结果（「已合进 main」，或要你合的原因）。
 * - card_blocked：一张卡连续两次没过（受阻），fix 是拼好的改法（含原话对不上的几处）；sourceWordIssues 是那次交回和本人原话对不上的几处（16.8），和没过的标准一起列；
 *   网页给选项「按这个改（推荐）/ 我去看看 / 仍然通过」，
 *   按这个改 = 照原来的送回（说一句 + /handbacks/:id/returned），仍然通过 = 推翻（/handbacks/:id/overrule）。
 * - criteria_met：taskId 这件 Task 约定里的每一条都有验收通过的卡（met = total）；网页问「约定 n 条都达到了，交给认可人？（推荐）」，
 *   接 V1 的出一版（/deliverable/versions/from-pending）、对表、请 X 看、交付。完成仍只由本人确认。
 * - rework_opened：合回以后被推翻，管线在同一件 Task 下开了一张返工卡（cardId），fromCardId 是被推翻的那张，reason 是推翻的理由。
 */
const FeedBase = { id: Type.String({ minLength: 1 }), at: Instant };
export const TaskFeedItem = Type.Union([
  Type.Object({ kind: Type.Literal("card_passed"), ...FeedBase, cardId: Type.String({ format: "uuid" }), title: Type.String(),
    met: Type.Integer({ minimum: 0 }), total: Type.Integer({ minimum: 0 }), merge: Nullable(CardMerge) }, strict),
  Type.Object({ kind: Type.Literal("card_blocked"), ...FeedBase, cardId: Type.String({ format: "uuid" }), title: Type.String(),
    handbackId: Type.String({ format: "uuid" }), fix: Nullable(Type.String()), sourceWordIssues: Type.Array(CardSourceWordIssue) }, strict),
  Type.Object({ kind: Type.Literal("criteria_met"), ...FeedBase, taskId: Type.String({ minLength: 1 }), met: Type.Integer({ minimum: 1 }),
    total: Type.Integer({ minimum: 1 }) }, strict),
  Type.Object({ kind: Type.Literal("rework_opened"), ...FeedBase, cardId: Type.String({ format: "uuid" }), title: Type.String(),
    fromCardId: Type.String({ format: "uuid" }), reason: Type.String() }, strict),
]);

/** GET /api/me/tasks/:taskId/feed（Task 负责人）：这件 Task 的验收行，从旧到新。 */
export const TaskFeedResponse = Type.Object({ items: Type.Array(TaskFeedItem) }, strict);

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
 * holdUntil：规划员、验收员停着等额度恢复（本机报的 hold）时恢复的时间，state 是 queued；别的为 null。
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
  holdUntil: Nullable(Instant),
}, strict);

/**
 * GET /api/me/background?scope=…：右栏跟着展示区走，看哪条对话就列哪条开出去的后台任务。
 * scope：main（首页和总管线：本人全部）、project:<projectId>（项目对话和详情：挂着的 Task 的规划员，加项目里各子会话的）、task:<taskId>（这件 Task 的规划员和它下面各子会话的）、
 * card:<卡 id>（这张卡的验收员和它会话里的子 agent、后台命令）、topic:<专题 id>（这个专题会话里的）。
 * items：进行中的（按开始时间）在前，然后是今天（公司时区）结束的（新的在前）。resources 是右栏第一行：本机在不在线、几个位置用了几个、今天的花费（同 /api/me/workers）。
 * 云端的数据给手机用；在配对的电脑上，网页以本机程序的实时事件为准，合并进来。
 */
export const BackgroundResponse = Type.Object({
  items: Type.Array(BackgroundItem),
  resources: WorkerResources,
}, strict);
/**
 * 右栏跟着什么（设计第 5 节）：首页、总管线 → main；项目对话、项目详情 → project:<projectId>；子会话 → card:<id> / topic:<id>；
 * 二级页、月份页 → resources（只要资源块，items 为空）。
 */
export const BackgroundQuery = Type.Object({
  scope: Type.String({ pattern: "^(main|resources|task:.{1,128}|project:[0-9a-fA-F-]{36}|card:[0-9a-fA-F-]{36}|topic:[0-9a-fA-F-]{36})$" }),
}, strict);

/** POST /api/me/route：首页输入框选「自动」时，这一句发给谁。 */
export const RouteRequest = Type.Object({ text: Type.String({ minLength: 1, maxLength: 20_000 }) }, strict);

/**
 * 发给谁（16.4）：main 是伙伴的总管线；{ projectId } 是那个项目的对话。先不用模型：句子里提到了哪个项目的名字，或它挂着的 Task 的名字、标准里的词，
 * 就发给那个项目；几个项目都有、分不出来，或什么都没提到，发给伙伴。
 */
export const RouteResponse = Type.Object({
  target: Type.Union([Type.Literal("main"), Type.Object({ projectId: Type.String({ format: "uuid" }) }, strict)]),
}, strict);

/**
 * 一条「要开工」（第 4.4 节）：卡（kind = card，cardId）或专题（kind = topic，topicId）。taskId 是挂的 Task（专题可以不挂），
 * projectId 是在哪个项目里（本机在这个项目在这台电脑上绑的文件夹里跑；不在项目里为 null）。
 * 来自管线里定了的计划（派活单上选了「就按这个开始」，接受草稿时带 start: true）或伙伴开的探索子会话。
 */
export const SessionStartView = Type.Object({
  id: Type.String({ format: "uuid" }),
  kind: Type.Union([Type.Literal("card"), Type.Literal("topic")]),
  cardId: Nullable(Type.String({ format: "uuid" })),
  topicId: Nullable(Type.String({ format: "uuid" })),
  taskId: Nullable(Type.String({ minLength: 1 })),
  projectId: Nullable(Type.String({ format: "uuid" })),
  requestedAt: Instant,
}, strict);

/**
 * POST /api/me/session-starts/claim：配对的电脑上开着的网页认领还没人接的「要开工」，回的就是这次认领到的（别的标签页、别的电脑同时认领，一条只给一处）。
 * deviceId 是这台电脑的本机程序 id（本机 GET /v1/status），要是本人没吊销的设备。网页拿到后照常取交代、一批交给本机程序；
 * 本机报上第一条这张卡或专题的执行，这条就了结。开不起来（本机拒了）时 POST /api/me/session-starts/:id/release 放回去（body 同样带 deviceId，
 * 只放回这台电脑认领的那条，别处已经重新认领的不动，回 404）；认领了 5 分钟还没了结的，别处可以再认领（网页认领后关掉了）。
 */
export const ClaimSessionStartsRequest = Type.Object({ deviceId: Type.String({ format: "uuid" }) }, strict);
/** POST /api/me/session-starts/:id/release 的 body：认领它的那台电脑。 */
export const ReleaseSessionStartRequest = Type.Object({ deviceId: Type.String({ format: "uuid" }) }, strict);
/**
 * 认领到的一条，带这件 Task 此刻的预算（设计 11.3、11.4，契约 budget.ts）：Task 单独设过的，没设过是本人的缺省；不挂 Task 的专题是本人的缺省。
 * 本机按它跑这张卡（模型、思考强度、多 agent、到 80%/100% 怎么办）；每开一张卡认领一次，所以中途改了预算，下一张卡就拿到新的。
 * 一张卡跑着时预算改了怎么办由本机程序定。
 * permissionMode（17.2 第 11 条）：所在项目新开子会话的默认权限模式（Project.permissionMode），不在项目里为 auto；网页开工时原样带给本机（LocalCreateSessionRequest.permissionMode）。
 */
export const ClaimedSessionStart = Type.Object({ ...SessionStartView.properties, budget: Budget, permissionMode: LocalPermissionMode }, strict);
export const ClaimSessionStartsResponse = Type.Object({ starts: Type.Array(ClaimedSessionStart) }, strict);

/**
 * 「请这台电脑停掉」（17.4：伙伴的 stop_sub_session，在跑的子会话只能在本人电脑上停）：云端记一条，开着的网页在跑这个会话的那台电脑上认领，
 * 让本机程序停掉（POST /v1/sessions/:sessionId/stop），再报结果。
 * - POST /api/me/session-stops/claim { deviceId }：认领这台电脑上的（deviceId 是本机会话所在的那台），回 { stops }；两处同时认领只有一处拿到，认领 5 分钟没报结果可以重新认领。
 * - POST /api/me/session-stops/:id/done { deviceId, result }：stopped 停掉了，not_running 本机上已经没在跑。报过的不再出现。
 * sessionId 是本机会话的 id（SubSession.sessionId），deviceId 是它所在的电脑。
 */
export const SessionStopView = Type.Object({
  id: Type.String({ format: "uuid" }),
  kind: Type.Union([Type.Literal("card"), Type.Literal("topic")]),
  subSessionId: Type.String({ format: "uuid" }),
  sessionId: Type.String({ format: "uuid" }),
  deviceId: Type.String({ format: "uuid" }),
  requestedAt: Instant,
}, strict);
export const ClaimSessionStopsRequest = Type.Object({ deviceId: Type.String({ format: "uuid" }) }, strict);
export const ClaimSessionStopsResponse = Type.Object({ stops: Type.Array(SessionStopView) }, strict);
export const SessionStopDoneRequest = Type.Object({ deviceId: Type.String({ format: "uuid" }),
  result: Type.Union([Type.Literal("stopped"), Type.Literal("not_running")]) }, strict);
export type TSessionStopView = Static<typeof SessionStopView>;
export type TClaimSessionStopsResponse = Static<typeof ClaimSessionStopsResponse>;
export type TSessionStopDoneRequest = Static<typeof SessionStopDoneRequest>;

/**
 * 伙伴开探索子会话（工具 open_topic，/internal/me/topics，照 /internal 的 INTERNAL_CHAT_TOKEN 加 X-Owner-Id，不进公开 OpenAPI）：
 * 建一个专题并登记要开工，不用本人同意。projectId 是在哪个项目里（本人的、没归档的）；planTaskId 是归到哪件 Task（本人负责的，带了就在它挂的项目里）。
 * 两样都不带，子会话挂在「其他」。
 */
export const BuddyOpenTopicRequest = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 60 }),
  planTaskId: Type.Optional(Type.String({ minLength: 1 })),
  projectId: Type.Optional(Type.String({ format: "uuid" })),
}, strict);
export const BuddyOpenTopicResponse = Type.Object({ topicId: Type.String({ format: "uuid" }), start: SessionStartView }, strict);

export type TSubSessionState = Static<typeof SubSessionState>;
export type TSubSessionWaiting = Static<typeof SubSessionWaiting>;
export type TCardMerge = Static<typeof CardMerge>;
export type TTaskFeedItem = Static<typeof TaskFeedItem>;
export type TTaskFeedResponse = Static<typeof TaskFeedResponse>;
export type TSubSession = Static<typeof SubSession>;
export type THomeTaskSummary = Static<typeof HomeTaskSummary>;
export type THomeProjectGoal = Static<typeof HomeProjectGoal>;
export type THomeProject = Static<typeof HomeProject>;
export type THomeMonthTask = Static<typeof HomeMonthTask>;
export type THomeMonthMission = Static<typeof HomeMonthMission>;
export type TWaitingKind = Static<typeof WaitingKind>;
export type TWaitingAnswer = Static<typeof WaitingAnswer>;
export type THomeItem = Static<typeof HomeItem>;
export type TWaitingTarget = Static<typeof WaitingTarget>;
export type TWaitingItem = Static<typeof WaitingItem>;
export type TWorkHomeResponse = Static<typeof WorkHomeResponse>;
export type TBackgroundKind = Static<typeof BackgroundKind>;
export type TBackgroundState = Static<typeof BackgroundState>;
export type TBackgroundItem = Static<typeof BackgroundItem>;
export type TBackgroundResponse = Static<typeof BackgroundResponse>;
export type TBackgroundQuery = Static<typeof BackgroundQuery>;
export type TRouteRequest = Static<typeof RouteRequest>;
export type TRouteResponse = Static<typeof RouteResponse>;
export type TSessionStartView = Static<typeof SessionStartView>;
export type TClaimSessionStartsRequest = Static<typeof ClaimSessionStartsRequest>;
export type TReleaseSessionStartRequest = Static<typeof ReleaseSessionStartRequest>;
export type TClaimSessionStartsResponse = Static<typeof ClaimSessionStartsResponse>;
export type TBuddyOpenTopicRequest = Static<typeof BuddyOpenTopicRequest>;
export type TBuddyOpenTopicResponse = Static<typeof BuddyOpenTopicResponse>;

/**
 * GET / PUT /api/me/notification-settings（本人，CEO 和 DRI 都有）：「偏好」里的通知开关（设计 13.1、13.2），存在服务端。
 * feishu：飞书通知，缺省开。开着时天枢只把三类事推到本人和天枢机器人的单聊（「天枢伙伴」那条对话）：
 * 卡住正在跑的活、而本人 10 分钟内没打开天枢的（验收两次没过、额度用完要定、批准等了 10 分钟）；要本人确认、离截止不到 24 小时的（Mission Card、复盘）；
 * CEO 要拍板的（原有的规矩）。10 分钟里的几件合成一条，22:00 到 08:00 不推、攒到 08:00；每件带一个打开天枢那一处的链接，不放批准、回答这类操作。
 * 没关联飞书的人开着也收不到。
 */
export const NotificationSettings = Type.Object({ feishu: Type.Boolean() }, strict);
export type TNotificationSettings = Static<typeof NotificationSettings>;

/**
 * GET / PUT /api/me/appearance（本人，CEO 和 DRI 都有）：「偏好」里的外观（设计 17.2），存在服务端，换设备一样。
 * system 跟随系统（缺省，没设过就是它）、light 浅色、dark 深色。伙伴代本人改外观的入口按 17.4 定下的做法再加。
 */
export const AppearanceSettings = Type.Object({ appearance: Type.Union([Type.Literal("system"), Type.Literal("light"), Type.Literal("dark")]) }, strict);
export type TAppearanceSettings = Static<typeof AppearanceSettings>;
