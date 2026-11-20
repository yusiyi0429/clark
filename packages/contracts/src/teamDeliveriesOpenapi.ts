import type { JsonSchema, OpenAPIV3 } from "./types/JsonSchemaTypes.js";
import {
  ReplyTeamDeliveryRequest, SendTeamDeliveryRequest, TeamDelivery, TeamDeliveryAttachment, TeamDeliveryBuddy, TeamDeliveryListQuery,
  TeamDeliveryListResponse, TeamDeliveryRecipient, TeamDeliveryReply, TeamDeliveryResponse,
  TeamDeliverySource, TeamDeliverySourcesResponse, TeamDeliveryTextResponse,
} from "./teamDeliveries.js";

export const teamDeliverySchemas: Record<string, JsonSchema> = {
  ReplyTeamDeliveryRequest, SendTeamDeliveryRequest, TeamDelivery, TeamDeliveryAttachment, TeamDeliveryBuddy, TeamDeliveryListQuery,
  TeamDeliveryListResponse, TeamDeliveryRecipient, TeamDeliveryReply, TeamDeliveryResponse,
  TeamDeliverySource, TeamDeliverySourcesResponse, TeamDeliveryTextResponse,
};
const ref = (name: string) => ({ $ref: "#/components/schemas/" + name });
const path = (...names: string[]) => names.map((name) => ({ name, in: "path", required: true, schema: { type: "string" } }));
const response = (name: string) => ({ description: "结果", content: { "application/json": { schema: ref(name) } } });
const errors = (...codes: number[]) => Object.fromEntries(codes.map((code) => [String(code), response("ApiError")]));
const uploadBody = (name: string) => ({ required: true, content: {
  "application/json": { schema: ref(name) },
  "multipart/form-data": { schema: { type: "object", required: ["payload"], properties: {
    payload: { type: "string", description: `首先发送 JSON 字符串（${name}）` },
    files: { type: "array", maxItems: 20, items: { type: "string", format: "binary" } },
  } } },
} });
const writeResponses = { "200": response("TeamDeliveryResponse"), ...errors(400, 401, 403, 404, 409, 413, 415) };

export const teamDeliveryPaths: OpenAPIV3.Document["paths"] = {
  "/api/me/team-deliveries": {
    get: { operationId: "listTeamDeliveries", summary: "本人伙伴收到或发出的团队来件",
      parameters: [{ name: "box", in: "query", required: true, schema: { type: "string", enum: ["received", "sent"] } }],
      responses: { "200": response("TeamDeliveryListResponse"), ...errors(400, 401) } },
    post: { operationId: "sendTeamDelivery", summary: "向指定同事的伙伴发文件、信息或临时问题", requestBody: uploadBody("SendTeamDeliveryRequest"),
      responses: writeResponses },
  },
  "/api/me/team-delivery-sources": {
    get: { operationId: "listTeamDeliverySources", summary: "本人可选的子会话文件版本",
      responses: { "200": response("TeamDeliverySourcesResponse"), ...errors(401) } },
  },
  "/api/me/team-deliveries/{id}": {
    get: { operationId: "readTeamDelivery", summary: "打开本人的来件；发起人看到逐人答复", parameters: path("id"),
      responses: { "200": response("TeamDeliveryResponse"), ...errors(400, 401, 404) } },
  },
  "/api/me/team-deliveries/{id}/replies": {
    post: { operationId: "replyTeamDelivery", summary: "在原请求下回复、说明缺项或给指定接收人澄清",
      parameters: path("id"), requestBody: uploadBody("ReplyTeamDeliveryRequest"), responses: writeResponses },
  },
  "/api/me/team-deliveries/{id}/recipients/{personId}/retry": {
    post: { operationId: "retryTeamDeliveryRecipient", summary: "发送人重试原名单中的一人", parameters: path("id", "personId"),
      responses: { "200": response("TeamDeliveryResponse"), ...errors(400, 401, 403, 404) } },
  },
  "/api/me/team-deliveries/{id}/recipients/{personId}/buddy/retry": {
    post: { operationId: "retryTeamDeliveryBuddy", summary: "问的人让这位同事的伙伴再答一次（没答上来时；不另占当天名额，超上限 409）", parameters: path("id", "personId"),
      responses: { "200": response("TeamDeliveryResponse"), ...errors(400, 401, 404, 409) } },
  },
  "/api/me/team-deliveries/{id}/recipients/{personId}/buddy/ask-owner": {
    post: { operationId: "askTeamDeliveryOwner", summary: "问的人不等伙伴了，转成普通征集进这位同事的等你（伙伴没答上来或超上限时）",
      parameters: path("id", "personId"), responses: { "200": response("TeamDeliveryResponse"), ...errors(400, 401, 404, 409) } },
  },
  "/api/me/team-deliveries/{id}/attachments/{attachmentId}": {
    get: { operationId: "downloadTeamDeliveryAttachment", summary: "按本人和原件权限下载本次投递的指定版本", parameters: path("id", "attachmentId"),
      responses: { "200": { description: "文件原件", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
        ...errors(400, 401, 404, 409) } },
  },
  "/api/me/team-deliveries/{id}/attachments/{attachmentId}/text": {
    get: { operationId: "readTeamDeliveryAttachmentText", summary: "按同一权限读取指定文件版本的正文", parameters: path("id", "attachmentId"),
      responses: { "200": response("TeamDeliveryTextResponse"), ...errors(400, 401, 404, 409, 413, 415, 422) } },
  },
};
