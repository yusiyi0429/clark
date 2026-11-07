import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { RoleBrief, RoleKind, RoleModelTier } from "./roles.js";

/**
 * 拆卡改在本机（V2 设计第 21 节）：伙伴只「登记拆卡」（工具名 register_card_split），真正去拆的是本人电脑上的规划员会话。
 * 网页读本人还没开工的登记，在这台电脑上开规划员；开了以后把登记去掉。规划员开工时拿的交代见 CardPlanBriefResponse。
 */

const strict = { additionalProperties: false } as const;
const Instant = Type.String({ format: "date-time" });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** 一条「要拆这个 Task」的登记：origin=buddy 是伙伴对话里说的（register_card_split），web 是 Task 页上的「拆一下」。 */
export const CardSplitRequestView = Type.Object({
  id: Type.String({ format: "uuid" }),
  taskId: Type.String({ minLength: 1 }),
  taskName: Type.String(),
  missionId: Type.String({ minLength: 1 }),
  origin: Type.Union([Type.Literal("buddy"), Type.Literal("web")]),
  createdAt: Instant,
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
 */
export const CardPlanBriefResponse = Type.Object({
  markdown: Type.String({ minLength: 1, maxLength: 20000 }),
  role: Nullable(RoleBrief),
  task: Type.Object({ taskId: Type.String({ minLength: 1 }), name: Type.String(), missionId: Type.String({ minLength: 1 }) }, strict),
  criteria: Type.Array(Type.Object({ index: Type.Integer({ minimum: 1 }), text: Type.String(), proof: Nullable(Type.String()) }, strict)),
  exclusions: Type.Array(Type.String()),
  roles: Type.Array(PlanBriefRole),
}, strict);

export type TCardSplitRequestView = Static<typeof CardSplitRequestView>;
export type TCardSplitListResponse = Static<typeof CardSplitListResponse>;
export type TPlanBriefRole = Static<typeof PlanBriefRole>;
export type TCardPlanBriefResponse = Static<typeof CardPlanBriefResponse>;
