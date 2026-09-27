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
  conversationAttachmentInfo,
  ensureMainConversation,
  getConversationHistory,
  getScopeObject,
  loadConversationAttachments,
  resolveReferenceSnapshots,
  storeConversationAttachments,
} from "../conversations.js";
import { recordAgentTrace } from "../langsmith.js";
import { MAX_MATERIAL_FILES, MAX_MATERIAL_FILE_BYTES, MaterialParseError, cleanupMaterialTemp, parseMaterialBatch } from "../materialParser.js";
import { logEvent } from "../observability.js";
import { personDisplayNames } from "../people.js";
import { getIssueRow } from "../issues.js";
import { getMeetingRow } from "../meetingStore.js";
import { projectMemberIssueCard, projectMemberMeetingCard } from "../memberCards.js";
import { isActiveMember } from "../threads.js";
import type { AppInstance, RouteContext, SessionPerson } from "./shared.js";

export function registerConversationRoutes(app: AppInstance, ctx: RouteContext): void {
  const { pool, q, env, fail, requirePerson, requestContext, runtime, companyMemory, conversationAttachmentStorageDir, conversationTurnTimeoutMs } = ctx;

  const conversationParams = Type.Object({ scope: ConversationScope }, { additionalProperties: false });
  // 我的 Agent 按「人 × 页面」私有；个人卡 scope 始终复查对象成员及当前拍板权。
  const scopeObjectFor = async (person: SessionPerson, scope: TConversationScope) => {
    if (person.role !== "ceo" && (scope.startsWith("issue:") || scope.startsWith("meeting:"))) {
      const [objectType, objectId] = scope.split(":", 2) as ["issue" | "meeting", string];
      if (!await isActiveMember(q, { objectType, objectId }, person.personId)) return { snapshot: null, visible: false };
      const card = objectType === "issue"
        ? await getIssueRow(q, objectId).then((row) => row && projectMemberIssueCard(row, env.sessionSecret))
        : await getMeetingRow(q, objectId).then((row) => row && projectMemberMeetingCard(row, env.sessionSecret));
      if (!card) return { snapshot: null, visible: false };
      return { visible: true, snapshot: { cardId: card.id, version: card.version, kind: card.kind, title: card.title,
        objectRef: card.objectRef, payload: card.payload } };
    }
    return person.role === "ceo" || scope === "global" || scope.startsWith("mission-card:") || scope.startsWith("task:")
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

  /** 一轮对话的完整流程：读写这个人在这个页面的主对话。 */
  const sendConversationTurn = async (
    req: FastifyRequest<{ Params: { scope: TConversationScope }; Body: TConversationMessageRequest }>,
    reply: FastifyReply,
  ): Promise<void> => {
      const person = req.person!;
      const owner = person.personId;
      const object = await scopeObjectFor(person, req.params.scope);
      if (!object.visible) return fail(reply, 404, "CONVERSATION_SCOPE_NOT_FOUND", "Conversation scope 不存在");
      // 成员在 2a 看不到任何 Card，也不能借显式引用把 Card 带进自己的 Agent。
      if (person.role !== "ceo" && req.body.references?.length) return fail(reply, 404, "REFERENCE_NOT_FOUND", "Card 引用不存在");
      const references = await resolveReferenceSnapshots(q, req.body.references ?? [], env.sessionSecret);
      if (!("snapshots" in references)) {
        return fail(reply, references.status, references.code, references.message);
      }

      // 锁按「人 × scope」：不同的人在同一页面不会互相挡住。
      const lockKey = `${owner}|${req.params.scope}`;
      const client = await pool.connect();
      const locked = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [lockKey]);
      if (!locked.rows[0]?.locked) {
        client.release();
        return fail(reply, 409, "TURN_IN_PROGRESS", "该 Conversation 正在运行");
      }

      let scopeLockHeld = true;
      const runId = randomUUID();
      requestContext.set(req, { runId, scope: req.params.scope });
      const runStartedAt = Date.now();
      const abort = new AbortController();
      let streamFinished = false;
      let eventSequence = 0;
      const runToolEvents: { name: string; isError?: boolean }[] = [];
      let runStatus = "aborted";
      let runError: string | undefined;
      let runOutput: unknown;
      try {
        // 主对话 = 这个人最早未删除的会话；不存在则在锁内惰性创建。
        let row: { id: string; pi_session_id: string; runtime_entries: unknown[] };
        const existing = await client.query<{ id: string; pi_session_id: string; runtime_entries: unknown[] }>(
          "SELECT id, pi_session_id, runtime_entries FROM conversations WHERE owner_id = $1 AND scope = $2 AND deleted_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1",
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
        const next = await client.query<{ sequence: number }>(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
             FROM conversation_messages WHERE conversation_id = $1`,
          [row.id],
        );
        const userSequence = next.rows[0].sequence;
        await client.query(
          `INSERT INTO conversation_messages
             (conversation_id, sequence, role, content, references_snapshot, attachments, run_id)
           VALUES ($1, $2, 'user', $3, $4::jsonb, $5::jsonb, $6)`,
          [row.id, userSequence, req.body.message, JSON.stringify(references.snapshots), JSON.stringify(attachments), runId],
        );
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
              message: req.body.message,
              currentObject: object.snapshot,
              references: references.snapshots,
              attachments: attachments.map(conversationAttachmentInfo),
            }),
          ],
        );

        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        reply.raw.on("close", () => {
          if (!streamFinished) abort.abort(Object.assign(new Error("Conversation client disconnected"), { code: "CLIENT_DISCONNECTED" }));
        });
        let runUsage: Record<string, unknown> | null = null;
        const emit = (event: Record<string, unknown>) => {
          if (event.type === "usage") {
            const { type: _type, ...usage } = event;
            runUsage = usage;
          }
          if (event.type === "tool" && event.phase === "completed") {
            runToolEvents.push({ name: String(event.name), isError: event.isError === true });
          }
          if (reply.raw.destroyed) return;
          const data = { ...event, runId, scope: req.params.scope, sequence: ++eventSequence };
          reply.raw.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        const timeout = setTimeout(() => {
          abort.abort(Object.assign(new Error("Conversation turn exceeded 180 seconds"), { code: "TURN_TIMEOUT" }));
        }, conversationTurnTimeoutMs);
        timeout.unref();
        try {
          const result = await runtime.run({
            scope: req.params.scope,
            viewer: { personId: owner, displayName: personDisplayNames(companyMemory).get(owner) ?? owner, role: person.role },
            message: runtimeMessage,
            currentObject: object.snapshot,
            referencesSnapshot: references.snapshots,
            recentMessages: recent.rows.reverse().map((message) => ({
              role: message.role,
              content: message.content,
              createdAt: message.created_at.toISOString(),
            })),
            runtimeEntries: row.runtime_entries,
            piSessionId: row.pi_session_id,
            signal: abort.signal,
            emit,
            checkpoint: async (runtimeEntries) => {
              await client.query(
                "UPDATE conversations SET runtime_entries = $2::jsonb, runtime_updated_at = now() WHERE id = $1",
                [row.id, JSON.stringify(runtimeEntries)],
              );
            },
          });
          if (abort.signal.aborted) {
            const reason = abort.signal.reason as { code?: string; message?: string } | undefined;
            await client.query(
              "UPDATE agent_runs SET status = 'aborted', error = $2, usage = $3::jsonb, completed_at = now() WHERE id = $1",
              [runId, reason?.message ?? "Conversation aborted", JSON.stringify(runUsage)],
            );
            runError = reason?.message ?? "Conversation aborted";
            if (reason?.code === "TURN_TIMEOUT") emit({ type: "error", code: "TURN_TIMEOUT", message: reason.message });
            else emit({ type: "done", status: "aborted" });
          } else {
            await client.query("BEGIN");
            await client.query(
              `INSERT INTO conversation_messages
                 (conversation_id, sequence, role, content, references_snapshot, run_id)
               VALUES ($1, $2, 'assistant', $3, '[]'::jsonb, $4)`,
              [row.id, userSequence + 1, result.assistantMessage, runId],
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
                  SET status = 'succeeded', candidate_output = $2::jsonb, usage = $3::jsonb, completed_at = now()
                WHERE id = $1`,
              [runId, JSON.stringify({ assistantMessage: result.assistantMessage }), JSON.stringify(runUsage)],
            );
            await client.query("COMMIT");
            runStatus = "succeeded";
            runOutput = { assistantMessage: result.assistantMessage };
            emit({ type: "done", status: "completed" });
          }
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          const reason = abort.signal.reason as { code?: string; message?: string } | undefined;
          await client.query(
            "UPDATE agent_runs SET status = $2, error = $3, usage = $4::jsonb, completed_at = now() WHERE id = $1",
            [
              runId,
              abort.signal.aborted ? "aborted" : "failed",
              reason?.message ?? (err as Error).message ?? "Pi Runtime 失败",
              JSON.stringify(runUsage),
            ],
          );
          runStatus = abort.signal.aborted ? "aborted" : "failed";
          runError = reason?.message ?? (err as Error).message ?? "Pi Runtime 失败";
          if (reason?.code === "TURN_TIMEOUT") {
            emit({ type: "error", code: "TURN_TIMEOUT", message: reason.message ?? "Conversation turn exceeded 180 seconds" });
          } else if (!abort.signal.aborted) {
            const code = (err as { code?: string }).code === "SEARCH_BUDGET_EXHAUSTED"
              ? "SEARCH_BUDGET_EXHAUSTED"
              : "RUNTIME_FAILED";
            emit({ type: "error", code, message: (err as Error).message || "Pi Runtime 失败" });
          }
        } finally {
          clearTimeout(timeout);
        }
        const durationMs = Date.now() - runStartedAt;
        const provider = "warmap";
        const model = runtime.modelId ?? env.lightModel;
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
        });
        void recordAgentTrace({
          runId,
          name: "conversation",
          agentKind: "conversation",
          promptHash: runtime.promptHash,
          objectRef: object.snapshot?.objectRef ?? { type: "global", id: "global" },
          inputs: { message: req.body.message, currentObject: object.snapshot, references: references.snapshots },
          outputs: runOutput,
          toolEvents: runToolEvents,
          usage: runUsage,
          error: runError,
          status: runStatus,
          startedAt: runStartedAt,
          durationMs,
        });
        streamFinished = true;
        // Fastify inject/browser may observe SSE end before this function's finally runs.
        // Release first so an immediate next turn/delete cannot spuriously see TURN_IN_PROGRESS.
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => undefined);
        scopeLockHeld = false;
        reply.raw.end();
      } finally {
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
