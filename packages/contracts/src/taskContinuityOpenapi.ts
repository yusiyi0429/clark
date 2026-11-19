import type { JsonSchema, OpenAPIV3 } from "./types/JsonSchemaTypes.js";
import {
  AddMonthTaskRequest, AddMonthTaskResponse, ContinueTaskRequest, ContinueTaskResponse, MonthDraft, MonthPageResponse, MonthTask, PutTaskGoalRequest, SetTaskDueDateRequest,
  StopTaskRequest, TaskDueDateResponse, TaskGoalResponse, TaskRef, TaskSettlement, TaskSettlementResponse,
} from "./taskContinuity.js";

/** 跨月延续与月份页的 OpenAPI 路径，手工列出，在 openapi.ts 里展开。 */

export const taskContinuitySchemas: Record<string, JsonSchema> = {
  TaskRef, TaskSettlement, ContinueTaskRequest, ContinueTaskResponse, StopTaskRequest, TaskSettlementResponse, MonthTask, MonthDraft, MonthPageResponse,
  SetTaskDueDateRequest, TaskDueDateResponse, PutTaskGoalRequest, TaskGoalResponse, AddMonthTaskRequest, AddMonthTaskResponse,
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
  "/api/me/tasks/{taskId}/due-date": {
    put: {
      operationId: "setTaskDueDate",
      summary: "改验收时间点（这件 Task 的负责人）：按 Task 存的唯一一份，不要求挂项目；null 不存了，退回记下的 Mission 节点。已经过去的月份 409",
      parameters: path("taskId"),
      requestBody: body("SetTaskDueDateRequest"),
      responses: { "200": json("存好了", "TaskDueDateResponse"), ...errors(400, 401, 403, 404, 409) },
    },
  },
  "/api/me/tasks/{taskId}/goal": {
    put: {
      operationId: "setTaskGoal",
      summary: "就地改名字和完成标准（这件 Task 的负责人）：天枢里先生效、标未进本体，不写本体；和本体一样就撤掉（恢复）。标准全删光、有空的 400，已经过去的月份 409",
      parameters: path("taskId"),
      requestBody: body("PutTaskGoalRequest"),
      responses: { "200": json("改后的名字和标准", "TaskGoalResponse"), ...errors(400, 401, 403, 404, 409) },
    },
  },
  "/api/me/months/{period}/tasks": {
    post: {
      operationId: "addMonthTask",
      summary: "添一件：在本人这个月的 Mission 下新建一件天枢里的 Task（不写本体，能挂项目、拆卡、进复盘）。不是本人的 Mission 403，已经过去的月份 409",
      parameters: path("period"),
      requestBody: body("AddMonthTaskRequest"),
      responses: { "201": json("建好了", "AddMonthTaskResponse"), ...errors(400, 401, 403, 404, 409) },
    },
  },
  "/api/me/months/{period}": {
    get: {
      operationId: "getMonthPage",
      summary: "月份页：这个月本人的 Task（Mission 的成果、完成标准原文和哪几条达到、改过的本体原文、是不是天枢里新加的、验收时间点和「原」、去向、"
        + "交付第几版、还在跑和受阻的子会话、确认完成没有、了结和延续去了哪），和下个月 Co-Agent 的草稿（现在为 null）",
      parameters: path("period"),
      responses: { "200": json("月份页", "MonthPageResponse"), ...errors(400, 401, 403) },
    },
  },
};
