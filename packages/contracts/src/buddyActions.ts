import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Budget } from "./budget.js";
import { LocalPlanEntry } from "./localRunner.js";
import { PersonRef } from "./projectTransfers.js";
import { AppearanceSettings, WaitingTarget } from "./workHome.js";

/**
 * 伙伴能代本人做事（设计《新首页》17.4、17.7，11/08 用户定做法 A）。
 *
 * - 授权：本人在引导里点「同意」（或偏好里打开）以后，伙伴有和本人一样的权限（full）；没同意时（none）伙伴只能读。
 * - Chat 一次性加一个通用入口：每一轮 GET /internal/me/buddy-actions 拿本人现在能用的动作（名字、说明、参数 schema），
 *   模型调哪个就 POST /internal/me/buddy-actions/:name。鉴权照 /internal 的老规矩：Authorization: Bearer <INTERNAL_CHAT_TOKEN>，X-Owner-Id 是本人；
 *   这两个接口只给 Chat 调，不进公开 OpenAPI，形状以这个文件为准。以后天枢加动作不用再动 Chat。
 * - 执行时照网页上对应接口的权限检查走：伙伴只能做本人本来就能做的事，不扩大能看能改的范围。
 * - 每个写动作记一条审计（GET /api/me/buddy-actions/log），能撤的可以「撤销」。
 * - 完全授权下只有「发消息给同事」先出一张卡给本人看一眼（卡上点「发出」才发）；别的都直接做：删除先进回收站，转交可以撤回。
 * - 界面上的效果（切外观、打开某页、刷新哪几块）和计划清单，由天枢插进这一轮的对话事件流（conversations.ts 的 ui、plan 事件），
 *   所以 Chat 调动作时要带上 conversationId 和 runId（同它调 /internal/issue-drafts 的做法）。
 */

const strict = { additionalProperties: false } as const;
const Instant = Type.String({ format: "date-time" });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Uuid = Type.String({ format: "uuid" });

// ───────────────────────── 授权 ─────────────────────────

/**
 * GET / PUT /api/me/buddy-authority（本人，CEO 和 DRI 都有）：伙伴代本人做事的授权。
 * authority：full 完全授权（引导里点「同意」、偏好里打开），none 只能读（缺省）；grantedAt 是最近一次打开的时间，none 时为 null。
 * PUT 只带 authority；关掉以后伙伴的写动作回 403 BUDDY_NOT_AUTHORIZED，动作清单里只剩读和界面动作。
 */
export const BuddyAuthority = Type.Object({
  authority: Type.Union([Type.Literal("none"), Type.Literal("full")]),
  grantedAt: Nullable(Instant),
}, strict);
export const UpdateBuddyAuthorityRequest = Type.Object({ authority: Type.Union([Type.Literal("none"), Type.Literal("full")]) }, strict);

// ───────────────────────── 第一批动作的参数 ─────────────────────────

const SubSessionRef = { kind: Type.Union([Type.Literal("card"), Type.Literal("topic")]), id: Uuid };

/**
 * 伙伴的选项框（设计 18 节第 9 条，ask_user 的参数，照 Claude Code 的 AskUserQuestion）：一题一个短标题 header（拼回答用，如「部署方式」）、题干、
 * 2–4 个选项（短标签 label + 一行说明 detail）；recommended 只能标在第一个选项上、每题最多一个；multiSelect 为 true 可以多选。
 * 「自己填」不在选项里，网页固定带。
 */
export const BuddyAskOption = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 40 }),
  detail: Type.String({ minLength: 1, maxLength: 120 }),
  recommended: Type.Optional(Type.Boolean()),
}, strict);
export const BuddyAskQuestion = Type.Object({
  header: Type.String({ minLength: 1, maxLength: 12 }),
  question: Type.String({ minLength: 1, maxLength: 300 }),
  options: Type.Array(BuddyAskOption, { minItems: 2, maxItems: 4 }),
  multiSelect: Type.Optional(Type.Boolean()),
}, strict);

