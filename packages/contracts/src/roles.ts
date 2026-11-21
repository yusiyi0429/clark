import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { NullableInteger } from "./nullable.js";

/**
 * 岗位与团队（V2 设计第 19 节）：长期存在、会成长的是岗位；每次干活按岗位临时起执行实例，验完就丢，学到的写回岗位。
 * 岗位正文（职责、做法、验收口径）都是 Markdown，本人在网页上改完保存，下一张卡就按新的来。预设的岗位包在仓库里，加进来是本人的一份副本。
 * 这个文件不引用 tasks.ts（卡的视图要引用它）。
 */

const strict = { additionalProperties: false } as const;
const Instant = Type.String({ format: "date-time" });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const Person = Type.Object({ personId: Type.String({ minLength: 1 }), name: Type.String({ minLength: 1 }) }, strict);

/** 岗位包：通用、研发、战略和内容（12 月加财务、HR）。 */
export const RoleFamily = Type.Union([Type.Literal("general"), Type.Literal("dev"), Type.Literal("strategy_content")]);
/** worker 干活的、reviewer 验收的（云端 Agent 验收按它的口径）、critic 挑刺的（专题评审会）。 */
export const RoleKind = Type.Union([Type.Literal("worker"), Type.Literal("reviewer"), Type.Literal("critic")]);
/** 开工时挂哪些插件。 */
export const RoleTool = Type.Union([Type.Literal("tianshu"), Type.Literal("web_search"), Type.Literal("feishu"), Type.Literal("github"), Type.Literal("browser")]);
/** 模型档位，开工时落到具体模型，本人可改。 */
export const RoleModelTier = Type.Union([Type.Literal("strong"), Type.Literal("normal"), Type.Literal("light")]);
const RoleText = Type.String({ maxLength: 8000 });
const RoleName = Type.String({ minLength: 1, maxLength: 20 });

/** 卡、草稿、专题上显示的岗位。 */
export const RoleRef = Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String({ minLength: 1 }), kind: RoleKind }, strict);

/** 交代里给本机会话的岗位：名称、职责、做法、验收口径、工具、模型档位、版本。 */
export const RoleBrief = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String({ minLength: 1 }),
  kind: RoleKind,
  dutiesMd: RoleText,
  practiceMd: RoleText,
  acceptanceMd: RoleText,
  tools: Type.Array(RoleTool),
  modelTier: RoleModelTier,
  version: Type.Integer({ minimum: 1 }),
}, strict);

/** 本人的一个岗位。presetKey、presetVersion 是从哪个预设、哪一版复制来的（自己新建的为 null）。 */
export const RoleView = Type.Object({
  ...RoleBrief.properties,
  family: RoleFamily,
  presetKey: Nullable(Type.String()),
  presetVersion: NullableInteger({ minimum: 1 }),
  updatedAt: Instant,
  updatedBy: Nullable(Person),
  /** 标了同事可用（同事的伙伴能读）才带。 */
  shared: Type.Optional(Type.Literal(true)),
}, strict);

/** 可加的预设岗位；added 是本人已经加过（有没归档的副本）。 */
export const RolePresetView = Type.Object({
  presetKey: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  family: RoleFamily,
  kind: RoleKind,
  dutiesMd: RoleText,
  tools: Type.Array(RoleTool),
  modelTier: RoleModelTier,
  version: Type.Integer({ minimum: 1 }),
  added: Type.Boolean(),
}, strict);

/** GET /api/me/roles：本人没归档的岗位，加可用的预设。 */
export const RoleListResponse = Type.Object({ roles: Type.Array(RoleView), presets: Type.Array(RolePresetView) }, strict);

/** 新建岗位：从预设复制（{presetKey}，同一个预设本人已经加过时 409），或自己写。 */
export const CreateRoleRequest = Type.Union([
  Type.Object({ presetKey: Type.String({ minLength: 1, maxLength: 80 }) }, strict),
  Type.Object({
    name: RoleName,
    family: RoleFamily,
    kind: RoleKind,
    dutiesMd: Type.Optional(RoleText),
    practiceMd: Type.Optional(RoleText),
    acceptanceMd: Type.Optional(RoleText),
    tools: Type.Optional(Type.Array(RoleTool, { maxItems: 5 })),
    modelTier: Type.Optional(RoleModelTier),
  }, strict),
]);

