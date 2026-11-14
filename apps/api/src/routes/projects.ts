import { decideAutoRelay } from "../autoRelay.js";
import { deleteProject } from "../subSessionAdmin.js";
import { projectNotices } from "../subSessionReports.js";
import { projectMeetingWork } from "../meetingWorkHandoffs.js";
import type { FastifyReply } from "fastify";
import { Type } from "@sinclair/typebox";
import { AcceptCardDraftsRequest, AcceptCardDraftsResponse, AnswerGoalChangeRequest, AutoRelayDecisionRequest, SetGoalDueDateRequest, ProjectGoalChangedItem, CardPlanBriefResponse, CardSplitRequestView, CreateProjectRequest, Project, ProjectBoardResponse,
  ProjectDetailResponse, ProjectFeedResponse, ProjectGoalResponse, ProjectListResponse, ProjectPipelineResponse, RegisterCardSplitRequest, UpdateProjectRequest,
  ConversationModelListResponse, ProjectPipelineModel, SetProjectPipelineModelRequest } from "@warmap/contracts";
import { projectPlanBrief, registerProjectCardSplit } from "../cardSplits.js";
import { answerGoalChange, goalChangeItems } from "../goalChanges.js";
import { emptyBodyAsObject, lastSequenceReader, projectHistoryReader, recentOwnerWords, typedWords } from "../sourceWords.js";
import { ChatServiceError } from "../chatService.js";
import { personDisplayNames } from "../people.js";
import { createProject, goalView, linkGoal, setGoalDueDate, listProjects, ownProject, projectDetail, projectGoalRows, projectOwners, projectReader, projectScope, projectView, unlinkGoal,
  updateProject } from "../projects.js";
import { decidedTransfers, handedAway, openTransfers, transferView } from "../projectTransfers.js";
import { readProjectFeed } from "../taskFeed.js";
import { acceptProjectCardDrafts, boardTask, CardError, planTaskOpener, readProjectBoard } from "../taskCards.js";
import { ensureProjectPipeline, pipelineViewer, projectPipelineConversation } from "../taskPipelines.js";
import { settlementsOf } from "../taskContinuity.js";
import type { AppInstance, Guard, RouteContext } from "./shared.js";

const projectParams = Type.Object({ projectId: Type.String({ minLength: 1 }) });
const goalParams = Type.Object({ projectId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }) });

/**
 * 项目（契约 projects.ts，设计《新首页》第 16 节）：本人的项目、挂接、项目详情、项目对话、项目动态。DRI 工作台的人才有，只给本人。
 */
