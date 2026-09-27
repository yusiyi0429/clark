import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, QueryResult } from "pg";
import type {
  TCardReference,
  TConversationAttachment,
  TConversationAttachmentInfo,
  TConversationHistory,
  TConversationScope,
  TReferenceSnapshot,
} from "@warmap/contracts";
import type { CompanyMemoryRepository } from "./companyMemory.js";
import type { ParsedMaterial } from "./materialParser.js";
import { roleOf, type SessionRole } from "./memberAccess.js";
import { getIssueRow, projectIssueCard } from "./issues.js";
import { moveStagedFile } from "./meetingMaterials.js";
import { getMeetingRow, projectMeetingCard } from "./meetingStore.js";
import { getMonthlyPlanRow, projectMonthlyPlanCard } from "./monthlyPlans.js";
import { getMissionRow, projectMissionCard } from "./missions.js";
import { getSignalCard } from "./signals.js";
import { getPersonalMissionCard } from "./personalMissionCards.js";
import { canReadTask, getTaskView } from "./tasks.js";
import type { MemoryPerson } from "./companyMemory.js";
import type { MissionRoundPerson } from "./missionRounds.js";

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
    /** 这一轮是谁在问：CEO 用 CEO Agent；成员用 DRI Agent（不带 CEO 决策面工具与首页全局上下文）。 */
    viewer: { personId: string; displayName: string; role: SessionRole };
    message: string;
    currentObject: TReferenceSnapshot | null;
    runId?: string;
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

/**
 * 旧对话归属：按人私有之前的会话没有 owner（都是 CEO 与天枢的对话），归到人员目录里的 CEO；目录里没有 CEO 就跳过。
 * 启动时在迁移之后执行（server.ts），可重复执行。
 */
export async function assignLegacyConversations(q: Query, companyMemory: CompanyMemoryRepository): Promise<void> {
  const ceo = companyMemory.searchPeople(undefined).find((person) => roleOf(person) === "ceo");
  if (ceo) await q("UPDATE conversations SET owner_id = $1 WHERE owner_id IS NULL", [ceo.personId]);
}

export async function getScopeObject(
  q: Query,
  scope: TConversationScope,
  secret: string,
  context?: { person: MissionRoundPerson; people: MemoryPerson[]; now: Date },
): Promise<{ snapshot: TReferenceSnapshot | null; visible: boolean }> {
  if (scope === "global") return { snapshot: null, visible: true };
  const [objectType, id] = scope.split(":", 2);
  if (objectType === "task") {
    if (!context || !await canReadTask(q, id, context.person.personId)) return { visible: false, snapshot: null };
    const task = await getTaskView(q, id, new Map(context.people.map((person) => [person.personId, person.displayName])));
    if (!task) return { visible: false, snapshot: null };
    const mission = task.mission ? (await q(`SELECT m.id,m.title,m.outcome,m.milestones,b.name AS battlefield_name,
      b.six_month_outcome,r.goal_snapshot,
      COALESCE(r.goal_snapshot->>'monthOutcome',
        (SELECT goal->>'outcome' FROM jsonb_array_elements(p.battlefields) AS goal
          WHERE goal->>'battlefieldId'=r.battlefield_id LIMIT 1)) AS month_outcome FROM missions m
      JOIN personal_mission_cards c ON c.id=m.personal_mission_card_id
      JOIN mission_rounds r ON r.id=c.round_id JOIN monthly_plans p ON p.id=r.monthly_plan_id
      JOIN battlefield_config b ON b.id=r.battlefield_id WHERE m.id=$1`,
    [task.mission.missionId])).rows[0] ?? null : null;
    return { visible: true, snapshot: { cardId: `task:${id}`, version: task.version, kind: "task", title: task.title,
      objectRef: { type: "task", id, version: task.version }, payload: { task, mission,
        monthOutcome: mission?.month_outcome ?? null } } };
  }
  if (objectType === "mission-card") {
    const card = context ? await getPersonalMissionCard(q, context.people, secret, context.person, id, context.now) : null;
    return card ? { visible: true, snapshot: { cardId: card.id, version: card.version, kind: card.kind, title: card.title, objectRef: card.objectRef, payload: card.payload } } : { visible: false, snapshot: null };
  }
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
  const mission = objectType === "mission" ? await getMissionRow(q, id) : null;
  if (mission) {
    const card = projectMissionCard(mission, secret, new Map());
    return {
      visible: true,
      snapshot: { cardId: card.id, version: card.version, kind: card.kind, title: card.title, objectRef: card.objectRef, payload: card.payload },
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
    if (extra || !["issue", "meeting", "monthly-plan", "mission"].includes(objectType)) {
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
    const mission = objectType === "mission" ? await getMissionRow(q, id) : null;
    if (mission) {
      const card = projectMissionCard(mission, secret, new Map());
      if (card.version !== reference.version) {
        return { status: 409, code: "REFERENCE_VERSION_CONFLICT", message: "Card 引用版本已过期" };
      }
      snapshots.push({ cardId: card.id, version: card.version, kind: card.kind, title: card.title, objectRef: card.objectRef, payload: card.payload });
      continue;
    }
    return { status: 404, code: "REFERENCE_NOT_FOUND", message: "Card 引用不存在" };
  }
  return { snapshots };
}

/** 这个人在这个页面的主对话：最早的未删除行（028 已把多余会话并进它）。 */
const MAIN_CONVERSATION_SQL =
  "SELECT id FROM conversations WHERE owner_id = $1 AND scope = $2 AND deleted_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1";

export async function getConversationHistory(q: Query, owner: string, scope: TConversationScope): Promise<TConversationHistory> {
  const conversation = await q(MAIN_CONVERSATION_SQL, [owner, scope]);
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

/**
 * 主对话 id；还没有时创建。创建走与轮次相同的「人 × scope」advisory lock（事务级锁与轮次的会话级锁同一键空间），
 * 避免和并发的首轮对话各建一条。已有主对话时不拿锁，上传不必等进行中的轮次。
 */
export async function ensureMainConversation(pool: Pool, owner: string, scope: TConversationScope): Promise<string> {
  const existing = await pool.query<{ id: string }>(MAIN_CONVERSATION_SQL, [owner, scope]);
  if (existing.rows[0]) return existing.rows[0].id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${owner}|${scope}`]);
    const locked = await client.query<{ id: string }>(MAIN_CONVERSATION_SQL, [owner, scope]);
    let id = locked.rows[0]?.id;
    if (!id) {
      id = randomUUID();
      await client.query(
        "INSERT INTO conversations (id, owner_id, scope, pi_session_id) VALUES ($1, $2, $3, $4)",
        [id, owner, scope, randomUUID()],
      );
    }
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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
      throw attachmentMissing("附件不存在");
    }
    try {
      attachments.push(JSON.parse(raw) as TConversationAttachment);
    } catch {
      throw attachmentMissing("附件元数据损坏");
    }
  }
  return attachments;
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
