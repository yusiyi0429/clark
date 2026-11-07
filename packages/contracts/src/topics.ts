import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { LocalRunBrief, LocalRunView } from "./localDevices.js";
import { DeliverableInclusion } from "./taskCardView.js";
import { RoleBrief, RoleRef } from "./roles.js";

/**
 * 调研专题（V2 设计第 9 节）：在本机由 Claude Code 跑，先交提纲、本人同意后再写，每改一次存一个新版本。
 * 版本由本机经同步报上来；对话全文只在本机，云端不存。只归档，不删。只有本人看得到。
 */

const strict = { additionalProperties: false } as const;
const Instant = Type.String({ format: "date-time" });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const TopicStatus = Type.Union([Type.Literal("active"), Type.Literal("archived")]);
/** outline 提纲；draft 正文的一版；review 评审会合成的「分歧和建议」。 */
export const TopicVersionKind = Type.Union([Type.Literal("outline"), Type.Literal("draft"), Type.Literal("review")]);

/**
 * 专题的一版（不带正文）：number 从 1 起连续；label 如「提纲」「第 2 版」；note 是这一版改了什么；
 * feishuUrl 是存进飞书以后的地址（没存为 null）；deliverable 是进交付物到哪了（专题挂了 Task 才可能有）。
 */
export const TopicVersionSummary = Type.Object({
  id: Type.String({ format: "uuid" }),
  number: Type.Integer({ minimum: 1 }),
  kind: TopicVersionKind,
  label: Type.String({ minLength: 1, maxLength: 20 }),
  note: Nullable(Type.String({ maxLength: 200 })),
  feishuUrl: Nullable(Type.String()),
  createdAt: Instant,
  deliverable: Nullable(DeliverableInclusion),
}, strict);

/** 带正文（Markdown）的一版。 */
export const TopicVersionView = Type.Object({
  ...TopicVersionSummary.properties,
  body: Type.String({ maxLength: 200000 }),
}, strict);

/**
 * 一个专题。planTaskId、missionId 是挂的 Task 和它的 Mission，可以不挂（都为 null）；role 是做这个专题的岗位，没配为 null。
 * latestVersion 是最新一版的号、种类和名字；run 是最近一次本机执行的摘要（等你回复、等你批准看 run.state）。
 */
export const ResearchTopicView = Type.Object({
  id: Type.String({ format: "uuid" }),
  title: Type.String({ minLength: 1, maxLength: 60 }),
  status: TopicStatus,
  planTaskId: Nullable(Type.String({ minLength: 1 })),
  missionId: Nullable(Type.String({ minLength: 1 })),
  role: Nullable(RoleRef),
  createdAt: Instant,
  updatedAt: Instant,
  lastVersionAt: Nullable(Instant),
  latestVersion: Nullable(Type.Object({ number: Type.Integer({ minimum: 1 }), kind: TopicVersionKind, label: Type.String() }, strict)),
  run: Nullable(LocalRunBrief),
}, strict);

/** GET /api/me/topics?status=active|archived（默认 active）：新动静的在前。 */
export const TopicListResponse = Type.Object({ topics: Type.Array(ResearchTopicView) }, strict);

/** 新建专题：planTaskId 只能是本人 Mission 下的 Task，roleId 是本人没归档的岗位。建好以后网页对本机「开始」（kind=topic）。 */
export const CreateTopicRequest = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 60 }),
  planTaskId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  roleId: Type.Optional(Type.String({ format: "uuid" })),
}, strict);

/** 改标题、归档或取消归档、换岗位（null 不配）。至少带一个字段。 */
export const PatchTopicRequest = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
  status: Type.Optional(TopicStatus),
  roleId: Type.Optional(Type.Union([Type.String({ format: "uuid" }), Type.Null()])),
}, strict);

/**
 * GET /api/me/topics/:id：task 是挂的 Task 的名字（没挂或读不到为 null）；versions 新的在前、不带正文；
 * current 是最新一版带正文（还没有版本为 null）；以前的版本按号取 GET /api/me/topics/:id/versions/:number。runs 是最近 5 次本机执行。
 */
export const TopicDetailResponse = Type.Object({
  topic: ResearchTopicView,
  task: Nullable(Type.Object({ taskId: Type.String({ minLength: 1 }), name: Type.String() }, strict)),
  versions: Type.Array(TopicVersionSummary),
  current: Nullable(TopicVersionView),
  runs: Type.Array(LocalRunView, { maxItems: 5 }),
}, strict);

/**
 * GET /api/me/topics/:id/brief?critics=<id>,<id>：开专题时交给本机的交代，markdown 原样作为第一句话：专题标题；挂了 Task 的带 Mission、Task、标准和约定；
 * 有版本时带最新一版的号（续写时用）。role 是专题的岗位；critics 是评审会用的挑刺岗位（本人团队里 kind=critic 的，最多 3 个；
 * 带 critics 参数时用本人点的那几个）。先交提纲等工作规矩在本机程序的提示词里。
 */
export const TopicBriefResponse = Type.Object({
  markdown: Type.String({ minLength: 1, maxLength: 20000 }),
  role: Nullable(RoleBrief),
  critics: Type.Array(RoleBrief, { maxItems: 3 }),
  title: Type.String({ minLength: 1 }),
  latestVersion: Nullable(Type.Integer({ minimum: 1 })),
}, strict);

export type TTopicStatus = Static<typeof TopicStatus>;
export type TTopicVersionKind = Static<typeof TopicVersionKind>;
export type TTopicVersionSummary = Static<typeof TopicVersionSummary>;
export type TTopicVersionView = Static<typeof TopicVersionView>;
export type TResearchTopicView = Static<typeof ResearchTopicView>;
export type TTopicListResponse = Static<typeof TopicListResponse>;
export type TCreateTopicRequest = Static<typeof CreateTopicRequest>;
export type TPatchTopicRequest = Static<typeof PatchTopicRequest>;
export type TTopicDetailResponse = Static<typeof TopicDetailResponse>;
export type TTopicBriefResponse = Static<typeof TopicBriefResponse>;
