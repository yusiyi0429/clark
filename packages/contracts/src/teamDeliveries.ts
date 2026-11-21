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
const ReplyStatus = Type.Union([Type.Literal("answered"), Type.Literal("needs_info"), Type.Literal("clarification")]);
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
export const TeamDeliveryReply = Type.Object({
  id: Id, status: ReplyStatus, text: Text, createdAt: Instant, attachments: Type.Array(TeamDeliveryAttachment),
}, strict);
export const TeamDeliveryRecipient = Type.Object({
  personId: PersonId, displayName: Type.String(),
  status: Type.Union([Type.Literal("delivered"), Type.Literal("pending"), Type.Literal("needs_info"), Type.Literal("answered"), Type.Literal("failed")]),
  error: Type.Union([Type.String(), Type.Null()]), replies: Type.Array(TeamDeliveryReply),
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
export type TTeamDeliveryAttachment = Static<typeof TeamDeliveryAttachment>;
export type TTeamDeliverySource = Static<typeof TeamDeliverySource>;
export type TTeamDeliveryReply = Static<typeof TeamDeliveryReply>;
export type TTeamDeliveryRecipient = Static<typeof TeamDeliveryRecipient>;
export type TTeamDelivery = Static<typeof TeamDelivery>;
export type TTeamDeliveryTextResponse = Static<typeof TeamDeliveryTextResponse>;
