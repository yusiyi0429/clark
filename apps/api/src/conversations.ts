import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { QueryResult } from "pg";
import type {
  TCardReference,
  TConversationAttachment,
  TConversationAttachmentInfo,
  TConversationHistory,
  TConversationScope,
  TConversationSessionSummary,
  TReferenceSnapshot,
} from "@warmap/contracts";
import type { ParsedMaterial } from "./materialParser.js";
import { getIssueRow, projectIssueCard } from "./issues.js";
import { moveStagedFile } from "./meetingMaterials.js";
import { getMeetingRow, projectMeetingCard } from "./meetingStore.js";
import { getMonthlyPlanRow, projectMonthlyPlanCard } from "./monthlyPlans.js";
import { getSignalCard } from "./signals.js";

export type ConversationRuntimeEvent =
  | { type: "message"; delta: string }
  | { type: "warning"; code: "RUNTIME_RECREATED"; message: string }
  | { type: "compaction"; phase: "started" | "completed" }
  | { type: "tool"; phase: "started" | "completed"; toolCallId: string; name: string; isError?: boolean }
  | { type: "usage"; input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };

export type ConversationRuntime = {
  promptHash?: string;
  modelSlot?: string;
  /** Provider 模型 id，只用于日志/trace，不进入业务状态。 */
  modelId?: string;
  run(input: {
    scope: TConversationScope;
    message: string;
    currentObject: TReferenceSnapshot | null;
    referencesSnapshot: TReferenceSnapshot[];
    recentMessages?: { role: "user" | "assistant"; content: string; createdAt: string }[];
    runtimeEntries: unknown[];
    piSessionId: string;
    signal: AbortSignal;
    emit: (event: ConversationRuntimeEvent) => void;
    checkpoint?: (runtimeEntries: unknown[]) => Promise<void>;
  }): Promise<{
    assistantMessage: string;
    runtimeEntries: unknown[];
    piSessionId?: string;
    recovery?: { recreated: true; warning: string };
  }>;
  close?(): Promise<void>;
};

type Query = (sql: string, params?: unknown[]) => Promise<QueryResult>;

export async function getScopeObject(
  q: Query,
  scope: TConversationScope,
  secret: string,
): Promise<{ snapshot: TReferenceSnapshot | null; visible: boolean }> {
  if (scope === "global") return { snapshot: null, visible: true };
  const [objectType, id] = scope.split(":", 2);
  const issue = objectType === "issue" ? await getIssueRow(q, id) : null;
  if (issue) {
    const card = projectIssueCard(issue, secret);
    return {
      visible: true,
      snapshot: {
        cardId: card.id,
        version: card.version,
        kind: card.kind,
        title: card.title,
        objectRef: card.objectRef,
        payload: card.payload,
      },
    };
  }
  const meeting = objectType === "meeting" ? await getMeetingRow(q, id) : null;
  if (meeting) {
    const card = projectMeetingCard(meeting, secret);
    const linkedIssues = (await Promise.all(meeting.issue_ids.map((issueId) => getIssueRow(q, issueId))))
      .flatMap((row) => {
        if (!row) return [];
        const issueCard = projectIssueCard(row, secret);
        return [{
          cardId: issueCard.id,
          version: issueCard.version,
          kind: issueCard.kind,
          title: issueCard.title,
          objectRef: issueCard.objectRef,
          payload: issueCard.payload,
        }];
      });
    return {
      visible: true,
      snapshot: {
        cardId: card.id,
        version: card.version,
        kind: card.kind,
        title: card.title,
        objectRef: card.objectRef,
        // Meeting 对话自动获得本场预审和关联 Issue；无需 Web 伪造引用快照。
        payload: { ...(card.payload as Record<string, unknown>), linkedIssues },
      },
    };
  }
  const monthlyPlan = objectType === "monthly-plan" ? await getMonthlyPlanRow(q, id) : null;
  if (monthlyPlan) {
    const card = projectMonthlyPlanCard(monthlyPlan, secret);
    return {
      visible: true,
      snapshot: {
        cardId: card.id,
        version: card.version,
        kind: card.kind,
        title: card.title,
        objectRef: card.objectRef,
        payload: card.payload,
      },
    };
  }
  const signal = objectType === "signal" ? await getSignalCard(q, id) : null;
  if (signal) {
    return {
      visible: true,
      snapshot: {
        cardId: signal.id,
        version: signal.version,
        kind: signal.kind,
        title: signal.title,
        objectRef: signal.objectRef,
        payload: signal.payload,
      },
    };
  }
  return { snapshot: null, visible: false };
}

export async function resolveReferenceSnapshots(
  q: Query,
  references: TCardReference[],
  secret: string,
): Promise<
  | { snapshots: TReferenceSnapshot[] }
  | { status: 403 | 404 | 409; code: string; message: string }
