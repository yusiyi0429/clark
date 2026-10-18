import { Type, type Static } from "@sinclair/typebox";
import { RequestStep } from "./requests.js";

/**
 * ⑧ 文档变更（含 ④ 的文档触发）：作者在机器人所在的群里 @机器人 贴文档链接即发布。
 * Agent 按工作依据清单里的文档和标题、修订时间等元数据（不读正文，D-26）找可能被它修订或取代的旧文档并给理由，
 * 作者勾选「修订 / 取代哪份」或「都不是」；确认不了时改问旧文档的负责人。确认后给依据旧版的人推影响卡。
 * 作者和被问的负责人都经送达通道收到一条 kind = doc_change 的请求。
 */
export const DocRelation = Type.Union([Type.Literal("revision"), Type.Literal("supersede")]);
/** finding Agent 在找候选；awaiting_author 等作者确认；asking_owner 作者确认不了、在问旧文档负责人；confirmed 有修订或取代；unrelated 都不是（或没有候选）。 */
export const DocChangeStatus = Type.Union([
  Type.Literal("finding"), Type.Literal("awaiting_author"), Type.Literal("asking_owner"), Type.Literal("confirmed"), Type.Literal("unrelated"),
]);
export const DocOwnerAnswer = Type.Union([Type.Literal("asked"), Type.Literal("valid"), Type.Literal("superseded")]);

export const DocChangeCandidate = Type.Object(
  {
    key: Type.String({ minLength: 1 }),
    kind: Type.Union([Type.Literal("material"), Type.Literal("feishu_doc"), Type.Literal("link")]),
    title: Type.String({ minLength: 1 }),
    url: Type.Union([Type.String(), Type.Null()]),
    ownerName: Type.Union([Type.String(), Type.Null()]),
    /** Agent 给的理由（只凭标题和元数据）。 */
    reason: Type.String({ minLength: 1 }),
    /** 同一个链接：有人依据的是它之前的版本。 */
    sameDoc: Type.Boolean(),
    /** 依据它的人数。 */
    dependents: Type.Integer({ minimum: 0 }),
    suggested: DocRelation,
    /** 确认下来的关系；没确认或不相关为 null。 */
    relation: Type.Union([DocRelation, Type.Null()]),
    ownerAnswer: Type.Union([DocOwnerAnswer, Type.Null()]),
  },
  { additionalProperties: false },
);

export const DocChangeView = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    status: DocChangeStatus,
    newDoc: Type.Object(
      { title: Type.String({ minLength: 1 }), url: Type.String({ minLength: 1 }), revisedAt: Type.Union([Type.String(), Type.Null()]) },
      { additionalProperties: false },
    ),
    authorName: Type.String({ minLength: 1 }),
    publishedAt: Type.String({ minLength: 1 }),
    candidates: Type.Array(DocChangeCandidate),
    /** 取代：生效日期、过渡期截止日（YYYY-MM-DD），已有的工作是否继续沿用旧版。 */
    effectiveOn: Type.Union([Type.String(), Type.Null()]),
    transitionUntil: Type.Union([Type.String(), Type.Null()]),
    keepExisting: Type.Union([Type.Boolean(), Type.Null()]),
    steps: Type.Array(RequestStep),
    /** 推出去的影响卡张数。 */
    pushed: Type.Integer({ minimum: 0 }),
    decidedByName: Type.Union([Type.String(), Type.Null()]),
    viewer: Type.Object(
      {
        role: Type.Union([Type.Literal("author"), Type.Literal("owner")]),
        /** 作者现在可以确认。 */
        canDecide: Type.Boolean(),
        /** 有别人负责的候选，可以改问负责人。 */
        canAskOwners: Type.Boolean(),
        /** 被问的负责人：还等他回答的候选 key。 */
        ownerKeys: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export const DocChangeResponse = Type.Object({ docChange: DocChangeView }, { additionalProperties: false });

const Day = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const SupersedeTerms = {
  effectiveOn: Type.Optional(Type.Union([Day, Type.Null()])),
  transitionUntil: Type.Optional(Type.Union([Day, Type.Null()])),
  keepExisting: Type.Optional(Type.Boolean()),
};

/** 作者确认：links 为空即「都不是」。 */
export const ConfirmDocChangeRequest = Type.Object(
  {
    links: Type.Array(Type.Object({ key: Type.String({ minLength: 1 }), relation: DocRelation }, { additionalProperties: false }), { maxItems: 10 }),
    ...SupersedeTerms,
  },
  { additionalProperties: false },
);

/** 旧文档负责人回答「你的《A》还有效吗？」。 */
export const DocOwnerAnswerRequest = Type.Object(
  { key: Type.String({ minLength: 1 }), answer: Type.Union([Type.Literal("valid"), Type.Literal("superseded")]), ...SupersedeTerms },
  { additionalProperties: false },
);

/** 文档变更影响卡上本人的选择：切换到新版；或继续用旧版到某天（until）并写一句理由（reason，keep 时必填）。修订卡「知道了」即 switch。 */
export const ImpactBasisChoiceRequest = Type.Object(
  {
    choice: Type.Union([Type.Literal("switch"), Type.Literal("keep")]),
    until: Type.Optional(Day),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  { additionalProperties: false },
);

export type TDocRelation = Static<typeof DocRelation>;
export type TDocChangeStatus = Static<typeof DocChangeStatus>;
export type TDocChangeCandidate = Static<typeof DocChangeCandidate>;
export type TDocChangeView = Static<typeof DocChangeView>;
export type TDocChangeResponse = Static<typeof DocChangeResponse>;
export type TConfirmDocChangeRequest = Static<typeof ConfirmDocChangeRequest>;
export type TDocOwnerAnswerRequest = Static<typeof DocOwnerAnswerRequest>;
export type TImpactBasisChoiceRequest = Static<typeof ImpactBasisChoiceRequest>;
