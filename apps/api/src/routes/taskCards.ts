import { Type } from "@sinclair/typebox";
import type { FastifyReply } from "fastify";
import { AcceptCardDraftsRequest, AcceptCardDraftsResponse, CardBoardResponse, CardBriefResponse, CardDetailResponse, CardPlanBriefResponse, CardPlanView, CardSplitListResponse,
  CardSplitRequestView, CardTaskView, CreateCardPlanRequest, AddPendingDeliverableRequest, CreateVersionFromPendingRequest, DeliverableVersion, OverruleCardHandbackRequest,
  PatchCardRequest, PendingDeliverableItem, RegisterCardSplitRequest, CardAgreementChangeListResponse, DecideAgreementProposalRequest } from "@warmap/contracts";
import { decideProposal, listAgreementChanges } from "../cardAgreements.js";
import { emptyBodyAsObject, lastSequenceReader, projectHistoryReader, recentOwnerWords, typedWords } from "../sourceWords.js";
import { createArticleFetcher, type ArticleFetcher } from "../articleText.js";
import { normalizeBudget, writeTaskBudget } from "../budgets.js";
import { createCardAcceptanceQueue, markHandbackReturned, overruleHandback, retryHandback } from "../cardAcceptance.js";
import { createCardAcceptanceAgent, type CardAcceptanceAgent } from "../cardAcceptanceAgent.js";
import { addPendingTopicVersion, createVersionFromPending, removePending } from "../cardDeliverables.js";
import { createCardPlanAgent, type CardPlanAgent } from "../cardPlanAgent.js";
import { createCardPlanQueue } from "../cardPlanner.js";
import { closeCardSplit, listCardSplits, planBrief, registerCardSplit } from "../cardSplits.js";
import { createRoleProposalAgent, type RoleProposalAgent } from "../roleProposalAgent.js";
import { createRoleProposalQueue } from "../roleProposals.js";
import { RoleError } from "../roles.js";
import { agreementSnapshot } from "../taskAgreements.js";
import { personDisplayNames } from "../people.js";
import { ownProject } from "../projects.js";
import { acceptCardDrafts, boardTask, CardError, cardBrief, createCardPlan, dismissCardDraft, patchCard, planTaskOpener, planTaskOrNull, readBoard,
  readCardDetail, type CardPlanTask } from "../taskCards.js";
import type { AppInstance, Guard, RouteContext } from "./shared.js";

const taskParams = Type.Object({ taskId: Type.String({ minLength: 1 }) });
const idParams = Type.Object({ id: Type.String({ minLength: 1 }) });
const handbackParams = Type.Object({ id: Type.String({ minLength: 1 }), handbackId: Type.String({ format: "uuid" }) });
const proposalParams = Type.Object({ id: Type.String({ minLength: 1 }), proposalId: Type.String({ minLength: 1 }) });

/** 看板的三个作业：拆卡、Agent 验收、提岗位修改。换成别的服务来跑时，只换这三个实现。 */
export type BoardAgents = { plan: CardPlanAgent; acceptance: CardAcceptanceAgent; proposal: RoleProposalAgent };

/** 本机那一侧（routes/local.ts）要用的：新交回排云端验收（开关关着时什么也不做）、岗位修改排队、按人读卡挂的 Task。 */
export type BoardHooks = { enqueueAcceptance: (handbackId: string) => void; enqueueProposal: (proposalId: string) => void;
  planTask: (personId: string, planTaskId: string) => Promise<CardPlanTask | null> };

/**
 * 执行看板（契约 taskCards.ts）：Task 页看板、拆卡和草稿、卡的详情、改卡、开工交代、Agent 验收的推翻、重试和「已送到」。成员工作台的人才有。
 * 拆卡、Agent 验收、提岗位修改在后台队列里跑；拆卡和验收照参考评审用 REVIEW_*（没配时用 PI_* 的 heavy 模型），提岗位修改用 PI_* 的 light 模型。
 * 第 21 节：拆卡和验收改在本人电脑上，云端的两个作业只在 BOARD_CLOUD_AGENTS=1 时开；登记拆卡、规划员交代在这里。
 * agents、fetchArticle 可注入（测试用假实现）。
 */