/** 改岗位：除 version、reason 外至少带一个字段；version 不一致 409 ROLE_VERSION_CONFLICT。保存后版本 +1，留一条修改记录。 */
export const PatchRoleRequest = Type.Object({
  version: Type.Integer({ minimum: 1 }),
  name: Type.Optional(RoleName),
  dutiesMd: Type.Optional(RoleText),
  practiceMd: Type.Optional(RoleText),
  acceptanceMd: Type.Optional(RoleText),
  tools: Type.Optional(Type.Array(RoleTool, { maxItems: 5 })),
  modelTier: Type.Optional(RoleModelTier),
  /** 为什么改，一句话，可不写。 */
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
}, strict);

export const RoleRevisionField = Type.Union([Type.Literal("name"), Type.Literal("dutiesMd"), Type.Literal("practiceMd"), Type.Literal("acceptanceMd"),
  Type.Literal("tools"), Type.Literal("modelTier")]);

/** 一次修改：改了哪些字段的前后文本（工具是逗号隔开的名单）、为什么、手改还是采纳的修改建议、谁改的。 */
export const RoleRevisionView = Type.Object({
  id: Type.String({ format: "uuid" }),
  version: Type.Integer({ minimum: 1 }),
  changes: Type.Array(Type.Object({ field: RoleRevisionField, before: Type.String(), after: Type.String() }, strict)),
  reason: Nullable(Type.String()),
  source: Type.Union([Type.Literal("manual"), Type.Literal("proposal")]),
  proposalId: Nullable(Type.String({ format: "uuid" })),
  createdBy: Person,
  createdAt: Instant,
}, strict);
export const RoleRevisionList = Type.Object({ revisions: Type.Array(RoleRevisionView) }, strict);

export const RoleProposalField = Type.Union([Type.Literal("dutiesMd"), Type.Literal("practiceMd"), Type.Literal("acceptanceMd")]);

/**
 * 伙伴提的一条岗位修改：本人推翻验收（overrule）或同一张卡第二次没过（second_fail）时提。
 * currentText 是这一段现在的文本，proposedText 是改后的整段；baseVersion 是提的时候岗位的版本，岗位之后又改过时采纳会 409 ROLE_CHANGED。
 */
export const RoleProposalView = Type.Object({
  id: Type.String({ format: "uuid" }),
  role: RoleRef,
  baseVersion: Type.Integer({ minimum: 1 }),
  sourceKind: Type.Union([Type.Literal("overrule"), Type.Literal("second_fail")]),
  handbackId: Type.String({ format: "uuid" }),
  card: Type.Object({ id: Type.String({ minLength: 1 }), title: Type.String() }, strict),
  field: RoleProposalField,
  currentText: Type.String(),
  proposedText: RoleText,
  why: Type.String({ maxLength: 200 }),
  status: Type.Union([Type.Literal("open"), Type.Literal("accepted"), Type.Literal("dismissed")]),
  createdAt: Instant,
  decidedAt: Nullable(Instant),
}, strict);
/** GET /api/me/role-proposals?status=open|all（默认 open）：新的在前。 */
export const RoleProposalList = Type.Object({ proposals: Type.Array(RoleProposalView) }, strict);

export type TRoleFamily = Static<typeof RoleFamily>;
export type TRoleKind = Static<typeof RoleKind>;
export type TRoleTool = Static<typeof RoleTool>;
export type TRoleModelTier = Static<typeof RoleModelTier>;
export type TRoleRef = Static<typeof RoleRef>;
export type TRoleBrief = Static<typeof RoleBrief>;
export type TRoleView = Static<typeof RoleView>;
export type TRolePresetView = Static<typeof RolePresetView>;
export type TRoleListResponse = Static<typeof RoleListResponse>;
export type TCreateRoleRequest = Static<typeof CreateRoleRequest>;
export type TPatchRoleRequest = Static<typeof PatchRoleRequest>;
export type TRoleRevisionField = Static<typeof RoleRevisionField>;
export type TRoleRevisionView = Static<typeof RoleRevisionView>;
export type TRoleRevisionList = Static<typeof RoleRevisionList>;
export type TRoleProposalField = Static<typeof RoleProposalField>;
export type TRoleProposalView = Static<typeof RoleProposalView>;
export type TRoleProposalList = Static<typeof RoleProposalList>;
