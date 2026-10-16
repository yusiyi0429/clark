import { createHash, randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { Type } from "@sinclair/typebox";
import {
  ConversationMessageRequest,
  ConversationScope,
  type TConversationAttachment,
  type TConversationMessageRequest,
  type TConversationScope,
} from "@warmap/contracts";
import {
  ACTIVE_CONVERSATION_WHERE,
  CONVERSATION_IDLE_RESTART_MS,
  conversationAttachmentInfo,
  ensureMainConversation,
  getArchivedConversationHistory,
  getConversationHistory,
  listArchivedConversations,
  switchConversation,
  getScopeObject,
  loadConversationAttachments,
  resolveReferenceSnapshots,
  storeConversationAttachments,
} from "../conversations.js";
import { AGENT_ROLES, anonUserId, conversationScope, conversationThreadId, conversationTurnId, preview, tracedTurn } from "../tracing.js";
import { MAX_MATERIAL_FILES, MAX_MATERIAL_FILE_BYTES, MaterialParseError, cleanupMaterialTemp, parseMaterialBatch } from "../materialParser.js";
import { logEvent } from "../observability.js";
import { personDisplayNames } from "../people.js";
import { getIssueRow } from "../issues.js";
import { getMeetingRow } from "../meetingStore.js";
import { projectMemberIssueCard, projectMemberMeetingCard } from "../memberCards.js";
import { isActiveMember } from "../threads.js";
import { getObjectMaterial } from "../objectMaterials.js";
import { withNotice } from "../conversationRouting.js";
import { ConversationTurnError, recoveryNote, resumeInstruction, shortFailureReason, turnFailureCopy, type TurnFailureKind, type TurnRecoverySummary } from "../conversationRecovery.js";
import { personalMemoryToolsFor } from "../personalMemory.js";
import { searchOwnConversationHistory } from "../conversationHistorySearch.js";
import type { AppInstance, RouteContext, SessionPerson } from "./shared.js";

export function registerConversationRoutes(app: AppInstance, ctx: RouteContext): void {
  const { pool, q, env, fail, requirePerson, requestContext, runtime, companyMemory, conversationAttachmentStorageDir, conversationTurnTimeoutMs, conversationStallTimeoutMs, conversationHeartbeatMs, conversationCompaction } = ctx;

  const conversationParams = Type.Object({ scope: ConversationScope }, { additionalProperties: false });
  const archivedParams = Type.Object({ scope: ConversationScope, id: Type.String({ format: "uuid" }) }, { additionalProperties: false });
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
      ? getScopeObject(q, scope, env.sessionSecret, { person, people: companyMemory.searchPeople(undefined), now: ctx.now() })
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

  /**
   * 新建对话：当前对话有内容就归档（不删除，能回看、能切回去继续），之后的消息进一条空白对话。
   * 一轮回答还没结束时不切（409）。当前对话本来就是空的就什么都不做。
   */
  app.post(
    "/api/conversations/:scope/new",
    { preHandler: requirePerson, schema: { params: conversationParams } },
    async (req, reply) => {
      if (!await conversationScopeVisible(req.person!, req.params.scope)) return fail(reply, 404, "CONVERSATION_SCOPE_NOT_FOUND", "Conversation scope 不存在");
      const result = await switchConversation(pool, req.person!.personId, req.params.scope);
      if (result.status === "busy") return fail(reply, 409, "TURN_IN_PROGRESS", "上一轮回答还没结束，请等它写完或点「停止」后再新建对话。");
      if (result.status !== "ok") return fail(reply, 404, "CONVERSATION_NOT_FOUND", "对话不存在");
      logEvent({ event: "conversation.new", requestId: String(req.id), scope: req.params.scope, archived: result.archived });
      return { conversationId: result.conversationId, archived: result.archived };
    },
  );

  /** 历史对话列表（新归档的在前），只有本人在这个页面归档、有内容的。 */
  app.get(
    "/api/conversations/:scope/archived",
    { preHandler: requirePerson, schema: { params: conversationParams } },
    async (req, reply) => {
      if (!await conversationScopeVisible(req.person!, req.params.scope)) return fail(reply, 404, "CONVERSATION_SCOPE_NOT_FOUND", "Conversation scope 不存在");
      return listArchivedConversations(q, req.person!.personId, req.params.scope);
    },
  );

  /** 只读回看一段历史对话。 */
  app.get(
    "/api/conversations/:scope/archived/:id/messages",
    { preHandler: requirePerson, schema: { params: archivedParams } },
    async (req, reply) => {
      if (!await conversationScopeVisible(req.person!, req.params.scope)) return fail(reply, 404, "CONVERSATION_SCOPE_NOT_FOUND", "Conversation scope 不存在");
      const history = await getArchivedConversationHistory(q, req.person!.personId, req.params.scope, req.params.id);
      return history ?? fail(reply, 404, "CONVERSATION_NOT_FOUND", "这段历史对话找不到了");
    },
  );

  /** 切回一段历史对话继续：当前对话归档，这一段成为当前对话。 */
  app.post(
    "/api/conversations/:scope/archived/:id/restore",
    { preHandler: requirePerson, schema: { params: archivedParams } },
    async (req, reply) => {
      if (!await conversationScopeVisible(req.person!, req.params.scope)) return fail(reply, 404, "CONVERSATION_SCOPE_NOT_FOUND", "Conversation scope 不存在");
      const result = await switchConversation(pool, req.person!.personId, req.params.scope, req.params.id);
      if (result.status === "busy") return fail(reply, 409, "TURN_IN_PROGRESS", "上一轮回答还没结束，请等它写完或点「停止」后再切换。");
      if (result.status !== "ok") return fail(reply, 404, "CONVERSATION_NOT_FOUND", "这段历史对话找不到了");
      logEvent({ event: "conversation.restore", requestId: String(req.id), scope: req.params.scope, archived: result.archived });
      return { conversationId: result.conversationId, archived: result.archived };
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
      if (req.body.viewingMaterialId) {
        const [objectType, objectId] = req.params.scope.split(":", 2);
        if (objectType !== "issue" && objectType !== "task" && objectType !== "meeting") return fail(reply, 404, "MATERIAL_NOT_FOUND", "材料不存在");
        try {
          const names = personDisplayNames(companyMemory);
          const material = await getObjectMaterial(q, { objectType, objectId }, req.body.viewingMaterialId,
            { personId: owner, role: person.role, displayName: names.get(owner) ?? owner }, names);
          if (object.snapshot) Object.assign(object.snapshot, { viewingMaterial: {
            id: material.id, fileName: material.fileName, version: material.version, editable: material.editable, canEdit: material.canEdit,
            ...(material.url ? { url: material.url } : {}) } });
        } catch { return fail(reply, 404, "MATERIAL_NOT_FOUND", "材料不存在"); }
      }
      // 成员在 2a 看不到任何 Card，也不能借显式引用把 Card 带进自己的 Agent。
      if (person.role !== "ceo" && req.body.references?.length) return fail(reply, 404, "REFERENCE_NOT_FOUND", "Card 引用不存在");
      const references = await resolveReferenceSnapshots(q, req.body.references ?? [], env.sessionSecret, person);
      if (!("snapshots" in references)) {
        return fail(reply, references.status, references.code, references.message);
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
          const previous = await client.query<{ input_snapshot: { conversationId?: string; message?: string; route?: { tier?: string }; partial?: boolean } }>(
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
             (conversation_id, sequence, role, content, references_snapshot, attachments, run_id)
           VALUES ($1, $2, 'user', $3, $4::jsonb, $5::jsonb, $6)`,
          [row.id, userSequence, req.body.message, JSON.stringify(references.snapshots), JSON.stringify(attachments), runId],
        );
        // 个人记忆：任何页面都读本人的记忆；后台提炼按游标增量跑（personalDistillation.ts），这里不排任务。
        // 「记住」「忘掉」「改成」由主 Agent 调工具完成，不在主回答之前同步跑提炼：记忆改动失败只是工具报错，不替换回答、不动上下文（3c）。
        // 当前页面对象就是这一轮的 anchor：检索时只比对象、不比版本；钉住的版本比现在旧时标「基于旧版本」（R8）。
        const objectRef = object.snapshot?.objectRef;
        const currentObject = objectRef ? { target: `${objectRef.type}:${objectRef.id}`, version: objectRef.version } : undefined;
        const personalMemory = await ctx.personalMemory.select(owner, req.body.message, { currentObject }, client)
          .then((entries) => entries.map(({ id, title, text, createdAt, basedOnOldVersion }) => ({ id, title, text, createdAt, ...(basedOnOldVersion ? { basedOnOldVersion } : {}) })), (error: unknown) => {
            logEvent({ event: "personal_memory.unavailable", requestId: String(req.id), runId, scope: req.params.scope, errorCode: (error as { code?: string })?.code ?? "PERSONAL_MEMORY_UNAVAILABLE" });
            return [];
          });
        // 主 Agent 记下的条目：依据是本轮这句原话，anchor 是当前页面对象（钉住此刻的版本）。
        const personalMemoryTools = personalMemoryToolsFor(ctx.personalMemory, owner, (event) =>
          logEvent({ ...event, requestId: String(req.id), runId, scope: req.params.scope }), {
          reference: { ref: `chat:${row.id}#${userSequence}`, quote: req.body.message.slice(0, 500), at: new Date().toISOString() },
          anchors: currentObject ? [{ target: currentObject.target, ...(typeof currentObject.version === "number" ? { pinnedVersion: currentObject.version } : {}) }] : [],
        });
        const recent = await client.query<{ role: "user" | "assistant"; content: string; created_at: Date }>(
          `SELECT role, content, created_at
             FROM conversation_messages
            WHERE conversation_id = $1 AND run_id <> $2
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
          if (reply.raw.destroyed) return;
          const data = { ...event, runId, scope: req.params.scope, sequence: ++eventSequence };
          reply.raw.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        // 整轮卡住检测（最后一道）：模型调用自己的卡住会就地恢复并发 recovery 事件；这里只在连恢复都没有进展时停下。
        const stall = setInterval(() => {
          if (compacting || Date.now() - lastEventAt < conversationStallTimeoutMs || abort.signal.aborted) return;
          abort.abort(Object.assign(new Error(`Conversation stalled for ${Math.round(conversationStallTimeoutMs / 1000)} seconds`), { code: "TURN_STALLED" }));
        }, Math.min(5_000, Math.max(5, Math.floor(conversationStallTimeoutMs / 4))));
        stall.unref();
        /** 运行记录里这一轮的档位与恢复：原模型、备用模型、触发原因、各类恢复次数、合计重试次数（没有恢复过就没有 recovery）。 */
        const routeSnapshot = (partial?: boolean, summary?: TurnRecoverySummary) => JSON.stringify({ route: { tier: routeTier ?? null, model: routeModel ?? null, recoveries,
          ...(summary ? { recovery: { originalModel: summary.originalModel, fallbackModel: summary.fallbackModel ?? null, reasons: summary.reasons,
            actions: summary.actions, retries: summary.retries } } : {}) },
          ...(partial === undefined ? {} : { partial }) });
        let recoverySummary: TurnRecoverySummary | undefined;
        /**
         * 这一轮没完成（出错、超时、卡住、一号位停止或关掉页面）：已写出的部分连同开场说明存成这一轮的回答，末尾一行说明；
         * 运行时给了这一轮的模型历史就一并存下（下一轮或「继续」接得上）。存档失败不影响给界面发说明。
         */
        const settleFailure = async (kind: TurnFailureKind, raw: string, cause?: unknown) => {
          const partial = streamedBody.trim().length > 0;
          const copy = turnFailureCopy(kind, { partial, recoveries, stallSeconds: Math.max(1, Math.round(conversationStallTimeoutMs / 1000)), capMinutes: Math.max(1, Math.round(conversationTurnTimeoutMs / 60_000)) });
          const stopped = kind === "aborted";
          const note = stopped
            ? "（已停止，以上是停止前写出的部分。）"
            : !partial ? `（这次回答没有完成：${shortFailureReason(kind)}。）`
            : kind === "turn_timeout" ? `（回答持续了 ${Math.max(1, Math.round(conversationTurnTimeoutMs / 60_000))} 分钟仍未写完，以上是已写出的部分。）`
            : "（这次回答在这里中断了，以上是已经写出的部分。）";
          let saved = false;
          if (partial || !stopped) {
            const content = withNotice(notice, partial ? `${streamedBody.trimEnd()}\n\n${note}` : note);
            saved = await client.query(
              `INSERT INTO conversation_messages (conversation_id, sequence, role, content, references_snapshot, run_id)
               VALUES ($1, $2, 'assistant', $3, '[]'::jsonb, $4)`,
              [row.id, userSequence + 1, content, runId],
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
            [runId, stopped || abort.signal.aborted ? "aborted" : "failed", raw, JSON.stringify(runUsage), routeSnapshot(partial && saved, recoverySummary)],
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
            viewer: { personId: owner, displayName: personDisplayNames(companyMemory).get(owner) ?? owner, role: person.role },
            message: runtimeMessage,
            currentObject: object.snapshot,
            referencesSnapshot: references.snapshots,
            ...(personalMemory.length ? { personalMemory } : {}),
            personalMemoryTools,
            // 本人历史对话原文检索（3e）：跨所有页面与归档，只查本人，本轮这条不算。
            searchHistory: (query: string) => searchOwnConversationHistory(q, { personId: owner, query, excludeRunId: runId }),
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
            const note = recoveryNote(recoverySummary);
            await client.query("BEGIN");
            await client.query(
              `INSERT INTO conversation_messages
                 (conversation_id, sequence, role, content, references_snapshot, run_id, recovery_note)
               VALUES ($1, $2, 'assistant', $3, '[]'::jsonb, $4, $5::jsonb)`,
              [row.id, userSequence + 1, result.assistantMessage, runId, note ? JSON.stringify(note) : null],
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
              [runId, JSON.stringify({ assistantMessage: result.assistantMessage }), JSON.stringify(runUsage), routeSnapshot(undefined, recoverySummary)],
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
