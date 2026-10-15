import { readHomeCards } from "./cards.js";
import { readMemberHome } from "./me.js";
import { buildSceneAnchor } from "../sceneAnchor.js";
import { boundedText, readableValue, type ReferenceView } from "../conversationAnchor.js";
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
import { getObjectMaterial } from "../objectMaterials.js";
import type { AppInstance, RouteContext, SessionPerson } from "./shared.js";

/** LangSmith run 名里的部分名称，按 scope 前缀取。 */
const SECTION_LABELS: Record<string, string> = {
  global: "全局", issue: "议题", signal: "信号", meeting: "会议", "monthly-plan": "月度计划", mission: "Mission",
  "mission-card": "Mission Card", "monthly-review-item": "复盘项", "personal-review": "个人复盘", task: "执行事项",
};

export function registerConversationRoutes(app: AppInstance, ctx: RouteContext): void {
  const { pool, q, env, fail, requirePerson, requestContext, runtime, conversationAttachmentStorageDir, conversationTurnTimeoutMs, peopleDirectory } = ctx;

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

  /** 一轮对话的完整流程：读写这个人在这个页面的主对话。 */
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
        if (objectType !== "issue" && objectType !== "task") return fail(reply, 404, "MATERIAL_NOT_FOUND", "材料不存在");
        try {
          const names = personDisplayNames(peopleDirectory);
          const material = await getObjectMaterial(q, { objectType, objectId }, req.body.viewingMaterialId,
            { personId: owner, role: person.role, displayName: names.get(owner) ?? owner }, names);
          if (object.snapshot) Object.assign(object.snapshot, { viewingMaterial: {
            id: material.id, fileName: material.fileName, version: material.version, editable: material.editable, canEdit: material.canEdit,
            ...(material.url ? { url: material.url } : {}) } });
        } catch { return fail(reply, 404, "MATERIAL_NOT_FOUND", "材料不存在"); }
      }
      const pageSnapshots = async () => {
        if (req.params.scope !== "global") {
          const current = await scopeObjectFor(person, req.params.scope);
          if (current.visible && current.snapshot && req.body.viewingMaterialId) {
            const [objectType, objectId] = req.params.scope.split(":", 2);
            if (objectType !== "issue" && objectType !== "task") return [];
            try {
              const names = personDisplayNames(companyMemory);
              const material = await getObjectMaterial(q, { objectType, objectId }, req.body.viewingMaterialId,
                { personId: owner, role: person.role, displayName: names.get(owner) ?? owner }, names);
              Object.assign(current.snapshot, { viewingMaterial: { id: material.id, fileName: material.fileName,
                version: material.version, editable: material.editable, canEdit: material.canEdit, ...(material.url ? { url: material.url } : {}) } });
            } catch { return []; }
          }
          return current.visible && current.snapshot ? [current.snapshot] : [];
        }
        if (person.role === "ceo") return (await readHomeCards(ctx, person)).cards.map(card => ({
          cardId: card.id, version: card.version, kind: card.kind, title: card.title, objectRef: card.objectRef, payload: card.payload,
        }));
        const home = await readMemberHome(ctx, person);
        const scopes = [...home.myTasks.map(task => `task:${task.id}`), ...home.work.missions.map(mission => `mission:${mission.id}`),
          ...home.work.missionCards.map(card => `mission-card:${card.cardId}`)];
        const projected = await Promise.all(scopes.map(scope => getScopeObject(q, scope, env.sessionSecret,
          { person, people: peopleDirectory.searchPeople(undefined), now: ctx.now() })));
        const workspaceItem = (id: string, kind: string, title: string, payload: unknown) => ({
          cardId: id, version: 1, kind, title, objectRef: { type: kind, id, version: 1 }, payload,
        });
        return [
          ...home.work.battlefields.map(field => workspaceItem(`member-battlefield:${field.id}`, "battlefield", field.name, { period: home.work.period, ...field })),
          workspaceItem("member-radar", "radar", "我的雷达", home.radar),
          workspaceItem("member-weekly-sync", "weekly-sync", "本周同步", home.weeklySync),
          ...projected.flatMap(result => result.visible && result.snapshot ? [result.snapshot] : []),
        ];
      };
      let anchor;
      try {
        anchor = await buildSceneAnchor({ scene: req.params.scope === "global" ? (person.role === "ceo" ? "公司首页" : "我的工作台") : "对象详情",
          selection: req.body.anchorSelection, list: pageSnapshots });
      } catch (error) {
        const cause = error as { status?: number; code?: string; message: string };
        if (cause.status) return fail(reply, cause.status, cause.code!, cause.message);
        throw error;
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
        let row: { id: string; pi_session_id: string; runtime_entries: unknown[]; context_schema_version?:number; memory_epoch:number; memory_history_cutoff:number };
        const existing = await client.query<{ id: string; pi_session_id: string; runtime_entries: unknown[]; context_schema_version?:number; memory_epoch:number; memory_history_cutoff:number }>(
          "SELECT id, pi_session_id, runtime_entries, context_schema_version, memory_epoch, memory_history_cutoff FROM conversations WHERE owner_id = $1 AND scope = $2 AND deleted_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1",
          [owner, req.params.scope],
        );
        if (existing.rows[0]) {
          row = existing.rows[0];
        } else {
          row = { id: randomUUID(), pi_session_id: randomUUID(), runtime_entries: [], memory_epoch:0, memory_history_cutoff:0 };
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
        const turnReferences: ReferenceView[] = [
          ...references.snapshots.map((snapshot, index) => ({ handle: `R${index + 1}`, kind: "explicit" as const, title: snapshot.title,
            text: boundedText(JSON.stringify(readableValue(snapshot.payload)), 4096), state: "本地页面引用" })),
          ...attachments.map((attachment, index) => ({ handle: `R${references.snapshots.length + index + 1}`, kind: "attachment" as const,
            title: attachment.fileName, text: boundedText(attachment.extractedText, 4096) })),
        ];
        let referenceBytes = 0;
        const boundedReferences = turnReferences.filter(reference => { referenceBytes += Buffer.byteLength(JSON.stringify(reference)); return referenceBytes <= 24576; });
        const readReference = async ({ handle, cursor }: { handle: string; cursor?: string }) => {
          const index = turnReferences.findIndex(reference => reference.handle === handle);
          if (index < 0) return { unavailable: true, message: "参考项不存在" };
          let offset = 0;
          if (cursor) {
            const prefix = `${runId}:${handle}:`;
            if (!cursor.startsWith(prefix) || !/^\d+$/.test(cursor.slice(prefix.length))) return { unavailable: true, message: "参考游标已失效" };
            offset = Number(cursor.slice(prefix.length));
          }
          let fullText: string;
          if (index < references.snapshots.length) {
            const snapshot = references.snapshots[index];
            const latest = await resolveReferenceSnapshots(q, [{ cardId: snapshot.cardId, version: snapshot.version }], env.sessionSecret, person);
            if (!("snapshots" in latest)) return { unavailable: true, message: "参考内容已更新或不可见" };
            fullText = JSON.stringify(readableValue(latest.snapshots[0].payload));
          } else {
            const attachment = attachments[index - references.snapshots.length];
            try {
              const [latest] = await loadConversationAttachments(conversationAttachmentStorageDir, row.id, [attachment.id]);
              if (latest.sha256 !== attachment.sha256) return { unavailable: true, message: "附件内容已变化" };
              fullText = latest.extractedText;
            } catch { return { unavailable: true, message: "附件已不可用" }; }
          }
          const text = boundedText(fullText.slice(offset), 6000);
          const next = offset + text.length;
          return { handle, title: turnReferences[index].title, kind: turnReferences[index].kind, text,
            more: next < fullText.length, ...(next < fullText.length ? { cursor: `${runId}:${handle}:${next}` } : {}) };
        };
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
            WHERE conversation_id = $1 AND run_id <> $2 AND sequence > $3
            ORDER BY sequence DESC LIMIT 20`,
          [row.id, runId, row.memory_history_cutoff],
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

        const personalReferences = await ctx.personalMemory.select(owner, req.body.message).catch((error:unknown) => {
          app.log.error({code:(error as {code?:string}).code}, "personal memory reference unavailable");
          return [];
        });
        const timeout = setTimeout(() => {
          abort.abort(Object.assign(new Error("Conversation turn exceeded 180 seconds"), { code: "TURN_TIMEOUT" }));
        }, conversationTurnTimeoutMs);
        timeout.unref();
        try {
          const result = await runtime.run({
            scope: req.params.scope,
            runId,
            viewer: { personId: owner, displayName: personDisplayNames(peopleDirectory).get(owner) ?? owner, role: person.role },
            message: req.body.message,
            anchor,
            references: [...boundedReferences, ...personalReferences].filter((reference, index, all) => all.slice(0, index + 1).reduce((bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item)), 0) <= 24576),
            readReference,
            currentObject: object.snapshot,
            referencesSnapshot: references.snapshots,
            recentMessages: recent.rows.reverse().map((message) => ({
              role: message.role,
              content: message.content,
              createdAt: message.created_at.toISOString(),
            })),
            runtimeEntries: row.context_schema_version === 2 ? row.runtime_entries : [],
            rebuildFromRaw: row.context_schema_version !== 2 && recent.rows.length > 0,
            piSessionId: row.pi_session_id,
            signal: abort.signal,
            emit,
            checkpoint: async (runtimeEntries) => {
              await client.query(
                "UPDATE conversations SET runtime_entries = $2::jsonb, context_schema_version = 2, runtime_updated_at = now() WHERE id = $1 AND memory_epoch = $3",
                [row.id, JSON.stringify(runtimeEntries), row.memory_epoch],
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
                  SET runtime_entries = CASE WHEN memory_epoch=$6 THEN $2::jsonb ELSE '[]'::jsonb END,
                      context_schema_version = 2,
                      pi_session_id = CASE WHEN memory_epoch=$6 THEN $3 ELSE pi_session_id END,
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
                row.memory_epoch,
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
            const errorCode = (err as { code?: string }).code;
            const code = errorCode && ["SEARCH_BUDGET_EXHAUSTED", "TURN_CONTEXT_TOO_LARGE", "CURRENT_QUERY_MISMATCH"].includes(errorCode) ? errorCode : "RUNTIME_FAILED";
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
        const section = req.params.scope.split(":", 1)[0];
        void recordAgentTrace({
          runId,
          name: `对话·${SECTION_LABELS[section] ?? section}`,
          agentKind: "conversation",
          promptHash: runtime.promptHash,
          objectRef: object.snapshot?.objectRef ?? { type: "global", id: "global" },
          personId: owner,
          personName: personDisplayNames(peopleDirectory).get(owner),
          threadId: row.id,
          metadata: { section, scope: req.params.scope, object_title: object.snapshot?.title },
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
