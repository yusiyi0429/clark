import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { RoleBrief, RoleKind, RoleModelTier } from "./roles.js";

/**
 * 拆卡改在本机（V2 设计第 21 节）：伙伴只「登记拆卡」（工具名 register_card_split），真正去拆的是本人电脑上的规划员会话。
 * 网页读本人还没开工的登记，在这台电脑上开规划员；开了以后把登记去掉。规划员开工时拿的交代见 CardPlanBriefResponse。
 *
 * 没挂 Task 的项目也能拆（新首页 16.3）：登记、交代、派活单、放进看板都能按项目走（/api/me/projects/:projectId/…）。这时没有 Task 的验收标准，
 * 每件派活单自带完成标准，验收员照卡上的完成标准验（卡本来就按自己的完成标准验）；卡挂项目、不挂 Task 和 Mission。
 * 本机的规划员会话 subject 是 { kind: "plan", projectId }（不带 taskId），派活单照旧经 card_plan 同步条目报上来。
 */

const strict = { additionalProperties: false } as const;
const Instant = Type.String({ format: "date-time" });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/**
 * 本人原话（设计《新首页》16.8，11/08 用户定）：派活单、卡带着本人说过的原话，免得规划员改写需求、加了没有的约束。
 * - 登记拆卡时存下这次拆卡依据的本人消息原文，最多最近 5 条（旧的在前）：网页按钮登记取请求里的 words；伙伴登记取本人在项目对话里最近说的话；什么都没说为空数组。
 * - 规划员交派活单时每件写 sourceWords（从原话里摘的、和这件有关的片段，只能摘原文）；云端核对：每段去掉首尾空白后必须是某条原话的子串，
 *   有一段不是就整件不认它摘的，改用整条原话；规划员没摘的也用整条原话。
 */
export const SourceWords = Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { maxItems: 10 });

/**
 * POST /api/plan-tasks/:taskId/card-splits、POST /api/me/projects/:projectId/card-splits 的请求体（可以不带）：words 是按钮旁输入框里本人的话。
 * 已有一条没开工的登记时，带了 words 就把那条的原话换成这次的。
 */
/**
 * afterSequence（17.2 第 29 条）：本人在项目对话里看到的最后一条消息的 sequence（ConversationMessage.sequence），「拆卡中」「拆卡失败」「派活单」
 * 插在它后面。项目对话页带上来；不带时（首页、手机、伙伴登记的）云端读这件 Task 挂的项目（或这个项目）的对话现在最后一条，读不到为 null。
 */
/**
 * 本人原话里关于用什么来源、模型、思考的那一截（第 69 条），原样，不翻译成型号（如「这几件用本机的 Opus 5.5，思考开高」）。整张派活单一句。
 * 云端只原样带到这次拆出来的派活单草稿上（CardDraftView.modelWords）；网页拿它和这台电脑连着的来源对，预选，对不上写「没找到「…」」并用自动。
 */
export const ModelWords = Type.String({ minLength: 1, maxLength: 300 });

export const RegisterCardSplitRequest = Type.Object({ words: Type.Optional(Type.String({ maxLength: 4000 })),
  afterSequence: Type.Optional(Type.Integer({ minimum: 1 })),
  /** 本人对用什么模型有要求时那一截原话（见 ModelWords，第 69 条）；没有不带。 */
  modelWords: Type.Optional(ModelWords) }, strict);

/**
 * 一条「要拆」的登记：origin=buddy 是伙伴对话里说的（register_card_split），web 是页面上的「拆一下」。
 * 拆一件 Task：taskId、taskName、missionId 有值，projectId 是这件 Task 挂的项目（没挂为 null）；
 * 拆一个没挂 Task 的项目（16.3）：taskId、taskName、missionId 为 null，projectId、projectName 有值。
 */
