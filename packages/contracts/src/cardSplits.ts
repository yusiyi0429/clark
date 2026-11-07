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
 * GET /api/me/projects/:projectId/plan-brief（项目负责人，16.3）：没挂 Task 的项目的交代，task 为 null、criteria 和 exclusions 为空，
 * markdown 写项目名、目标历史、项目里已有的卡，要求每件派活单自带能核对的完成标准（对约定第几条一律写 null）。project 是拆的哪个项目（拆 Task 时是它挂的项目，没挂为 null）。
 */
export const CardPlanBriefResponse = Type.Object({
  markdown: Type.String({ minLength: 1, maxLength: 20000 }),
  role: Nullable(RoleBrief),
  task: Nullable(Type.Object({ taskId: Type.String({ minLength: 1 }), name: Type.String(), missionId: Type.String({ minLength: 1 }) }, strict)),
  project: Nullable(Type.Object({ projectId: Type.String({ format: "uuid" }), name: Type.String() }, strict)),
  criteria: Type.Array(Type.Object({ index: Type.Integer({ minimum: 1 }), text: Type.String(), proof: Nullable(Type.String()) }, strict)),
  exclusions: Type.Array(Type.String()),
  roles: Type.Array(PlanBriefRole),
}, strict);

export type TCardSplitRequestView = Static<typeof CardSplitRequestView>;
export type TCardSplitListResponse = Static<typeof CardSplitListResponse>;
export type TPlanBriefRole = Static<typeof PlanBriefRole>;
export type TCardPlanBriefResponse = Static<typeof CardPlanBriefResponse>;
