import type { JsonSchema, OpenAPIV3 } from "./types/JsonSchemaTypes.js";
import { PartnerMeetingItem, PartnerMeetingRecordResponse, PartnerMeetingsResponse } from "./partnerMeetings.js";

export const partnerMeetingSchemas: Record<string, JsonSchema> = { PartnerMeetingItem, PartnerMeetingsResponse, PartnerMeetingRecordResponse };
const json = (description: string, schema: string) => ({ description, content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } });
const errors = Object.fromEntries([401, 403, 404, 409, 502, 503].map(status => [String(status), json("读取失败", "ApiError")]));
const path = (name: string) => ({ name, in: "path" as const, required: true, schema: { type: "string" } });

export const partnerMeetingPaths: OpenAPIV3.Document["paths"] = {
  "/api/me/partner-meetings": { get: { operationId: "listPartnerMeetings", summary: "本人的会议、预审和会后收件",
    responses: { "200": json("伙伴里的会议", "PartnerMeetingsResponse"), "401": errors["401"] } } },
  "/api/me/partner-meetings/minutes/{token}": { get: { operationId: "readUnmatchedPartnerMinute", summary: "所有者用自己的授权读待整理的妙记",
    parameters: [path("token")], responses: { "200": json("妙记正文", "PartnerMeetingRecordResponse"), ...errors } } },
  "/api/me/partner-meetings/{id}/record": { get: { operationId: "readPartnerMeetingRecord", summary: "按当前参会资格和来源权限打开会议记录",
    parameters: [path("id"), { name: "source", in: "query", schema: { type: "string", enum: ["tianshu", "feishu"] } },
      { name:"recordingId",in:"query",schema:{type:"string"} }],
    responses: { "200": json("会议记录正文", "PartnerMeetingRecordResponse"), ...errors } } },
};
