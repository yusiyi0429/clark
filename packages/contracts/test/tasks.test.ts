import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  AcceptMyTaskRequest, AddMaterialLinkRequest, ConversationScope, CreateMyTaskRequest, MaterialFormat, MonthPlanResponse, NotificationKind, PatchMyTaskRequest,
  SaveMonthPlanRequest, TaskDetailResponse, TaskView,
} from "../src/index.js";
import { buildOpenApiDocument } from "../src/openapi.js";

const now = "2026-10-03T02:00:00.000Z";
const person = { personId: "sun-mingze", name: "孙铭泽" };
const step = {
  id: "7b0c3c1e-0000-4000-8000-000000000001", version: 1, title: "准备上线清单", status: "not_started", source: "plan",
  startDate: "2026-10-05", dueDate: "2026-10-08", doneDefinition: null,
  mission: { missionId: "sun-202610-1", title: "CEO Agent 核心体验", cardId: "card-1", period: "2026-10", battlefieldName: "灯塔项目", step: 2, steps: 4 },
  waitingOn: { taskId: "7b0c3c1e-0000-4000-8000-000000000000", title: "对齐验收口径" },
  owner: person, collaborators: [{ personId: "bai-tiantian", name: "白田田" }], latestProgress: null,
  returnReason: null, origin: null, awaitingAcceptance: false, planTaskId: null, blocker: null, createdAt: now, updatedAt: now,
};
/** uuid 格式由 Fastify 校验；这里只查字段与范围。 */
const withoutFormat = (schema: typeof CreateMyTaskRequest) => ({ ...schema, properties: { ...schema.properties, clientId: { ...schema.properties.clientId, format: undefined } } });