/**
 * 第一批动作（名字 → 参数）。kind：read 只读（没授权也能用）；ui 只动界面（没授权也能用）；write 写（要完全授权，记审计）；plan 计划清单。
 * - read_work_home：读本人的首页（项目、子会话、等你），回 /api/me/work-home 同样的内容。
 * - read_project：读一个项目的详情和最近的动态（GET /api/me/projects/:id 和 /feed）。
 * - find_people：按名字在人员目录里找同事（send_message、transfer_project 要的是人员 id，先用它从名字找到 id）。回最多 10 个 { personId, name, self }，
 *   self 是本人自己（不能转达给自己）。
 * - open_page（ui）：让网页打开某一处，target 同「等你」的 open（WaitingTarget），另加 home（首页）、preferences（偏好）。
 * - set_appearance（write）：切外观，同 PUT /api/me/appearance。可撤（回到原来的）。
 * - set_feishu_push（write）：飞书推送开关，同 PUT /api/me/notification-settings。可撤。
 * - start_sub_session（write）：让一个卡或专题开工（登记要开工，开着的网页在本人电脑上认领）。可撤（还没被电脑接下时撤掉登记）。
 * - stop_sub_session（write）：停掉一个子会话。还没被电脑接下的撤掉开工登记；在跑的登记「请这台电脑停掉」（workHome.ts 的 SessionStopView），由开着的网页认领后让本机停。不可撤。
 * - archive_sub_session（write）：归档一个子会话：专题改成 archived，卡从首页和看板收起（项目里「已归档」能看到）。可撤。
 * - delete_sub_session（write）：删掉一个子会话：先进回收站（GET /api/me/trash），30 天内能恢复，之后才真删。可撤（从回收站恢复）。
 * - create_project / rename_project / archive_project（write）：同 POST /api/me/projects、PATCH /api/me/projects/:id。新建可撤（归档它），改名、归档可撤（改回、恢复）。
 * - link_task_to_project（write）：把本人负责的一件 Task 挂到项目上（同 PUT /api/me/projects/:id/goals/:taskId）。可撤（挂回原来的或取下来）。
 * - transfer_project（write）：发起转交并直接发出（同 16.7 的发起 + 发出；交接说明照常由云端写，写完才发出）。可撤（撤回转交）。
 * - split_cards（write）：登记拆卡（Task 或没挂 Task 的项目，带本人原话）。可撤（去掉登记）。
 * - set_budget（write）：改一件 Task 的预算或本人的缺省预算（taskId 不带是缺省）。可撤。
 * - message_project（write）：把本人在伙伴台说的、关于某个项目的话转给这个项目的对话（设计 18 节第 8 条：伙伴台 → 项目对话 → 子会话，一层管一层，
 *   伙伴不直接和子会话对话；凡是要改子会话手上的活的都走它）。天枢把话写进那个项目的对话（标成伙伴转来的，ConversationMessage.via = buddy），
 *   触发项目对话这一轮，由它去派活、问子会话；立即回 summary，不等项目对话回完（项目对话正在回上一轮时排在后面，不打断它）。
 *   项目对话的结果照原来的方式由伙伴在总管线里回报（18 节第 4 条）。不可撤。从项目对话里调（conversationId 是项目对话）回 409 ALREADY_IN_PROJECT。
 * - send_message（write）：给人员目录里的同事发一句话。先出一张卡（ConversationCard 的 buddy_message）给本人看，本人点「发出」才由天枢机器人转达；
 *   每人每天最多 20 条（回 429 DAILY_LIMIT）。不可撤（发出以后）。
 * - update_plan（plan）：计划清单，见 BuddyPlanParams。
 * - ask_user（ui）：出一个选项框问本人（18 节第 9 条），参数见 BuddyAskQuestion：1–4 题。天枢存成这一轮的一张卡（ConversationCard 的 buddy_question，
 *   status open），经 card 事件插进这一轮，读历史时也在那一轮的回答上。调完这一轮就该结束，等本人回答。伙伴台和项目对话都能用。
 *   recommended 不在第一个选项上、或一题标了不止一个，回 400 INVALID_ARGS；这一轮没带 runId（界面上出不来）回 409 NO_TURN。回 { questionId }。
 */
