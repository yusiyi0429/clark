import { createHash, randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import {
  AcceptIssueDraftRequest,
  ConversationMessageRequest,
  ConversationScope,
  IssueDraftResponse,
  type TAcceptIssueDraftRequest,
  type TAskAnswerRecord,
  type TConversationAttachment,
  type TConversationCard,
  type TConversationMessageRequest,
  type TConversationScope,
  type TReadScope,
  type TReferenceSnapshot,
} from "@warmap/contracts";
import {
  ACTIVE_CONVERSATION_WHERE,
  CONVERSATION_IDLE_RESTART_MS,
  conversationAttachmentInfo,
  ensureMainConversation,
  getConversationHistory,
  getScopeObject,
  loadConversationAttachments,
  resolveReferenceSnapshots,
  storeConversationAttachments,
} from "../conversations.js";
import { AGENT_ROLES, anonUserId, conversationScope, conversationThreadId, conversationTurnId, preview, tracedTurn } from "../tracing.js";
import { MAX_MATERIAL_FILES, MAX_MATERIAL_FILE_BYTES, MaterialParseError, cleanupMaterialTemp, parseMaterialBatch } from "../materialParser.js";
import { logEvent } from "../observability.js";
import { getIssueRow } from "../issues.js";
import { getMeetingRow } from "../meetingStore.js";
import { projectMemberIssueCard, projectMemberMeetingCard } from "../memberCards.js";
import { isActiveMember } from "../threads.js";
import { getObjectMaterial } from "../objectMaterials.js";
import { withNotice } from "../conversationRouting.js";
import { ConversationTurnError, recoveryNote, resumeInstruction, shortFailureReason, turnFailureCopy, type TurnFailureKind, type TurnRecoverySummary } from "../conversationRecovery.js";
import { personalMemoryToolsFor, unknownMemoryMarks } from "../personalMemory.js";
import { searchOwnConversationHistory } from "../conversationHistorySearch.js";
import { createStepTracker } from "../conversationSteps.js";
import { createConversationEntries, openTodoContext } from "../conversationEntries.js";
import { loadAsk, readAnswers, type AskUser, type QuestionsCard } from "../askUser.js";
import type { RequestAgent } from "../delivery/requestAgent.js";
import { isRealPerson, personDisplayNames } from "../people.js";
import { createCompanyMap, defaultFocus, scopeLabel } from "../companyMap.js";
import { acceptIssueDraft, createIssueSuggest, declineIssueDraft, getIssueDraftView, issueSuggestBlock, issueSuggestContext, saveDraftMaterial } from "../issueDrafts.js";
import { buildSceneAnchor } from "../sceneAnchor.js";
import type { ConversationAnchor } from "../conversationAnchor.js";
import { listMyTasks } from "../tasks.js";
import { readMemberWork } from "../memberWork.js";
import { readHomeCards } from "./cards.js";
import { idParams, type AppInstance, type RouteContext, type SessionPerson } from "./shared.js";

/** 场景锚点里对象页的叫法（按 scope 前缀）。 */
const OBJECT_SCENES: Record<string, string> = {
  task: "执行事项详情", meeting: "会议详情", issue: "议题详情", mission: "Mission 详情", "mission-card": "任务卡详情",
  "monthly-plan": "月度计划详情", "monthly-review-item": "复盘项详情", "personal-review": "个人复盘", signal: "信号详情",
};

export function registerConversationRoutes(app: AppInstance, ctx: RouteContext, deliveryAgent: RequestAgent): void {
  const { pool, q, env, fail, requirePerson, requireCEO, requestContext, runtime, peopleDirectory, conversationAttachmentStorageDir, conversationTurnTimeoutMs, conversationStallTimeoutMs, conversationHeartbeatMs, conversationCompaction, research } = ctx;

  const conversationParams = Type.Object({ scope: ConversationScope }, { additionalProperties: false });
  // 我的 Agent 按「人 × 页面」私有；任务卡 scope 始终复查对象成员及当前拍板权。
  const scopeObjectFor = async (person: SessionPerson, scope: TConversationScope) => {
    if (person.role !== "ceo" && (scope.startsWith("issue:") || scope.startsWith("meeting:"))) {
      const [objectType, objectId] = scope.split(":", 2) as ["issue" | "meeting", string];
      if (!await isActiveMember(q, { objectType, objectId }, person.personId)) return { snapshot: null, visible: false };
      const card = objectType === "issue"
        ? await getIssueRow(q, objectId).then((row) => row && projectMemberIssueCard(row, env.sessionSecret))
        : await getMeetingRow(q, objectId).then((row) => row && projectMemberMeetingCard(row, env.sessionSecret, person.personId));
      if (!card) return { snapshot: null, visible: false };
      return { visible: true, snapshot: { cardId: card.id, version: card.version, kind: card.kind, title: card.title,
        objectRef: card.objectRef, payload: card.payload } };
    }
    return person.role === "ceo" || scope === "global" || scope.startsWith("mission-card:") || scope.startsWith("task:") || scope.startsWith("monthly-review-item:") || scope.startsWith("personal-review:")
      ? getScopeObject(q, scope, env.sessionSecret, { person, people: peopleDirectory.searchPeople(undefined), now: ctx.now() })
      : { snapshot: null, visible: false };
  };
  const conversationScopeVisible = async (person: SessionPerson, scope: TConversationScope) =>
    (await scopeObjectFor(person, scope)).visible;

  app.get(
    "/api/conversations/:scope/messages",
    { preHandler: requirePerson, schema: { params: conversationParams } },
    async (req, reply) => {
      const object = await scopeObjectFor(req.person!, req.params.scope);
      if (!object.visible) return fail(reply, 404, "CONVERSATION_SCOPE_NOT_FOUND", "Conversation scope 不存在");
      return getConversationHistory(q, req.person!.personId, req.params.scope);
    },
  );

  /** 一轮对话的完整流程：读写这个人在这个页面的当前对话。 */
  const sendConversationTurn = async (
    req: FastifyRequest<{ Params: { scope: TConversationScope }; Body: TConversationMessageRequest }>,
    reply: FastifyReply,
  ): Promise<void> => {
      const person = req.person!;
      const owner = person.personId;
      const object = await scopeObjectFor(person, req.params.scope);
      if (!object.visible) return fail(reply, 404, "CONVERSATION_SCOPE_NOT_FOUND", "Conversation scope 不存在");
      /** 页面左侧正在看的那份材料（只认这个 scope 的对象）；读不到抛错。read_anchor 展开时按当前权限重读。 */
      const viewingMaterial = async (materialId: string) => {
        const [objectType, objectId] = req.params.scope.split(":", 2);
        if (objectType !== "issue" && objectType !== "task" && objectType !== "meeting") throw new Error("MATERIAL_NOT_FOUND");
        const names = personDisplayNames(peopleDirectory);
        const material = await getObjectMaterial(q, { objectType, objectId }, materialId,
          { personId: owner, role: person.role, displayName: names.get(owner) ?? owner }, names);
        return { id: material.id, fileName: material.fileName, version: material.version, editable: material.editable, canEdit: material.canEdit,
          ...(material.url ? { url: material.url } : {}) };
      };
      if (req.body.viewingMaterialId) {
        try {
          const material = await viewingMaterial(req.body.viewingMaterialId);
          if (object.snapshot) Object.assign(object.snapshot, { viewingMaterial: material });
        } catch { return fail(reply, 404, "MATERIAL_NOT_FOUND", "材料不存在"); }
      }
      // 成员在 2a 看不到任何 Card，也不能借显式引用把 Card 带进自己的 Agent。
      if (person.role !== "ceo" && req.body.references?.length) return fail(reply, 404, "REFERENCE_NOT_FOUND", "Card 引用不存在");
      const references = await resolveReferenceSnapshots(q, req.body.references ?? [], env.sessionSecret, person);
      if (!("snapshots" in references)) {
        return fail(reply, references.status, references.code, references.message);
      }
      // 场景锚点（PR #12 Anchor 层）：本人有权看的页面投影 → 目录、聚焦项与 read_anchor；每次展开都按当前权限和版本重读。
      // 对象页 = 这个对象（第一次直接用上面已授权的快照）；首页 = CEO 首页的 Card / 成员工作台上本人的事项、任务卡与战场。
      let firstList = true;
      const pageSnapshots = async (): Promise<TReferenceSnapshot[]> => {
        if (req.params.scope !== "global") {
          if (firstList) { firstList = false; return object.snapshot ? [object.snapshot] : []; }
          const current = await scopeObjectFor(person, req.params.scope);
          if (!current.visible || !current.snapshot) return [];
          if (req.body.viewingMaterialId) {
            try { Object.assign(current.snapshot, { viewingMaterial: await viewingMaterial(req.body.viewingMaterialId) }); } catch { return []; }
          }
          return [current.snapshot];
        }
        if (person.role === "ceo") return (await readHomeCards(ctx, person)).cards.map((card) => ({
          cardId: card.id, version: card.version, kind: card.kind, title: card.title, objectRef: card.objectRef, payload: card.payload,
        }));
        const names = personDisplayNames(peopleDirectory);
        const [tasks, { work }] = await Promise.all([
          listMyTasks(q, owner, names),
          readMemberWork(q, peopleDirectory.searchPeople(undefined), env.sessionSecret, person, ctx.now()),
        ]);
        const item = (type: string, id: string, title: string, payload: unknown, version = 1): TReferenceSnapshot =>
          ({ cardId: `${type}:${id}`, version, kind: type, title, objectRef: { type, id, version }, payload });
        return [
          ...tasks.map((task) => item("task", task.id, task.title, { task }, task.version)),
          ...work.missionCards.map((card) => item("mission-card", card.cardId, `${card.battlefieldName} · ${card.period} 任务卡`, card)),
          ...work.battlefields.map((field) => item("battlefield", field.id, field.name, { period: work.period, ...field })),
        ];
      };
      const scene = {
        scene: req.params.scope === "global" ? (person.role === "ceo" ? "公司首页" : "我的工作台") : OBJECT_SCENES[req.params.scope.split(":", 1)[0]] ?? "对象详情",
        objectPage: req.params.scope !== "global", list: pageSnapshots,
      };
      let anchor: ConversationAnchor;
      try {
        anchor = await buildSceneAnchor({ ...scene, selection: req.body.anchorSelection });
      } catch (error) {
        const cause = error as { status?: number; code?: string; message: string };
        if (cause.status && cause.code) return fail(reply, cause.status, cause.code, cause.message);
        throw error;
      }

      // 锁按「人 × scope」：不同的人在同一页面不会互相挡住。
      const lockKey = `${owner}|${req.params.scope}`;
      const client = await pool.connect();
      const locked = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [lockKey]);
      if (!locked.rows[0]?.locked) {
        client.release();
        return fail(reply, 409, "TURN_IN_PROGRESS", "上一轮回答还没结束，请等它写完或点「停止」后再发。");
      }

      let scopeLockHeld = true;
      const runId = randomUUID();
      requestContext.set(req, { runId, scope: req.params.scope });
      const runStartedAt = Date.now();
      const abort = new AbortController();
      let streamFinished = false;
      let eventSequence = 0;
      let runStatus = "aborted";
      let runError: string | undefined;
      let hijacked = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        // 当前对话 = 这个人最早一条未删除、未归档的会话；不存在则在锁内惰性创建。
        let row: { id: string; pi_session_id: string; runtime_entries: unknown[] };
        const existing = await client.query<{ id: string; pi_session_id: string; runtime_entries: unknown[] }>(
          `SELECT id, pi_session_id, runtime_entries FROM conversations WHERE ${ACTIVE_CONVERSATION_WHERE} ORDER BY created_at ASC, id ASC LIMIT 1`,
          [owner, req.params.scope],
        );
        if (existing.rows[0]) {
          row = existing.rows[0];
        } else {
          row = { id: randomUUID(), pi_session_id: randomUUID(), runtime_entries: [] };
          await client.query(
            "INSERT INTO conversations (id, owner_id, scope, pi_session_id) VALUES ($1, $2, $3, $4)",
            [row.id, owner, req.params.scope, row.pi_session_id],
          );
        }
        // 「继续」：只能接这个人在这个页面自己的那一轮；有已写出的部分就从断点续写，没有就用已查到的材料重答。
        let resume: { tier?: "quick" | "grounded" | "deep"; question: string; instruction: string } | undefined;
        if (req.body.resumeRunId) {
          const previous = await client.query<{ input_snapshot: { conversationId?: string; message?: string; route?: { tier?: string }; partial?: boolean;
            anchorFocus?: { cardId: string; version: number } | null } }>(
            "SELECT input_snapshot FROM agent_runs WHERE id = $1 AND kind = 'conversation'", [req.body.resumeRunId]);
          const snapshot = previous.rows[0]?.input_snapshot;
          if (!snapshot || snapshot.conversationId !== row.id || typeof snapshot.message !== "string") {
            return fail(reply, 404, "RESUME_NOT_FOUND", "要接着写的那一轮回答找不到了，请直接重新提问。");
          }
          const written = await client.query<{ content: string }>(
            "SELECT content FROM conversation_messages WHERE conversation_id = $1 AND run_id = $2 AND role = 'assistant' ORDER BY sequence DESC LIMIT 1",
            [row.id, req.body.resumeRunId]);
          // 那一轮记了有没有写出正文（存档里开头可能只有开场说明，不能当作正文）。
          resume = resumeInstruction(snapshot.message, snapshot.partial === false ? undefined : written.rows[0]?.content, snapshot.route?.tier);
          // 场景锚点按那一轮记下的聚焦卡引用重建：读不到就不聚焦，版本变了按当前版本并标 changed。
          if (snapshot.anchorFocus !== undefined) {
            firstList = true;
            anchor = await buildSceneAnchor({ ...scene, ...(snapshot.anchorFocus ? { selection: snapshot.anchorFocus } : {}), resumed: true });
          }
        }
        // 回答 Agent 的提问（askUser.ts）：只能答这条对话里的提问卡，一张卡只答一次。这一句的原文按卡和答案重写
        // （下面存档、个人记忆、交给运行时的都是它），问答记录存在这条消息上。
        let answerRecord: TAskAnswerRecord | undefined;
        if (req.body.answers) {
          const asked = await loadAsk(client.query.bind(client), row.id, req.body.answers.askId);
          if (!asked) return fail(reply, 404, "ASK_NOT_FOUND", "这组提问找不到了，可以直接回复。");
          if (asked.answered) return fail(reply, 409, "ASK_ANSWERED", "这组提问已经回答过了。");
          const read = readAnswers(asked.card, req.body.answers);
          if ("error" in read) return fail(reply, 400, "ASK_ANSWER_INVALID", read.error);
          answerRecord = read.record;
          req.body.message = read.text;
        }
        // 附件：只信服务端 sidecar（客户端只能传 id）；原件不进入 Runtime，只拼接有界抽取文本。
        let attachments: TConversationAttachment[] = [];
        if (req.body.attachments?.length) {
          try {
            attachments = await loadConversationAttachments(
              conversationAttachmentStorageDir,
              row.id,
              req.body.attachments.map((item) => item.id),
            );
          } catch (error) {
            if ((error as { code?: string }).code === "ATTACHMENT_NOT_FOUND") {
              return fail(reply, 400, "ATTACHMENT_NOT_FOUND", (error as Error).message);
            }
            throw error;
          }
        }
        const runtimeMessage = attachments.length
          ? `${req.body.message}\n\n${attachments.map((attachment) => `[附件 ${attachment.fileName}]\n${attachment.extractedText}`).join("\n\n")}`
          : req.body.message;
        const next = await client.query<{ sequence: number; last_at: Date | null }>(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence, MAX(created_at) AS last_at
             FROM conversation_messages WHERE conversation_id = $1`,
          [row.id],
        );
        const userSequence = next.rows[0].sequence;
        // 转议题时从首页带进来、模型还没见过的那一段：排在最后一轮普通问答之后的 carried 消息（运行时接进模型历史）。
        const carried = await client.query<{ role: "user" | "assistant"; content: string; created_at: Date }>(
          `SELECT role, content, created_at FROM conversation_messages WHERE conversation_id = $1 AND kind = 'carried'
              AND sequence > COALESCE((SELECT MAX(sequence) FROM conversation_messages WHERE conversation_id = $1 AND kind = 'message'), 0)
            ORDER BY sequence`,
          [row.id],
        );
        // 闲置太久：这一轮模型侧只带摘要重新开始（「继续」那一轮要接上原来的工具结果，不重开）。
        const lastAt = next.rows[0].last_at;
        const idleRestart = !resume && Array.isArray(row.runtime_entries) && row.runtime_entries.length > 0
          && lastAt !== null && Date.now() - lastAt.getTime() >= CONVERSATION_IDLE_RESTART_MS;
        // 后台压缩（conversationCompaction.ts）：已就绪的快照这时换进这一轮的模型历史（毫秒级，不调模型、不等后台任务）；
        // 闲置重开用的也是换进来之后最近的那份摘要。历史已经很长又没有快照在做时，顺手在后台补起一次。
        const prepared = conversationCompaction
          ? await conversationCompaction.prepareTurn(client.query.bind(client), row)
          : { runtimeEntries: row.runtime_entries };
        await client.query(
          `INSERT INTO conversation_messages
             (conversation_id, sequence, role, content, references_snapshot, attachments, run_id, meta)
           VALUES ($1, $2, 'user', $3, $4::jsonb, $5::jsonb, $6, $7::jsonb)`,
          [row.id, userSequence, req.body.message, JSON.stringify(references.snapshots), JSON.stringify(attachments), runId,
            answerRecord ? JSON.stringify({ answers: answerRecord }) : null],
        );
        // 个人记忆：任何页面都读本人的记忆；后台提炼按游标增量跑（personalDistillation.ts），这里不排任务。
        // 「记住」「忘掉」「改成」由主 Agent 调工具完成，不在主回答之前同步跑提炼：记忆改动失败只是工具报错，不替换回答、不动上下文（3c）。
        // 场景锚点聚焦的那张卡（页面对象或本人选中的卡）就是这一轮记忆的 anchor：检索时只比对象、不比版本；钉住的版本比现在旧时标「基于旧版本」（R8）。
        const objectRef = anchor.focus?.objectRef;
        const currentObject = objectRef ? { target: `${objectRef.type}:${objectRef.id}`, version: objectRef.version } : undefined;
        // 选取要等召回模型（personalMemoryRecall.ts）：不在这里等，交给运行时与分诊同时进行，拼上下文包时才等它。
        // 本轮实际装进上下文的个人记忆 id：上下文包里的，加上检索工具返回的；随回答存进 memory_used。
        // 运行时等的是记完 id 的这个 Promise，模型看到的条目一定已经记下。
        const memoryUsed = new Set<string>();
        const personalMemory = ctx.personalMemory.select(owner, req.body.message, { currentObject }, client)
          .then((entries) => entries.map(({ id, title, text, createdAt, basedOnOldVersion }) => ({ id, title, text, createdAt, ...(basedOnOldVersion ? { basedOnOldVersion } : {}) })), (error: unknown) => {
            logEvent({ event: "personal_memory.unavailable", requestId: String(req.id), runId, scope: req.params.scope, errorCode: (error as { code?: string })?.code ?? "PERSONAL_MEMORY_UNAVAILABLE" });
            return [];
          })
          .then((entries) => {
            for (const entry of entries) memoryUsed.add(entry.id);
            return entries;
          });
        // 主 Agent 记下的条目：依据是本轮这句原话，anchor 是当前页面对象（钉住此刻的版本）。
        const memoryTools = personalMemoryToolsFor(ctx.personalMemory, owner, (event) =>
          logEvent({ ...event, requestId: String(req.id), runId, scope: req.params.scope }), {
          reference: { ref: `chat:${row.id}#${userSequence}`, quote: req.body.message.slice(0, 500), at: new Date().toISOString() },
          anchors: currentObject ? [{ target: currentObject.target, ...(typeof currentObject.version === "number" ? { pinnedVersion: currentObject.version } : {}) }] : [],
        });
        const personalMemoryTools = { ...memoryTools, search: async (query: string) => {
          const entries = await memoryTools.search(query);
          for (const entry of entries) memoryUsed.add(entry.id);
          return entries;
        } };
        const memoryUsedJson = () => (memoryUsed.size ? JSON.stringify([...memoryUsed]) : null);
        // 本人手上没完成的待办，每轮带进上下文（条数少，只有标题、发起人、时间、类型）；读不到不影响这一轮。
        const names = personDisplayNames(peopleDirectory);
        const openTodos = await openTodoContext(q, owner, names).catch(() => []);
        const recent = await client.query<{ role: "user" | "assistant"; content: string; created_at: Date }>(
          `SELECT role, content, created_at
             FROM conversation_messages
            WHERE conversation_id = $1 AND run_id <> $2 AND kind <> 'trace'
            ORDER BY sequence DESC LIMIT 20`,
          [row.id, runId],
        );
        await client.query(
          `INSERT INTO agent_runs (id, kind, object_ref, status, model_slot, prompt_hash, input_snapshot)
           VALUES ($1, 'conversation', $2::jsonb, 'running', $3, $4, $5::jsonb)`,
          [
            runId,
            JSON.stringify(object.snapshot?.objectRef ?? null),
            runtime.modelSlot ?? "light",
            runtime.promptHash ?? createHash("sha256").update("conversation-runtime").digest("hex"),
            JSON.stringify({
              scope: req.params.scope,
              viewerId: owner,
              conversationId: row.id,
              // 「继续」那一轮记原问题：再点一次「继续」时接的还是同一个问题。
              message: resume ? resume.question : req.body.message,
              ...(req.body.resumeRunId ? { resumeOf: req.body.resumeRunId } : {}),
              ...(idleRestart ? { idleRestart: true } : {}),
              currentObject: object.snapshot,
              // 场景锚点的聚焦卡引用（id@版本）：「继续」这一轮时按它重建锚点。
              anchorFocus: anchor.focus ? { cardId: anchor.focus.cardId, version: anchor.focus.version } : null,
              references: references.snapshots,
              attachments: attachments.map(conversationAttachmentInfo),
            }),
          ],
        );

        reply.hijack();
        hijacked = true;
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        reply.raw.on("close", () => {
          if (!streamFinished) abort.abort(Object.assign(new Error("Conversation client disconnected"), { code: "CLIENT_DISCONNECTED" }));
        });
        // 心跳：长时间思考、查证、压缩时也每隔一会儿写一行注释，代理和浏览器不会把连接当成断了。
        heartbeat = setInterval(() => {
          if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(": ping\n\n");
        }, conversationHeartbeatMs);
        heartbeat.unref();
        let runUsage: Record<string, unknown> | null = null;
        let lastEventAt = Date.now();
        let compacting = false;
        /** 已经流给界面的正文与开场说明：这一轮没完成时，已写出的部分连同开场说明存成这一轮的回答。 */
        let streamedBody = "";
        let notice: string | undefined;
        let routeTier: string | undefined;
        /** 本档实际用的主答模型（按档位换模型以后，runtime.modelId 只是默认的那个）。 */
        let routeModel: string | undefined;
        let recoveries = 0;
        const toolErrors: { kind: "tool_error"; tool: string; code: string; at: string }[] = [];
        // 绝对上限只防死循环（10 分钟）；正常的长回答按进展判断，不按档位截断。
        const timeout = setTimeout(() => abort.abort(Object.assign(
          new Error(`Conversation turn exceeded ${Math.max(1, Math.round(conversationTurnTimeoutMs / 1000))} seconds`), { code: "TURN_TIMEOUT" })), conversationTurnTimeoutMs);
        timeout.unref();
        const emit = (event: Record<string, unknown>) => {
          lastEventAt = Date.now();
          compacting = event.type === "compaction" && event.phase === "started";
          if (event.type === "usage") {
            const { type: _type, ...usage } = event;
            runUsage = usage;
          }
          if (event.type === "message" && typeof event.delta === "string") streamedBody += event.delta;
          if (event.type === "recovery") recoveries += 1;
          if (event.type === "route") {
            routeTier = String(event.tier);
            if (typeof event.model === "string") routeModel = event.model;
            notice = typeof event.notice === "string" ? event.notice : undefined;
            // 界面只用它显示档位；时限统一是绝对上限。
            event = { ...event, timeoutMs: conversationTurnTimeoutMs };
          }
          // 工具报错或超时：记一条质量信号（随运行记录存下，管理员视图的「质量信号」读它）；errorCode 只给运行记录，不发给界面。
          if (event.type === "tool" && event.phase === "completed" && event.isError) {
            const { errorCode, ...rest } = event as Record<string, unknown> & { errorCode?: unknown };
            const signal = { kind: "tool_error" as const, tool: String(event.name), code: typeof errorCode === "string" ? errorCode : "TOOL_ERROR", at: new Date().toISOString() };
            toolErrors.push(signal);
            logEvent({ event: "conversation.quality_signal", signal: "tool_error", requestId: String(req.id), runId, scope: req.params.scope, tool: signal.tool, code: signal.code });
            event = rest;
          }
          if (!reply.raw.destroyed) {
            const data = { ...event, runId, scope: req.params.scope, sequence: ++eventSequence };
            reply.raw.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(data)}\n\n`);
          }
          // 连接断了也照样记步骤：运行记录里要有完整的步骤。
          if (event.type === "tool") steps.tool(event as Parameters<typeof steps.tool>[0]);
        };
        // 当前步骤（已定设计第 6 节第 2 条）：工具开始、结束映射成 step 事件；整轮的步骤随运行记录存下。
        const steps = createStepTracker((step) => emit({ type: "step", ...step }));
        // 对话里的一句话入口（生成复盘、帮我问问、请同事帮忙）：步骤实时报给界面，结果卡随这一轮的运行记录存下、挂在回答后面。
        const cards: TConversationCard[] = [];
        const directory = peopleDirectory.searchPeople(undefined).filter(isRealPerson).map(({ personId, displayName }) => ({ personId, displayName }));
        const entries = createConversationEntries({
          pool, agent: deliveryAgent, secret: env.sessionSecret, viewer: { personId: owner, role: person.role },
          message: resume ? resume.question : req.body.message, names, people: directory, directory, now: ctx.now,
          reviews: ctx.monthlyReviewService, weeklyReviews: ctx.weeklyReviewService, collections: ctx.collections, fingerprint: `conversation:${runId}`,
          onStep: (step) => steps.report(step), onCard: (card) => { if (cards.length < 4) cards.push(card); },
        });
        // Agent 向本人提问：提问卡和上面的卡一样随运行记录存下、挂在回答后面；「等你回答」这一步留着高亮。
        const ask: AskUser = (questions) => {
          const card: QuestionsCard = { kind: "questions", askId: randomUUID(), questions: questions.map((question, index) => ({ id: `q${index + 1}`, ...question })) };
          cards.push(card);
          steps.report({ id: "ask", label: "等你回答", status: "active", result: `${questions.length} 个问题` });
          return card;
        };

        // 三层取用（companyMap.ts）：默认焦点只有一个来源——场景锚点聚焦的那张卡（对象页就是页面对象；首页没有聚焦时按页面）。
        // 同一个焦点既给三层取用的工具当默认参数，也作为 anchor.range / anchor.period 给模型看。跨对象读取时发范围标签，同时记成「定范围」这一步。
        const now = ctx.now();
        const viewer = { personId: owner, role: person.role };
        const focusScope = req.params.scope === "global" && anchor.focus ? `${anchor.focus.objectRef.type}:${anchor.focus.objectRef.id}` : req.params.scope;
        const baseFocus = defaultFocus(focusScope, anchor.focus, viewer, now);
        const focusIds = baseFocus.people === "all" ? null : baseFocus.people === "me" ? [owner] : baseFocus.people;
        const battlefieldName = baseFocus.battlefieldId
          ? (await q("SELECT name FROM battlefield_config WHERE id = $1", [baseFocus.battlefieldId])).rows[0]?.name as string | undefined : undefined;
        const turnAnchor: ConversationAnchor = { ...anchor, view: { ...anchor.view, period: baseFocus.period,
          range: scopeLabel({ people: focusIds, battlefieldName, from: baseFocus.period, to: baseFocus.period, viewerId: owner }, names) } };
        let readScope: TReadScope | undefined;
        const companyMap = createCompanyMap({ q, viewer, people: directory, now: ctx.now, focus: baseFocus, override: req.body.scopeOverride,
          onScope: (scope) => {
            readScope = scope;
            emit({ type: "scope", ...scope });
            steps.report({ id: "scope", label: "定范围", status: "done", result: scope.label });
          } });
        // 一号位深聊转议题（只在 CEO 首页）：这一轮提了建议，回答末尾附建议卡。
        let issueDraftId: string | undefined;
        const homeOfCeo = person.role === "ceo" && req.params.scope === "global";
        const issueSuggest = homeOfCeo ? createIssueSuggest({ pool, ownerId: owner, conversationId: row.id, runId, userSequence, now: ctx.now,
          onDraft: (draftId) => { issueDraftId = draftId; } }) : undefined;
        const issueContext = homeOfCeo ? await issueSuggestContext(q, owner).catch(() => undefined) : undefined;
        const withSuggestCard = (text: string) => (issueDraftId ? `${text.trimEnd()}\n\n${issueSuggestBlock(issueDraftId)}` : text);

        // 整轮卡住检测（最后一道）：模型调用自己的卡住会就地恢复并发 recovery 事件；这里只在连恢复都没有进展时停下。
        const stall = setInterval(() => {
          if (compacting || Date.now() - lastEventAt < conversationStallTimeoutMs || abort.signal.aborted) return;
          abort.abort(Object.assign(new Error(`Conversation stalled for ${Math.round(conversationStallTimeoutMs / 1000)} seconds`), { code: "TURN_STALLED" }));
        }, Math.min(5_000, Math.max(5, Math.floor(conversationStallTimeoutMs / 4))));
        stall.unref();
        /** 运行记录里这一轮的档位与恢复：原模型、备用模型、触发原因、各类恢复次数、合计重试次数（没有恢复过就没有 recovery）。 */
        /**
         * 质量信号：回答里的记忆标记指向不在本轮 memory_used 里的 id（界面不显示这种标记）。记日志并随运行记录存下，之后进管理员视图。
         */
        const qualitySignals = (text: string) => {
          const unknown = unknownMemoryMarks(text, memoryUsed);
          if (!unknown.length) return [];
          logEvent({ event: "conversation.quality_signal", signal: "memory_mark_unknown_id", requestId: String(req.id), runId, scope: req.params.scope, count: unknown.length });
          return [{ signal: "memory_mark_unknown_id", ids: unknown }];
        };
        const routeSnapshot = (partial: boolean | undefined, summary: TurnRecoverySummary | undefined, text: string) => {
          const signals = [...qualitySignals(text), ...toolErrors];
          return JSON.stringify({ route: { tier: routeTier ?? null, model: routeModel ?? null, recoveries,
            ...(summary ? { recovery: { originalModel: summary.originalModel, fallbackModel: summary.fallbackModel ?? null, reasons: summary.reasons,
              actions: summary.actions, retries: summary.retries } } : {}) },
            ...(partial === undefined ? {} : { partial }), steps: steps.list(), ...(cards.length ? { cards } : {}), ...(readScope ? { readScope } : {}),
            ...(issueDraftId ? { issueDraftId } : {}), ...(signals.length ? { qualitySignals: signals } : {}) });
        };
        let recoverySummary: TurnRecoverySummary | undefined;
        /**
         * 这一轮没完成（出错、超时、卡住、一号位停止或关掉页面）：已写出的部分连同开场说明存成这一轮的回答，末尾一行说明；
         * 运行时给了这一轮的模型历史就一并存下（下一轮或「继续」接得上）。存档失败不影响给界面发说明。
         */
        const settleFailure = async (kind: TurnFailureKind, raw: string, cause?: unknown) => {
          const partial = streamedBody.trim().length > 0;
          steps.finish(true);
          const copy = turnFailureCopy(kind, { partial, recoveries, stallSeconds: Math.max(1, Math.round(conversationStallTimeoutMs / 1000)), capMinutes: Math.max(1, Math.round(conversationTurnTimeoutMs / 60_000)) });
          const stopped = kind === "aborted";
          const note = stopped
            ? "（已停止，以上是停止前写出的部分。）"
            : !partial ? `（这次回答没有完成：${shortFailureReason(kind)}。）`
            : kind === "turn_timeout" ? `（回答持续了 ${Math.max(1, Math.round(conversationTurnTimeoutMs / 60_000))} 分钟仍未写完，以上是已写出的部分。）`
            : "（这次回答在这里中断了，以上是已经写出的部分。）";
          let saved = false;
          if (partial || !stopped) {
            const content = withSuggestCard(withNotice(notice, partial ? `${streamedBody.trimEnd()}\n\n${note}` : note));
            saved = await client.query(
              `INSERT INTO conversation_messages (conversation_id, sequence, role, content, references_snapshot, run_id, memory_used)
               VALUES ($1, $2, 'assistant', $3, '[]'::jsonb, $4, $5::jsonb)`,
              [row.id, userSequence + 1, content, runId, memoryUsedJson()],
            ).then(() => true, () => false);
          }
          const entries = (cause as { runtimeEntries?: unknown })?.runtimeEntries;
          const piSession = (cause as { details?: { piSessionId?: unknown } })?.details?.piSessionId;
          if (Array.isArray(entries) && entries.length) {
            await client.query(
              "UPDATE conversations SET runtime_entries = $2::jsonb, pi_session_id = COALESCE($3, pi_session_id), runtime_updated_at = now() WHERE id = $1",
              [row.id, JSON.stringify(entries), typeof piSession === "string" ? piSession : null],
            ).then(async () => { if (prepared.snapshotId) await conversationCompaction?.markApplied(client.query.bind(client), prepared.snapshotId); }, () => undefined);
          }
          recoverySummary = (cause as { details?: { recoverySummary?: TurnRecoverySummary } })?.details?.recoverySummary;
          await client.query(
            "UPDATE agent_runs SET status = $2, error = $3, usage = $4::jsonb, input_snapshot = input_snapshot || $5::jsonb, completed_at = now() WHERE id = $1",
            [runId, stopped || abort.signal.aborted ? "aborted" : "failed", raw, JSON.stringify(runUsage), routeSnapshot(partial && saved, recoverySummary, streamedBody)],
          ).catch(() => undefined);
          runStatus = stopped || abort.signal.aborted ? "aborted" : "failed";
          runError = raw;
          if (stopped) emit({ type: "done", status: "aborted" });
          else emit({ type: "error", code: (cause as { code?: string })?.code === "CONTENT_FILTER" ? "CONTENT_FILTER" : copy.code, message: copy.message,
            ...(copy.resume ? { resume: copy.resume } : {}), partial: saved && partial });
        };
        try {
          // LangSmith：一轮对话 = 一个 Turn（conv-<会话>-t<用户消息序号>），Thread = 这个人在这个页面的主对话。
          const result = await tracedTurn({
            resolve: async () => ({
              agentRole: person.role === "ceo" ? AGENT_ROLES.ceoAgent : AGENT_ROLES.driAgent,
              logicalTurnId: conversationTurnId(row.id, userSequence),
              attempt: 1,
              threadId: await conversationThreadId(client.query.bind(client), row.id),
              scope: conversationScope(req.params.scope),
              anonUserId: anonUserId(owner),
              inputs: { message: preview(req.body.message) },
            }),
            outputs: (value) => ({ assistantMessage: preview(value.assistantMessage) }),
            errorOf: () => (abort.signal.aborted ? String((abort.signal.reason as { message?: string } | undefined)?.message ?? "Conversation aborted") : undefined),
          }, () => runtime.run({
            scope: req.params.scope,
            runId,
            viewer: { personId: owner, displayName: names.get(owner) ?? owner, role: person.role },
            message: runtimeMessage,
            currentObject: object.snapshot,
            referencesSnapshot: references.snapshots,
            personalMemory,
            personalMemoryTools,
            // 本人历史对话原文检索（3e）：跨所有页面与归档，只查本人，本轮这条不算。
            searchHistory: (query: string) => searchOwnConversationHistory(q, { personId: owner, query, excludeRunId: runId }),
            openTodos,
            entries,
            ask,
            companyMap,
            anchor: turnAnchor,
            ...(req.body.scopeOverride ? { scopeOverride: req.body.scopeOverride } : {}),
            ...(issueSuggest ? { issueSuggest } : {}),
            ...(issueContext ? { issueContext } : {}),
            ...(carried.rows.length ? { carriedOver: carried.rows.map((message) => ({ role: message.role, content: message.content, createdAt: message.created_at.toISOString() })) } : {}),
            recentMessages: recent.rows.reverse().map((message) => ({
              role: message.role,
              content: message.content,
              createdAt: message.created_at.toISOString(),
            })),
            runtimeEntries: prepared.runtimeEntries,
            piSessionId: row.pi_session_id,
            signal: abort.signal,
            emit,
            ...(resume ? { resume } : {}),
            ...(idleRestart ? { idleRestart: true } : {}),
            checkpoint: async (runtimeEntries) => {
              await client.query(
                "UPDATE conversations SET runtime_entries = $2::jsonb, runtime_updated_at = now() WHERE id = $1",
                [row.id, JSON.stringify(runtimeEntries)],
              );
            },
          }));
          if (abort.signal.aborted) {
            const reason = abort.signal.reason as { code?: string; message?: string } | undefined;
            await settleFailure(reason?.code === "TURN_TIMEOUT" ? "turn_timeout" : reason?.code === "TURN_STALLED" ? "turn_stalled" : "aborted",
              reason?.message ?? "Conversation aborted");
          } else {
            // 这一轮走过恢复（用了备用模型、重试、续写、精简历史）：回答末尾一行很淡的说明，随消息存下。
            recoverySummary = result.recoverySummary;
            steps.finish(false);
            const note = recoveryNote(recoverySummary);
            // 这一轮提了转议题建议：建议卡的块接在回答末尾（界面画成卡），也随正文流给界面。
            const answer = withSuggestCard(result.assistantMessage);
            if (answer !== result.assistantMessage) emit({ type: "message", delta: answer.slice(result.assistantMessage.length) });
            await client.query("BEGIN");
            await client.query(
              `INSERT INTO conversation_messages
                 (conversation_id, sequence, role, content, references_snapshot, run_id, recovery_note, memory_used)
               VALUES ($1, $2, 'assistant', $3, '[]'::jsonb, $4, $5::jsonb, $6::jsonb)`,
              [row.id, userSequence + 1, answer, runId, note ? JSON.stringify(note) : null, memoryUsedJson()],
            );
            await client.query(
              `UPDATE conversations
                  SET runtime_entries = $2::jsonb,
                      pi_session_id = $3,
                      runtime_updated_at = now(),
                      recreated_at = CASE WHEN $4::boolean THEN now() ELSE recreated_at END,
                      runtime_warning = COALESCE($5, runtime_warning)
                WHERE id = $1`,
              [
                row.id,
                JSON.stringify(result.runtimeEntries),
                result.piSessionId ?? row.pi_session_id,
                result.recovery?.recreated === true,
                result.recovery?.warning ?? null,
              ],
            );
            await client.query(
              `UPDATE agent_runs
                  SET status = 'succeeded', candidate_output = $2::jsonb, usage = $3::jsonb, input_snapshot = input_snapshot || $4::jsonb, completed_at = now()
                WHERE id = $1`,
              [runId, JSON.stringify({ assistantMessage: result.assistantMessage }), JSON.stringify(runUsage), routeSnapshot(undefined, recoverySummary, result.assistantMessage)],
            );
            await client.query("COMMIT");
            if (prepared.snapshotId) await conversationCompaction?.markApplied(client.query.bind(client), prepared.snapshotId);
            runStatus = "succeeded";
            emit({ type: "done", status: "completed", ...(note ? { recoveryNote: note } : {}) });
          }
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          const reason = abort.signal.reason as { code?: string; message?: string } | undefined;
          const raw = reason?.message ?? (err as Error)?.message ?? "Conversation runtime failed";
          const kind: TurnFailureKind = reason?.code === "TURN_TIMEOUT" ? "turn_timeout"
            : reason?.code === "TURN_STALLED" ? "turn_stalled"
            : abort.signal.aborted ? "aborted"
            : err instanceof ConversationTurnError ? err.kind
            : (err as { code?: string })?.code === "SEARCH_BUDGET_EXHAUSTED" ? "search_budget"
            : (err as { code?: string })?.code === "CONTENT_FILTER" ? "content_filter"
            : "internal";
          await settleFailure(kind, raw, err);
        } finally {
          clearTimeout(timeout);
          clearInterval(stall);
        }
        const durationMs = Date.now() - runStartedAt;
        const provider = "warmap";
        const model = routeModel ?? runtime.modelId ?? env.lightModel;
        logEvent({
          event: "agent.run",
          requestId: String(req.id),
          runId,
          agentKind: "conversation",
          scope: req.params.scope,
          objectRef: object.snapshot ? `${object.snapshot.objectRef.type}:${object.snapshot.objectRef.id}` : undefined,
          provider,
          model,
          durationMs,
          status: runStatus,
          errorCode: runError ? (runStatus === "aborted" ? "ABORTED" : "RUNTIME_FAILED") : undefined,
          error: runError,
          recoveries,
          ...(recoverySummary ? { originalModel: recoverySummary.originalModel, fallbackModel: recoverySummary.fallbackModel,
            recoveryReasons: recoverySummary.reasons, recoveryActions: recoverySummary.actions, recoveryRetries: recoverySummary.retries } : {}),
          ...(idleRestart ? { idleRestart: true } : {}),
        });
        // 用了备用模型或走过恢复：单独一条，便于按事件检索（原模型、备用模型、原因、次数；报错原文在 conversation.recovery 与 agent_runs.error）。
        if (recoverySummary) logEvent({ event: "conversation.fallback", requestId: String(req.id), runId, scope: req.params.scope, status: runStatus,
          originalModel: recoverySummary.originalModel, fallbackModel: recoverySummary.fallbackModel, reasons: recoverySummary.reasons,
          actions: recoverySummary.actions, retries: recoverySummary.retries });
        streamFinished = true;
        // Fastify inject/browser may observe SSE end before this function's finally runs.
        // Release first so an immediate next turn/delete cannot spuriously see TURN_IN_PROGRESS.
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => undefined);
        scopeLockHeld = false;
        // 这一轮的历史已落库、锁已释放：历史超过软阈值就在后台压缩（不等它，一号位马上可以发下一问）。
        conversationCompaction?.schedule(row.id, "after_turn");
        reply.raw.end();
      } catch (error) {
        // 接管连接之后再出意外（读库失败等）：也要给界面一个结束事件，不能让连接一直挂着。
        if (!hijacked) throw error;
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          const copy = turnFailureCopy("internal", { partial: false });
          reply.raw.write(`event: error\ndata: ${JSON.stringify({ type: "error", code: copy.code, message: copy.message, resume: copy.resume, runId, scope: req.params.scope, sequence: ++eventSequence })}\n\n`);
        }
        logEvent({ event: "agent.run", requestId: String(req.id), runId, agentKind: "conversation", scope: req.params.scope, status: "failed", errorCode: "ROUTE_FAILED", error: (error as Error)?.message });
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        streamFinished = true;
        if (hijacked && !reply.raw.writableEnded) reply.raw.end();
        if (scopeLockHeld) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => undefined);
        client.release();
      }
    };

  app.post(
    "/api/conversations/:scope/messages",
    {
      preHandler: requirePerson,
      schema: { params: conversationParams, body: ConversationMessageRequest },
    },
    async (req: FastifyRequest<{ Params: { scope: TConversationScope }; Body: TConversationMessageRequest }>, reply) =>
      sendConversationTurn(req, reply),
  );

  // 一号位深聊转议题（issueDrafts.ts）：建议卡读取、开议题 / 接到议题、不用。只有 CEO。
  const names = () => personDisplayNames(peopleDirectory);
  app.get("/api/issue-drafts/:id", { preHandler: requireCEO, schema: { params: idParams, response: { 200: IssueDraftResponse } } }, async (req, reply) => {
    const view = await getIssueDraftView(q, req.person!.personId, req.params.id);
    return view ? { draft: view } : fail(reply, 404, "ISSUE_DRAFT_NOT_FOUND", "这条建议不存在");
  });
  app.post("/api/issue-drafts/:id/accept", { preHandler: requireCEO, schema: { params: idParams, body: AcceptIssueDraftRequest, response: { 200: IssueDraftResponse } } },
    async (req: FastifyRequest<{ Params: { id: string }; Body: TAcceptIssueDraftRequest }>, reply) => {
      const owner = req.person!.personId;
      const result = await acceptIssueDraft(pool, env.sessionSecret, owner, req.params.id, req.body, ctx.now());
      if ("error" in result) return fail(reply, result.error.status, result.error.code, result.error.message);
      if (result.created) {
        const { issueId, draft } = result.created;
        // 与其他议题创建路径一致：立即启动预研；初稿存成议题的一份群材料。都不阻塞响应、失败不影响议题本身。
        research.start(issueId).catch((error) => logEvent({ event: "issue_draft.research_failed", issueId, error: (error as Error)?.message }));
        await saveDraftMaterial(pool, { personId: owner, role: "ceo", displayName: names().get(owner) ?? owner }, issueId, draft)
          .catch((error) => logEvent({ event: "issue_draft.material_failed", issueId, error: (error as Error)?.message }));
      }
      return { draft: result.view };
    });
  app.post("/api/issue-drafts/:id/decline", { preHandler: requireCEO, schema: { params: idParams, response: { 200: IssueDraftResponse } } }, async (req, reply) => {
    const result = await declineIssueDraft(pool, req.person!.personId, req.params.id, ctx.now());
    return "error" in result ? fail(reply, result.error.status, result.error.code, result.error.message) : { draft: result.view };
  });

  // 附件挂到这个人在这个页面的主对话（没有就建）；复用 Meeting 材料的受限解析器（PDF/DOCX/Markdown、同一大小/数量/超时限制），API 卷独立。
  app.post(
    "/api/conversations/:scope/attachments",
    { preHandler: requirePerson, schema: { params: conversationParams }, bodyLimit: 101 * 1024 * 1024 },
    async (req, reply) => {
      let parsed: Awaited<ReturnType<typeof parseMaterialBatch>> | undefined;
      try {
        if (!await conversationScopeVisible(req.person!, req.params.scope)) return fail(reply, 404, "CONVERSATION_SCOPE_NOT_FOUND", "Conversation scope 不存在");
        const files: { filename: string; mimetype: string; buffer: Buffer }[] = [];
        for await (const part of req.files({ limits: { fileSize: MAX_MATERIAL_FILE_BYTES, files: MAX_MATERIAL_FILES } })) {
          if (part.type !== "file" || part.fieldname !== "files") return fail(reply, 400, "INVALID_ATTACHMENT", "multipart 只接受 files 文件字段");
          files.push({ filename: part.filename, mimetype: part.mimetype, buffer: await part.toBuffer() });
        }
        if (!files.length) return fail(reply, 400, "INVALID_ATTACHMENT", "缺少附件文件");
        parsed = await parseMaterialBatch(files);
        const conversationId = await ensureMainConversation(pool, req.person!.personId, req.params.scope);
        const stored = await storeConversationAttachments(conversationAttachmentStorageDir, conversationId, parsed.materials);
        return { attachments: stored.map(conversationAttachmentInfo) };
      } catch (error) {
        if (error instanceof MaterialParseError) return fail(reply, 400, error.code, error.message);
        const code = (error as { code?: string }).code;
        if (code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT") return fail(reply, 413, "MATERIAL_BATCH_TOO_LARGE", "附件文件或数量超出上限");
        throw error;
      } finally {
        if (parsed) await cleanupMaterialTemp(parsed.directory);
      }
    },
  );
}
