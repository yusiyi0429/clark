import { Type } from "@sinclair/typebox";
import type { FastifyReply } from "fastify";
import { AcceptCardDraftsRequest, AcceptCardDraftsResponse, CardBoardResponse, CardBriefResponse, CardDetailResponse, CardPlanView, CardTaskView, CreateCardPlanRequest,
  AddPendingDeliverableRequest, CreateVersionFromPendingRequest, DeliverableVersion, OverruleCardHandbackRequest, PatchCardRequest, PendingDeliverableItem } from "@warmap/contracts";
import { createArticleFetcher, type ArticleFetcher } from "../articleText.js";
import { createCardAcceptanceQueue, markHandbackReturned, overruleHandback, retryHandback } from "../cardAcceptance.js";
import { createCardAcceptanceAgent, type CardAcceptanceAgent } from "../cardAcceptanceAgent.js";
import { addPendingTopicVersion, createVersionFromPending, removePending } from "../cardDeliverables.js";
import { createCardPlanAgent, type CardPlanAgent } from "../cardPlanAgent.js";
import { createCardPlanQueue } from "../cardPlanner.js";
import { createRoleProposalAgent, type RoleProposalAgent } from "../roleProposalAgent.js";
import { createRoleProposalQueue } from "../roleProposals.js";
import { RoleError } from "../roles.js";
import { personDisplayNames } from "../people.js";
import { findOwnTask, type OwnTask } from "../taskDeliverables.js";
import { acceptCardDrafts, boardTask, CardError, cardBrief, createCardPlan, dismissCardDraft, patchCard, readBoard, readCardDetail } from "../taskCards.js";
import type { AppInstance, Guard, RouteContext } from "./shared.js";

const taskParams = Type.Object({ taskId: Type.String({ minLength: 1 }) });
const idParams = Type.Object({ id: Type.String({ minLength: 1 }) });
const handbackParams = Type.Object({ id: Type.String({ minLength: 1 }), handbackId: Type.String({ format: "uuid" }) });

/** 看板的三个作业：拆卡、Agent 验收、提岗位修改。换成别的服务来跑时，只换这三个实现。 */
export type BoardAgents = { plan: CardPlanAgent; acceptance: CardAcceptanceAgent; proposal: RoleProposalAgent };

/**
 * 执行看板（契约 taskCards.ts）：Task 页看板、拆卡和草稿、卡的详情、改卡、开工交代、Agent 验收的推翻、重试和「已送到」。成员工作台的人才有。
 * 拆卡、Agent 验收、提岗位修改在后台队列里跑；拆卡和验收照参考评审用 REVIEW_*（没配时用 PI_* 的 heavy 模型），提岗位修改用 PI_* 的 light 模型。
 * agents、fetchArticle 可注入（测试用假实现）。
 * 返回 Agent 验收的入队（本机上报新交回时用）。
 */
