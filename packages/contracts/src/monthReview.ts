import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { MonthPeriod } from "./taskContinuity.js";

/**
 * 月底复盘第三版（设计《复盘进新首页_设计第三版_2026-11-10》）：月份页在复盘期间就是复盘页。
 *
 * - 每件 Task 先定去向：current 本期验收（默认）/ deferred 延期到某个月 / cancelled 已取消。Agent 先填，本人随时改；
 *   Mission 负责人能改这个 Mission 下所有 Task，Task 负责人能改自己的。
 * - 本期验收的逐条评定：一行一条验收标准（本体 Task 的验收标准；没有就按完成定义算一条；两样都没有用 Task 名算一条），
 *   三档 met 达到 / partial 部分达到 / unmet 未达到。统一评审员先预评，本人改；和预评不同时备注必填。交付可以没有，有的话一律是链接。
 * - Mission 总评只算本期验收的 Task 的各条（按本人评定，没改的按预评）：全部达到为 achieved，一条都没达到为 not_achieved，其余 partial。
 *   延期、取消的不计入，单独数出来。
 * - 「确认」按 Mission，只有 Mission 负责人能点；确认以后这个 Mission 下任何一处改动都清掉确认。
 * - 延期的 Task 收成本人的顺延清单，作为那个月出草稿的输入。
 * 都是天枢自己的数据：不写本体、不转 M2（M2 的接口定了再接）。
 */

const strict = { additionalProperties: false } as const;
const Instant = Type.String({ format: "date-time" });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Note = Type.String({ maxLength: 1000 });

export const ReviewDisposition = Type.Union([Type.Literal("current"), Type.Literal("deferred"), Type.Literal("cancelled")]);
export const ReviewRating = Type.Union([Type.Literal("met"), Type.Literal("partial"), Type.Literal("unmet")]);
export const MissionVerdict = Type.Union([Type.Literal("achieved"), Type.Literal("partial"), Type.Literal("not_achieved")]);

/** 复盘里的一个人。 */
export const ReviewPerson = Type.Object({ personId: Type.String({ minLength: 1 }), name: Type.String() }, strict);

/** 挂在一条标准上的交付：一律是链接。title 是标题（读不到就是网址）；source：agent 预评时挂的，person 本人挂的。 */
export const MonthReviewLink = Type.Object({
  id: Type.String({ format: "uuid" }),
  title: Type.String({ minLength: 1 }),
  url: Type.String({ minLength: 1 }),
  source: Type.Union([Type.Literal("agent"), Type.Literal("person")]),
}, strict);

/**
 * 一条验收标准。index 从 1 起；text 是标准原文。
 * agentRating / agentBasis：预评和它的依据（一句话），预评还没出时为 null。
 * rating：本人（或 Mission 负责人）的评定，没改过为 null（按预评算）；ratedBy 是谁改的。
 * note：这条实际完成得怎么样，没写为 null；rating 和 agentRating 不同时一定有。
 */
export const MonthReviewCriterion = Type.Object({
  index: Type.Integer({ minimum: 1 }),
  text: Type.String({ minLength: 1 }),
  agentRating: Nullable(ReviewRating),
  agentBasis: Nullable(Type.String()),
  rating: Nullable(ReviewRating),
  ratedBy: Nullable(ReviewPerson),
  note: Nullable(Type.String()),
  links: Type.Array(MonthReviewLink),
}, strict);

/**
 * 复盘里的一件 Task。responsible：本体登记的负责人（没登记为 null，算 Mission 负责人的）。
 * disposition / deferredTo：去向和延期到哪个月（只有 deferred 有）；dispositionBy：谁定的，Agent 预填的为 null。
 * canChange：看的人能不能改这件的去向、评定和交付（Mission 负责人或这件 Task 的负责人）。
 * criteria：本期验收的逐条；延期、取消的为空。
 */
export const MonthReviewTask = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  name: Type.String(),
  missionId: Type.String({ minLength: 1 }),
  missionTitle: Type.String(),
  responsible: Nullable(ReviewPerson),
  disposition: ReviewDisposition,
  deferredTo: Nullable(MonthPeriod),
  dispositionBy: Nullable(ReviewPerson),
  canChange: Type.Boolean(),
  criteria: Type.Array(MonthReviewCriterion),
}, strict);

/**
 * 一个 Mission 一块，只放本期验收的 Task。owner 是 Mission 负责人。
 * verdict：总评（本期验收的各条按评定算），没有本期验收的条目或预评还没出完时为 null。met / total：达到几条 / 共几条（只算本期验收的）。
 * deferred / cancelled：这个 Mission 下延期、取消了几件（不计入总评，旁边写出来）。
 * confirmedAt / confirmedBy：确认了的时间和人，没确认（或确认后又改过）为 null。canConfirm：看的人是这个 Mission 的负责人。
 */
export const MonthReviewMission = Type.Object({
  missionId: Type.String({ minLength: 1 }),
  code: Type.String(),
  title: Type.String(),
  owner: ReviewPerson,
  verdict: Nullable(MissionVerdict),
  met: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 }),
  deferred: Type.Integer({ minimum: 0 }),
  cancelled: Type.Integer({ minimum: 0 }),
  confirmedAt: Nullable(Instant),
  confirmedBy: Nullable(ReviewPerson),
  canConfirm: Type.Boolean(),
  tasks: Type.Array(MonthReviewTask),
}, strict);

/** 预评走到哪了：pending 还没开始，running 在评，done 评完了，failed 没评成（error 是给人看的一句）。 */
export const MonthReviewPrefill = Type.Object({
  status: Type.Union([Type.Literal("pending"), Type.Literal("running"), Type.Literal("done"), Type.Literal("failed")]),
  error: Nullable(Type.String()),
}, strict);

