import { Type, type Static } from "@sinclair/typebox";
import { BuddyForm } from "./buddy.js";

const strict = { additionalProperties: false } as const;
const Id = Type.String({ format: "uuid" });
const PersonId = Type.String({ minLength: 1, maxLength: 100 });
const Instant = Type.String({ format: "date-time" });
const Said = Type.String({ minLength: 1, maxLength: 2000 });

/** 伙伴自己不答、要本人表态的原因；飞书只推 CHAT_PUSH_REASONS。 */
export const ChatWaitReason = Type.Union([
  Type.Literal("commit"), Type.Literal("approve"), Type.Literal("money_external"),
  Type.Literal("asked_owner"), Type.Literal("no_basis"), Type.Literal("unsure"),
]);
export type TChatWaitReason = Static<typeof ChatWaitReason>;
export const CHAT_WAIT_WORD: Record<TChatWaitReason, string> = {
  commit: "要承诺", approve: "要批准", money_external: "钱和对外", asked_owner: "找你本人", no_basis: "资料里没有", unsure: "没把握",
};
export const CHAT_PUSH_REASONS: readonly TChatWaitReason[] = ["commit", "approve", "money_external", "asked_owner"];

export const FriendRelation = Type.Union([Type.Literal("none"), Type.Literal("pending_out"), Type.Literal("pending_in"), Type.Literal("friends")]);
/** agentAsk：对方的伙伴可以替他来问我。 */
export const FriendGrant = Type.Object({ agentAsk: Type.Boolean() }, strict);
export const FriendSettings = Type.Object({ admission: Type.Union([Type.Literal("auto"), Type.Literal("approve")]), defaults: FriendGrant }, strict);

/** left：这人已不在名单里。 */
export const ChatPerson = Type.Object({ personId: PersonId, displayName: Type.String(), left: Type.Boolean() }, strict);
const PeerBuddy = Type.Union([Type.Object({ name: Type.String(), form: BuddyForm }, strict), Type.Null()]);
const Author = Type.Union([Type.Literal("asker"), Type.Literal("asker_buddy"), Type.Literal("buddy"), Type.Literal("owner")]);

/** answer、wait 只有问句带；seen、retracted、correction 伙伴句用。 */
export const ChatMessage = Type.Object({
  id: Id, author: Author, text: Type.String(), at: Instant, replyTo: Type.Union([Id, Type.Null()]), sources: Type.Array(Type.String()),
  answer: Type.Union([Type.Literal("answering"), Type.Literal("answered"), Type.Literal("failed"), Type.Literal("limited"), Type.Literal("asked_owner"), Type.Null()]),
  wait: Type.Union([Type.Object({ reason: ChatWaitReason, at: Instant, closed: Type.Boolean() }, strict), Type.Null()]),
  seen: Type.Boolean(), retracted: Type.Boolean(), correction: Type.Union([Type.Object({ id: Id, text: Type.String(), at: Instant }, strict), Type.Null()]),
}, strict);
/** side：with 我去问他的伙伴，from 他来问我的伙伴。id 还没说过话时为 null。 */
export const ChatView = Type.Object({
  id: Type.Union([Id, Type.Null()]), side: Type.Union([Type.Literal("with"), Type.Literal("from")]), peer: ChatPerson, peerBuddy: PeerBuddy,
  relation: FriendRelation, messages: Type.Array(ChatMessage), firstWaiting: Type.Union([Id, Type.Null()]),
}, strict);
export const ChatRow = Type.Object({
  id: Id, peer: ChatPerson, peerBuddy: PeerBuddy, last: Type.Object({ author: Author, text: Type.String(), at: Instant }, strict),
  unread: Type.Boolean(), waiting: Type.Integer({ minimum: 0 }),
}, strict);
export const ChatListResponse = Type.Object({
  mine: Type.Array(ChatRow), inbound: Type.Array(ChatRow), requests: Type.Array(Type.Object({ person: ChatPerson, at: Instant }, strict)),
}, strict);
export const ChatResponse = Type.Object({ chat: ChatView }, strict);
export const SendChatMessageRequest = Type.Object({ clientId: Id, text: Said, via: Type.Optional(Type.Literal("main")) }, strict);
export const OwnerChatMessageRequest = Type.Object({ clientId: Id, text: Said, replyTo: Type.Optional(Id) }, strict);
export const CorrectChatMessageRequest = Type.Object({ clientId: Id, text: Said }, strict);

export const MainLine = Type.Object({
  chatId: Id, messageId: Id, peer: ChatPerson, author: Type.Union([Type.Literal("asker"), Type.Literal("asker_buddy")]),
  text: Type.Union([Type.String(), Type.Null()]), at: Instant,
}, strict);
export const MainLinesResponse = Type.Object({ items: Type.Array(MainLine) }, strict);

export const FriendView = Type.Object({
  person: ChatPerson, relation: FriendRelation, theirs: Type.Union([FriendGrant, Type.Null()]), mine: Type.Union([FriendGrant, Type.Null()]),
}, strict);
export const ColleagueSearchResponse = Type.Object({
  people: Type.Array(Type.Object({ personId: PersonId, displayName: Type.String(), matched: Type.Array(Type.String()), relation: FriendRelation }, strict)),
  more: Type.Integer({ minimum: 0 }),
}, strict);

export type TChatPerson = Static<typeof ChatPerson>;
export type TChatMessage = Static<typeof ChatMessage>;
export type TChatView = Static<typeof ChatView>;
export type TChatRow = Static<typeof ChatRow>;
export type TChatListResponse = Static<typeof ChatListResponse>;
export type TChatResponse = Static<typeof ChatResponse>;
export type TSendChatMessageRequest = Static<typeof SendChatMessageRequest>;
export type TOwnerChatMessageRequest = Static<typeof OwnerChatMessageRequest>;
export type TCorrectChatMessageRequest = Static<typeof CorrectChatMessageRequest>;
export type TMainLine = Static<typeof MainLine>;
export type TMainLinesResponse = Static<typeof MainLinesResponse>;
export type TFriendRelation = Static<typeof FriendRelation>;
export type TFriendGrant = Static<typeof FriendGrant>;
export type TFriendSettings = Static<typeof FriendSettings>;
export type TFriendView = Static<typeof FriendView>;
export type TColleagueSearchResponse = Static<typeof ColleagueSearchResponse>;
