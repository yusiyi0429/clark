/**
 * 检索本人历史对话原文（3e，R3）：跨本人所有页面（scope）和已归档的对话，原话永久保留、可检索。
 * 只读、只查本人（owner_id 由路由绑定，模型不能传人）；已删除的对话不查。
 * 返回带出处的片段：cite 照抄进回答（cite:chat:<会话 id>#<消息序号>）。
 * 先用 ILIKE 粗筛（中文按二字词、英文按词），再按命中词数与时间排序；不建向量库（用户已定）。
 */
type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export type HistoryHit = { cite: string; scope: string; role: "user" | "assistant"; at: string; archived: boolean; snippet: string };

const MAX_TERMS = 12;
const CANDIDATE_ROWS = 300;
const SNIPPET_BEFORE = 60;
const SNIPPET_AFTER = 160;

/** 检索词：英文/数字按词（至少 2 个字符），中文连续段 ≤ 4 字整段用，更长的拆成二字词。 */
export function historyTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const word of query.toLowerCase().match(/[a-z0-9][a-z0-9_.-]+/g) ?? []) terms.add(word);
  for (const run of query.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (run.length <= 4) terms.add(run);
    else for (let index = 0; index < run.length - 1; index++) terms.add(run.slice(index, index + 2));
  }
  return [...terms].slice(0, MAX_TERMS);
}

const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

function snippetOf(content: string, terms: string[]): string {
  const lower = content.toLowerCase();
  const first = Math.min(...terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0));
  const start = Number.isFinite(first) ? Math.max(0, first - SNIPPET_BEFORE) : 0;
  const end = Math.min(content.length, start + SNIPPET_BEFORE + SNIPPET_AFTER);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

export async function searchOwnConversationHistory(q: Query, input: {
  personId: string;
  query: string;
  /** 本轮自己的消息不算历史。 */
  excludeRunId?: string;
  limit?: number;
}): Promise<{ hits: HistoryHit[]; message?: string }> {
  const terms = historyTerms(input.query);
  if (!terms.length) return { hits: [], message: "检索词里没有可用的字词，请换个说法。" };
  const rows = (await q(
    `SELECT m.conversation_id, m.sequence, m.role, m.content, m.created_at, c.scope, c.archived_at IS NOT NULL AS archived
       FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.owner_id = $1 AND c.deleted_at IS NULL AND ($3::uuid IS NULL OR m.run_id <> $3::uuid) AND m.kind = 'message'
        AND m.content ILIKE ANY($2::text[])
      ORDER BY m.created_at DESC
      LIMIT ${CANDIDATE_ROWS}`,
    [input.personId, terms.map(likePattern), input.excludeRunId ?? null],
  )).rows as { conversation_id: string; sequence: number; role: "user" | "assistant"; content: string; created_at: Date; scope: string; archived: boolean }[];
  const scored = rows.map((row, index) => {
    const lower = row.content.toLowerCase();
    return { row, index, score: terms.filter((term) => lower.includes(term)).length };
  }).sort((left, right) => right.score - left.score || left.index - right.index);
  const hits = scored.slice(0, input.limit ?? 8).map(({ row }) => ({
    cite: `cite:chat:${row.conversation_id}#${row.sequence}`,
    scope: row.scope,
    role: row.role,
    at: new Date(row.created_at).toISOString(),
    archived: row.archived,
    snippet: snippetOf(row.content, terms),
  }));
  return hits.length ? { hits } : { hits, message: "本人的历史对话里没有找到相关原话。" };
}
