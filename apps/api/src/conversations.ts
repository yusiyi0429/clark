import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, QueryResult } from "pg";
import type { Usage } from "@earendil-works/pi-ai";
import type {
  TCardReference,
  TConversationAttachment,
  TConversationAttachmentInfo,
  TArchivedConversationList,
  TConversationHistory,
  TConversationScope,
  TReferenceSnapshot,
} from "@warmap/contracts";
import type { CompanyMemoryRepository } from "./companyMemory.js";
import type { TurnRecoverySummary } from "./conversationRecovery.js";
import type { ParsedMaterial } from "./materialParser.js";
import { roleOf, type SessionRole } from "./memberAccess.js";
import { getIssueRow, projectIssueCard } from "./issues.js";
import { moveStagedFile } from "./meetingMaterials.js";
import { getMeetingRow, projectMeetingCard } from "./meetingStore.js";
import { getMonthlyPlanRow, projectMonthlyPlanCard } from "./monthlyPlans.js";
import { canReadMission, getMissionRow, projectMissionCard } from "./missions.js";
import { canReadMonthlyReviewItem, getMonthlyReviewItem } from "./monthlyReviews.js";
import { getSignalCard } from "./signals.js";
import { getPersonalMissionCard } from "./personalMissionCards.js";
import { canReadTask, getTaskView } from "./tasks.js";
import type { MemoryPerson } from "./companyMemory.js";
import type { MissionRoundPerson } from "./missionRounds.js";

