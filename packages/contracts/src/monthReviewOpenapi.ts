import type { JsonSchema, OpenAPIV3 } from "./types/JsonSchemaTypes.js";
import {
  AddReviewLinkRequest, MissionVerdict, MonthCarryoverResponse, MonthCarryoverTask, MonthReviewCriterion, MonthReviewLink, MonthReviewMission, MonthReviewPrefill,
  MonthReviewResponse, MonthReviewTask, PutReviewCriterionRequest, PutReviewDispositionRequest, ReviewDisposition, ReviewLinkCandidate, ReviewLinkCandidatesResponse,
  ReviewPerson, ReviewRating,
} from "./monthReview.js";

/** 月底复盘第三版的 OpenAPI 路径，手工列出，在 openapi.ts 里展开。 */

export const monthReviewSchemas: Record<string, JsonSchema> = {
  ReviewDisposition, ReviewRating, MissionVerdict, ReviewPerson, MonthReviewLink, MonthReviewCriterion, MonthReviewTask, MonthReviewMission, MonthReviewPrefill,
  MonthReviewResponse, PutReviewDispositionRequest, PutReviewCriterionRequest, ReviewLinkCandidate, ReviewLinkCandidatesResponse, AddReviewLinkRequest,
  MonthCarryoverTask, MonthCarryoverResponse,
};

const error = { description: "ApiError 统一错误", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } } };
const errors = (...codes: number[]) => Object.fromEntries(codes.map((code) => [String(code), error]));
const json = (description: string, schema: string) => ({ description, content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } });
const body = (schema: string) => ({ required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } });
const path = (...names: string[]) => names.map((name) => ({ name, in: "path" as const, required: true, schema: { type: "string" } }));
const review = (description: string) => json(description, "MonthReviewResponse");

export const monthReviewPaths: OpenAPIV3.Document["paths"] = {
  "/api/me/months/{period}/review": {
    get: {
      operationId: "getMonthReview",
      summary: "复盘页：本人这个月的 Mission（只放本期验收的 Task，逐条预评、评定、交付，总评），延期和取消的放最下面；预评走到哪了、截止时间",
      parameters: path("period"),
      responses: { "200": review("复盘页"), ...errors(400, 401, 403) },
    },
  },
  "/api/me/months/{period}/review/tasks/{taskId}/disposition": {
    put: {
      operationId: "putMonthReviewDisposition",
      summary: "改一件 Task 的去向：本期验收 / 延期到某个月（缺省下个月）/ 已取消。Mission 负责人能改整个 Mission 的，Task 负责人能改自己的",
      parameters: path("period", "taskId"),
      requestBody: body("PutReviewDispositionRequest"),
      responses: { "200": review("改好了，整份复盘页"), ...errors(400, 401, 403, 404) },
    },
  },
  "/api/me/months/{period}/review/tasks/{taskId}/criteria/{index}": {
    put: {
      operationId: "putMonthReviewCriterion",
      summary: "改一条验收标准的评定和备注；和预评不同时备注必填。这件不是本期验收的 409",
      parameters: path("period", "taskId", "index"),
      requestBody: body("PutReviewCriterionRequest"),
      responses: { "200": review("改好了，整份复盘页"), ...errors(400, 401, 403, 404, 409) },
    },
  },
  "/api/me/months/{period}/review/tasks/{taskId}/criteria/{index}/links": {
    post: {
      operationId: "addMonthReviewLink",
      summary: "给一条标准挂一个交付：粘贴的链接，或者弹层里点的天枢交付物、子会话产出",
      parameters: path("period", "taskId", "index"),
      requestBody: body("AddReviewLinkRequest"),
      responses: { "200": review("挂好了，整份复盘页"), ...errors(400, 401, 403, 404, 409) },
    },
  },
  "/api/me/months/{period}/review/links/{linkId}": {
    delete: {
      operationId: "deleteMonthReviewLink",
      summary: "删掉一个挂上的交付",
      parameters: path("period", "linkId"),
      responses: { "200": review("删好了，整份复盘页"), ...errors(401, 403, 404) },
    },
  },
  "/api/me/months/{period}/review/tasks/{taskId}/link-candidates": {
    get: {
      operationId: "listMonthReviewLinkCandidates",
      summary: "「+ 添加」弹层：这件 Task 在天枢里已有的交付物条目和子会话产出",
      parameters: path("period", "taskId"),
      responses: { "200": json("可以挂的", "ReviewLinkCandidatesResponse"), ...errors(401, 403, 404) },
    },
  },
  "/api/me/months/{period}/review/missions/{missionId}/confirm": {
    post: {
      operationId: "confirmMonthReviewMission",
      summary: "确认一个 Mission 的复盘（只有 Mission 负责人能点）；确认以后再改要重新确认",
      parameters: path("period", "missionId"),
      responses: { "200": review("确认了，整份复盘页"), ...errors(401, 403, 404, 409) },
    },
  },
  "/api/me/months/{period}/carryover": {
    get: {
      operationId: "getMonthCarryover",
      summary: "顺延清单：本人延期到这个月（和延期到更早、还没了结）的 Task，带原验收标准、做到哪了、已挂的交付；已取消的不带",
      parameters: path("period"),
      responses: { "200": json("顺延清单", "MonthCarryoverResponse"), ...errors(400, 401, 403) },
    },
  },
};