export function registerTaskCardRoutes(app: AppInstance, ctx: RouteContext, deps: { agents?: Partial<BoardAgents>; fetchArticle?: ArticleFetcher } = {}):
  { enqueueAcceptance: (handbackId: string) => void } {
  const { q, pool, fail, requirePerson, env } = ctx;
  const names = () => personDisplayNames(ctx.peopleDirectory);
  const model = { query: q, baseUrl: env.review?.baseUrl ?? env.piBaseUrl, apiKey: env.review?.apiKey ?? env.piApiKey,
    modelId: env.review?.model ?? env.heavyModel, thinking: env.review?.thinking };
  /** 卡挂的 Task（推进人自己 Mission 下的），读不到为 null。 */
  const planTaskOf = (personId: string) => (planTaskId: string): Promise<OwnTask | null> =>
    findOwnTask(q, ctx.planTasks, personId, ctx.now(), planTaskId).catch(() => null);
  const plans = createCardPlanQueue({ pool, now: ctx.now, onError: () => app.log.error("card plan failed"), agent: deps.agents?.plan ?? createCardPlanAgent(model),
    planTask: (ownerId, planTaskId) => planTaskOf(ownerId)(planTaskId) });
  const proposals = createRoleProposalQueue({ pool, onError: () => app.log.error("role proposal failed"), agent: deps.agents?.proposal
    ?? createRoleProposalAgent({ query: q, baseUrl: env.piBaseUrl, apiKey: env.piApiKey, modelId: env.lightModel, thinking: "off" }) });
  const acceptance = createCardAcceptanceQueue({ pool, storageDir: ctx.materialStorageDir, now: ctx.now, onError: () => app.log.error("card acceptance failed"),
    agent: deps.agents?.acceptance ?? createCardAcceptanceAgent(model), fetchArticle: deps.fetchArticle ?? createArticleFetcher(),
    onProposal: (id) => { void proposals.enqueue(id); } });
  app.decorate("cardPlans", plans);
  app.decorate("cardAcceptance", acceptance);
  app.decorate("roleProposals", proposals);
  let recovery: ReturnType<typeof setInterval> | undefined;
  const recover = () => Promise.all([plans.recover(), acceptance.recover(), proposals.recover()]).catch(() => app.log.error("board queue recovery failed"));
  app.addHook("onReady", async () => {
    await recover();
    recovery = setInterval(() => { void recover(); }, 60_000);
    recovery.unref();
  });
  app.addHook("onClose", async () => { clearInterval(recovery); await Promise.all([plans.close(), acceptance.close(), proposals.close()]); });

  const requireMember: Guard = async (req, reply) => {
    await requirePerson(req, reply);
    if (reply.sent) return reply;
    if (req.person?.role !== "member") return fail(reply, 403, "FORBIDDEN", "请切换到 DRI 工作台");
  };
  /** CardError、RoleError 换成对应的错误响应。 */
  const handle = async <T>(reply: FastifyReply, work: () => Promise<T>) => {
    try { return await work(); } catch (cause) {
      if (cause instanceof CardError) return fail(reply, cause.status, cause.code, cause.message, cause.latestTask ? { latestTask: cause.latestTask } : undefined);
      if (cause instanceof RoleError) return fail(reply, cause.status, cause.code, cause.message);
      throw cause;
    }
  };
  const board = (personId: string, taskId: string) => boardTask(q, ctx.planTasks, personId, ctx.now(), taskId);

  app.get("/api/plan-tasks/:taskId/cards", { preHandler: requireMember, schema: { params: taskParams, response: { 200: CardBoardResponse } } }, async (req, reply) =>
    handle(reply, async () => readBoard(q, await board(req.person!.personId, req.params.taskId), names())));

  app.post("/api/plan-tasks/:taskId/card-plans", { preHandler: requireMember, schema: { params: taskParams, body: CreateCardPlanRequest,
    response: { 200: CardPlanView, 202: CardPlanView } } }, async (req, reply) => handle(reply, async () => {
    const { plan, created } = await createCardPlan(q, await board(req.person!.personId, req.params.taskId), req.body.hint);
    if (created) void plans.enqueue(plan.id);
    return reply.status(created ? 202 : 200).send(plan);
  }));

  app.post("/api/plan-tasks/:taskId/card-drafts/accept", { preHandler: requireMember, schema: { params: taskParams, body: AcceptCardDraftsRequest,
    response: { 200: AcceptCardDraftsResponse } } }, async (req, reply) => handle(reply, async () =>
    ({ cards: await acceptCardDrafts(pool, await board(req.person!.personId, req.params.taskId), req.body, names()) })));

  app.post("/api/card-drafts/:id/dismiss", { preHandler: requireMember, schema: { params: idParams } }, async (req, reply) => handle(reply, async () => {
    await dismissCardDraft(q, req.person!.personId, req.params.id, (planTaskId) => board(req.person!.personId, planTaskId));
    return reply.status(204).send();
  }));

  app.get("/api/me/cards/:id", { preHandler: requireMember, schema: { params: idParams, response: { 200: CardDetailResponse } } }, async (req, reply) =>
    handle(reply, () => readCardDetail(q, req.person!.personId, req.params.id, names())));

  app.patch("/api/me/cards/:id", { preHandler: requireMember, schema: { params: idParams, body: PatchCardRequest, response: { 200: CardTaskView } } }, async (req, reply) =>
    handle(reply, () => patchCard(pool, req.person!.personId, req.params.id, req.body, names(), planTaskOf(req.person!.personId))));

  app.get("/api/me/cards/:id/brief", { preHandler: requireMember, schema: { params: idParams, response: { 200: CardBriefResponse } } }, async (req, reply) =>
    handle(reply, () => cardBrief(q, req.person!.personId, req.params.id, planTaskOf(req.person!.personId))));

  /** 对一次交回做完一件事，回卡的详情。 */
  const handbackAction = (path: string, work: (personId: string, cardId: string, handbackId: string, body: never) => Promise<void>, body?: typeof OverruleCardHandbackRequest) =>
    app.post(path, { preHandler: requireMember, schema: { params: handbackParams, ...(body ? { body } : {}), response: { 200: CardDetailResponse } } }, async (req, reply) => {
      const params = req.params as { id: string; handbackId: string };
      return handle(reply, async () => {
        await work(req.person!.personId, params.id, params.handbackId, req.body as never);
        return readCardDetail(q, req.person!.personId, params.id, names());
      });
    });
  handbackAction("/api/me/cards/:id/handbacks/:handbackId/overrule", async (personId, cardId, handbackId, body: { reason: string }) => {
    const proposal = await overruleHandback(pool, personId, cardId, handbackId, body.reason, ctx.now(), names());
    if (proposal) void proposals.enqueue(proposal);
  }, OverruleCardHandbackRequest);
  handbackAction("/api/me/cards/:id/handbacks/:handbackId/retry", async (personId, cardId, handbackId) => {
    await retryHandback(pool, personId, cardId, handbackId);
    void acceptance.enqueue(handbackId);
  });
  handbackAction("/api/me/cards/:id/handbacks/:handbackId/returned", (personId, cardId, handbackId) => markHandbackReturned(pool, personId, cardId, handbackId, ctx.now()));

  app.post("/api/plan-tasks/:taskId/deliverable/pending", { preHandler: requireMember, schema: { params: taskParams, body: AddPendingDeliverableRequest,
    response: { 201: PendingDeliverableItem } } }, async (req, reply) => handle(reply, async () =>
    reply.status(201).send(await addPendingTopicVersion(q, await board(req.person!.personId, req.params.taskId), req.body.topicVersionId))));

  app.delete("/api/plan-tasks/:taskId/deliverable/pending/:id", { preHandler: requireMember,
    schema: { params: Type.Object({ taskId: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) }) } }, async (req, reply) => handle(reply, async () => {
    await removePending(q, await board(req.person!.personId, req.params.taskId), req.params.id);
    return reply.status(204).send();
  }));

  app.post("/api/plan-tasks/:taskId/deliverable/versions/from-pending", { preHandler: requireMember, schema: { params: taskParams, body: CreateVersionFromPendingRequest,
    response: { 201: DeliverableVersion } } }, async (req, reply) => handle(reply, async () => {
    const version = await createVersionFromPending(pool, await board(req.person!.personId, req.params.taskId), req.body.statement, ctx.materialStorageDir);
    void app.deliverables.enqueueReview(version.id);
    return reply.status(201).send(version);
  }));

  return { enqueueAcceptance: (handbackId) => { void acceptance.enqueue(handbackId); } };
}

declare module "fastify" {
  interface FastifyInstance {
    /** 拆卡队列（测试用 idle() 等它跑完）。 */
    cardPlans: ReturnType<typeof createCardPlanQueue>;
    /** Agent 验收队列（测试用 idle() 等它跑完）。 */
    cardAcceptance: ReturnType<typeof createCardAcceptanceQueue>;
    /** 提岗位修改的队列（测试用 idle() 等它跑完）。 */
    roleProposals: ReturnType<typeof createRoleProposalQueue>;
  }
}
