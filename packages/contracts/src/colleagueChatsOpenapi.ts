import type { JsonSchema, OpenAPIV3 } from "./types/JsonSchemaTypes.js";
import {
  ChatListResponse, ChatMessage, ChatPerson, ChatResponse, ChatRow, ChatView, ChatWaitReason, ColleagueSearchResponse, CorrectChatMessageRequest,
  FriendGrant, FriendRelation, FriendSettings, FriendView, MainLine, MainLinesResponse, OwnerChatMessageRequest, SendChatMessageRequest,
} from "./colleagueChats.js";

export const colleagueChatSchemas: Record<string, JsonSchema> = {
  ChatListResponse, ChatMessage, ChatPerson, ChatResponse, ChatRow, ChatView, ChatWaitReason, ColleagueSearchResponse, CorrectChatMessageRequest,
  FriendGrant, FriendRelation, FriendSettings, FriendView, MainLine, MainLinesResponse, OwnerChatMessageRequest, SendChatMessageRequest,
};
const ref = (name: string) => ({ $ref: "#/components/schemas/" + name });
const path = (...names: string[]) => names.map((name) => ({ name, in: "path", required: true, schema: { type: "string" } }));
const response = (name: string) => ({ description: "结果", content: { "application/json": { schema: ref(name) } } });
const body = (name: string) => ({ required: true, content: { "application/json": { schema: ref(name) } } });
const errors = (...codes: number[]) => Object.fromEntries(codes.map((code) => [String(code), response("ApiError")]));
const chat = { "200": response("ChatResponse"), ...errors(400, 401, 403, 404, 409) };
const friend = { "200": response("FriendView"), ...errors(400, 401, 403, 404, 409) };
const C = "/api/me/colleague-chats";
const M = `${C}/{chatId}/messages/{messageId}`;
const F = "/api/me/friends/{personId}";

export const colleagueChatPaths: OpenAPIV3.Document["paths"] = {
  [C]: {
    get: { operationId: "listColleagueChats", summary: "本人的同事对话：我去问的、来问我的、加好友的请求",
      responses: { "200": response("ChatListResponse"), ...errors(401) } },
  },
  [`${C}/main-lines`]: {
    get: { operationId: "listColleagueChatMainLines", summary: "主对话里要出现的同事来问的话", responses: { "200": response("MainLinesResponse"), ...errors(401) } },
  },
  [`${C}/{chatId}/read`]: {
    post: { operationId: "readColleagueChat", summary: "这段对话读到最新", parameters: path("chatId"),
      responses: { "204": { description: "已读" }, ...errors(400, 401, 404) } },
  },
  [`${C}/with/{personId}`]: {
    get: { operationId: "readColleagueChatWith", summary: "我和这位同事的伙伴的对话", parameters: path("personId"), responses: chat },
  },
  [`${C}/from/{personId}`]: {
    get: { operationId: "readColleagueChatFrom", summary: "这位同事来问我的伙伴的对话", parameters: path("personId"), responses: chat },
  },
  [`${C}/with/{personId}/messages`]: {
    post: { operationId: "sendColleagueChatMessage", summary: "对这位同事的伙伴说一句", parameters: path("personId"),
      requestBody: body("SendChatMessageRequest"), responses: chat },
  },
  [`${M}/retry`]: {
    post: { operationId: "retryColleagueChatMessage", summary: "伙伴没答上来的这句再答一次", parameters: path("chatId", "messageId"), responses: chat },
  },
  [`${M}/ask-owner`]: {
    post: { operationId: "askColleagueChatOwner", summary: "这句请他本人回", parameters: path("chatId", "messageId"), responses: chat },
  },
  [`${M}/retract`]: {
    post: { operationId: "retractColleagueChatMessage", summary: "收回我的伙伴答的这句", parameters: path("chatId", "messageId"), responses: chat },
  },
  [`${M}/correct`]: {
    post: { operationId: "correctColleagueChatMessage", summary: "改我的伙伴答的这句", parameters: path("chatId", "messageId"),
      requestBody: body("CorrectChatMessageRequest"), responses: chat },
  },
  [`${C}/{chatId}/owner-messages`]: {
    post: { operationId: "sendColleagueChatOwnerMessage", summary: "本人在来问我的对话里说一句", parameters: path("chatId"),
      requestBody: body("OwnerChatMessageRequest"), responses: chat },
  },
  "/api/me/colleagues": {
    get: { operationId: "searchColleagues", summary: "找同事",
      parameters: [{ name: "query", in: "query", required: false, schema: { type: "string", maxLength: 100 } }],
      responses: { "200": response("ColleagueSearchResponse"), ...errors(400, 401) } },
  },
  "/api/me/friend-settings": {
    get: { operationId: "readFriendSettings", summary: "本人的加好友设置", responses: { "200": response("FriendSettings"), ...errors(401) } },
    put: { operationId: "saveFriendSettings", summary: "改本人的加好友设置", requestBody: body("FriendSettings"),
      responses: { "200": response("FriendSettings"), ...errors(400, 401) } },
  },
  [F]: {
    get: { operationId: "readFriend", summary: "我和这位同事的好友关系", parameters: path("personId"), responses: friend },
    delete: { operationId: "removeFriend", summary: "删好友", parameters: path("personId"), responses: friend },
  },
  [`${F}/request`]: {
    post: { operationId: "requestFriend", summary: "加这位同事为好友", parameters: path("personId"), responses: friend },
  },
  [`${F}/accept`]: {
    post: { operationId: "acceptFriend", summary: "同意这位同事的好友请求", parameters: path("personId"), requestBody: body("FriendGrant"), responses: friend },
  },
  [`${F}/grant`]: {
    put: { operationId: "saveFriendGrant", summary: "改给这位好友的授权", parameters: path("personId"), requestBody: body("FriendGrant"), responses: friend },
  },
};
