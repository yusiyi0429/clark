import type { QueryResult } from "pg";
import type {
  TCardReference,
  TConversationHistory,
  TConversationScope,
  TReferenceSnapshot,
} from "@warmap/contracts";
import { getIssueRow, projectIssueCard } from "./issues.js";
import { getMeetingRow, projectMeetingCard } from "./meetings.js";
import { getMonthlyPlanRow, projectMonthlyPlanCard } from "./monthlyPlans.js";

export type ConversationRuntimeEvent =
  | { type: "message"; delta: string }
  | { type: "warning"; code: "RUNTIME_RECREATED"; message: string }
  | { type: "compaction"; phase: "started" | "completed" }
  | { type: "tool"; phase: "started" | "completed"; toolCallId: string; name: string; isError?: boolean }
  | { type: "usage"; input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };

export type ConversationRuntime = {
  promptHash?: string;
  modelSlot?: string;
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
    if (extra || !["issue", "signal", "meeting", "monthly-plan"].includes(objectType)) {
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
  const result = await q(
    `SELECT m.sequence, m.role, m.content, m.references_snapshot, m.run_id, m.created_at
       FROM conversations c
       JOIN conversation_messages m ON m.conversation_id = c.id
      WHERE c.scope = $1
      ORDER BY m.sequence`,
    [scope],
  );
  return {
    scope,
    messages: result.rows.map((row) => ({
      sequence: row.sequence as number,
      role: row.role as "user" | "assistant",
      content: row.content as string,
      referencesSnapshot: row.references_snapshot,
      runId: row.run_id as string,
      createdAt: (row.created_at as Date).toISOString(),
    })),
  };
}
