import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, QueryResult } from "pg";
import type { Usage } from "@earendil-works/pi-ai";
import type {
  TAskAnswerRecord,
  TCardReference,
  TConversationAttachment,
  TConversationAttachmentInfo,
  TConversationCard,
  TConversationHistory,
  TConversationScope,
  TReadScope,
  TReadScopeParams,
  TReferenceSnapshot,
} from "@warmap/contracts";
import type { PeopleDirectory } from "./peopleDirectory.js";
import type { AskUser } from "./askUser.js";
import type { ConversationEntries } from "./conversationEntries.js";
import type { CompanyMap } from "./companyMap.js";
import type { ConversationAnchor } from "./conversationAnchor.js";
import type { IssueSuggest, IssueSuggestContext } from "./issueDrafts.js";
import type { TurnRecoverySummary } from "./conversationRecovery.js";
import type { ParsedMaterial } from "./materialParser.js";
import { roleOf, type SessionRole } from "./memberAccess.js";
import { getIssueRow, projectIssueCard } from "./issues.js";
import { moveStagedFile } from "./meetingMaterials.js";
import { cardWithMeetingFacts } from "./meetingCardRead.js";
import { getMeetingRow, projectMeetingCard } from "./meetingStore.js";
import { getMonthlyPlanRow, projectMonthlyPlanCard } from "./monthlyPlans.js";
import { canReadMission, getMissionRow, projectMissionCard } from "./missions.js";
import { canReadMonthlyReviewItem, getMonthlyReviewItem } from "./monthlyReviews.js";
import { getSignalCard } from "./signals.js";
import { getPersonalMissionCard } from "./personalMissionCards.js";
import { canReadTask, getTaskView } from "./tasks.js";
import type { DirectoryPerson as MemoryPerson } from "./peopleDirectory.js";
import type { MissionRoundPerson } from "./missionRounds.js";
import type { HistoryHit } from "./conversationHistorySearch.js";

export type ConversationRuntimeEvent =
  | { type: "message"; delta: string }
  | { type: "warning"; code: "RUNTIME_RECREATED"; message: string }
  | { type: "compaction"; phase: "started" | "completed" }
  /** errorCode：工具出错的类别（只在出错时有，路由层记成质量信号，不发给界面）。 */
  | { type: "tool"; phase: "started" | "completed"; toolCallId: string; name: string; isError?: boolean; label?: string; detail?: string; errorCode?: string }
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
  | { type: "usage"; input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number }
  /** 跨对象读取的范围标签（三层取用，companyMap.ts）：界面显示成可以点开调整的标签。 */
  | ({ type: "scope" } & TReadScope);

