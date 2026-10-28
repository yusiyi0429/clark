import { createHash } from "node:crypto";
import type { ChatService, ChatViewer } from "./chatService.js";
import { syncTianshuSegments } from "./conversationDigests.js";
import { historyTerms, searchOwnConversationHistory } from "./conversationHistorySearch.js";
import { segmentDateLabel } from "./conversationSegments.js";
import { shanghaiLabel } from "./workdays.js";

/**
 * 回看以前的对话（10/28 定）：会话目录 + 两个工具，天枢页面的运行时和给 Chat 的 /internal 接口共用这一份。只看本人的。
 * - 会话目录：上一段的完整纪要（首页是首页的上一段，天枢页面是本页面的上一段，就是换段时的交接），加近 14 天其他段的一行目录（≤10 条）。
 * - search_past_conversations：在本人的纪要里按关键词和日期查，最多 5 段一页；纪要里查不到再按原话查天枢页面的对话（Chat 段只查纪要）。
 * - read_past_conversation：读一段的完整纪要；带 cursor 时分页读原文（每页 ≤8,000 字）。
 * 范围：首页 Chat 的段按视角隔离；天枢页面的段属于本人，两种视角都能查。隐藏了的段不进目录、查不到。
 * 首页第一版（Chat 还没接目录和两个工具）：同一份首页目录做成一张「以前的对话」卡，随 /internal/home-cards 交给 Chat（homeCard）。
 */
const CATALOG_DAYS = 14;
const CATALOG_RECENT = 10;
const SEARCH_PAGE = 5;
const EXCERPT_CHARS = 300;
const RAW_PAGE_CHARS = 8_000;

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
type RecallViewer = ChatViewer;
type Row = { id: string; source: "chat" | "tianshu"; source_ref: string; from_position: string; scope_label: string; started_at: Date; ended_at: Date;
  title: string; digest: string; status: string };

export type CatalogEntry = { segmentId: string; date: string; page: string; title: string };
export type ConversationCatalog = { previous: { segmentId: string; date: string; page: string; title?: string; digest?: string; note?: string } | null; recent: CatalogEntry[] };
export type SearchArgs = { query?: string; from?: string; to?: string; page?: number };
export type ReadArgs = { segmentId: string; cursor?: string };
/** 交给运行时的回看（已绑定本人与视角）：目录放进上下文包，两个工具转调这里。 */
export type PastConversations = {
  catalog: ConversationCatalog | null;
  search(args: SearchArgs): Promise<unknown>;
  read(args: ReadArgs): Promise<unknown>;
};

/** 本人能看到的段：本人的、没隐藏的；Chat 段只看这个视角的；天枢页面的对话没被删。 */
const VISIBLE = `d.owner_id = $1 AND d.status <> 'hidden' AND (d.source = 'tianshu' AND EXISTS (SELECT 1 FROM conversations c WHERE c.id::text = d.source_ref AND c.deleted_at IS NULL)
  OR d.source = 'chat' AND d.viewer_role = $2)`;
const COLUMNS = "d.id, d.source, d.source_ref, d.from_position, d.scope_label, d.started_at, d.ended_at, d.title, d.digest, d.status";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTHING = "本人以前的对话里没有找到相关内容。";
/** 「以前的对话」卡给模型的说明（Chat 把卡的正文放进本轮资料；它的提示词里还没有回看这一条）。 */
const CARD_NOTE = "本人以前在首页和各个页面聊过的对话。摘要是首页上一段对话的纪要（换段时的交接）；事项是近 14 天其他段的目录和纪要开头。本人接着上一段说、或提到以前聊过的事时，以这里为准；这里没有的如实说没找到，不要编。纪要写明了哪些是本人确认的、哪些只是助手建议，转述时照这个区分，并说出是哪天、在哪个页面聊的。";