/**
 * GET /api/me/months/:period/review（复盘页）。deadline：本轮截止时间。
 * toConfirm：本人能确认、还没确认的 Mission 几个；deferred / cancelled：整页延期、取消了几件。
 * missions：按 Mission 编号排；setAside：延期和取消的 Task（页面最下面，不评定、不挂交付、没有确认）。
 * 写操作（去向、评定、交付、确认）都回整份最新的复盘页。
 */
export const MonthReviewResponse = Type.Object({
  period: MonthPeriod,
  deadline: Instant,
  prefill: MonthReviewPrefill,
  toConfirm: Type.Integer({ minimum: 0 }),
  deferred: Type.Integer({ minimum: 0 }),
  cancelled: Type.Integer({ minimum: 0 }),
  missions: Type.Array(MonthReviewMission),
  setAside: Type.Array(MonthReviewTask),
}, strict);

/**
 * PUT /api/me/months/:period/review/tasks/:taskId/disposition：改去向。deferredTo 只给 deferred 用，要晚于本月，不写就是下个月。
 * 不能改的 403，不在这次复盘里的 404，deferredTo 不对 400。
 */
export const PutReviewDispositionRequest = Type.Object({
  disposition: ReviewDisposition,
  deferredTo: Type.Optional(MonthPeriod),
}, strict);

/**
 * PUT /api/me/months/:period/review/tasks/:taskId/criteria/:index：改一条的评定和备注（整条覆盖）。
 * 和预评不同时 note 必填（400）；只想写备注就把 rating 写成现在的评定。这件不是本期验收的 409。
 */
export const PutReviewCriterionRequest = Type.Object({
  rating: ReviewRating,
  note: Nullable(Note),
}, strict);

/** 「+ 添加」弹层上面那一部分：这件 Task 在天枢里已有的交付物条目（kind deliverable）和子会话产出（kind output），新的在前。 */
export const ReviewLinkCandidate = Type.Object({
  kind: Type.Union([Type.Literal("deliverable"), Type.Literal("output")]),
  id: Type.String({ format: "uuid" }),
  title: Type.String({ minLength: 1 }),
  url: Type.String({ minLength: 1 }),
  at: Instant,
}, strict);
export const ReviewLinkCandidatesResponse = Type.Object({ candidates: Type.Array(ReviewLinkCandidate) }, strict);

/**
 * POST /api/me/months/:period/review/tasks/:taskId/criteria/:index/links：挂一个交付。
 * 两种写法：粘贴的链接（只收 http / https，title 不写就用网址）；或者弹层里点的一样（candidate，标题和链接由服务端填）。
 */
export const AddReviewLinkRequest = Type.Union([
  Type.Object({ url: Type.String({ minLength: 1, maxLength: 2000 }), title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }, strict),
  Type.Object({ candidate: Type.Object({ kind: ReviewLinkCandidate.properties.kind, id: Type.String({ format: "uuid" }) }, strict) }, strict),
]);

/**
 * 顺延清单里的一件：本人延期的 Task，带原来的验收标准、每条做到哪了（rating 按本人评定，没改按预评；延期前没评过为 null）、
 * 备注和已挂的交付。fromPeriod 是复盘的那个月，deferredTo 是延到哪个月。
 */
export const MonthCarryoverTask = Type.Object({
  taskId: Type.String({ minLength: 1 }),
  name: Type.String(),
  missionId: Type.String({ minLength: 1 }),
  missionTitle: Type.String(),
  fromPeriod: MonthPeriod,
  deferredTo: MonthPeriod,
  criteria: Type.Array(Type.Object({
    index: Type.Integer({ minimum: 1 }),
    text: Type.String({ minLength: 1 }),
    rating: Nullable(ReviewRating),
    note: Nullable(Type.String()),
    links: Type.Array(MonthReviewLink),
  }, strict)),
}, strict);

/**
 * GET /api/me/months/:period/carryover：本人带进这个月草稿的顺延清单：延期到这个月的，加上延期到更早、到现在还没了结的。
 * 已取消的不带。
 */
export const MonthCarryoverResponse = Type.Object({ period: MonthPeriod, tasks: Type.Array(MonthCarryoverTask) }, strict);

export type TReviewDisposition = Static<typeof ReviewDisposition>;
export type TReviewRating = Static<typeof ReviewRating>;
export type TMissionVerdict = Static<typeof MissionVerdict>;
export type TReviewPerson = Static<typeof ReviewPerson>;
export type TMonthReviewLink = Static<typeof MonthReviewLink>;
export type TMonthReviewCriterion = Static<typeof MonthReviewCriterion>;
export type TMonthReviewTask = Static<typeof MonthReviewTask>;
export type TMonthReviewMission = Static<typeof MonthReviewMission>;
export type TMonthReviewPrefill = Static<typeof MonthReviewPrefill>;
export type TMonthReviewResponse = Static<typeof MonthReviewResponse>;
export type TPutReviewDispositionRequest = Static<typeof PutReviewDispositionRequest>;
export type TPutReviewCriterionRequest = Static<typeof PutReviewCriterionRequest>;
export type TReviewLinkCandidate = Static<typeof ReviewLinkCandidate>;
export type TReviewLinkCandidatesResponse = Static<typeof ReviewLinkCandidatesResponse>;
export type TAddReviewLinkRequest = Static<typeof AddReviewLinkRequest>;
export type TMonthCarryoverTask = Static<typeof MonthCarryoverTask>;
export type TMonthCarryoverResponse = Static<typeof MonthCarryoverResponse>;