> {
  const snapshots: TReferenceSnapshot[] = [];
  for (const reference of references) {
    const [objectType, id, extra] = reference.cardId.split(":");
    // Signal 内容经 scope 快照进入对话上下文；Signal Card 不作为显式引用对象（CEO 2026-09-21 裁决）。
    if (extra || !["issue", "meeting", "monthly-plan"].includes(objectType)) {
      return { status: 404, code: "REFERENCE_NOT_FOUND", message: "Card 引用不存在" };
    }
    const issue = objectType === "issue" ? await getIssueRow(q, id) : null;
    if (issue) {
      const card = projectIssueCard(issue, secret);
      if (card.version !== reference.version) {
        return { status: 409, code: "REFERENCE_VERSION_CONFLICT", message: "Card 引用版本已过期" };
      }
      snapshots.push({
        cardId: card.id,
        version: card.version,
        kind: card.kind,
        title: card.title,
        objectRef: card.objectRef,
        payload: card.payload,
      });
      continue;
    }
    const meeting = objectType === "meeting" ? await getMeetingRow(q, id) : null;
    if (meeting) {
      const card = projectMeetingCard(meeting, secret);
      if (card.version !== reference.version) {
        return { status: 409, code: "REFERENCE_VERSION_CONFLICT", message: "Card 引用版本已过期" };
      }
      snapshots.push({
        cardId: card.id,
        version: card.version,
        kind: card.kind,
        title: card.title,
        objectRef: card.objectRef,
        payload: card.payload,
      });
      continue;
    }
    const monthlyPlan = objectType === "monthly-plan" ? await getMonthlyPlanRow(q, id) : null;
    if (monthlyPlan) {
      const card = projectMonthlyPlanCard(monthlyPlan, secret);
      if (card.version !== reference.version) {
        return { status: 409, code: "REFERENCE_VERSION_CONFLICT", message: "Card 引用版本已过期" };
      }
      snapshots.push({
        cardId: card.id,
        version: card.version,
        kind: card.kind,
        title: card.title,
        objectRef: card.objectRef,
        payload: card.payload,
      });
      continue;
    }
    return { status: 404, code: "REFERENCE_NOT_FOUND", message: "Card 引用不存在" };
  }
  return { snapshots };
}

export async function getConversationHistory(q: Query, scope: TConversationScope): Promise<TConversationHistory> {
  // legacy 路由：只读默认会话（最早未删除），不合并其他会话的消息。
  const conversation = await q(
    "SELECT id FROM conversations WHERE scope = $1 AND deleted_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1",
    [scope],
  );
  const conversationId = conversation.rows[0]?.id as string | undefined;
  if (!conversationId) return { scope, messages: [] };
  const result = await q(
    `SELECT m.sequence, m.role, m.content, m.references_snapshot, m.attachments, m.run_id, m.created_at
       FROM conversation_messages m
      WHERE m.conversation_id = $1
      ORDER BY m.sequence`,
    [conversationId],
  );
  return {
    scope,
    messages: result.rows.map((row) => ({
      sequence: row.sequence as number,
      role: row.role as "user" | "assistant",
      content: row.content as string,
      referencesSnapshot: row.references_snapshot,
      attachments: (row.attachments as TConversationAttachment[]).map(conversationAttachmentInfo),
      runId: row.run_id as string,
      createdAt: (row.created_at as Date).toISOString(),
    })),
  };
}

/** 会话行：scope 匹配且未删除才算存在。 */
export async function getConversationSession(
  q: Query,
  scope: TConversationScope,
  sessionId: string,
): Promise<{ id: string } | null> {
  const result = await q(
    "SELECT id FROM conversations WHERE id = $1::uuid AND scope = $2 AND deleted_at IS NULL",
    [sessionId, scope],
  );
  return result.rows[0] ? { id: result.rows[0].id as string } : null;
}

export async function getConversationSessionHistory(
  q: Query,
  scope: TConversationScope,
  sessionId: string,
): Promise<TConversationHistory> {
  const result = await q(
    `SELECT m.sequence, m.role, m.content, m.references_snapshot, m.attachments, m.run_id, m.created_at
       FROM conversations c
       JOIN conversation_messages m ON m.conversation_id = c.id
      WHERE c.id = $1::uuid AND c.scope = $2 AND c.deleted_at IS NULL
      ORDER BY m.sequence`,
    [sessionId, scope],
  );
  return {
    scope,
    messages: result.rows.map((row) => ({
      sequence: row.sequence as number,
      role: row.role as "user" | "assistant",
      content: row.content as string,
      referencesSnapshot: row.references_snapshot,
      attachments: (row.attachments as TConversationAttachment[]).map(conversationAttachmentInfo),
      runId: row.run_id as string,
      createdAt: (row.created_at as Date).toISOString(),
    })),
  };
}

