import { Type, type Static } from "@sinclair/typebox";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT } from "./attachments.js";
import { RequestPerson } from "./requests.js";

const strict = { additionalProperties: false } as const;
const Id = Type.String({ format: "uuid" });
const PersonId = Type.String({ minLength: 1, maxLength: 100 });
const Instant = Type.String({ format: "date-time" });
const Text = Type.String({ maxLength: 20_000 });
const Sha = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Url = Type.String({ minLength: 1, maxLength: 2048, pattern: "^https?://" });
const FileInfo = { id: Id, fileName: Type.String({ minLength: 1, maxLength: 255 }), size: Type.Integer({ minimum: 1, maximum: ATTACHMENT_MAX_BYTES }), sha256: Sha };
const Kind = Type.Union([Type.Literal("share"), Type.Literal("question")]);
/** follow_up：发起人对伙伴的答复追问（必带 recipientId），伙伴带着整段往来再答一次。 */
const ReplyStatus = Type.Union([Type.Literal("answered"), Type.Literal("needs_info"), Type.Literal("clarification"), Type.Literal("follow_up")]);
const SourceAttachments = Type.Array(Type.Object({ id: Id, sha256: Sha }, strict), { maxItems: ATTACHMENT_MAX_COUNT, uniqueItems: true });

/** 两个写接口接受此 JSON；拖入文件时把同一 JSON 放入 multipart 的 payload 字段，文件逐个使用 files 字段。 */
export const SendTeamDeliveryRequest = Type.Object({
  clientId: Id, kind: Kind, recipientIds: Type.Array(PersonId, { minItems: 1, maxItems: 50, uniqueItems: true }),
  text: Type.Optional(Text), sourceUrl: Type.Optional(Url), dueAt: Type.Optional(Instant), sourceAttachments: Type.Optional(SourceAttachments),
}, strict);
export const ReplyTeamDeliveryRequest = Type.Object({
  clientId: Id, status: ReplyStatus, recipientId: Type.Optional(PersonId), text: Type.Optional(Text), sourceAttachments: Type.Optional(SourceAttachments),
}, strict);
export const TeamDeliveryAttachment = Type.Object({ ...FileInfo, href: Type.String() }, strict);
export const TeamDeliverySource = Type.Object({ ...FileInfo, createdAt: Instant }, strict);
export const TeamDeliverySourcesResponse = Type.Object({ items: Type.Array(TeamDeliverySource) }, strict);
/**
 * origin：伙伴替被问的人答的才带 "buddy"；本人答的不带。伙伴答的不算本人回复，收件人的 status 不因它变。以下有才带：
 * reviewedAt 伙伴的答复，被问的人点「没问题」或「改一下」的时间；corrects 这条是被问的人的更正，更正的是哪条伙伴答复；
 * correctionSeenAt 更正，发起人点了「知道了」的时间（没点的在发起人的等你里）。
 */
export const TeamDeliveryReply = Type.Object({
  id: Id, status: ReplyStatus, text: Text, createdAt: Instant, attachments: Type.Array(TeamDeliveryAttachment), origin: Type.Optional(Type.Literal("buddy")),
  reviewedAt: Type.Optional(Instant), corrects: Type.Optional(Id), correctionSeenAt: Type.Optional(Instant),
}, strict);
/**
 * 被问的人看伙伴的答复：「没问题」，或「改一下」另起一条更正（原话保留；点过没问题也能改，一条最多改一次）。
 * corrected 放在前面：接口校验会删掉不认识的字段，先试 ok 会把 clientId、text 删掉。
 */
export const ReviewBuddyReplyRequest = Type.Union([
  Type.Object({ clientId: Id, verdict: Type.Literal("corrected"), text: Type.String({ minLength: 1, maxLength: 20_000 }) }, strict),
  Type.Object({ verdict: Type.Literal("ok") }, strict),
]);
/**
 * 这位收件人经过了伙伴（只问一个人、没附件、没截止的征集，两边都被覆盖）。askedAt 是最近一次问到伙伴的时间。
 * answering 伙伴在答；answered 伙伴答了；handoff 转本人，在他的等你里（note 是原因）；
 * failed 没答上来（出错、在答超过 2 分钟、没有可读的资料），limited 今天的代答次数满了：这两种不进被问的人的等你，note 是给问的人看的原因，
 * 问的人可以「问本人」（转成 handoff）；failed 还可以「重试」，limited 不能。
 * handoffBy 只在 handoff 时带：buddy 伙伴判的要本人定（note 是伙伴给的原因）；asker 问的人点了「问本人」
 * （问的人看到的 note 是当时没答上来的原因，被问的人看到的是「同事请你本人回」）。
 */
export const TeamDeliveryBuddy = Type.Object({
  state: Type.Union([Type.Literal("answering"), Type.Literal("answered"), Type.Literal("handoff"), Type.Literal("failed"), Type.Literal("limited")]),
  note: Type.Union([Type.String(), Type.Null()]), askedAt: Instant, handoffBy: Type.Optional(Type.Union([Type.Literal("buddy"), Type.Literal("asker")])),
}, strict);
export const TeamDeliveryRecipient = Type.Object({
  personId: PersonId, displayName: Type.String(),
  status: Type.Union([Type.Literal("delivered"), Type.Literal("pending"), Type.Literal("needs_info"), Type.Literal("answered"), Type.Literal("failed")]),
  error: Type.Union([Type.String(), Type.Null()]), replies: Type.Array(TeamDeliveryReply), buddy: Type.Optional(TeamDeliveryBuddy),
}, strict);
export const TeamDelivery = Type.Object({
  id: Id, kind: Kind, text: Text, sourceUrl: Type.Union([Url, Type.Null()]), dueAt: Type.Union([Instant, Type.Null()]), createdAt: Instant,
  sender: RequestPerson, attachments: Type.Array(TeamDeliveryAttachment), recipients: Type.Array(TeamDeliveryRecipient),
}, strict);
export const TeamDeliveryResponse = Type.Object({ delivery: TeamDelivery }, strict);
export const TeamDeliveryListQuery = Type.Object({ box: Type.Union([Type.Literal("received"), Type.Literal("sent")]) }, strict);
export const TeamDeliveryListResponse = Type.Object({ items: Type.Array(TeamDelivery) }, strict);
export const TeamDeliveryTextResponse = Type.Object({ text: Type.String(), fileName: Type.String(), truncated: Type.Boolean() }, strict);

export type TSendTeamDeliveryRequest = Static<typeof SendTeamDeliveryRequest>;
export type TReplyTeamDeliveryRequest = Static<typeof ReplyTeamDeliveryRequest>;
export type TReviewBuddyReplyRequest = Static<typeof ReviewBuddyReplyRequest>;
export type TTeamDeliveryAttachment = Static<typeof TeamDeliveryAttachment>;
export type TTeamDeliverySource = Static<typeof TeamDeliverySource>;
export type TTeamDeliveryReply = Static<typeof TeamDeliveryReply>;
export type TTeamDeliveryBuddy = Static<typeof TeamDeliveryBuddy>;
export type TTeamDeliveryRecipient = Static<typeof TeamDeliveryRecipient>;
export type TTeamDelivery = Static<typeof TeamDelivery>;
export type TTeamDeliveryTextResponse = Static<typeof TeamDeliveryTextResponse>;
