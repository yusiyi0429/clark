import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { LocalBranchName, LocalHandoverCheck, LocalRepoUrl } from "./localRunner.js";

/**
 * 项目转交（设计《新首页》16.7；11/07 用户同意，并改了一处：对话记录默认不带）。项目的带走，个人的留下：
 * - 带走：项目本身、目标历史、交付物和链接、附件、子会话记录（状态、验收结论，项目动态里看）、交接说明。
 * - 留下：项目对话（默认不带，原负责人那边只读；勾了「带上对话记录」时接手人能读原来那段，GET /api/me/project-transfers/:id/history，管线照样不读）、
 *   个人记忆、子会话的原始对话、预算（接手人用自己的缺省）、钥匙和账号（交接说明只写要哪些、找谁要）。
 * - 本体不动：挂着的 Task 跟着项目走，负责人还是原来的人（HomeProjectGoal.responsible）；月初自动挂接只挂到 Task 负责人自己的项目。
 *
 * 流程：原负责人在详情里「转给…」→ preparing（准备交接：在跑的会话等做完还是停掉、本机检查还是不检查直接转、交接说明）→ 发出 sent（发出前查密钥样式）
 * → 接手人「接手」accepted 或「不接」declined；没接之前原负责人随时撤回 withdrawn。一个项目同时只有一份没了结的（preparing 或 sent）。
 * 发出以后到接手之前，管线不开新的子会话；接手以后管线先不自己开子会话，等接手人先说一句（伙伴开专题回 409 PROJECT_PAUSED）。
 * 接手以后原负责人那边项目进「已归档」、只读（能看详情、动态、自己那段对话，不能发、不能改）；接手人那边对话从分隔线开始，第一条是交接说明。
 */

const strict = { additionalProperties: false } as const;
const Instant = Type.String({ format: "date-time" });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const PersonRef = Type.Object({ personId: Type.String({ minLength: 1 }), name: Type.String() }, strict);
export const ProjectTransferStatus = Type.Union([Type.Literal("preparing"), Type.Literal("sent"), Type.Literal("accepted"), Type.Literal("declined"),
  Type.Literal("withdrawn")]);

/** 交接说明的一段（顺序照 16.7：到哪了、没做完的事、关键决定和原因、怎么跑起来、代码在哪、坑、可以问谁；没内容的段不放）。 */
export const HandoverSection = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 20 }),
  lines: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 50 }),
}, strict);
export const HandoverNote = Type.Array(HandoverSection, { maxItems: 12 });

/**
 * 一份转交（同网页 lib/home/transfer.ts 的 Transfer）。
 * - status、startedAt（发起的时间）、decidedAt（最近一次发出 / 接手 / 不接 / 撤回的时间，还在准备为 null）。
 * - includeHistory：带不带对话记录，默认不带。
 * - running：有在跑的会话时本人选的「等做完再转 / 停掉」；check：绑了文件夹时选的「等本机检查 / 不检查直接转」；还没问到或用不着为 null。
 * - note：交接说明。发起时和存下本机检查结果（PATCH checkResult）时 note 先变成 null，云端在后台调模型写（和战场进展汇总同一套模型配置），
 *   材料是原负责人的项目对话、目标历史和判定、交付物、没做完的卡和专题、本机检查结果，七段一次写完（环境变量、账号只写名字和找谁要，不写值），
 *   写出来像密钥的让模型改掉；模型没配、出错、超时（约 90 秒）退回按云端的东西拼的四段（到哪了、没做完的事、代码在哪、可以问谁）。
 *   null 就是「正在写」，网页隔几秒 GET 一次；写的过程中本人改了（PATCH note）就不覆盖。本人和伙伴（/internal）都是整份交上来。
 * - checkResult：本机程序的交接检查（D 的 POST /v1/projects/:projectId/handover-check 原样转来）；没检查为 null。
 * - clone：接手人「拉到这台电脑」用的仓库地址和分支（检查结果里 origin（没有就第一个）远端；分支取 handover/ 开头的没推完分支，没有就当前分支），
 *   形状同本机的 POST /v1/projects/:projectId/clone（LocalRepoUrl、LocalBranchName）。不是 git、远端不是 https://、ssh://、git@ 开头（本地路径、file:// 等）为 null。
 *   远端地址照本机检查结果存（本机已去掉口令：https 去掉整段 user:password，ssh 只去密码、留着用户名），云端不再改。
 * - afterSequence：发起「准备交接」时这个项目对话最后一条消息的 sequence（ConversationMessage.sequence）。项目对话的消息从 Chat 读回来不带时间，
 *   网页按它把转交卡插在那条消息后面。发起时网页传上来；没传时云端读这个对话当时最后一条补上；对话还没有消息或读不到为 null。
 */