describe("执行事项契约（工单 05）", () => {
  it("一条执行事项带来源、起止、所属个人任务的第几步、等哪一步、推进人和协作者；独立事项没有所属", () => {
    expect(Value.Check(TaskView, step)).toBe(true);
    expect(Value.Check(TaskView, { ...step, source: "self", mission: null, waitingOn: null })).toBe(true);
    for (const invalid of [{ source: "ceo" }, { dueDate: "10/8" }, { startDate: "2026-10-5" }, { mission: { ...step.mission, step: 0 } }, { ownerId: "sun-mingze" }]) {
      expect(Value.Check(TaskView, { ...step, ...invalid })).toBe(false);
    }
  });

  it("新建必须写标题和归属（可以是 null 的独立事项），不能指定别人为推进人", () => {
    const schema = withoutFormat(CreateMyTaskRequest);
    const request = { clientId: "00000000-0000-4000-8000-000000000000", title: "调研竞品的上线节奏", missionId: null };
    expect(Value.Check(schema, request)).toBe(true);
    expect(Value.Check(schema, { ...request, missionId: "sun-202610-1", startDate: "2026-10-05", dueDate: "2026-10-09", doneDefinition: "写成一页对比" })).toBe(true);
    for (const invalid of [{ title: "" }, { title: "字".repeat(121) }, { ownerId: "bai-tiantian" }, { status: "done" }, { dueDate: "下周" }]) {
      expect(Value.Check(schema, { ...request, ...invalid })).toBe(false);
    }
    expect(Value.Check(schema, { clientId: request.clientId, title: request.title })).toBe(false);
  });

  it("修改只要 version 加上要改的字段；原来只改状态的请求照样有效，不能直接改成退回", () => {
    expect(Value.Check(PatchMyTaskRequest, { version: 3, status: "in_progress" })).toBe(true);
    expect(Value.Check(PatchMyTaskRequest, { version: 3, missionId: null, dueDate: null, judgment: "先做数据口径" })).toBe(true);
    expect(Value.Check(PatchMyTaskRequest, { version: 3, status: "returned" })).toBe(false);
    expect(Value.Check(PatchMyTaskRequest, { status: "done" })).toBe(false);
    // 完成只能走验收（design-12）。
    expect(Value.Check(PatchMyTaskRequest, { version: 3, status: "done" })).toBe(false);
  });

  it("验收只带判断，完成标准的文字由服务端拆；链接只收 http/https；通知多了「等你验收」", () => {
    /** uuid 格式由 Fastify 校验；这里只查字段与范围。 */
    const check = { ...AcceptMyTaskRequest, properties: { ...AcceptMyTaskRequest.properties, standards: Type.Array(Type.Object({ index: Type.Integer({ minimum: 0, maximum: 49 }), met: Type.Boolean(),
      evidence: Type.Union([Type.String({ minLength: 1, maxLength: 300 }), Type.Null()]), materialId: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false })),
      deliverableMaterialIds: Type.Array(Type.String()) } };
    const accept = { version: 4, verdict: "路线图定稿", standards: [{ index: 0, met: true, evidence: "见路线图 v4", materialId: null }], deliverableMaterialIds: [] };
    expect(Value.Check(check, accept)).toBe(true);
    for (const invalid of [{ verdict: "字".repeat(201) }, { standards: [{ index: 50, met: true, evidence: null, materialId: null }] }, { standards: [{ index: 0, met: true, evidence: null, materialId: null, text: "不收文字" }] }]) {
      expect(Value.Check(check, { ...accept, ...invalid })).toBe(false);
    }
    expect(Value.Check(AddMaterialLinkRequest, { url: "https://claude.ai/artifact/x" })).toBe(true);
    expect(Value.Check(AddMaterialLinkRequest, { url: "javascript:alert(1)" })).toBe(false);
    expect(Value.Check(MaterialFormat, "link")).toBe(true);
    expect(Value.Check(NotificationKind, "task_submitted")).toBe(true);
  });

  it("详情区分推进人与协作者，批注只属于本人", () => {
    const detail = { task: step, judgment: null, judgmentAt: null, myNote: "我这边周三能给数据", myNoteAt: now, role: "collaborator", missionOptions: [], collaboratorOptions: [], progress: [],
      standards: ["路线图定稿", "明华确认"], submission: null, acceptance: null };
    expect(Value.Check(TaskDetailResponse, detail)).toBe(true);
    expect(Value.Check(TaskDetailResponse, { ...detail, role: "ceo" })).toBe(false);
  });

  it("本月计划按组给出事项；保存时只带改过的组和字段，新步骤带 clientId，日期可以不定，给了就必须是 YYYY-MM-DD", () => {
    const plan = { period: "2026-10", firstDay: "2026-10-01", lastDay: "2026-10-31", today: "2026-10-03", editable: true, closedReason: null, groups: [
      { missionId: "sun-202610-1", title: "CEO Agent 核心体验", battlefieldName: "灯塔项目", cardId: "card-1", milestones: [{ date: "2026-10-10", text: "10/10 内测" }, { date: null, text: "待定 · 上线" }], items: [step] },
      { missionId: null, title: "独立事项", battlefieldName: null, cardId: null, milestones: [], items: [] },
    ] };
    expect(Value.Check(MonthPlanResponse, plan)).toBe(true);
    expect(Value.Check(MonthPlanResponse, { ...plan, period: "2026-13" })).toBe(false);
    const { format: _format, ...clientId } = SaveMonthPlanRequest.properties.groups.items.properties.items.items.properties.clientId;
    const itemSchema = SaveMonthPlanRequest.properties.groups.items.properties.items.items;
    const lenient = { ...itemSchema, properties: { ...itemSchema.properties, clientId } };
    expect(Value.Check(lenient, { taskId: step.id })).toBe(true);
    expect(Value.Check(lenient, { taskId: step.id, dueDate: "2026-10-08" })).toBe(true);
    expect(Value.Check(lenient, { taskId: step.id, startDate: null, dueDate: null })).toBe(true);
    expect(Value.Check(lenient, { clientId: "00000000-0000-4000-8000-000000000009", title: "灰度" })).toBe(true);
    expect(Value.Check(lenient, { clientId: "00000000-0000-4000-8000-000000000009", title: "灰度", startDate: "2026-10-09", dueDate: "2026-10-12" })).toBe(true);
    expect(Value.Check(lenient, { taskId: step.id, version: 1 })).toBe(false);
    expect(Value.Check(lenient, { title: "灰度", startDate: "10/9", dueDate: "10/12" })).toBe(false);
    expect(Value.Check(lenient, { taskId: step.id, title: "" })).toBe(false);
  });

  it("对话范围多了 task:，通知多了「邀请你协作」，接口都登记在 OpenAPI 里", () => {
    expect(Value.Check(ConversationScope, "task:7b0c3c1e-0000-4000-8000-000000000001")).toBe(true);
    expect(Value.Check(NotificationKind, "task_collaborator_added")).toBe(true);
    const doc = buildOpenApiDocument();
    expect(doc.paths["/api/me/tasks"]?.post).toBeDefined();
    expect(doc.paths["/api/me/tasks/{id}"]?.get).toBeDefined();
    expect(doc.paths["/api/me/tasks/{id}"]?.delete).toBeDefined();
    expect(doc.paths["/api/me/tasks/{id}/note"]?.put).toBeDefined();
    expect(doc.paths["/api/me/tasks/{id}/collaborators"]?.post).toBeDefined();
    expect(doc.paths["/api/me/plan"]?.get).toBeDefined();
    expect(doc.paths["/api/me/plan"]?.put?.responses?.["409"]).toBeDefined();
    expect(doc.components.schemas.MonthPlanResponse).toBeDefined();
    expect(doc.paths["/api/me/tasks/{id}/accept"]?.post).toBeDefined();
    expect(doc.paths["/api/me/tasks/{id}/acceptance-draft"]?.post?.responses?.["503"]).toBeDefined();
    expect(doc.paths["/api/me/tasks/{id}/submission"]?.delete).toBeDefined();
    expect(doc.paths["/api/me/tasks/{id}/reopen"]?.post).toBeDefined();
    expect(doc.paths["/api/materials/{objectType}/{objectId}/links"]?.post).toBeDefined();
  });
});