export const CardSplitRequestView = Type.Object({
  id: Type.String({ format: "uuid" }),
  taskId: Nullable(Type.String({ minLength: 1 })),
  taskName: Nullable(Type.String()),
  missionId: Nullable(Type.String({ minLength: 1 })),
  projectId: Nullable(Type.String({ format: "uuid" })),
  projectName: Nullable(Type.String()),
  origin: Type.Union([Type.Literal("buddy"), Type.Literal("web")]),
  /** 这次拆卡依据的本人原话（见 SourceWords）。 */
  sourceWords: SourceWords,
  createdAt: Instant,
  /** 登记时项目对话最后一条消息的 sequence（见 RegisterCardSplitRequest.afterSequence），「拆卡中」插在它后面；对话还没有消息、读不到、老记录为 null。 */
  afterSequence: Nullable(Type.Integer({ minimum: 1 })),
  /** 登记时带的模型要求原话（见 ModelWords，第 69 条）；没带、老记录为 null 或不带。 */
  modelWords: Type.Optional(Nullable(ModelWords)),
}, strict);

/** GET /api/me/card-splits：本人还没开工的登记，先登记的在前。 */
export const CardSplitListResponse = Type.Object({ requests: Type.Array(CardSplitRequestView) }, strict);

/** 规划员能派的岗位：本人的（id 是本人的岗位）和本人还没加的预设（presetKey）。dutiesSummary 是职责的第一段，最多 200 字。 */
export const PlanBriefRole = Type.Object({
  id: Nullable(Type.String({ format: "uuid" })),
  presetKey: Nullable(Type.String({ minLength: 1 })),
  name: Type.String({ minLength: 1 }),
  kind: RoleKind,
  dutiesSummary: Type.String(),
  modelTier: RoleModelTier,
}, strict);

/**
 * GET /api/plan-tasks/:taskId/plan-brief（Task 负责人）：开规划员会话的交代。markdown 原样作为第一句话：Task、约定（每条用什么证明、这次不包括什么）、
 * 本人的岗位清单和职责摘要、出派活单的要求；role 是规划员岗位（本人加过的，没有时是预设），网页原样交给本机程序；roles 是派活单里能写的岗位。
 * GET /api/me/projects/:projectId/plan-brief（项目负责人，16.3）：没挂 Task 的项目的交代，task 为 null、criteria 和 exclusions 为空，
 * markdown 写项目名、目标历史、项目里已有的卡，要求每件派活单自带能核对的完成标准（对约定第几条一律写 null）。project 是拆的哪个项目（拆 Task 时是它挂的项目，没挂为 null）。
 * sourceWords（16.8）：这个 Task 或项目最近一次登记拆卡存下的本人原话；markdown 里有一段「本人原话」，要求每件派活单从里面摘相关片段写进 sourceWords，只摘原文不改写。
 */
export const CardPlanBriefResponse = Type.Object({
  markdown: Type.String({ minLength: 1, maxLength: 20000 }),
  role: Nullable(RoleBrief),
  task: Nullable(Type.Object({ taskId: Type.String({ minLength: 1 }), name: Type.String(), missionId: Type.String({ minLength: 1 }) }, strict)),
  project: Nullable(Type.Object({ projectId: Type.String({ format: "uuid" }), name: Type.String() }, strict)),
  criteria: Type.Array(Type.Object({ index: Type.Integer({ minimum: 1 }), text: Type.String(), proof: Nullable(Type.String()) }, strict)),
  exclusions: Type.Array(Type.String()),
  roles: Type.Array(PlanBriefRole),
  sourceWords: SourceWords,
}, strict);

export type TCardSplitRequestView = Static<typeof CardSplitRequestView>;
export type TCardSplitListResponse = Static<typeof CardSplitListResponse>;
export type TPlanBriefRole = Static<typeof PlanBriefRole>;
export type TCardPlanBriefResponse = Static<typeof CardPlanBriefResponse>;
export type TSourceWords = Static<typeof SourceWords>;
export type TRegisterCardSplitRequest = Static<typeof RegisterCardSplitRequest>;
export type TModelWords = Static<typeof ModelWords>;