export const ProjectTransfer = Type.Object({
  id: Type.String({ format: "uuid" }),
  projectId: Type.String({ format: "uuid" }),
  projectName: Type.String(),
  from: PersonRef,
  to: PersonRef,
  status: ProjectTransferStatus,
  startedAt: Instant,
  decidedAt: Nullable(Instant),
  includeHistory: Type.Boolean(),
  running: Nullable(Type.Union([Type.Literal("wait"), Type.Literal("stop")])),
  check: Nullable(Type.Union([Type.Literal("wait"), Type.Literal("skip")])),
  note: Nullable(HandoverNote),
  checkResult: Nullable(LocalHandoverCheck),
  clone: Nullable(Type.Object({ repoUrl: LocalRepoUrl, branch: Nullable(LocalBranchName) }, strict)),
  afterSequence: Nullable(Type.Integer({ minimum: 1 })),
}, strict);

/**
 * POST /api/me/projects/:projectId/transfers（项目负责人，201）：发起。给自己 400；人员目录里没有 404；已有没了结的 409 TRANSFER_OPEN；归档的 409。
 * afterSequence：网页看到的这个项目对话最后一条消息的 sequence（转交卡排在它后面）；不传时云端自己读。
 */
export const CreateProjectTransferRequest = Type.Object({
  toPersonId: Type.String({ minLength: 1 }),
  afterSequence: Type.Optional(Type.Integer({ minimum: 1 })),
}, strict);

/** PATCH /api/me/project-transfers/:id（原负责人，preparing 时）：改说明、带不带对话、两个选择、本机检查结果。至少带一样；不在准备中 409。 */
export const UpdateProjectTransferRequest = Type.Object({
  note: Type.Optional(HandoverNote),
  includeHistory: Type.Optional(Type.Boolean()),
  running: Type.Optional(Nullable(Type.Union([Type.Literal("wait"), Type.Literal("stop")]))),
  check: Type.Optional(Nullable(Type.Union([Type.Literal("wait"), Type.Literal("skip")]))),
  checkResult: Type.Optional(LocalHandoverCheck),
}, { ...strict, minProperties: 1 });

/**
 * POST /api/me/project-transfers/:id/send（原负责人，preparing 时）：发出。交接说明为空 400。按常见密钥样式查一遍（sk-、ghp_、github_pat_、AKIA、
 * -----BEGIN … PRIVATE KEY-----、xox?-），命中就挡住，回 422，findings 标出哪一段第几行（从 1 数）、命中那一截只露前 6 位。
 */
export const HandoverSecretFinding = Type.Object({ section: Type.String(), line: Type.Integer({ minimum: 1 }), sample: Type.String() }, strict);
export const HandoverSecretsResponse = Type.Object({ code: Type.Literal("SECRET_IN_NOTE"), message: Type.String(), findings: Type.Array(HandoverSecretFinding) }, strict);

export type TPersonRef = Static<typeof PersonRef>;
export type TProjectTransferStatus = Static<typeof ProjectTransferStatus>;
export type THandoverSection = Static<typeof HandoverSection>;
export type THandoverNote = Static<typeof HandoverNote>;
export type TProjectTransfer = Static<typeof ProjectTransfer>;
export type TCreateProjectTransferRequest = Static<typeof CreateProjectTransferRequest>;
export type TUpdateProjectTransferRequest = Static<typeof UpdateProjectTransferRequest>;
export type THandoverSecretFinding = Static<typeof HandoverSecretFinding>;
export type THandoverSecretsResponse = Static<typeof HandoverSecretsResponse>;