export type PersonalMemoryEntry = { id: string; title: string; text: string };
export type PersonalMemoryContext = PersonalMemoryEntry & { createdAt?: string; basedOnOldVersion?: boolean };
export type PersonalMemoryTools = {
  search(query: string): Promise<PersonalMemoryEntry[]>;
  /** 新记一条；replaces 给出时是纠正：旧条目被新说法替代。 */
  remember(input: { kind?: "idea" | "stance" | "open_question" | "reason" | "preference" | "practice"; title: string; text: string; topic?: string; replaces?: string }): Promise<PersonalMemoryEntry>;
  forget(input: { id: string }): Promise<{ id: string }>;
};

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
    /**
     * 与本轮原话相关的本人个人记忆（只有本人可见）；放进上下文包的 personalMemory。
     * 路由交来的是还在选的 Promise（召回模型与分诊同时跑），运行时拼上下文包时才等它。
     */
    personalMemory?: PersonalMemoryContext[] | Promise<PersonalMemoryContext[]>;
    /** 本人个人记忆的检索与「记住 / 改成 / 忘掉」，已绑定本人；运行时据此给主 Agent 提供工具。失败时抛错，只作为工具报错。 */
    personalMemoryTools?: PersonalMemoryTools;
    /** 检索本人历史对话原文（跨所有页面与归档，只读、已绑定本人）；运行时据此提供 search_conversation_history。 */
    searchHistory?: (query: string) => Promise<{ hits: HistoryHit[]; message?: string }>;
    /** 本人手上没完成的待办（标题、发起人、发出时间、类型）：每轮放进上下文包的 myOpenTodos。 */
    openTodos?: { title: string; from: string; sentAt: string; kind: string }[];
    /** 对话里的一句话入口（生成复盘、帮我问问、请同事帮忙），已绑定本人与这一轮；运行时据此提供对应工具。 */
    entries?: ConversationEntries;
    /** 向本人提问（askUser.ts）：登记一张提问卡挂在这一轮回答后面；运行时据此提供 ask_user，问完这一轮就停。 */
    ask?: AskUser;
    recentMessages?: { role: "user" | "assistant"; content: string; createdAt: string }[];
    /** 三层取用（companyMap.ts）：已绑定本人与这一轮，运行时据此提供 read_mission_cards / read_progress / read_reviews / read_object_tree。 */
    companyMap?: CompanyMap;
    /**
     * 场景锚点（PR #12 Anchor 层）：本人在哪个页面、聚焦哪张卡，连同三层取用的默认读取范围（range、period）；
     * 放进上下文包的 anchor，运行时据此提供 read_anchor。页面只决定默认焦点，不是边界。
     */
    anchor?: ConversationAnchor;
    /** 本人在范围标签上改过的读取范围：放进上下文包，这一轮的读取一律按它。 */
    scopeOverride?: TReadScopeParams;
    /** 一号位深聊转议题（只在 CEO 首页，issueDrafts.ts）：运行时据此提供 propose_issue、read_issue_conversation。 */
    issueSuggest?: IssueSuggest;
    /** 首页上下文包里的已转议题与拒绝过的话题。 */
    issueContext?: IssueSuggestContext;
    /**
     * 模型还没见过的、从别的对话带进来的消息（转议题时复制进议题页的那一段）：运行时在这一轮之前接进模型历史。
     * 模型历史重建或闲置重开时它们已经在 recentMessages 里，不再重复接。
     */
    carriedOver?: { role: "user" | "assistant"; content: string; createdAt: string }[];
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
export async function assignLegacyConversations(q: Query, companyMemory: PeopleDirectory): Promise<void> {
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
    const viewer = context && { personId: context.person.personId, isCeo: context.person.role === "ceo" };
    const card = await cardWithMeetingFacts(q, meeting, projectMeetingCard(meeting, secret), viewer);
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
      const card = await cardWithMeetingFacts(q, meeting, projectMeetingCard(meeting, secret), person && { personId: person.personId, isCeo: person.role === "ceo" });
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
 * 这个人在这个页面的当前对话：最早的未删除、未归档行（028 已把多余会话并进它）。
 * 一条连续的对话，界面上没有新建与历史列表；067 归档过的旧对话不再显示，原话仍可由 search_conversation_history 检索。
 */
export const ACTIVE_CONVERSATION_WHERE = "owner_id = $1 AND scope = $2 AND deleted_at IS NULL AND archived_at IS NULL";
const MAIN_CONVERSATION_SQL = `SELECT id FROM conversations WHERE ${ACTIVE_CONVERSATION_WHERE} ORDER BY created_at ASC, id ASC LIMIT 1`;

/**
 * 闲置这么久之后的下一轮，模型侧只带摘要重新开始（压缩摘要 + 最近几轮问答的文字），不再回放之前的工具往返与上游条目；
 * 界面上的历史照常显示，一号位感觉不到（piConversationRuntime.ts 的 idleRestart）。
 */
export const CONVERSATION_IDLE_RESTART_MS = 12 * 60 * 60 * 1000;

type MessageRow = { sequence: number; role: string; content: string; references_snapshot: unknown; attachments: TConversationAttachment[];
  run_id: string; created_at: Date; recovery_note: { text?: unknown; detail?: unknown } | null; memory_used: unknown; cards?: unknown;
  read_scope?: unknown; kind?: string; meta?: { issueId?: unknown; title?: unknown; href?: unknown; answers?: unknown; via?: unknown } | null };

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
    ...(Array.isArray(row.memory_used) && row.memory_used.length ? { memoryUsed: row.memory_used.filter((id): id is string => typeof id === "string") } : {}),
    ...(row.role === "assistant" && Array.isArray(row.cards) && row.cards.length ? { cards: row.cards as TConversationCard[] } : {}),
    ...(row.role === "assistant" && row.read_scope && typeof row.read_scope === "object" ? { readScope: row.read_scope as TReadScope } : {}),
    // 回答 Agent 提问的那条：问答记录存在 meta.answers（routes/conversations.ts 按提问卡核对后写入）。
    ...(row.role === "user" && row.meta?.answers && typeof row.meta.answers === "object" ? { answers: row.meta.answers as TAskAnswerRecord } : {}),
    ...(row.kind === "carried" || row.kind === "trace" ? { kind: row.kind } : {}),
    ...(row.meta?.via === "feishu" || row.meta?.via === "wechat" ? { via: row.meta.via as "feishu" | "wechat" } : {}),
    ...(row.kind === "trace" && row.meta ? { meta: Object.fromEntries((["issueId", "title", "href"] as const)
      .flatMap((key) => (typeof row.meta?.[key] === "string" ? [[key, row.meta[key]]] : []))) } : {}),
  };
}

async function conversationMessages(q: Query, conversationId: string): Promise<TConversationHistory["messages"]> {
  const result = await q(
    // 这一轮工具生成的卡记在运行记录里（routes/conversations.ts），随回答一起读回。
    `SELECT m.sequence, m.role, m.content, m.references_snapshot, m.attachments, m.run_id, m.created_at, m.recovery_note, m.memory_used, m.kind, m.meta,
            CASE WHEN m.role = 'assistant' AND m.kind = 'message' THEN r.input_snapshot -> 'cards' END AS cards,
            CASE WHEN m.role = 'assistant' AND m.kind = 'message' THEN r.input_snapshot -> 'readScope' END AS read_scope
       FROM conversation_messages m
       LEFT JOIN agent_runs r ON r.id = m.run_id
      WHERE m.conversation_id = $1
      ORDER BY m.sequence`,
    [conversationId],
  );
  return (result.rows as MessageRow[]).map(historyMessage);
}

export async function getConversationHistory(q: Query, owner: string, scope: TConversationScope): Promise<TConversationHistory> {
  const conversation = await q(MAIN_CONVERSATION_SQL, [owner, scope]);
  const conversationId = conversation.rows[0]?.id as string | undefined;
  return { scope, messages: conversationId ? await conversationMessages(q, conversationId) : [] };
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
