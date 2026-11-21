import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../src/openapi.js";

/** 本月页就地改的接口（11/19 DRI 根据地）都写进 OpenAPI，网页客户端类型从这里生成。 */
describe("本月页的 OpenAPI", () => {
  const doc = buildOpenApiDocument();
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const json = (value: unknown) => (value as { content: { "application/json": { schema: unknown } } }).content["application/json"].schema;

  it("改验收时间点、改名字和标准、添一件三条路径带请求和响应", () => {
    const due = doc.paths["/api/me/tasks/{taskId}/due-date"]?.put;
    expect(json(due?.requestBody)).toEqual(ref("SetTaskDueDateRequest"));
    expect(json(due?.responses["200"])).toEqual(ref("TaskDueDateResponse"));
    const goal = doc.paths["/api/me/tasks/{taskId}/goal"]?.put;
    expect(json(goal?.requestBody)).toEqual(ref("PutTaskGoalRequest"));
    expect(json(goal?.responses["200"])).toEqual(ref("TaskGoalResponse"));
    const add = doc.paths["/api/me/months/{period}/tasks"]?.post;
    expect(json(add?.requestBody)).toEqual(ref("AddMonthTaskRequest"));
    expect(json(add?.responses["201"])).toEqual(ref("AddMonthTaskResponse"));
    for (const operation of [due, goal, add]) expect(Object.keys(operation?.responses ?? {})).toContain("409");
    const schemas = Object.keys(doc.components?.schemas ?? {});
    expect(schemas).toEqual(expect.arrayContaining(["SetTaskDueDateRequest", "TaskDueDateResponse", "PutTaskGoalRequest", "TaskGoalResponse", "AddMonthTaskRequest", "AddMonthTaskResponse"]));
  });

  it("月份页的说明照现在的样子写", () => {
    const summary = doc.paths["/api/me/months/{period}"]?.get?.summary ?? "";
    expect(summary).not.toContain("约定几条达到");
    expect(summary).toContain("完成标准");
    expect(summary).toContain("验收时间点");
  });
});