export type ConversationRuntimeEvent =
  | { type: "message"; delta: string }
  | { type: "warning"; code: "RUNTIME_RECREATED"; message: string }
  | { type: "compaction"; phase: "started" | "completed" }
  | { type: "tool"; phase: "started" | "completed"; toolCallId: string; name: string; isError?: boolean; label?: string; detail?: string }
  /** 本轮档位（conversationRouting.ts）：路由层据此设整轮时限，界面据此显示预计用时；深度档带开场说明。 */
  | { type: "route"; tier: "quick" | "grounded" | "deep"; source: "rule" | "model" | "fallback"; expectSeconds: number; timeoutMs: number; notice?: string; model?: string }
  /**
   * 模型在思考。summary：GPT 推理摘要里的一句中文要点；delta：Claude 思考摘要的中文正文（逐段追加，英文段落已译成中文，conversationThinking.ts）。
   * 都不带时只是「还在想」的心跳。
   */
  | { type: "thinking"; summary?: string; delta?: string }
  /** 非深度档中途升级：需要更深入的分析，预计还需约 expectSeconds 秒（notice 是给界面的整句）。 */
  | { type: "escalation"; reason: "slow" | "retrieval"; expectSeconds: number; notice: string }
  /** 上游出错后正在自动恢复（conversationRecovery.ts）：notice 是给进度行的一句中文。 */
  | { type: "recovery"; reason: string; action: "retry" | "fallback" | "trim" | "continue" | "skip"; attempt: number; notice: string }
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
    /** 与本轮原话相关的本人个人记忆（只有本人可见）；放进上下文包的 personalMemory。 */
    personalMemory?: { title: string; text: string }[];
    recentMessages?: { role: "user" | "assistant"; content: string; createdAt: string }[];
    runtimeEntries: unknown[];
    piSessionId: string;
    signal: AbortSignal;
    emit: (event: ConversationRuntimeEvent) => void;
    checkpoint?: (runtimeEntries: unknown[]) => Promise<void>;
    /**
     * 「继续」上一轮没完成的回答：沿用那一轮的档位（tier）；question 是那一轮的原问题，instruction 是交给模型的续写 / 重答说明
     * （放进上下文包的 resume 字段，不当作一号位的原话）。
     */
    resume?: { tier?: "quick" | "grounded" | "deep"; question: string; instruction: string };
    /**
     * 这条对话闲置超过 CONVERSATION_IDLE_RESTART_MS：模型侧换一条新的会话，只带压缩摘要和最近几轮问答的文字
     * （不回放之前的工具往返、推理与上游条目）。界面上的历史不变。
     */
    idleRestart?: boolean;
  }): Promise<{
    assistantMessage: string;
    runtimeEntries: unknown[];
    piSessionId?: string;
    recovery?: { recreated: true; warning: string };
    /** 这一轮走过恢复（重试、换备用模型、精简历史、续写）时的汇总；没有就是一路顺利。 */
    recoverySummary?: TurnRecoverySummary;
  }>;
  /**
   * 后台压缩写摘要（conversationCompaction.ts）：不在任何一轮里调用，用后台压缩模型（出错换备用模型）。
   * 没有时（测试、未配置模型）不做后台压缩，只靠窗口兜底。
   */
  summarizeHistory?(input: { systemPrompt: string; prompt: string; signal: AbortSignal }): Promise<{ text: string; usage?: Usage; model: string; fallbackFrom?: string }>;
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
  if (objectType === "personal-review") {
    if (!context || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return { visible: false, snapshot: null };
    const review = (await q("SELECT id, version, person_id, period, status, self_review FROM personal_reviews WHERE id=$1", [id])).rows[0];
    if (!review || review.person_id !== context.person.personId) return { visible: false, snapshot: null };
    return { visible: true, snapshot: { cardId: scope, version: review.version, kind: "personal-review",
      title: `${review.period} 个人复盘`, objectRef: { type: "personal-review", id, version: review.version },
      payload: { period: review.period, status: review.status, selfReview: review.self_review } } };
  }
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
  if (objectType === "monthly-review-item") {
    // 负责人、CEO 和本单元当月 Mission 负责人能读；对话仍按本人隔离
    const item = context ? await getMonthlyReviewItem(q, id) : null;
    if (!item || !context || !await canReadMonthlyReviewItem(q, context.person, item)) return { visible: false, snapshot: null };
    return { visible: true, snapshot: { cardId: `monthly-review-item:${item.id}`, version: item.version, kind: "monthly-review-item",
      title: `${item.period} 复盘 · ${item.subject_name}`, objectRef: { type: "monthly-review-item", id: item.id, version: item.version },
      payload: {
        period: item.period,
        subject: { type: item.subject_type, id: item.subject_id, code: item.subject_code, name: item.subject_name, sixMonthOutcome: item.six_month_outcome },
        ownerId: item.owner_id,
        target: item.target,
        selfReview: item.self_review,
        status: item.status,
        returnReason: item.return_reason,
        assessment: item.assessment.result,
        suggestions: item.suggestions,
      } } };
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
  if (mission && !await canReadMission(q, mission, context?.person)) return { visible: false, snapshot: null };
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
  person?: MissionRoundPerson,
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
    if (mission && !await canReadMission(q, mission, person)) return { status: 404, code: "REFERENCE_NOT_FOUND", message: "Card 引用不存在" };
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

/**
 * 这个人在这个页面的当前对话：最早的未删除、未归档行（028 已把多余会话并进它；「新建对话」把旧的归档，067）。
 * 同一时刻只有一条：新建、切回都在「人 × scope」锁里先归档旧的再放出新的。
 */
export const ACTIVE_CONVERSATION_WHERE = "owner_id = $1 AND scope = $2 AND deleted_at IS NULL AND archived_at IS NULL";
const MAIN_CONVERSATION_SQL = `SELECT id FROM conversations WHERE ${ACTIVE_CONVERSATION_WHERE} ORDER BY created_at ASC, id ASC LIMIT 1`;

/**
 * 闲置这么久之后的下一轮，模型侧只带摘要重新开始（压缩摘要 + 最近几轮问答的文字），不再回放之前的工具往返与上游条目；
 * 界面上的历史照常显示，一号位感觉不到（piConversationRuntime.ts 的 idleRestart）。
 */
export const CONVERSATION_IDLE_RESTART_MS = 12 * 60 * 60 * 1000;

type MessageRow = { sequence: number; role: string; content: string; references_snapshot: unknown; attachments: TConversationAttachment[];
  run_id: string; created_at: Date; recovery_note: { text?: unknown; detail?: unknown } | null };

function historyMessage(row: MessageRow): TConversationHistory["messages"][number] {
  const note = row.recovery_note;
  return {
    sequence: row.sequence,
    role: row.role as "user" | "assistant",
    content: row.content,
    referencesSnapshot: row.references_snapshot as TConversationHistory["messages"][number]["referencesSnapshot"],
    attachments: row.attachments.map(conversationAttachmentInfo),
    runId: row.run_id,
    createdAt: row.created_at.toISOString(),
    ...(note && typeof note.text === "string" && note.text
      ? { recoveryNote: { text: note.text, detail: typeof note.detail === "string" ? note.detail : "" } } : {}),
  };
}

async function conversationMessages(q: Query, conversationId: string): Promise<TConversationHistory["messages"]> {
  const result = await q(
    `SELECT m.sequence, m.role, m.content, m.references_snapshot, m.attachments, m.run_id, m.created_at, m.recovery_note
       FROM conversation_messages m
      WHERE m.conversation_id = $1
      ORDER BY m.sequence`,
    [conversationId],
  );
  return (result.rows as MessageRow[]).map(historyMessage);
}

/** 已归档、有内容的历史对话（空的归档不算：界面上没有可看的）。 */
const ARCHIVED_WITH_MESSAGES = `FROM conversations c
  WHERE c.owner_id = $1 AND c.scope = $2 AND c.deleted_at IS NULL AND c.archived_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = c.id)`;

export async function getConversationHistory(q: Query, owner: string, scope: TConversationScope): Promise<TConversationHistory> {
  const conversation = await q(MAIN_CONVERSATION_SQL, [owner, scope]);
  const conversationId = conversation.rows[0]?.id as string | undefined;
  const archived = Number((await q(`SELECT count(*)::int AS count ${ARCHIVED_WITH_MESSAGES}`, [owner, scope])).rows[0]?.count ?? 0);
  return { scope, messages: conversationId ? await conversationMessages(q, conversationId) : [], archivedCount: archived };
}

/** 历史对话列表：新归档的在前；首问取第一条用户消息（前 4000 字，带着引用与页面前缀，界面解析后再截标题）。 */
export async function listArchivedConversations(q: Query, owner: string, scope: TConversationScope): Promise<TArchivedConversationList> {
  const result = await q(
    `SELECT c.id, c.archived_at,
            (SELECT left(m.content, 4000) FROM conversation_messages m WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY m.sequence LIMIT 1) AS first_question,
            (SELECT min(m.created_at) FROM conversation_messages m WHERE m.conversation_id = c.id) AS started_at,
            (SELECT max(m.created_at) FROM conversation_messages m WHERE m.conversation_id = c.id) AS last_at,
            (SELECT count(*)::int FROM conversation_messages m WHERE m.conversation_id = c.id) AS message_count
       ${ARCHIVED_WITH_MESSAGES}
      ORDER BY c.archived_at DESC, c.id DESC
      LIMIT 200`,
    [owner, scope],
  );
  return {
    conversations: result.rows.map((row) => ({
      id: row.id as string,
      firstQuestion: (row.first_question as string | null) ?? "",
      startedAt: (row.started_at as Date).toISOString(),
      lastAt: (row.last_at as Date).toISOString(),
      archivedAt: (row.archived_at as Date).toISOString(),
      messageCount: row.message_count as number,
    })),
  };
}

/** 只读回看一段历史对话：只认这个人在这个页面自己归档的那一条。 */
export async function getArchivedConversationHistory(q: Query, owner: string, scope: TConversationScope, id: string): Promise<TConversationHistory | null> {
  if (!SESSION_ID_PATTERN.test(id)) return null;
  const found = await q(
    "SELECT id FROM conversations WHERE id = $3 AND owner_id = $1 AND scope = $2 AND deleted_at IS NULL AND archived_at IS NOT NULL",
    [owner, scope, id],
  );
  if (!found.rows[0]) return null;
  return { scope, messages: await conversationMessages(q, id) };
}

export type ConversationSwitch =
  | { status: "ok"; conversationId: string | null; archived: boolean }
  | { status: "busy" }
  | { status: "not_found" };

/**
 * 在「人 × scope」锁里切换当前对话（锁与轮次同一键空间：有一轮回答还没结束就不切，返回 busy）。
 * - 新建（target 不给）：当前对话有内容就归档、建一条空白的；当前对话本来就是空的（或还没有）就不动。
 * - 切回（target 给了）：那一条必须是这个人在这个页面归档的；当前对话（有没有内容都一样）归档，那一条放出来。
 * 只改 archived_at，不删任何行。
 */
export async function switchConversation(pool: Pool, owner: string, scope: TConversationScope, target?: string): Promise<ConversationSwitch> {
  if (target !== undefined && !SESSION_ID_PATTERN.test(target)) return { status: "not_found" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked", [`${owner}|${scope}`]);
    if (!locked.rows[0]?.locked) {
      await client.query("ROLLBACK");
      return { status: "busy" };
    }
    if (target !== undefined) {
      const found = await client.query(
        "SELECT id FROM conversations WHERE id = $3 AND owner_id = $1 AND scope = $2 AND deleted_at IS NULL AND archived_at IS NOT NULL FOR UPDATE",
        [owner, scope, target],
      );
      if (!found.rows[0]) {
        await client.query("ROLLBACK");
        return { status: "not_found" };
      }
    }
    const current = await client.query<{ id: string; has_messages: boolean }>(
      `SELECT c.id, EXISTS (SELECT 1 FROM conversation_messages m WHERE m.conversation_id = c.id) AS has_messages
         FROM conversations c
        WHERE c.owner_id = $1 AND c.scope = $2 AND c.deleted_at IS NULL AND c.archived_at IS NULL
        ORDER BY c.created_at ASC, c.id ASC FOR UPDATE OF c`,
      [owner, scope],
    );
    let archived = false;
    let conversationId: string | null;
    if (target === undefined && !current.rows.some((row) => row.has_messages)) {
      // 当前对话还是空的（或还没有）：已经是一条空白对话，不再多建一条。
      conversationId = current.rows[0]?.id ?? null;
    } else {
      // 当前的先归档（防御：万一有多条未归档的，一并归档），再放出目标或新建一条。
      if (current.rows.length) {
        await client.query("UPDATE conversations SET archived_at = now() WHERE id = ANY($1::uuid[])", [current.rows.map((row) => row.id)]);
        archived = current.rows.some((row) => row.has_messages);
      }
      if (target !== undefined) {
        await client.query("UPDATE conversations SET archived_at = NULL WHERE id = $1", [target]);
        conversationId = target;
      } else {
        conversationId = randomUUID();
        await client.query(
          "INSERT INTO conversations (id, owner_id, scope, pi_session_id) VALUES ($1, $2, $3, $4)",
          [conversationId, owner, scope, randomUUID()],
        );
      }
    }
    await client.query("COMMIT");
    return { status: "ok", conversationId, archived };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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

/** 上传即为材料；读取服务端目录，不要求附件已经绑定到一条消息。 */
export async function listConversationAttachments(storageDir: string, sessionId: string): Promise<TConversationAttachment[]> {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw attachmentMissing("会话不存在");
  let files: string[];
  try { files = await readdir(join(storageDir, sessionId)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const ids = files.filter((file) => file.endsWith(".json") && SESSION_ID_PATTERN.test(file.slice(0, -5)))
    .map((file) => file.slice(0, -5)).sort();
  return loadConversationAttachments(storageDir, sessionId, ids);
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
