import type { JsonSchema, OpenAPIV3 } from "./types/JsonSchemaTypes.js";
import {
  ContinueTaskRequest, ContinueTaskResponse, MonthAnswer, MonthDraft, MonthPageResponse, MonthTask, StopTaskRequest, TaskRef, TaskSettlement, TaskSettlementResponse,
} from "./taskContinuity.js";

/** 跨月延续与月份页的 OpenAPI 路径，手工列出，在 openapi.ts 里展开。 */

export const taskContinuitySchemas: Record<string, JsonSchema> = {
  TaskRef, TaskSettlement, ContinueTaskRequest, ContinueTaskResponse, StopTaskRequest, TaskSettlementResponse, MonthAnswer, MonthTask, MonthDraft, MonthPageResponse,
};

const error = { description: "ApiError 统一错误", content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } } };
const errors = (...codes: number[]) => Object.fromEntries(codes.map((code) => [String(code), error]));
const json = (description: string, schema: string) => ({ description, content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } });
const body = (schema: string) => ({ required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } });
const path = (...names: string[]) => names.map((name) => ({ name, in: "path" as const, required: true, schema: { type: "string" } }));

export const taskContinuityPaths: OpenAPIV3.Document["paths"] = {
  "/api/me/tasks/{taskId}/continuation": {
    post: {
      operationId: "continueTask",
      summary: "延续（这件 Task 的负责人）：接着做成另一件本人负责的 Task；没做完的卡、专题、待交付条目、拆卡登记、规划员挂过去，管线接着用，约定复制成草稿。可以重复调",
      parameters: path("taskId"),
      requestBody: body("ContinueTaskRequest"),
      responses: { "200": json("延续好了", "ContinueTaskResponse"), ...errors(400, 401, 403, 404, 409) },
    },
  },
  "/api/me/tasks/{taskId}/stop": {
    post: {
      operationId: "stopTask",
      summary: "到此为止（这件 Task 的负责人）：这件 Task 了结了，不在左栏；可以补一句话。已经延续出去的 409",
      parameters: path("taskId"),
      requestBody: body("StopTaskRequest"),
      responses: { "200": json("定了到此为止", "TaskSettlementResponse"), ...errors(400, 401, 403, 404, 409) },
    },
    delete: {
      operationId: "unstopTask",
      summary: "撤销到此为止（这件 Task 的负责人）；本来就没定也回 204",
      parameters: path("taskId"),
      responses: { "204": { description: "撤销了" }, ...errors(401, 403, 404) },
    },
  },
  "/api/me/months/{period}": {
    get: {
      operationId: "getMonthPage",
      summary: "月份页：这个月本人的 Task（约定几条达到、交付第几版、还在跑和受阻的子会话、确认完成没有、了结和延续去了哪、复盘时怎么定的），和下个月 Co-Agent 的草稿（现在为 null）",
      parameters: path("period"),
      responses: { "200": json("月份页", "MonthPageResponse"), ...errors(400, 401, 403) },
    },
  },
  "/api/me/months/{period}/tasks/{taskId}/decision": {
    put: {
      operationId: "decideMonthTask",
      summary: "复盘时这件怎么办：继续做 / 改一改再做 / 到此为止，可以补一句话；选到此为止同时定了到此为止，改成别的就撤销",
      parameters: path("period", "taskId"),
      requestBody: body("MonthAnswer"),
      responses: { "204": { description: "存好了" }, ...errors(400, 401, 403, 404, 409) },
    },
  },
};
