import type { FastifyReply } from "fastify";
import { Type } from "@sinclair/typebox";
import { CreateProjectRequest, Project, ProjectDetailResponse, ProjectFeedResponse, ProjectGoalResponse, ProjectListResponse, ProjectPipelineResponse,
  UpdateProjectRequest } from "@warmap/contracts";
import { ChatServiceError } from "../chatService.js";
import { createProject, goalView, linkGoal, listProjects, ownProject, projectDetail, projectGoalRows, projectScope, projectView, unlinkGoal, updateProject } from "../projects.js";
import { readProjectFeed } from "../taskFeed.js";
import { boardTask, CardError, planTaskOpener } from "../taskCards.js";
import { ensureProjectPipeline } from "../taskPipelines.js";
import { settlementsOf } from "../taskContinuity.js";
import type { AppInstance, Guard, RouteContext } from "./shared.js";

const projectParams = Type.Object({ projectId: Type.String({ minLength: 1 }) });
const goalParams = Type.Object({ projectId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }) });

/**
 * 项目（契约 projects.ts，设计《新首页》第 16 节）：本人的项目、挂接、项目详情、项目对话、项目动态。DRI 工作台的人才有，只给本人。
 */
export function registerProjectRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, pool, fail, requirePerson } = ctx;
  const open = planTaskOpener(q, ctx.planTasks, ctx.peopleDirectory, ctx.now);
  const requireMember: Guard = async (req, reply) => {
    await requirePerson(req, reply);
    if (reply.sent) return reply;
    if (req.person?.role !== "member") return fail(reply, 403, "FORBIDDEN", "请切换到 DRI 工作台");
  };
  const handle = async <T>(reply: FastifyReply, work: () => Promise<T>) => {
    try { return await work(); } catch (cause) {
      if (cause instanceof CardError || cause instanceof ChatServiceError) return fail(reply, cause.status, cause.code, cause.message);
      throw cause;
    }
  };
  /** 挂一件本人负责的 Task（boardTask 核对负责人）。 */
  const link = async (personId: string, projectId: string, taskId: string) => {
    const own = await boardTask(open, personId, taskId);
    const row = await linkGoal(q, { projectId, ownerId: personId, task: own.task, source: "owner", now: ctx.now() });
    return goalView(row, (await settlementsOf(q, [row.task_id])).get(row.task_id)?.kind ?? "open");
  };

  app.get("/api/me/projects", { preHandler: requireMember, schema: { response: { 200: ProjectListResponse } } }, async (req) =>
    ({ projects: await listProjects(q, req.person!.personId) }));

  app.post("/api/me/projects", { preHandler: requireMember, schema: { body: CreateProjectRequest, response: { 201: Project } } }, async (req, reply) => handle(reply, async () => {
    const personId = req.person!.personId;
    // 带 Task 的先核对负责人，不行就不建。
    const own = req.body.taskId ? await boardTask(open, personId, req.body.taskId) : null;
    const project = await createProject(q, personId, req.body.name, ctx.now());
    if (own) await linkGoal(q, { projectId: project.id, ownerId: personId, task: own.task, source: "owner", now: ctx.now() });
    return reply.status(201).send(projectView(await ownProject(q, personId, project.id)));
  }));

  app.get("/api/me/projects/:projectId", { preHandler: requireMember, schema: { params: projectParams, response: { 200: ProjectDetailResponse } } }, async (req, reply) =>
    handle(reply, () => projectDetail(q, req.person!.personId, req.params.projectId, ctx.now())));

  app.patch("/api/me/projects/:projectId", { preHandler: requireMember, schema: { params: projectParams, body: UpdateProjectRequest, response: { 200: Project } } },
    async (req, reply) => handle(reply, () => updateProject(q, req.person!.personId, req.params.projectId, req.body, ctx.now())));

  app.put("/api/me/projects/:projectId/goals/:taskId", { preHandler: requireMember, schema: { params: goalParams, response: { 200: ProjectGoalResponse } } },
    async (req, reply) => handle(reply, async () => {
      const project = await ownProject(q, req.person!.personId, req.params.projectId);
      if (project.archived_at) throw new CardError(409, "PROJECT_ARCHIVED", "这个项目已经归档了，恢复后再挂");
      return link(req.person!.personId, project.id, req.params.taskId);
    }));

  app.delete("/api/me/projects/:projectId/goals/:taskId", { preHandler: requireMember, schema: { params: goalParams } }, async (req, reply) =>
    handle(reply, async () => {
      await unlinkGoal(q, req.person!.personId, req.params.projectId, req.params.taskId);
      return reply.status(204).send();
    }));

  app.post("/api/me/projects/:projectId/pipeline", { preHandler: requireMember, schema: { params: projectParams,
    response: { 200: ProjectPipelineResponse, 201: ProjectPipelineResponse } } }, async (req, reply) => handle(reply, async () => {
    const project = await ownProject(q, req.person!.personId, req.params.projectId);
    const { conversationId, created } = await ensureProjectPipeline({ pool, chat: ctx.chat }, req.person!, project.id, String(req.id));
    return reply.status(created ? 201 : 200).send({ projectId: project.id, conversationId, scope: projectScope(project.id) });
  }));

  // 项目动态：每件挂过的 Task 的标准从本体读（读不到的那件不出「约定都达到」），卡的验收行照 Task 管线原来的算法。
  app.get("/api/me/projects/:projectId/feed", { preHandler: requireMember, schema: { params: projectParams, response: { 200: ProjectFeedResponse } } },
    async (req, reply) => handle(reply, async () => {
      const personId = req.person!.personId;
      const project = await ownProject(q, personId, req.params.projectId);
      const goals = await projectGoalRows(q, project.id);
      const criteria = new Map(await Promise.all(goals.map(async (goal) =>
        [goal.task_id, (await boardTask(open, personId, goal.task_id).catch(() => null))?.criteria ?? []] as const)));
      return readProjectFeed(q, personId, project.id, goals, criteria);
    }));
}
