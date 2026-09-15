import type { QueryResult } from "pg";
import type {
  TCard,
  TCardReference,
  TConversationHistory,
  TConversationScope,
  TReferenceSnapshot,
} from "@warmap/contracts";
import { getFixtureHome, projectHomeCard } from "./fixture.js";
import { getIssueRow, projectIssueCard } from "./issues.js";

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

type FixtureObjectRow = {
  object_type: string;
  id: string;
  version: number;
  title: string;
  payload: unknown;
  visible_to_ceo: boolean;
};

export async function getFixtureObject(q: Query, objectType: string, id: string): Promise<FixtureObjectRow | null> {
  const result = await q(
    `SELECT object_type, id, version, title, payload, visible_to_ceo
       FROM fixture_objects
      WHERE object_type = $1 AND id = $2`,
    [objectType, id],
  );
  return result.rowCount === 1 ? result.rows[0] as FixtureObjectRow : null;
}

export function projectFixtureObjectCard(row: FixtureObjectRow): TCard {
  const scope = `${row.object_type}:${row.id}`;
  return {
    schemaVersion: 1,
    id: scope,
    version: row.version,
    kind: row.object_type,
    objectRef: { type: row.object_type, id: row.id, version: row.version },
    title: row.title,
    badge: "FIXTURE",
    urgency: "normal",
    payload: row.payload,
    navigation: [{ href: `/issues/${row.id}`, label: "Issue" }],
    conversation: { scope },
    actions: [],
  };
}

export async function getScopeObject(
  q: Query,
  scope: TConversationScope,
): Promise<{ snapshot: TReferenceSnapshot | null; visible: boolean }> {
  if (scope === "global") return { snapshot: null, visible: true };
  const [objectType, id] = scope.split(":", 2);
  // 真实 Issue 优先；fixture 仅在迁移期兼容
  const issue = objectType === "issue" ? await getIssueRow(q, id) : null;
  if (issue) {
    const card = projectIssueCard(issue);
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
  const row = await getFixtureObject(q, objectType, id);
  if (!row?.visible_to_ceo) return { snapshot: null, visible: false };
  const card = projectFixtureObjectCard(row);
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

export async function resolveReferenceSnapshots(
  q: Query,
  references: TCardReference[],
  actionSecret: string,
): Promise<
  | { snapshots: TReferenceSnapshot[] }
  | { status: 403 | 404 | 409; code: string; message: string }
> {
  const snapshots: TReferenceSnapshot[] = [];
  for (const reference of references) {
    if (reference.cardId === "home:default") {
      const card = projectHomeCard(await getFixtureHome(q), actionSecret);
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

    const [objectType, id, extra] = reference.cardId.split(":");
    if (extra || !["issue", "signal", "meeting", "monthly-plan"].includes(objectType)) {
      return { status: 404, code: "REFERENCE_NOT_FOUND", message: "Card 引用不存在" };
    }
    const issue = objectType === "issue" ? await getIssueRow(q, id) : null;
    if (issue) {
      const card = projectIssueCard(issue);
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
    const row = await getFixtureObject(q, objectType, id);
    if (!row) return { status: 404, code: "REFERENCE_NOT_FOUND", message: "Card 引用不存在" };
    if (!row.visible_to_ceo) return { status: 403, code: "REFERENCE_FORBIDDEN", message: "无权引用该 Card" };
    const card = projectFixtureObjectCard(row);
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