const entry = (row: Row): CatalogEntry => ({ segmentId: row.id, date: segmentDateLabel(row.started_at), page: row.scope_label, title: row.title });
const span = (row: Row) => `${shanghaiLabel(row.started_at)} 至 ${shanghaiLabel(row.ended_at)}`;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** from / to：北京时间的 YYYY-MM-DD（to 含当天）或 ISO 时间；写错返回 null。 */
function rangeOf(args: SearchArgs): { from: Date | null; to: Date | null } | null {
  const parse = (value: string | undefined, end: boolean) => {
    if (!value) return null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T${end ? "23:59:59.999" : "00:00:00"}+08:00`) : new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  };
  const from = parse(args.from, false);
  const to = parse(args.to, true);
  return from === undefined || to === undefined ? null : { from, to };
}

export type ConversationRecall = ReturnType<typeof createConversationRecall>;

export function createConversationRecall(deps: { q: Query; chat?: Pick<ChatService, "messagesPage"> }) {
  const { q, chat } = deps;

  /** 近 14 天其他段的一行目录（有纪要的，按时间倒序），不含 exclude 里的段。 */
  async function recent(viewer: RecallViewer, exclude: string[]): Promise<CatalogEntry[]> {
    const rows = (await q(`SELECT ${COLUMNS} FROM conversation_digests d WHERE ${VISIBLE} AND d.digest <> ''
        AND d.ended_at >= now() - make_interval(days => $3) AND NOT (d.id = ANY($4::uuid[]))
      ORDER BY d.ended_at DESC LIMIT $5`, [viewer.personId, viewer.role, CATALOG_DAYS, exclude, CATALOG_RECENT])).rows as Row[];
    return rows.map(entry);
  }

  /** 「上一段」：有纪要给全文；最后几轮还没整理进去或还没有纪要时如实说，模型需要时读原文（回答路径上不当场写纪要）。 */
  function previousOf(row: Row | undefined): ConversationCatalog["previous"] {
    if (!row) return null;
    const base = { segmentId: row.id, date: segmentDateLabel(row.started_at), page: row.scope_label };
    if (!row.digest) return { ...base, note: "这一段的纪要还在整理，需要时用 read_past_conversation 读原文。" };
    return { ...base, title: row.title, digest: row.digest,
      ...(row.status === "stale" ? { note: "这一段最后几轮还没整理进纪要，需要时用 read_past_conversation 读原文。" } : {}) };
  }

  const empty = (catalog: ConversationCatalog) => (!catalog.previous && !catalog.recent.length ? null : catalog);

  /** 首页这一轮的会话目录：conversationId 是当前这段；不给时按最新开的那段算。 */
  async function homeCatalog(viewer: RecallViewer, conversationId?: string): Promise<ConversationCatalog | null> {
    const rows = (await q(`SELECT ${COLUMNS} FROM conversation_digests d WHERE ${VISIBLE} AND d.source = 'chat'
        ORDER BY d.started_at DESC LIMIT 20`, [viewer.personId, viewer.role])).rows as Row[];
    const current = conversationId ? rows.find((row) => row.source_ref === conversationId) : rows[0];
    const previous = rows.find((row) => row !== current && row.source_ref !== conversationId && (!current || row.started_at < current.started_at));
    return empty({ previous: previousOf(previous), recent: await recent(viewer, [current?.id, previous?.id].filter(Boolean) as string[]) });
  }

  return {
    /**
     * 天枢页面这一轮的会话目录：先把这条对话切好段（本轮这句已经存下），最新的一段是当前段，前一段是「上一段」。
     * 没有任何旧段时返回 null（上下文包里不出现）。
     */
    async pageCatalog(viewer: RecallViewer, conversationId: string): Promise<ConversationCatalog | null> {
      await syncTianshuSegments(q, { conversationId, latestSegments: 2 });
      const [current, previous] = (await q(`SELECT ${COLUMNS} FROM conversation_digests d WHERE ${VISIBLE} AND d.source = 'tianshu' AND d.source_ref = $3
          ORDER BY d.from_position DESC LIMIT 2`, [viewer.personId, viewer.role, conversationId])).rows as Row[];
      return empty({ previous: previousOf(previous), recent: await recent(viewer, [current?.id, previous?.id].filter(Boolean) as string[]) });
    },

    /** 首页这一轮的会话目录（Chat 每轮来取）。 */
    homeCatalog,

    /**
     * 首页的「以前的对话」卡（第一版回看，Chat 不用改）：上一段的完整纪要 + 近 14 天其他段的目录和纪要开头。Chat 每轮把卡的正文放进本轮资料，
     * 模型可用它的 read_anchor 读全文。只用 Chat 认得的字段（note、summary、items、occurred_at、title），别的字段 Chat 会丢掉。
     * 版本取内容的摘要值，内容不变版本不变。没有任何旧段时没有这张卡。
     */
    async homeCard(viewer: RecallViewer): Promise<{ cardId: string; version: number; kind: string; title: string; payload: Record<string, unknown> } | null> {
      const catalog = await homeCatalog(viewer);
      if (!catalog) return null;
      const digests = new Map((await q("SELECT id::text, digest FROM conversation_digests WHERE id = ANY($1::uuid[])",
        [catalog.recent.map((item) => item.segmentId)])).rows.map((row: { id: string; digest: string }) => [row.id, row.digest]));
      const previous = catalog.previous;
      const payload = {
        note: CARD_NOTE,
        ...(previous ? { summary: [`上一段：${previous.date} · ${previous.page}${previous.title ? ` · ${previous.title}` : ""}`,
          previous.digest ?? "这一段的纪要还在整理。", ...(previous.digest && previous.note ? ["这一段最后几轮还没整理进纪要。"] : [])].join("\n") } : {}),
        ...(catalog.recent.length ? { items: catalog.recent.map((item) => ({ occurred_at: item.date, title: `${item.page} · ${item.title}`,
          summary: clip((digests.get(item.segmentId) ?? "").replace(/^截至[^\n]*\n/, ""), EXCERPT_CHARS) })) } : {}),
      };
      const version = 1 + Number.parseInt(createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 12), 16);
      return { cardId: "conversation-catalog", version, kind: "conversation-catalog", title: "以前的对话", payload };
    },

    async search(viewer: RecallViewer, args: SearchArgs, options: { excludeRunId?: string } = {}): Promise<unknown> {
      const range = rangeOf(args);
      if (!range) return { error: "INVALID_DATE", message: "from / to 写成北京时间的 YYYY-MM-DD。" };
      const terms = args.query ? historyTerms(args.query) : [];
      if (args.query && !terms.length) return { segments: [], message: "检索词里没有可用的字词，请换个说法。" };
      const page = Math.max(1, Math.floor(args.page ?? 1));
      const patterns = terms.map((term) => `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`);
      const rows = (await q(`SELECT ${COLUMNS}, d.keywords FROM conversation_digests d WHERE ${VISIBLE} AND d.digest <> ''
          AND ($3::timestamptz IS NULL OR d.ended_at >= $3) AND ($4::timestamptz IS NULL OR d.started_at <= $4)
          AND (cardinality($5::text[]) = 0 OR d.title ILIKE ANY($5) OR d.digest ILIKE ANY($5) OR EXISTS (SELECT 1 FROM unnest(d.keywords) k WHERE k ILIKE ANY($5)))
        ORDER BY d.ended_at DESC LIMIT 200`, [viewer.personId, viewer.role, range.from, range.to, patterns])).rows as (Row & { keywords: string[] })[];
      const scored = rows.map((row, index) => {
        const text = `${row.title}\n${row.keywords.join(" ")}\n${row.digest}`.toLowerCase();
        return { row, index, score: terms.filter((term) => text.includes(term)).length };
      }).sort((left, right) => right.score - left.score || left.index - right.index);
      const shown = scored.slice((page - 1) * SEARCH_PAGE, page * SEARCH_PAGE).map(({ row }) => ({
        ...entry(row), when: span(row), excerpt: clip(row.digest.replace(/^截至[^\n]*\n/, ""), EXCERPT_CHARS),
      }));
      if (shown.length) return { segments: shown, page, ...(scored.length > page * SEARCH_PAGE ? { nextPage: page + 1 } : {}) };
      if (!terms.length || page > 1) return { segments: [], message: NOTHING };
      // 纪要里没有：按原话查天枢页面的对话，命中的原话尽量对上它所在的段（还没切段、没纪要的就没有 segmentId）。
      const raw = await searchOwnConversationHistory(q, { personId: viewer.personId, query: args.query!, excludeRunId: options.excludeRunId });
      const hits = raw.hits.filter((hit) => (!range.from || new Date(hit.at) >= range.from) && (!range.to || new Date(hit.at) <= range.to));
      if (!hits.length) return { segments: [], message: NOTHING };
      const located = hits.map((hit) => /^cite:chat:([0-9a-f-]{36})#(\d+)$/.exec(hit.cite));
      const segments = (await q(`SELECT d.id, d.source_ref, d.from_position, d.to_position, d.scope_label FROM conversation_digests d
          WHERE ${VISIBLE} AND d.source = 'tianshu' AND d.source_ref = ANY($3::text[])`,
      [viewer.personId, viewer.role, located.flatMap((match) => (match ? [match[1]] : []))])).rows as { id: string; source_ref: string; from_position: string; to_position: string; scope_label: string }[];
      return { segments: [], note: "纪要里没有找到，下面是按原话查到的片段。", hits: hits.map((hit, index) => {
        const match = located[index];
        const segment = match && segments.find((row) => row.source_ref === match[1] && Number(row.from_position) <= Number(match[2]) && Number(match[2]) <= Number(row.to_position));
        return { ...(segment ? { segmentId: segment.id, page: segment.scope_label } : {}), at: shanghaiLabel(new Date(hit.at)),
          who: hit.role === "user" ? "本人" : "天枢", snippet: hit.snippet, cite: hit.cite };
      }) };
    },

    async read(viewer: RecallViewer, args: ReadArgs): Promise<unknown> {
      const missing = { error: "SEGMENT_NOT_FOUND", message: "没有这一段，或已经看不到了。" };
      if (!UUID.test(args.segmentId)) return missing;
      const row = (await q(`SELECT ${COLUMNS} FROM conversation_digests d WHERE ${VISIBLE} AND d.id = $3::uuid`, [viewer.personId, viewer.role, args.segmentId])).rows[0] as Row | undefined;
      if (!row) return missing;
      const base = { segmentId: row.id, page: row.scope_label, when: span(row), ...(row.title ? { title: row.title } : {}) };
      if (args.cursor === undefined) {
        return { ...base, ...(row.digest ? { digest: row.digest } : { note: "这一段还没有纪要。" }), rawCursor: "0", howToReadRaw: "要原话时带 cursor 再调一次，分页读原文。" };
      }
      if (!/^\d{1,18}$/.test(args.cursor)) return { error: "INVALID_CURSOR", message: "cursor 照抄上一次给的值。" };
      const messages: { who: string; at?: string; text: string }[] = [];
      let chars = 0;
      const push = (role: string, text: string, at?: Date) => {
        if (messages.length && chars + Math.min(text.length, RAW_PAGE_CHARS) > RAW_PAGE_CHARS) return false;
        chars += Math.min(text.length, RAW_PAGE_CHARS);
        messages.push({ who: role === "user" ? "本人" : "天枢", ...(at ? { at: shanghaiLabel(at) } : {}), text: clip(text, RAW_PAGE_CHARS) });
        return true;
      };
      if (row.source === "tianshu") {
        // 这一段的原文：从这段第一条到下一段开始之前（只看普通问答）。
        const rows = (await q(`SELECT m.sequence, m.role, m.content, m.created_at FROM conversation_messages m
            WHERE m.conversation_id = $1::uuid AND m.kind = 'message' AND m.sequence >= $2 AND m.sequence > $3
              AND m.sequence < COALESCE((SELECT min(n.from_position) FROM conversation_digests n
                WHERE n.source = 'tianshu' AND n.source_ref = $1::text AND n.from_position > $2), 9223372036854775807)
            ORDER BY m.sequence LIMIT 200`, [row.source_ref, row.from_position, args.cursor])).rows as { sequence: number; role: string; content: string; created_at: Date }[];
        let last: number | undefined;
        for (const message of rows) {
          if (!push(message.role, message.content, message.created_at)) return { ...base, messages, nextCursor: String(last) };
          last = message.sequence;
        }
        return { ...base, messages, nextCursor: rows.length === 200 && last !== undefined ? String(last) : null };
      }
      if (!chat) return { ...base, messages: [], nextCursor: null, note: "首页这一段的原文现在读不到，只有纪要。" };
      let cursor: string | null = args.cursor;
      let last = args.cursor;
      while (cursor !== null) {
        const page = await chat.messagesPage(viewer, `recall:${row.id}`, row.source_ref, cursor);
        for (const message of page.messages) {
          if (!push(message.role, message.text, message.turnAt ? new Date(message.turnAt) : undefined)) return { ...base, messages, nextCursor: last };
          last = message.position ?? last;
        }
        cursor = page.nextCursor;
      }
      return { ...base, messages, nextCursor: null };
    },
  };
}