export function registerProjectRoutes(app: AppInstance, ctx: RouteContext): void {
  const { q, pool, env, fail, requirePerson, requireServiceToken } = ctx;
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
  /** 本人这几个项目的转交：正在转交的，和本人交出去了的。 */
  const transfersOf = async (personId: string, projectIds: string[]) => {
    const names = personDisplayNames(ctx.peopleDirectory);
    const open = await openTransfers(q, projectIds);
    const away = new Map((await handedAway(q, personId)).map((row) => [row.project_id, row]));
    return new Map(projectIds.flatMap((id) => { const row = open.get(id) ?? away.get(id); return row ? [[id, transferView(row, names)] as const] : []; }));
  };
  /** 本人的、没归档的项目（要往里放东西的几步用）。 */
  const activeProject = async (personId: string, projectId: string) => {
    const project = await ownProject(q, personId, projectId);
    if (project.archived_at) throw new CardError(409, "PROJECT_ARCHIVED", "这个项目已经归档了");
    return project;
  };
  /** 挂一件本人负责的 Task（boardTask 核对负责人）。 */
  const link = async (personId: string, projectId: string, taskId: string) => {
    const own = await boardTask(open, personId, taskId);
    const row = await linkGoal(q, { projectId, ownerId: personId, task: own.task, source: "owner", now: ctx.now() });
    return goalView(row, (await settlementsOf(q, [row.task_id])).get(row.task_id)?.kind ?? "open");
  };

  app.get("/api/me/projects", { preHandler: requireMember, schema: { response: { 200: ProjectListResponse } } }, async (req) =>
    ({ projects: await listProjects(q, req.person!.personId, (ids) => transfersOf(req.person!.personId, ids)) }));

  app.post("/api/me/projects", { preHandler: requireMember, schema: { body: CreateProjectRequest, response: { 201: Project } } }, async (req, reply) => handle(reply, async () => {
    const personId = req.person!.personId;
    // 带 Task 的先核对负责人，不行就不建。
    const own = req.body.taskId ? await boardTask(open, personId, req.body.taskId) : null;
    const project = await createProject(q, personId, req.body.name, ctx.now());
    if (own) await linkGoal(q, { projectId: project.id, ownerId: personId, task: own.task, source: "owner", now: ctx.now() });
    return reply.status(201).send(projectView(await ownProject(q, personId, project.id)));
  }));

  app.get("/api/me/projects/:projectId", { preHandler: requireMember, schema: { params: projectParams, response: { 200: ProjectDetailResponse } } }, async (req, reply) =>
    handle(reply, () => projectDetail(q, req.person!.personId, req.params.projectId, ctx.now(),
      async (id) => (await transfersOf(req.person!.personId, [id])).get(id) ?? null)));

  app.patch("/api/me/projects/:projectId", { preHandler: requireMember, schema: { params: projectParams, body: UpdateProjectRequest, response: { 200: Project } } },
    async (req, reply) => handle(reply, () => updateProject(q, req.person!.personId, req.params.projectId, req.body, ctx.now())));

  // 删掉项目（17.2 第 35 条，撤不回）：子会话进回收站，其余见 subSessionAdmin.ts 的 deleteProject。
  app.delete("/api/me/projects/:projectId", { preHandler: requireMember, schema: { params: projectParams } }, async (req, reply) =>
    handle(reply, async () => {
      await deleteProject(pool, req.person!.personId, req.params.projectId, ctx.now());
      return reply.status(204).send();
    }));

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

  // 项目对话按对话选模型和思考程度（17.2 第 36 条）：转发给 Chat，选择存在 Chat 那段对话上；伙伴（总管线）的对话不开放。
  app.get("/api/me/conversation-models", { preHandler: requireMember, schema: { response: { 200: ConversationModelListResponse } } }, async (req, reply) =>
    handle(reply, async () => ({ models: ctx.chat ? await ctx.chat.models(pipelineViewer(req.person!.personId), String(req.id)) : [] })));
  app.get("/api/me/projects/:projectId/pipeline/model", { preHandler: requireMember, schema: { params: projectParams, response: { 200: ProjectPipelineModel } } },
    async (req, reply) => handle(reply, async () => {
      const personId = req.person!.personId;
      const project = await ownProject(q, personId, req.params.projectId);
      const conversationId = ctx.chat ? await projectPipelineConversation(q, project.id, personId) : null;
      return { choice: conversationId ? await ctx.chat!.conversationModel(pipelineViewer(personId), String(req.id), conversationId) : null };
    }));
  app.put("/api/me/projects/:projectId/pipeline/model", { preHandler: requireMember, schema: { params: projectParams, body: SetProjectPipelineModelRequest,
    response: { 200: ProjectPipelineModel } } }, async (req, reply) => handle(reply, async () => {
    const personId = req.person!.personId;
    const project = await ownProject(q, personId, req.params.projectId);
    if (!ctx.chat) throw new CardError(409, "CHAT_NOT_CONNECTED", "没接对话服务，项目对话用的是天枢自己的模型，不能另选");
    const { conversationId } = await ensureProjectPipeline({ pool, chat: ctx.chat }, req.person!, project.id, String(req.id));
    return { choice: await ctx.chat.setConversationModel(pipelineViewer(personId), String(req.id), conversationId, req.body.choice) };
  }));

  // 项目动态：每件挂过的 Task 的标准从本体读（读不到的那件不出「约定都达到」），卡的验收行照 Task 管线原来的算法；
  // 交出去之前负责过的人也能看（只读），卡读每个负责过的人的；换人、交接说明、没接那几行按看的人给（feed.ts 的 transferItems）。
  app.get("/api/me/projects/:projectId/feed", { preHandler: requireMember, schema: { params: projectParams, response: { 200: ProjectFeedResponse } } },
    async (req, reply) => handle(reply, async () => {
      const personId = req.person!.personId;
      const { row: project } = await projectReader(q, personId, req.params.projectId);
      const goals = await projectGoalRows(q, project.id);
      const checked = await Promise.all(goals.map(async (goal) => ({
        goal, task: await boardTask(open, goal.owner_id, goal.task_id).catch(() => null),
      })));
      const criteria = new Map(checked.map(({ goal, task }) => [goal.task_id, task?.criteria ?? []]));
      const accessibleTasks = new Set(checked.filter(({ goal, task }) => task && goal.owner_id === personId).map(({ goal }) => goal.task_id));
      const transfers = (await decidedTransfers(q, project.id)).map((row) => transferView(row, personDisplayNames(ctx.peopleDirectory)));
      // 月中 Task 改了或取消了的选项框（16.4）。
      // 子会话停了、要介入的报告和决定卡（18 节第 10 条）。
      return readProjectFeed(q, await projectOwners(q, project.id), project.id, goals, criteria, { viewer: personId, transfers },
        [...await goalChangeItems(q, project.id), ...await projectNotices(q, project.id), ...await projectMeetingWork(q, personId, project.id, accessibleTasks)]);
    }));

  // 天枢里给一件目标存的验收截止日（null 不存了）。
  app.put("/api/me/projects/:projectId/goals/:taskId/due-date", { preHandler: requireMember, schema: { params: goalParams, body: SetGoalDueDateRequest,
    response: { 200: ProjectGoalResponse } } }, async (req, reply) =>
    handle(reply, () => setGoalDueDate(q, req.person!.personId, req.params.projectId, req.params.taskId, req.body.dueDate)));

  // 自动接力停住了，「等你」里答继续还是停下（18 节第 12 条）。
  app.post("/api/me/projects/:projectId/auto-relay", { preHandler: requireMember, schema: { params: projectParams, body: AutoRelayDecisionRequest } }, async (req, reply) =>
    handle(reply, async () => {
      await decideAutoRelay(q, req.person!.personId, req.params.projectId, req.body.decision);
      return reply.status(204).send();
    }));

  app.post("/api/me/projects/:projectId/goal-changes/:id", { preHandler: requireMember, schema: { params: Type.Object({ projectId: Type.String({ minLength: 1 }),
    id: Type.String({ minLength: 1 }) }), body: AnswerGoalChangeRequest, response: { 200: ProjectGoalChangedItem } } }, async (req, reply) =>
    handle(reply, () => answerGoalChange(q, req.person!.personId, req.params.projectId, req.params.id, req.body.answer, ctx.now())));

  // 没挂 Task 的项目也能拆卡（16.3）：看板、登记、规划员交代、放进看板。挂着 Task 的照旧走 /api/plan-tasks/:taskId/…。
  app.get("/api/me/projects/:projectId/board", { preHandler: requireMember, schema: { params: projectParams, response: { 200: ProjectBoardResponse } } },
    async (req, reply) => handle(reply, async () => {
      const project = await ownProject(q, req.person!.personId, req.params.projectId);
      return readProjectBoard(q, req.person!.personId, project.id, personDisplayNames(ctx.peopleDirectory));
    }));

  app.post("/api/me/projects/:projectId/card-splits", { preValidation: emptyBodyAsObject, preHandler: requireMember, schema: { params: projectParams,
    body: RegisterCardSplitRequest, response: { 200: CardSplitRequestView, 201: CardSplitRequestView } } }, async (req, reply) => handle(reply, async () => {
    const project = await activeProject(req.person!.personId, req.params.projectId);
    const { request, created } = await registerProjectCardSplit(q, req.person!.personId, project.id, "web", ctx.now(), typedWords(req.body.words),
      req.body.afterSequence ?? await lastSequenceReader(ctx)(req.person!.personId, { taskId: null, projectId: project.id }, String(req.id)),
      req.body.modelWords?.trim() || undefined);
    return reply.status(created ? 201 : 200).send(request);
  }));

  app.get("/api/me/projects/:projectId/plan-brief", { preHandler: requireMember, schema: { params: projectParams, response: { 200: CardPlanBriefResponse } } },
    async (req, reply) => handle(reply, async () => projectPlanBrief(q, await ownProject(q, req.person!.personId, req.params.projectId))));

  // 带的 budget 不存（没有 Task 可挂），开工用本人的缺省预算。
  app.post("/api/me/projects/:projectId/card-drafts/accept", { preHandler: requireMember, schema: { params: projectParams, body: AcceptCardDraftsRequest,
    response: { 200: AcceptCardDraftsResponse } } }, async (req, reply) => handle(reply, async () => {
    const project = await activeProject(req.person!.personId, req.params.projectId);
    // 开工那一下的序号（17.2 第 29 条）：网页带了用它，没带读这个项目对话现在最后一条。
    const after = req.body.afterSequence ?? await lastSequenceReader(ctx)(req.person!.personId, { taskId: null, projectId: project.id }, String(req.id));
    return { cards: await acceptProjectCardDrafts(pool, req.person!.personId, project.id, req.body, personDisplayNames(ctx.peopleDirectory), ctx.now(), after) };
  }));

  // 伙伴在项目对话里登记拆这个项目（register_card_split 带 projectId）：照 /internal/plan-tasks/:taskId/card-splits，INTERNAL_CHAT_TOKEN 加 X-Owner-Id；没配时不注册。
  if (env.internalChatToken) app.post("/internal/me/projects/:projectId/card-splits", { onRequest: requireServiceToken(env.internalChatToken),
    schema: { params: projectParams, response: { 200: CardSplitRequestView, 201: CardSplitRequestView } } }, async (req, reply) => {
    const id = req.headers["x-owner-id"];
    if (typeof id !== "string" || !ctx.peopleDirectory.searchPeople(undefined).some((person) => person.personId === id)) return fail(reply, 404, "OWNER_NOT_FOUND", "提问人不在人员目录");
    return handle(reply, async () => {
      const project = await activeProject(id, req.params.projectId);
      const words = await recentOwnerWords(q, projectHistoryReader(ctx), id, { taskId: null, projectId: project.id }, String(req.id));
      const { request, created } = await registerProjectCardSplit(q, id, project.id, "buddy", ctx.now(), words,
        await lastSequenceReader(ctx)(id, { taskId: null, projectId: project.id }, String(req.id)));
      return reply.status(created ? 201 : 200).send(request);
    });
  });
}
