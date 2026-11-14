import type { JsonSchema, OpenAPIV3 } from "./types/JsonSchemaTypes.js";
import { ContinueMeetingWork, MeetingWorkHandoffs, MeetingWorkResult, MeetingWorkTargetList } from "./meetingWorkHandoffs.js";

export const meetingWorkHandoffSchemas: Record<string, JsonSchema> = { ContinueMeetingWork, MeetingWorkHandoffs, MeetingWorkResult, MeetingWorkTargetList };

const json = (name: string) => ({ "application/json": { schema: { $ref: `#/components/schemas/${name}` } } });
const failure = { description: "ApiError", content: json("ApiError") };
export const meetingWorkHandoffPaths: OpenAPIV3.Document["paths"] = {
  "/api/me/meeting-work-handoffs": { get: { operationId: "listMeetingWorkHandoffs", summary: "本人可递送的已确认会后变化和各去向的回执",
    responses: { "200": { description: "当前确认版本", content: json("MeetingWorkHandoffs") }, "401": failure, "403": failure } } },
  "/api/me/meeting-work-handoff-targets": { get: { operationId: "listMeetingWorkTargets", summary: "本人的项目和可选工作去向",
    responses: { "200": { description: "当前可选去向", content: json("MeetingWorkTargetList") }, "401": failure, "403": failure } } },
  "/api/me/meeting-work-handoffs/{confirmationRef}": { post: { operationId: "continueMeetingWork", summary: "本人明确继续推进，按目标分别递送这版确认内容",
    parameters: [{ name: "confirmationRef", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
    requestBody: { required: true, content: json("ContinueMeetingWork") },
    responses: { "200": { description: "各目标的递送回执", content: json("MeetingWorkResult") }, "400": failure, "401": failure, "403": failure, "404": failure, "409": failure } } },
};
