import { Type, type Static } from "@sinclair/typebox";
import type { OpenAPIV3, JsonSchema } from "./types/JsonSchemaTypes.js";
import { TaskQualityOptions, TaskQualityCatalog, TaskQualityReviewList, TaskQualityReviewView, TaskRepairInput,
  TaskRepairView, TaskRepairList, TaskRepairHandoff, TaskRepairReceiptInput, TaskMeetingInput, TaskMeetingAnalysis, TaskMeetingRepairInput, TaskRepairRevision } from "./vendor/chat-task-quality.js";

/** 这套天枢接没接数据质量服务（CHAT_SERVICE_URL）：没接时前端不显示入口。 */
export const TaskQualityStatus = Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false });
export type TTaskQualityStatus = Static<typeof TaskQualityStatus>;

export const taskQualitySchemas: Record<string, JsonSchema> = { TaskQualityStatus, TaskQualityOptions, TaskQualityCatalog, TaskQualityReviewList, TaskQualityReviewView,
  TaskRepairInput, TaskRepairView, TaskRepairList, TaskRepairHandoff, TaskRepairReceiptInput, TaskMeetingInput, TaskMeetingAnalysis, TaskMeetingRepairInput, TaskRepairRevision };
const route = (operationId: string, response: string, body?: string, param?: string, cursor = false): OpenAPIV3.PathItem => ({
  operationId, summary: "本人 Task 数据质量与补齐记录",
  parameters: [...(param ? [{ name: param, in: "path", required: true, schema: { type: "string" } }] : []),
    ...(cursor ? [{ name: "cursor", in: "query", required: false, schema: { type: "string" } }] : [])],
  ...(body ? { requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${body}` } } } } } : {}),
  responses: { "200": { description: "本人核对结果", content: { "application/json": { schema: { $ref: `#/components/schemas/${response}` } } } },
    ...Object.fromEntries([400, 401, 403, 404, 409, 502, 503].map(code => [String(code), { description: "请求未完成", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } } }])) },
});
export const taskQualityPaths: OpenAPIV3.Document["paths"] = {
  "/api/task-quality/status": { get: route("getTaskQualityStatus", "TaskQualityStatus") },
  "/api/task-quality": { get: route("listTaskQualityReviews", "TaskQualityReviewList") },
  "/api/task-quality/catalog": { get: route("listQualityTaskCatalog", "TaskQualityCatalog", undefined, undefined, true) },
  "/api/task-quality/tasks/{taskId}/check": { post: route("checkTaskQuality", "TaskQualityReviewView", "TaskQualityOptions", "taskId") },
  "/api/task-quality/tasks/{taskId}/proposals": { post: route("proposeTaskRepair", "TaskRepairView", "TaskRepairInput", "taskId") },
  "/api/task-quality/proposals": { get: route("listTaskRepairs", "TaskRepairList") },
  "/api/task-quality/proposals/{proposalId}/revise": { post: route("reviseTaskRepair", "TaskRepairView", "TaskRepairRevision", "proposalId") },
  "/api/task-quality/proposals/{proposalId}/handoff": { get: route("getTaskRepairHandoff", "TaskRepairHandoff", undefined, "proposalId") },
  "/api/task-quality/proposals/{proposalId}/receipts": { post: route("reportTaskRepairReceipt", "TaskRepairView", "TaskRepairReceiptInput", "proposalId") },
  "/api/task-quality/meetings/{meetingId}/analyze": { post: route("analyzeMeetingTasks", "TaskMeetingAnalysis", "TaskMeetingInput", "meetingId") },
  "/api/task-quality/meetings/{meetingId}/proposals": { post: route("proposeMeetingTaskRepair", "TaskRepairView", "TaskMeetingRepairInput", "meetingId") },
};