export const BuddyActionParams = {
  read_work_home: Type.Object({}, strict),
  read_project: Type.Object({ projectId: Uuid }, strict),
  find_people: Type.Object({ query: Type.String({ minLength: 1, maxLength: 40 }) }, strict),
  open_page: Type.Object({ target: Type.Union([WaitingTarget, Type.Object({ kind: Type.Union([Type.Literal("home"), Type.Literal("preferences")]) }, strict)]) }, strict),
  set_appearance: AppearanceSettings,
  set_feishu_push: Type.Object({ feishu: Type.Boolean() }, strict),
  start_sub_session: Type.Object(SubSessionRef, strict),
  stop_sub_session: Type.Object(SubSessionRef, strict),
  archive_sub_session: Type.Object(SubSessionRef, strict),
  delete_sub_session: Type.Object(SubSessionRef, strict),
  create_project: Type.Object({ name: Type.String({ minLength: 1, maxLength: 60 }), taskId: Type.Optional(Type.String({ minLength: 1 })) }, strict),
  rename_project: Type.Object({ projectId: Uuid, name: Type.String({ minLength: 1, maxLength: 60 }) }, strict),
  archive_project: Type.Object({ projectId: Uuid }, strict),
  link_task_to_project: Type.Object({ projectId: Uuid, taskId: Type.String({ minLength: 1 }) }, strict),
  transfer_project: Type.Object({ projectId: Uuid, toPersonId: Type.String({ minLength: 1 }) }, strict),
  split_cards: Type.Object({ taskId: Type.Optional(Type.String({ minLength: 1 })), projectId: Type.Optional(Uuid),
    words: Type.Optional(Type.String({ maxLength: 4000 })) }, strict),
  set_budget: Type.Object({ taskId: Type.Optional(Type.String({ minLength: 1 })), budget: Budget }, strict),
  message_project: Type.Object({ projectId: Uuid, text: Type.String({ minLength: 1, maxLength: 4000 }) }, strict),
  send_message: Type.Object({ toPersonIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 5 }), text: Type.String({ minLength: 1, maxLength: 2000 }) }, strict),
  update_plan: Type.Object({
    /** 整张清单（每次都交全部，后一次取代前一次）。少于 2 条不出。 */
    entries: Type.Array(LocalPlanEntry, { maxItems: 20 }),
  }, strict),
  ask_user: Type.Object({ questions: Type.Array(BuddyAskQuestion, { minItems: 1, maxItems: 4 }) }, strict),
} as const;
export type BuddyActionName = keyof typeof BuddyActionParams;
export type TBuddyAskQuestion = Static<typeof BuddyAskQuestion>;
export const BUDDY_ACTION_NAMES = Object.keys(BuddyActionParams) as BuddyActionName[];

// ───────────────────────── 动作清单和执行（只给 Chat） ─────────────────────────

/**
 * GET /internal/me/buddy-actions：本人现在能用的动作。authority 为 none 时只列 read、ui、plan 三类。
 * parameters 是参数的 JSON Schema（直接交给模型当工具的 input_schema）。Chat 把 name 原样当工具名，这样网页收到的 tool 事件里就是动作名。
 */
export const BuddyActionSpec = Type.Object({
  name: Type.String({ minLength: 1 }),
  description: Type.String({ minLength: 1 }),
  kind: Type.Union([Type.Literal("read"), Type.Literal("ui"), Type.Literal("write"), Type.Literal("plan")]),
  parameters: Type.Unknown(),
}, strict);
export const BuddyActionListResponse = Type.Object({ authority: BuddyAuthority, actions: Type.Array(BuddyActionSpec) }, strict);

/**
 * POST /internal/me/buddy-actions/:name：按名字执行。args 是模型给的参数；conversationId、runId 是这一轮（天枢据此往这一轮的事件流里插 ui、plan 事件，
 * 也记进审计）。没带时动作照做，只是插不了事件。
 */
export const BuddyActionRequest = Type.Object({
  args: Type.Unknown(),
  conversationId: Type.Optional(Type.String({ minLength: 1 })),
  runId: Type.Optional(Type.String({ minLength: 1 })),
}, strict);

/**
 * 执行结果（200）。summary 是一句人话（「已把『Chat 服务』归档」），模型照它回本人；result 是给模型的数据（读动作的内容、新建的 id 等）；
 * auditId 是这条审计（读、ui、plan 为 null）；undoable 能不能撤。
 * 出错照天枢的 ApiError：400 INVALID_ARGS 参数不对，403 BUDDY_NOT_AUTHORIZED 没授权（写动作），404 UNKNOWN_ACTION 没有这个动作，
 * 429 DAILY_LIMIT 发消息超过每天上限；其余（404 NOT_FOUND、409 …）原样是对应网页接口的错误，message 是给人看的中文。
 */
export const BuddyActionResult = Type.Object({
  summary: Type.String(),
  result: Type.Unknown(),
  auditId: Nullable(Uuid),
  undoable: Type.Boolean(),
}, strict);

// ───────────────────────── 审计和撤销（本人） ─────────────────────────

/**
 * GET /api/me/buddy-actions/log：伙伴代本人做过的写动作，新的在前，最近 100 条。POST /api/me/buddy-actions/log/:id/undo 撤销一条（回撤销后的这条）：
 * 不能撤的、已经撤过的 409 NOT_UNDOABLE；撤的时候对象已经变了（比如项目又被改过名）照现在的样子撤不了也是 409，message 说为什么。
 */
export const BuddyAuditEntry = Type.Object({
  id: Uuid,
  action: Type.String({ minLength: 1 }),
  summary: Type.String(),
  at: Instant,
  conversationId: Nullable(Type.String()),
  undoable: Type.Boolean(),
  undoneAt: Nullable(Instant),
}, strict);
export const BuddyAuditListResponse = Type.Object({ entries: Type.Array(BuddyAuditEntry) }, strict);