export function registerTaskCardRoutes(app: AppInstance, ctx: RouteContext, deps: { agents?: Partial<BoardAgents>; fetchArticle?: ArticleFetcher } = {}): BoardHooks {
  const { q, pool, fail, requirePerson, requireServiceToken, env } = ctx;
  const history = projectHistoryReader(ctx);
  // 拆卡那几块按序号插进项目对话（17.2 第 29 条）：网页带了本人看到的最后一条就用它，没带读这件 Task 挂的项目对话现在最后一条。
  const lastSequence = lastSequenceReader(ctx);
  const sequenceOf = (given: number | undefined, ownerId: string, taskId: string, requestId: string) =>
    given !== undefined ? Promise.resolve(given) : lastSequence(ownerId, { taskId, projectId: null }, requestId);
  const cloud = Boolean(env.boardCloudAgents);
  const names = () => personDisplayNames(ctx.peopleDirectory);
  const model = { query: q, baseUrl: env.review?.baseUrl ?? env.piBaseUrl, apiKey: env.review?.apiKey ?? env.piApiKey,
    modelId: env.review?.model ?? env.heavyModel, thinking: env.review?.thinking };
  const open = planTaskOpener(q, ctx.planTasks, ctx.peopleDirectory, ctx.now);
  /** 卡挂的 Task（推进人看得到的），读不到为 null。 */
  const planTaskOf = (personId: string) => planTaskOrNull(open, personId);
  const plans = createCardPlanQueue({ pool, now: ctx.now, onError: () => app.log.error("card plan failed"), agent: deps.agents?.plan ?? createCardPlanAgent(model),
    planTask: (ownerId, planTaskId) => planTaskOf(ownerId)(planTaskId) });
  const proposals = createRoleProposalQueue({ pool, onError: () => app.log.error("role proposal failed"), agent: deps.agents?.proposal
    ?? createRoleProposalAgent({ query: q, baseUrl: env.piBaseUrl, apiKey: env.piApiKey, modelId: env.lightModel, thinking: "off" }) });
  const acceptance = createCardAcceptanceQueue({ pool, storageDir: ctx.materialStorageDir, now: ctx.now, onError: () => app.log.error("card acceptance failed"),
    agent: deps.agents?.acceptance ?? createCardAcceptanceAgent(model), fetchArticle: deps.fetchArticle ?? createArticleFetcher(),
    onProposal: (id) => { void proposals.enqueue(id); }, planTask: (ownerId, planTaskId) => planTaskOf(ownerId)(planTaskId), modelLabel: model.modelId });
  app.decorate("cardPlans", plans);
  app.decorate("cardAcceptance", acceptance);
  app.decorate("roleProposals", proposals);
  let recovery: ReturnType<typeof setInterval> | undefined;
  const recover = () => Promise.all([...cloud ? [plans.recover(), acceptance.recover()] : [], proposals.recover()]).catch(() => app.log.error("board queue recovery failed"));
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
  const board = (personId: string, taskId: string) => boardTask(open, personId, taskId);
  const cloudOff = (reply: FastifyReply) => fail(reply, 409, "CLOUD_AGENTS_OFF", "拆卡和验收在本人电脑上做，云端这一路没开");

  app.get("/api/plan-tasks/:taskId/cards", { preHandler: requireMember, schema: { params: taskParams, response: { 200: CardBoardResponse } } }, async (req, reply) =>
    handle(reply, async () => readBoard(q, await board(req.person!.personId, req.params.taskId), names())));

  app.post("/api/plan-tasks/:taskId/card-plans", { preHandler: requireMember, schema: { params: taskParams, body: CreateCardPlanRequest,
    response: { 200: CardPlanView, 202: CardPlanView } } }, async (req, reply) => handle(reply, async () => {
    const own = await board(req.person!.personId, req.params.taskId);
    if (!cloud) return cloudOff(reply);
    const { plan, created } = await createCardPlan(q, own, req.body.hint, await sequenceOf(undefined, own.viewerId, own.task.taskId, String(req.id)));
    if (created) void plans.enqueue(plan.id);
    return reply.status(created ? 202 : 200).send(plan);
  }));

  app.post("/api/plan-tasks/:taskId/card-drafts/accept", { preHandler: requireMember, schema: { params: taskParams, body: AcceptCardDraftsRequest,
    response: { 200: AcceptCardDraftsResponse } } }, async (req, reply) => handle(reply, async () => {
    // 开工框上方选的预算（设计 11.3）：先核对，卡放进看板以后存成这件 Task 的预算。
    const budget = req.body.budget ? normalizeBudget(req.body.budget) : null;
    const own = await board(req.person!.personId, req.params.taskId);
    const cards = await acceptCardDrafts(pool, own, req.body, names(), ctx.now(), await sequenceOf(req.body.afterSequence, own.viewerId, own.task.taskId, String(req.id)));
    if (budget) await writeTaskBudget(q, req.person!.personId, req.params.taskId, budget, ctx.now());
    return { cards };
  }));

  // 登记拆卡（第 21 节）：只记下本人要拆这个 Task，不起作业；网页在本人电脑上开规划员，开了以后去掉登记。
  // 带了 words（按钮旁输入框里的话）就存成这次的原话（16.8）。
  app.post("/api/plan-tasks/:taskId/card-splits", { preValidation: emptyBodyAsObject, preHandler: requireMember, schema: { params: taskParams, body: RegisterCardSplitRequest,
    response: { 200: CardSplitRequestView, 201: CardSplitRequestView } } }, async (req, reply) => handle(reply, async () => {
    const own = await board(req.person!.personId, req.params.taskId);
    const { request, created } = await registerCardSplit(q, own, "web", ctx.now(), typedWords(req.body.words),
      await sequenceOf(req.body.afterSequence, own.viewerId, own.task.taskId, String(req.id)));
    return reply.status(created ? 201 : 200).send(request);
  }));

  app.get("/api/me/card-splits", { preHandler: requireMember, schema: { response: { 200: CardSplitListResponse } } }, async (req) =>
    ({ requests: await listCardSplits(q, req.person!.personId) }));

  app.delete("/api/me/card-splits/:id", { preHandler: requireMember, schema: { params: idParams } }, async (req, reply) =>
    await closeCardSplit(q, req.person!.personId, req.params.id, ctx.now()) ? reply.status(204).send() : fail(reply, 404, "NOT_FOUND", "找不到这条登记"));

  app.get("/api/plan-tasks/:taskId/plan-brief", { preHandler: requireMember, schema: { params: taskParams, response: { 200: CardPlanBriefResponse } } }, async (req, reply) =>
    handle(reply, async () => planBrief(q, await board(req.person!.personId, req.params.taskId))));

  app.post("/api/card-drafts/:id/dismiss", { preHandler: requireMember, schema: { params: idParams } }, async (req, reply) => handle(reply, async () => {
    await dismissCardDraft(q, req.person!.personId, req.params.id, (planTaskId) => board(req.person!.personId, planTaskId),
      (projectId) => ownProject(q, req.person!.personId, projectId));
    return reply.status(204).send();
  }));

  app.get("/api/me/cards/:id", { preHandler: requireMember, schema: { params: idParams, response: { 200: CardDetailResponse } } }, async (req, reply) =>
    handle(reply, () => readCardDetail(q, req.person!.personId, req.params.id, names())));

  app.patch("/api/me/cards/:id", { preHandler: requireMember, schema: { params: idParams, body: PatchCardRequest, response: { 200: CardTaskView } } }, async (req, reply) =>
    handle(reply, () => patchCard(pool, req.person!.personId, req.params.id, req.body, names(), planTaskOf(req.person!.personId), ctx.now())));

  app.get("/api/me/cards/:id/agreement-changes", { preHandler: requireMember, schema: { params: idParams, response: { 200: CardAgreementChangeListResponse } } },
    async (req, reply) => handle(reply, async () => ({ changes: await listAgreementChanges(q, req.person!.personId, req.params.id) })));

  app.post("/api/me/cards/:id/agreement-proposals/:proposalId/decision", { preHandler: requireMember,
    schema: { params: proposalParams, body: DecideAgreementProposalRequest, response: { 200: CardDetailResponse } } }, async (req, reply) => handle(reply, async () => {
    await decideProposal(pool, req.person!.personId, req.params.id, req.params.proposalId, req.body.decision, ctx.now());
    return readCardDetail(q, req.person!.personId, req.params.id, names());
  }));

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
    if (!cloud) throw new CardError(409, "CLOUD_AGENTS_OFF", "验收在本人电脑上做，云端这一路没开");
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
    const own = await board(req.person!.personId, req.params.taskId);
    const version = await createVersionFromPending(pool, own, req.body.statement, ctx.materialStorageDir, agreementSnapshot(own.agreement));
    void app.deliverables.enqueueReview(version.id);
    return reply.status(201).send(version);
  }));

  // 伙伴的「登记拆卡」（工具名 register_card_split）：照 /internal/me/workers，INTERNAL_CHAT_TOKEN 加 X-Owner-Id；没配时不注册，不进公开 OpenAPI。
  if (env.internalChatToken) app.post("/internal/plan-tasks/:taskId/card-splits", { onRequest: requireServiceToken(env.internalChatToken),
    schema: { params: taskParams, response: { 200: CardSplitRequestView, 201: CardSplitRequestView } } }, async (req, reply) => {
    const id = req.headers["x-owner-id"];
    if (typeof id !== "string" || !ctx.peopleDirectory.searchPeople(undefined).some((person) => person.personId === id)) return fail(reply, 404, "OWNER_NOT_FOUND", "提问人不在人员目录");
    return handle(reply, async () => {
      const own = await board(id, req.params.taskId);
      // 伙伴登记：原话取本人在这件 Task 所在项目对话里最近说的话（16.8；Chat 调过来不带是哪段对话）。
      const words = await recentOwnerWords(q, history, id, { taskId: own.task.taskId, projectId: null }, String(req.id));
      const { request, created } = await registerCardSplit(q, own, "buddy", ctx.now(), words, await sequenceOf(undefined, id, own.task.taskId, String(req.id)));
      return reply.status(created ? 201 : 200).send(request);
    });
  });

  return { enqueueAcceptance: (handbackId) => { if (cloud) void acceptance.enqueue(handbackId); }, enqueueProposal: (proposalId) => { void proposals.enqueue(proposalId); },
    planTask: (personId, planTaskId) => planTaskOf(personId)(planTaskId) };
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