export async function listConversationSessions(
  q: Query,
  scope: TConversationScope,
): Promise<{ scope: TConversationScope; sessions: TConversationSessionSummary[] }> {
  const result = await q(
    `SELECT c.id, c.title, c.created_at,
            (SELECT count(*)::int FROM conversation_messages m WHERE m.conversation_id = c.id) AS message_count,
            (SELECT max(m.created_at) FROM conversation_messages m WHERE m.conversation_id = c.id) AS last_message_at
       FROM conversations c
      WHERE c.scope = $1 AND c.deleted_at IS NULL
      ORDER BY c.created_at ASC, c.id ASC`,
    [scope],
  );
  return {
    scope,
    sessions: result.rows.map((row, index) => ({
      id: row.id as string,
      scope,
      title: (row.title as string | null) ?? null,
      isDefault: index === 0,
      messageCount: row.message_count as number,
      lastMessageAt: row.last_message_at ? (row.last_message_at as Date).toISOString() : null,
      createdAt: (row.created_at as Date).toISOString(),
    })),
  };
}

export async function createConversationSession(
  q: Query,
  scope: TConversationScope,
  title: string | undefined,
): Promise<TConversationSessionSummary> {
  const id = randomUUID();
  await q(
    "INSERT INTO conversations (id, scope, pi_session_id, title) VALUES ($1, $2, $3, $4)",
    [id, scope, randomUUID(), title ?? null],
  );
  const sessions = await listConversationSessions(q, scope);
  const created = sessions.sessions.find((session) => session.id === id);
  if (!created) throw new Error("会话创建后不可见");
  return created;
}

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function attachmentMissing(message: string): Error {
  return Object.assign(new Error(message), { code: "ATTACHMENT_NOT_FOUND" });
}

/** 全批原子落盘：原件 + 服务端元数据 sidecar（含抽取文本）；任一步失败则回滚已落盘文件。 */
export async function storeConversationAttachments(
  storageDir: string,
  sessionId: string,
  materials: ParsedMaterial[],
): Promise<TConversationAttachment[]> {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw attachmentMissing("会话不存在");
  const staged: { source: string; destination: string }[] = [];
  try {
    const attachments = materials.map((material) => {
      const id = randomUUID();
      const storageKey = `${sessionId}/${id}`;
      const attachment: TConversationAttachment = {
        id,
        fileName: material.fileName,
        mimeType: material.mimeType,
        sizeBytes: material.sizeBytes,
        storageKey,
        sha256: material.sha256,
        extractedText: material.extractedText,
        ...(material.pageCount ? { pageCount: material.pageCount } : {}),
      };
      staged.push({ source: material.tempPath, destination: join(storageDir, storageKey) });
      return attachment;
    });
    await mkdir(join(storageDir, sessionId), { recursive: true, mode: 0o700 });
    for (const item of staged) await moveStagedFile(item.source, item.destination);
    for (let i = 0; i < staged.length; i += 1) {
      await writeFile(`${staged[i].destination}.json`, JSON.stringify(attachments[i]), { mode: 0o600 });
    }
    return attachments;
  } catch (error) {
    await Promise.all([
      ...staged.map((item) => rm(item.destination, { force: true })),
      ...staged.map((item) => rm(`${item.destination}.json`, { force: true })),
    ]);
    throw error;
  }
}

/** 按 id 读取服务端 sidecar；客户端只能传 id，不能伪造元数据或抽取文本。 */
export async function loadConversationAttachments(
  storageDir: string,
  sessionId: string,
  ids: string[],
): Promise<TConversationAttachment[]> {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw attachmentMissing("会话不存在");
  const attachments: TConversationAttachment[] = [];
  for (const id of ids) {
    if (!SESSION_ID_PATTERN.test(id)) throw attachmentMissing("附件不存在");
    let raw: string;
    try {
      raw = await readFile(join(storageDir, sessionId, `${id}.json`), "utf8");
    } catch {
      throw attachmentMissing("附件不存在或已随会话删除");
    }
    try {
      attachments.push(JSON.parse(raw) as TConversationAttachment);
    } catch {
      throw attachmentMissing("附件元数据损坏");
    }
  }
  return attachments;
}

/** 删除会话后清理附件原件与 sidecar；失败只留孤儿文件，不影响删除语义。 */
export async function removeConversationAttachmentFiles(storageDir: string, sessionId: string): Promise<void> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return;
  await rm(join(storageDir, sessionId), { recursive: true, force: true });
}

export function conversationAttachmentInfo(attachment: TConversationAttachment): TConversationAttachmentInfo {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    ...(attachment.pageCount ? { pageCount: attachment.pageCount } : {}),
  };
}