// ───────────────────────── 发消息给同事 ─────────────────────────

/**
 * 伙伴要发给同事的一句话（send_message 先出的卡，ConversationCard 的 buddy_message 带 draftId）。
 * 发出时由天枢机器人发到对方和机器人的单聊，开头是「{本人名字}请我转达：」；收不到（对方没关联飞书、不在应用可见范围）的那几个人列在 failed 里。
 * GET /api/me/buddy-messages/:id 读；POST …/:id/send 发出（status 变 sent，回这一份）；POST …/:id/cancel 不发了（cancelled）。不是 draft 时 409。
 */
export const BuddyMessageDraft = Type.Object({
  id: Uuid,
  to: Type.Array(PersonRef),
  text: Type.String(),
  status: Type.Union([Type.Literal("draft"), Type.Literal("sent"), Type.Literal("cancelled")]),
  createdAt: Instant,
  sentAt: Nullable(Instant),
  failed: Type.Array(PersonRef),
}, strict);

// ───────────────────────── 回收站 ─────────────────────────

/**
 * GET /api/me/trash：删掉的子会话（伙伴删的、本人删的都在这），新删的在前；purgeAt 以后真删。
 * POST /api/me/trash/:kind/:id/restore 恢复（回 204），已经真删了 404。
 */
export const TrashItem = Type.Object({
  kind: Type.Union([Type.Literal("card"), Type.Literal("topic")]),
  id: Uuid,
  title: Type.String(),
  deletedAt: Instant,
  purgeAt: Instant,
}, strict);
export const TrashListResponse = Type.Object({ items: Type.Array(TrashItem) }, strict);

// ───────────────────────── 插进对话事件流的 ─────────────────────────

/**
 * 界面上的效果（conversations.ts 的 ui 事件，天枢在动作做完时插进这一轮的流）：
 * - appearance：外观换了，网页立刻照它换（不用再读）；
 * - open：让网页打开某一处（target 同 open_page 的参数）；
 * - refresh：哪几块要重读（work_home 首页、project 某个项目、sub_session 某个子会话、settings 偏好、trash 回收站）。
 */
export const BuddyUiEffect = Type.Union([
  Type.Object({ kind: Type.Literal("appearance"), appearance: AppearanceSettings.properties.appearance }, strict),
  Type.Object({ kind: Type.Literal("open"), target: BuddyActionParams.open_page.properties.target }, strict),
  Type.Object({ kind: Type.Literal("refresh"), what: Type.Array(Type.Union([Type.Literal("work_home"), Type.Literal("project"), Type.Literal("sub_session"),
    Type.Literal("settings"), Type.Literal("trash")]), { minItems: 1 }), id: Type.Optional(Type.String({ minLength: 1 })) }, strict),
]);

/**
 * 计划清单（conversations.ts 的 plan 事件、ConversationMessage.plan）：由伙伴自己产生（update_plan 动作），天枢记在这一轮上并插进流。
 * entries 同本机子会话的 LocalPlanEntry（content，status 为 pending / in_progress / completed），网页用同一个组件画。
 * 只有执行两步以上时才有（少于 2 条天枢不出）；伙伴某一步的写动作做成了而没打勾，天枢替它把那一步标成 completed（兜底，按动作做完的先后对第一条 in_progress）。
 * collapsed：这一轮执行到一半本人发来新消息，清单收起来（网页折叠成一行）；新的一轮伙伴重新出清单。
 */
export const BuddyPlan = Type.Object({ entries: Type.Array(LocalPlanEntry), collapsed: Type.Boolean() }, strict);

export type TBuddyAuthority = Static<typeof BuddyAuthority>;
export type TUpdateBuddyAuthorityRequest = Static<typeof UpdateBuddyAuthorityRequest>;
export type TBuddyActionSpec = Static<typeof BuddyActionSpec>;
export type TBuddyActionListResponse = Static<typeof BuddyActionListResponse>;
export type TBuddyActionRequest = Static<typeof BuddyActionRequest>;
export type TBuddyActionResult = Static<typeof BuddyActionResult>;
export type TBuddyAuditEntry = Static<typeof BuddyAuditEntry>;
export type TBuddyAuditListResponse = Static<typeof BuddyAuditListResponse>;
export type TBuddyMessageDraft = Static<typeof BuddyMessageDraft>;
export type TTrashItem = Static<typeof TrashItem>;
export type TTrashListResponse = Static<typeof TrashListResponse>;
export type TBuddyUiEffect = Static<typeof BuddyUiEffect>;
export type TBuddyPlan = Static<typeof BuddyPlan>;
