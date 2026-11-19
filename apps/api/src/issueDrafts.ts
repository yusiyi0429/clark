import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { Type, type Static } from "@sinclair/typebox";
import type { TAcceptIssueDraftRequest, TIssueDraftContent, TIssueDraftLocation, TIssueDraftView } from "@warmap/contracts";
import { beijingLabel } from "./agentTime.js";
import type { ChatService } from "./chatService.js";
import { createCeoIssue, getIssueRow } from "./issues.js";
import type { Query } from "./meetingStore.js";
import { createObjectMaterial } from "./objectMaterials.js";
import { logEvent } from "./observability.js";
import { issueTitleSimilarity } from "./radarDedupe.js";
import type { ResearchService } from "./research.js";
import { cutText } from "./textCut.js";

/**
 * 一号位深聊转议题（已定设计第 2 节，只在 CEO 首页）：
 * - 首页 Agent 判断三个条件同时满足（同一个问题连续聊了几轮、有要拍板的选项和取舍、还没有对应的议题）时调 propose_issue，
 *   这里写一条 issue_drafts：初稿、首页对话里相关那一段的起止序号、能对上的已有议题；回答后面附 ```issue-suggest 建议卡。
 * - 「不用」：记进 issue_suggestion_declines，同一话题不再提（服务端按话题相似度兜底，不只靠模型自觉）。
 * - 「开议题」：一号位确认或修改初稿、选好挂在哪个战场或作为全局战略议题后才建成；「接到议题 X」不新建。
 *   接受时同一个事务里：把相关那段首页对话复制进议题页对话（kind=carried）、首页写一行留痕（kind=trace，点击直达）、
 *   这段对话沉淀出的个人记忆改挂到这个议题上。新建的议题另存一份「议题初稿」材料，并照常启动预研（路由层）。
 * - 之后在首页再提到这件事：上下文里有已转出的议题清单（issueThreads），read_issue_conversation 读议题里已经聊到哪。
 * - 首页走独立 Chat 时（11/02）：Chat 的 propose_issue 调 POST /internal/issue-drafts（proposeChatIssueDraft），拦法和初稿同上，
 *   建议挂在 Chat 那段对话的那一轮上；天枢读首页历史时把建议卡补在那一轮回答末尾（withChatIssueCards）。
 *   接受时相关那段从 Chat 现读、复制进议题页；首页留痕和记忆改挂不做（天枢写不进 Chat，Chat 模式不用天枢的个人记忆）。
 */

/** 至少连续聊了这么多轮才提。 */
export const MIN_TURNS = 3;
/** 话题相似到这个程度算同一话题（拒绝过的不再提、转过的不再提）。 */
const SAME_TOPIC = 0.5;
const ISSUE_SUGGEST_FENCE = "issue-suggest";

export const ISSUE_SUGGEST_RULES = `# 深聊转议题（只在首页）

三个条件同时满足才用 propose_issue 建议转成议题接着聊：一号位围绕同一个问题连续聊了至少 ${MIN_TURNS} 轮（含这一轮）；这个问题有要拍板的事（有选项、有取舍）；还没有对应的议题。缺一不提，一轮最多提一次。提之前先用 list_pending_issues 看有没有对得上的已有议题，对得上就把它的 id 填进 matchIssueId。\`declinedIssueTopics\` 是一号位说过「不用」的话题，同一话题不再提。\`issueThreads\` 是已经转成议题的话题：不再提议；一号位在首页再提到其中某件事时，先用 read_issue_conversation 读议题里已经聊到哪一步，再接着答，并告诉一号位可以去议题里接着聊。
调用时起草议题初稿：title（不超过 25 字）、whyNow（为什么现在要议）、formedIdeas（对话里已经形成的想法）、options（可选方案与各自的取舍）、openQuestions（还没定的问题）；topic 是几个字的话题名，turns 是围绕这个问题聊了几轮；能判断挂在哪个战场时填 battlefieldId，跨战场或公司层面的填 company。只写对话里真有的内容，不补没聊过的。界面会在回答后面附建议卡，回答里只用一句话说为什么建议转议题，不复述初稿，不写选项块。`;

type DraftRow = {
  id: string; owner_id: string; conversation_id: string | null; chat_conversation_id: string | null; run_id: string; topic: string;
  start_sequence: number | null; end_sequence: number | null; turns: number;
  draft: TIssueDraftContent; suggested_location: TIssueDraftLocation | null; matched_issue_id: string | null;
  status: "proposed" | "accepted" | "declined"; issue_id: string | null; mode: "new" | "existing" | null; decided_at: Date | null; created_at: Date;
};
export type ProposeIssueArgs = {
  topic: string; turns: number; title: string; whyNow: string; formedIdeas?: string[]; options?: { label: string; tradeoff?: string }[];
  openQuestions?: string[]; matchIssueId?: string; battlefieldId?: string;
};
export type IssueSuggest = {
  propose(args: ProposeIssueArgs): Promise<Record<string, unknown>>;
  readIssueConversation(issueId: string): Promise<Record<string, unknown>>;
};
export type IssueSuggestContext = {
  issueThreads: { issueId: string; title: string; status: string; transferredAt: string; turnsInIssue: number }[];
  declinedIssueTopics: string[];
};

const issueHref = (id: string) => `/issues/${id}`;
const sameTopic = (left: string, right: string) => issueTitleSimilarity(left, right) >= SAME_TOPIC;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clip = (text: string, max: number) => (text.length > max ? cutText(text, max) : text);

/** 建议卡的代码块（服务端写进这一轮回答的末尾，前端 RichPre 画成卡）。 */
export const issueSuggestBlock = (draftId: string) => `\`\`\`${ISSUE_SUGGEST_FENCE}\n${JSON.stringify({ draftId })}\n\`\`\``;
/** 带进议题页时去掉建议卡的块。 */
export const withoutIssueSuggestBlocks = (text: string) => text.replace(/\n*```issue-suggest[ \t]*\n[\s\S]*?\n```[ \t]*/g, "").trimEnd();

const ALREADY_PROPOSED = "这一轮已经提过，不要再调用。";

/**
 * 两个入口（天枢自己的首页对话、Chat）共用的拦法，依次：还没连续聊够轮数（explicit：本人明说要转，不看轮数）、说过不用的话题、
 * 已经转过的话题、同一段对话里同一话题的建议卡还没处理（where：天枢或 Chat 的那段对话）。都没拦下返回 null。
 */
async function screenProposal(q: Query, ownerId: string, where: { column: "conversation_id" | "chat_conversation_id"; id: string },
  args: { topic: string; title: string; turns: number; explicit?: boolean }): Promise<Record<string, unknown> | null> {
  const { topic, title } = args;
  if (!args.explicit && (!Number.isInteger(args.turns) || args.turns < MIN_TURNS)) {
    return { proposed: false, reason: "too_early", note: `围绕这个问题还没连续聊到 ${MIN_TURNS} 轮，先不提议，照常回答。` };
  }
  const declined = (await q("SELECT topic, title FROM issue_suggestion_declines WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 100", [ownerId])).rows as { topic: string; title: string }[];
  const hit = declined.find((item) => sameTopic(item.topic, topic) || sameTopic(item.title, title));
  if (hit) return { proposed: false, reason: "declined", note: `一号位对「${hit.topic}」说过不用转议题，同一话题不再提，照常回答，回答里也不提议题。` };
  const transferred = (await q(`SELECT d.topic, d.issue_id, i.title FROM issue_drafts d JOIN issues i ON i.id = d.issue_id
      WHERE d.owner_id = $1 AND d.status = 'accepted' ORDER BY d.decided_at DESC LIMIT 50`, [ownerId])).rows as { topic: string; issue_id: string; title: string }[];
  const moved = transferred.find((item) => sameTopic(item.topic, topic) || sameTopic(item.title, title));
  if (moved) return { proposed: false, reason: "transferred", issue: { id: moved.issue_id, title: moved.title },
    note: `这件事已经转到议题「${moved.title}」，不再提议；先用 read_issue_conversation 看议题里聊到哪，再接着答。` };
  const pending = (await q(`SELECT id FROM issue_drafts WHERE owner_id = $1 AND ${where.column} = $2 AND status = 'proposed' AND topic = $3 LIMIT 1`,
    [ownerId, where.id, topic])).rows[0] as { id: string } | undefined;
  if (pending) return { proposed: false, reason: "pending", note: "同一话题的建议卡还在上面没处理，不要再提。" };
  return null;
}

/** 初稿：只留对话里真有的内容，各项截到界面能放下的长度。 */
const draftContent = (args: Pick<ProposeIssueArgs, "whyNow" | "formedIdeas" | "options" | "openQuestions">, title: string): TIssueDraftContent => ({
  title: [...title].slice(0, 25).join(""), whyNow: clip(args.whyNow.trim(), 1000),
  formedIdeas: (args.formedIdeas ?? []).map((item) => clip(item.trim(), 500)).filter(Boolean).slice(0, 8),
  options: (args.options ?? []).filter((item) => item.label?.trim()).slice(0, 5).map((item) => ({ label: clip(item.label.trim(), 60), tradeoff: clip(item.tradeoff?.trim() ?? "", 500) })),
  openQuestions: (args.openQuestions ?? []).map((item) => clip(item.trim(), 300)).filter(Boolean).slice(0, 8),
});

const matchedIssueOf = async (q: Query, matchIssueId: string | undefined) => (matchIssueId && UUID.test(matchIssueId) ? getIssueRow(q, matchIssueId) : null);

const proposedResult = (id: string, matched: Awaited<ReturnType<typeof getIssueRow>>) => ({
  proposed: true, draftId: id, ...(matched && matched.status !== "dismissed" ? { matchedIssue: matched.title } : {}),
  note: matched ? `建议卡已附在回答后面，主选项是「接到议题 ${matched.title} 继续」。回答里只用一句话说为什么建议转议题。` : "建议卡已附在回答后面。回答里只用一句话说为什么建议转议题，不复述初稿。",
});

/** 首页对话里的建议：绑定本人和这一轮（只给 CEO 的首页对话）。onDraft：这一轮提了哪条建议（路由层据此在回答末尾附建议卡）。 */
export function createIssueSuggest(deps: {
  pool: Pool; ownerId: string; conversationId: string; runId: string; userSequence: number; now: () => Date;
  onDraft: (draftId: string) => void;
}): IssueSuggest {
  const q: Query = (sql, params) => deps.pool.query(sql, params);
  let proposedThisTurn: string | undefined;
  return {
    async propose(args) {
      const topic = args.topic.trim().slice(0, 60), title = args.title.trim();
      if (proposedThisTurn) return { proposed: true, draftId: proposedThisTurn, note: ALREADY_PROPOSED };
      const refused = await screenProposal(q, deps.ownerId, { column: "conversation_id", id: deps.conversationId }, { topic, title, turns: args.turns });
      if (refused) return refused;
      const matched = await matchedIssueOf(q, args.matchIssueId);
      // 相关那一段：往前数 turns 轮提问（含这一轮），不越过上一次转议题的留痕。
      const starts = (await q(`SELECT sequence FROM conversation_messages WHERE conversation_id = $1 AND role = 'user' AND kind = 'message' AND sequence <= $2
          AND sequence > COALESCE((SELECT max(sequence) FROM conversation_messages WHERE conversation_id = $1 AND kind = 'trace'), 0)
          ORDER BY sequence DESC LIMIT $3`, [deps.conversationId, deps.userSequence, Math.min(args.turns, 30)])).rows as { sequence: number }[];
      const start = Math.min(deps.userSequence, ...starts.map((row) => row.sequence));
      const turns = Math.max(1, starts.length);
      const draft = draftContent(args, title);
      const location: TIssueDraftLocation | null = args.battlefieldId === "company" ? { level: "company" }
        : args.battlefieldId && (await q("SELECT 1 FROM battlefield_config WHERE id = $1", [args.battlefieldId])).rowCount ? { level: "battlefield", battlefieldId: args.battlefieldId } : null;
      const id = randomUUID();
      await q(`INSERT INTO issue_drafts (id, owner_id, conversation_id, run_id, topic, start_sequence, end_sequence, turns, draft, suggested_location, matched_issue_id, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, 'proposed', $12)`,
      [id, deps.ownerId, deps.conversationId, deps.runId, topic, start, deps.userSequence + 1, turns, JSON.stringify(draft), location ? JSON.stringify(location) : null,
        matched && matched.status !== "dismissed" ? matched.id : null, deps.now()]);
      proposedThisTurn = id;
      deps.onDraft(id);
      return proposedResult(id, matched);
    },

    async readIssueConversation(issueId) {
      const issue = UUID.test(issueId) ? await getIssueRow(q, issueId) : null;
      if (!issue) return { error: "ISSUE_NOT_FOUND", message: "没有这个议题" };
      const rows = (await q(`SELECT m.role, m.content, m.created_at, m.kind FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.owner_id = $1 AND c.scope = $2 AND c.deleted_at IS NULL AND c.archived_at IS NULL AND m.kind <> 'trace'
          ORDER BY m.sequence DESC LIMIT 12`, [deps.ownerId, `issue:${issueId}`])).rows as { role: string; content: string; created_at: Date; kind: string }[];
      const decisions = (issue.receipts ?? []).filter((item) => !item.revokedAt).map((item) => clip(item.decisionText, 300));
      return {
        issue: { title: issue.title, status: issue.status === "pending" ? "待决策" : issue.status === "decided" ? "已决定" : "已搁置", ...(decisions.length ? { decisions } : {}) },
        messages: rows.reverse().map((row) => ({ role: row.role === "user" ? "一号位" : "天枢", ...(row.kind === "carried" ? { fromHome: true } : {}),
          at: beijingLabel(row.created_at), text: clip(withoutIssueSuggestBlocks(row.content), 800) })),
        cite: `issue:${issueId}`,
      };
    },
  };
}

/** 每轮放进首页上下文的：已经转成议题的话题（最近 8 个）、一号位说过「不用」的话题（最近 20 个）。 */
export async function issueSuggestContext(q: Query, ownerId: string): Promise<IssueSuggestContext> {
  const [threads, declined] = await Promise.all([
    q(`SELECT d.issue_id, i.title, i.status, d.decided_at,
         (SELECT count(*)::int FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE c.owner_id = d.owner_id AND c.scope = 'issue:' || d.issue_id::text AND c.deleted_at IS NULL AND m.role = 'user' AND m.kind = 'message') AS turns
       FROM issue_drafts d JOIN issues i ON i.id = d.issue_id WHERE d.owner_id = $1 AND d.status = 'accepted' ORDER BY d.decided_at DESC LIMIT 8`, [ownerId]),
    q("SELECT topic FROM issue_suggestion_declines WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 20", [ownerId]),
  ]);
  return {
    issueThreads: (threads.rows as { issue_id: string; title: string; status: string; decided_at: Date; turns: number }[]).map((row) => ({
      issueId: row.issue_id, title: row.title, status: row.status === "pending" ? "待决策" : row.status === "decided" ? "已决定" : "已搁置",
      transferredAt: beijingLabel(row.decided_at), turnsInIssue: row.turns })),
    declinedIssueTopics: (declined.rows as { topic: string }[]).map((row) => row.topic),
  };
}

// ---------- 首页走 Chat 时的建议 ----------

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
/** POST /internal/issue-drafts 的请求体（与 Chat 的 propose_issue 对齐的固定契约）。 */
export const ChatProposeIssueBody = Type.Object({
  conversationId: Type.String({ pattern: UUID_PATTERN }),
  runId: Type.String({ pattern: UUID_PATTERN }),
  explicit: Type.Boolean(),
  topic: Type.String({ minLength: 1, maxLength: 60, pattern: "\\S" }),
  turns: Type.Integer({ minimum: 1, maximum: 50 }),
  title: Type.String({ minLength: 1, maxLength: 60, pattern: "\\S" }),
  whyNow: Type.String({ minLength: 1, maxLength: 1000, pattern: "\\S" }),
  formedIdeas: Type.Optional(Type.Array(Type.String())),
  options: Type.Optional(Type.Array(Type.Object({ label: Type.String(), tradeoff: Type.Optional(Type.String()) }))),
  openQuestions: Type.Optional(Type.Array(Type.String())),
  matchIssueId: Type.Optional(Type.String({ pattern: UUID_PATTERN })),
  level: Type.Optional(Type.Union([Type.Literal("company"), Type.Literal("battlefield")])),
  battlefieldName: Type.Optional(Type.String()),
}, { additionalProperties: false });
export type TChatProposeIssueBody = Static<typeof ChatProposeIssueBody>;

/** Chat 给的战场名 → 战场：先找同名的，再找互相包含且只对上一个的；对不上留空（卡上由一号位选）。 */
async function battlefieldNamed(q: Query, name: string): Promise<TIssueDraftLocation | null> {
  const rows = (await q("SELECT id, name FROM battlefield_config ORDER BY sort_order, code, id")).rows as { id: string; name: string }[];
  const near = rows.filter((row) => row.name && (row.name.includes(name) || name.includes(row.name)));
  const hit = rows.find((row) => row.name === name) ?? (near.length === 1 ? near[0] : undefined);
  return hit ? { level: "battlefield", battlefieldId: hit.id } : null;
}

/**
 * Chat 的 propose_issue（POST /internal/issue-drafts）：拦法、初稿与天枢自己的首页对话一样；建议挂在 Chat 那段对话的这一轮上，
 * 相关那段不在这里定（这一轮的回答还没写完），接受时从 Chat 现读。一轮最多一条，同一轮再调拿回原来那条。
 */
export async function proposeChatIssueDraft(q: Query, ownerId: string, body: TChatProposeIssueBody, now: Date): Promise<Record<string, unknown>> {
  const topic = body.topic.trim().slice(0, 60), title = body.title.trim();
  const sameRun = async () => (await q("SELECT id FROM issue_drafts WHERE chat_conversation_id = $1 AND run_id = $2 AND owner_id = $3",
    [body.conversationId, body.runId, ownerId])).rows[0] as { id: string } | undefined;
  const earlier = await sameRun();
  if (earlier) return { proposed: true, draftId: earlier.id, note: ALREADY_PROPOSED };
  const refused = await screenProposal(q, ownerId, { column: "chat_conversation_id", id: body.conversationId }, { topic, title, turns: body.turns, explicit: body.explicit });
  if (refused) return refused;
  const matched = await matchedIssueOf(q, body.matchIssueId);
  const location: TIssueDraftLocation | null = body.level === "company" ? { level: "company" }
    : body.battlefieldName?.trim() ? await battlefieldNamed(q, body.battlefieldName.trim()) : null;
  const id = randomUUID();
  const inserted = await q(`INSERT INTO issue_drafts (id, owner_id, chat_conversation_id, run_id, topic, turns, draft, suggested_location, matched_issue_id, status, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, 'proposed', $10)
    ON CONFLICT (chat_conversation_id, run_id) WHERE chat_conversation_id IS NOT NULL DO NOTHING`,
  [id, ownerId, body.conversationId, body.runId, topic, Math.min(body.turns, 30), JSON.stringify(draftContent(body, title)),
    location ? JSON.stringify(location) : null, matched && matched.status !== "dismissed" ? matched.id : null, now]);
  if (!inserted.rowCount) return { proposed: true, draftId: (await sameRun())?.id, note: ALREADY_PROPOSED };
  return proposedResult(id, matched);
}

/**
 * 首页走 Chat 时的历史（只给 CEO）：有建议的那一轮，在它最后一条回答末尾补上建议卡的块（天枢写不进 Chat，读历史时补）；
 * 卡按建议现在的状态自己画（待处理 / 已转到议题 / 已忽略）。
 */
export async function withChatIssueCards<T extends { role: string; content: string; runId: string; kind?: string }>(q: Query, ownerId: string, messages: T[]): Promise<T[]> {
  // 段之间的日期行 runId 不是一轮（可能是空的），不拿去查。
  const runIds = [...new Set(messages.map((message) => message.runId).filter((runId) => UUID.test(runId)))];
  if (!runIds.length) return messages;
  const drafts = (await q("SELECT id, run_id FROM issue_drafts WHERE owner_id = $1 AND chat_conversation_id IS NOT NULL AND run_id = ANY($2::uuid[])",
    [ownerId, runIds])).rows as { id: string; run_id: string }[];
  if (!drafts.length) return messages;
  const draftOf = new Map(drafts.map((row) => [row.run_id, row.id]));
  const lastAnswer = new Map<string, number>();
  messages.forEach((message, index) => {
    if (message.role === "assistant" && message.kind !== "trace" && draftOf.has(message.runId)) lastAnswer.set(message.runId, index);
  });
  return messages.map((message, index) => (lastAnswer.get(message.runId) === index
    ? { ...message, content: `${message.content.trimEnd()}\n\n${issueSuggestBlock(draftOf.get(message.runId)!)}` } : message));
}

type ChatSegmentReader = Pick<ChatService, "messagesPage">;
type ChatMessage = Awaited<ReturnType<ChatService["messagesPage"]>>["messages"][number];

/**
 * Chat 那段对话里相关的一段（接受时在事务外现读）：到提议那一轮的回答为止，往前数 turns 轮提问（含那一轮）；
 * 不越过这段对话里之前已经转出去的那几轮。找不到那一轮时是空的（议题照样建，只是没有带过去的对话）。
 */
async function chatDraftSegment(q: Query, chat: ChatSegmentReader, ownerId: string, row: DraftRow): Promise<ChatMessage[]> {
  const viewer = { personId: ownerId, role: "ceo" as const }, requestId = randomUUID();
  const messages: ChatMessage[] = [];
  for (let cursor: string | null = "0"; cursor !== null;) {
    const page = await chat.messagesPage(viewer, requestId, row.chat_conversation_id!, cursor);
    messages.push(...page.messages);
    cursor = page.nextCursor;
  }
  let end = messages.length - 1;
  while (end >= 0 && messages[end].runId !== row.run_id) end -= 1;
  if (end < 0) return [];
  const carried = new Set(((await q("SELECT run_id FROM issue_drafts WHERE chat_conversation_id = $1 AND status = 'accepted' AND id <> $2",
    [row.chat_conversation_id, row.id])).rows as { run_id: string }[]).map((item) => item.run_id));
  let start = end + 1, asked = 0;
  for (let index = end; index >= 0 && asked < row.turns && !carried.has(messages[index].runId); index -= 1) {
    start = index;
    if (messages[index].role === "user") asked += 1;
  }
  return messages.slice(start, end + 1);
}

// ---------- 建议卡的读取、接受、拒绝 ----------

async function draftRow(q: Query, ownerId: string, id: string, lock = false): Promise<DraftRow | null> {
  if (!UUID.test(id)) return null;
  return (await q(`SELECT * FROM issue_drafts WHERE id = $1 AND owner_id = $2${lock ? " FOR UPDATE" : ""}`, [id, ownerId])).rows[0] as DraftRow | undefined ?? null;
}

async function viewOf(q: Query, row: DraftRow): Promise<TIssueDraftView> {
  // 依次查：q 可能是事务里的同一个连接。
  const matched = row.matched_issue_id ? await getIssueRow(q, row.matched_issue_id) : null;
  const issue = row.issue_id ? await getIssueRow(q, row.issue_id) : null;
  const battlefields = await q("SELECT id, name FROM battlefield_config ORDER BY sort_order, code, id");
  return {
    id: row.id, status: row.status, draft: row.draft, suggestedLocation: row.suggested_location,
    matchedIssue: matched ? { id: matched.id, title: matched.title, href: issueHref(matched.id) } : null,
    issue: issue ? { id: issue.id, title: issue.title, href: issueHref(issue.id) } : null,
    battlefields: (battlefields.rows as { id: string; name: string }[]).map(({ id, name }) => ({ id, name })),
    turns: row.turns,
  };
}

export async function getIssueDraftView(q: Query, ownerId: string, id: string): Promise<TIssueDraftView | null> {
  const row = await draftRow(q, ownerId, id);
  return row ? viewOf(q, row) : null;
}

type DraftError = { error: { status: 400 | 404 | 409 | 503; code: string; message: string } };
const fail = (status: 400 | 404 | 409 | 503, code: string, message: string): DraftError => ({ error: { status, code, message } });

/** 主对话（这个人在这个页面最早一条未删除、未归档的会话）；没有就建一条。 */
async function mainConversation(client: PoolClient, ownerId: string, scope: string): Promise<string> {
  const found = await client.query<{ id: string }>(`SELECT id FROM conversations WHERE owner_id = $1 AND scope = $2 AND deleted_at IS NULL AND archived_at IS NULL
    ORDER BY created_at ASC, id ASC LIMIT 1`, [ownerId, scope]);
  if (found.rows[0]) return found.rows[0].id;
  const id = randomUUID();
  await client.query("INSERT INTO conversations (id, owner_id, scope, pi_session_id) VALUES ($1, $2, $3, $4)", [id, ownerId, scope, randomUUID()]);
  return id;
}

/** 议题初稿的 Markdown（新建的议题存成一份群材料）。 */
export function draftMarkdown(draft: TIssueDraftContent): string {
  const lines = [`# ${draft.title}`, "", "## 为什么现在要议", "", draft.whyNow];
  if (draft.formedIdeas.length) lines.push("", "## 已经形成的想法", "", ...draft.formedIdeas.map((item) => `- ${item}`));
  if (draft.options.length) lines.push("", "## 可选方案", "", ...draft.options.map((item) => `- **${item.label}**${item.tradeoff ? `：${item.tradeoff}` : ""}`));
  if (draft.openQuestions.length) lines.push("", "## 还没定的问题", "", ...draft.openQuestions.map((item) => `- ${item}`));
  return lines.join("\n");
}

/**
 * 接受建议：开议题（新建）或接到已有议题。一个事务里完成新建议题、复制相关那段对话、首页留痕、改挂个人记忆；
 * 首页或议题页这时有正在进行的回答就 409（等它写完再点）。重放（已接受）直接返回原结果。
 * created：这次新建的议题 id（路由层在事务之后启动预研、存初稿材料）。
 * Chat 来的建议（chat_conversation_id）：相关那段先从 Chat 读好（事务外，不占着锁等网络）；首页在 Chat 那边，不查天枢首页的进行中，
 * 不写首页留痕、不改挂记忆。没接 Chat 时 503。
 */
export async function acceptIssueDraft(pool: Pool, secret: string, ownerId: string, id: string, body: TAcceptIssueDraftRequest, now: Date, chat?: ChatSegmentReader):
  Promise<{ view: TIssueDraftView; created?: { issueId: string; draft: TIssueDraftContent } } | DraftError> {
  const before = await draftRow((sql, params) => pool.query(sql, params), ownerId, id);
  let fromChat: ChatMessage[] = [];
  if (before?.chat_conversation_id && before.status === "proposed") {
    if (!chat) return fail(503, "CHAT_UNAVAILABLE", "对话服务没有接上，这条建议现在转不了");
    fromChat = await chatDraftSegment((sql, params) => pool.query(sql, params), chat, ownerId, before);
  }
  const client = await pool.connect();
  const q: Query = (sql, params) => client.query(sql, params);
  try {
    await client.query("BEGIN");
    const row = await draftRow(q, ownerId, id, true);
    if (!row) { await client.query("ROLLBACK"); return fail(404, "ISSUE_DRAFT_NOT_FOUND", "这条建议不存在"); }
    if (row.status === "accepted") { await client.query("COMMIT"); return { view: await viewOf(q, row) }; }
    if (row.status === "declined") { await client.query("ROLLBACK"); return fail(409, "ISSUE_DRAFT_DECLINED", "这条建议已经选了不用"); }
    const busy = async (scope: string) => !(await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked", [`${ownerId}|${scope}`])).rows[0]?.locked;
    if (row.conversation_id) {
      const home = await client.query<{ scope: string }>("SELECT scope FROM conversations WHERE id = $1", [row.conversation_id]);
      if (await busy(home.rows[0]?.scope ?? "global")) { await client.query("ROLLBACK"); return fail(409, "TURN_IN_PROGRESS", "首页还有一轮回答没写完，写完再点"); }
    }

    let issueId: string, issueTitle: string, created: { issueId: string; draft: TIssueDraftContent } | undefined;
    if (body.mode === "new") {
      const result = await createCeoIssue(client, secret, { title: body.draft.title, ...(body.location.level === "battlefield" ? { battlefieldId: body.location.battlefieldId } : {}) });
      if (result.status !== 201) { await client.query("ROLLBACK"); return fail(400, result.code, result.message); }
      issueId = result.card.objectRef.id;
      issueTitle = result.card.title;
      created = { issueId, draft: body.draft };
    } else {
      const issue = await getIssueRow(q, body.issueId);
      if (!issue || issue.status === "dismissed") { await client.query("ROLLBACK"); return fail(404, "ISSUE_NOT_FOUND", "议题不存在或已搁置"); }
      issueId = issue.id;
      issueTitle = issue.title;
    }
    const scope = `issue:${issueId}`;
    if (await busy(scope)) { await client.query("ROLLBACK"); return fail(409, "TURN_IN_PROGRESS", "议题页还有一轮回答没写完，写完再点"); }

    // 相关那一段：首页 start..end 之间的普通问答，原样（含引用、附件、用到的记忆），去掉建议卡的块；时间保留原来的。
    // Chat 来的用上面从 Chat 读好的那段：引用、附件是 Chat 的，不带过来；时间用那一轮开始的时间，carriedFrom 指回 Chat 的那段对话和那一轮。
    const target = await mainConversation(client, ownerId, scope);
    const segment = row.conversation_id ? (await q(`SELECT sequence, role, content, references_snapshot, attachments, run_id, created_at, memory_used FROM conversation_messages
        WHERE conversation_id = $1 AND sequence BETWEEN $2 AND $3 AND kind = 'message' ORDER BY sequence`, [row.conversation_id, row.start_sequence, row.end_sequence])).rows as
      { sequence: number; role: string; content: string; references_snapshot: unknown; attachments: unknown; run_id: string; created_at: Date; memory_used: unknown }[] : [];
    const copies = row.conversation_id
      ? segment.map((message) => ({ ...message, carriedFrom: { conversationId: row.conversation_id, sequence: message.sequence } }))
      : fromChat.map((message) => ({ role: message.role, content: message.text, references_snapshot: [], attachments: [], run_id: message.runId,
        created_at: message.turnAt ? new Date(message.turnAt) : now, memory_used: null,
        carriedFrom: { chatConversationId: row.chat_conversation_id, runId: message.runId, ...(message.position ? { position: message.position } : {}) } }));
    let next = (await q("SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM conversation_messages WHERE conversation_id = $1", [target])).rows[0].n as number;
    for (const message of copies) {
      const content = message.role === "assistant" ? withoutIssueSuggestBlocks(message.content) : message.content;
      await q(`INSERT INTO conversation_messages (conversation_id, sequence, role, content, references_snapshot, attachments, run_id, created_at, memory_used, kind, meta)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9::jsonb, 'carried', $10::jsonb)`,
      [target, next++, message.role, content || "（空）", JSON.stringify(message.references_snapshot ?? []), JSON.stringify(message.attachments ?? []), message.run_id,
        message.created_at, message.memory_used === null ? null : JSON.stringify(message.memory_used), JSON.stringify({ carriedFrom: message.carriedFrom })]);
    }
    if (row.conversation_id) {
      // 首页留痕：一行「已转到议题 X」，点击直达。
      await q(`INSERT INTO conversation_messages (conversation_id, sequence, role, content, run_id, created_at, kind, meta)
        VALUES ($1, (SELECT COALESCE(MAX(sequence), 0) + 1 FROM conversation_messages WHERE conversation_id = $1), 'assistant', $2, $3, $4, 'trace', $5::jsonb)`,
      [row.conversation_id, `已转到议题「${issueTitle}」`, randomUUID(), now, JSON.stringify({ issueId, title: issueTitle, href: issueHref(issueId) })]);
      // 这段对话沉淀出的个人记忆改挂到议题上（去掉主题 anchor，加上议题）。
      const refs = segment.map((message) => `chat:${row.conversation_id}#${message.sequence}`);
      const issueVersion = (await getIssueRow(q, issueId))?.version ?? 1;
      if (refs.length) await q(`UPDATE personal_memory_items
          SET anchors = COALESCE((SELECT jsonb_agg(a) FROM jsonb_array_elements(anchors) a WHERE a->>'target' NOT LIKE 'topic:%' AND a->>'target' <> $3), '[]'::jsonb)
            || jsonb_build_array(jsonb_build_object('target', $3::text, 'pinnedVersion', $4::int)), updated_at = now()
        WHERE person_id = $1 AND status = 'active' AND EXISTS (SELECT 1 FROM jsonb_array_elements(refs) r WHERE r->>'ref' = ANY($2::text[]))`,
      [ownerId, refs, scope, issueVersion]);
    }
    const final = body.mode === "new" ? body.draft : row.draft;
    const updated = (await q(`UPDATE issue_drafts SET status = 'accepted', issue_id = $2, mode = $3, draft = $4::jsonb, decided_at = $5 WHERE id = $1 RETURNING *`,
      [row.id, issueId, body.mode, JSON.stringify(final), now])).rows[0] as DraftRow;
    await client.query("COMMIT");
    return { view: await viewOf(q, updated), ...(created ? { created } : {}) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** 新建的议题存一份「议题初稿」群材料（议题页能看到）；失败不影响议题本身。 */
export async function saveDraftMaterial(pool: Pool, viewer: { personId: string; role: "ceo" | "member"; displayName: string }, issueId: string, draft: TIssueDraftContent): Promise<void> {
  await createObjectMaterial(pool, { objectType: "issue", objectId: issueId }, viewer, "议题初稿", draftMarkdown(draft), "首页对话转议题时的初稿", null);
}

/**
 * 接受建议新建了议题之后（卡上点和 Chat 里打字确认共用）：与其他议题创建路径一致，立即启动预研；初稿存成议题的一份群材料。
 * 都不阻塞响应、失败不影响议题本身。
 */
export async function afterIssueDraftCreated(pool: Pool, research: Pick<ResearchService, "start">, viewer: { personId: string; displayName: string },
  created: { issueId: string; draft: TIssueDraftContent }): Promise<void> {
  const { issueId, draft } = created;
  research.start(issueId).catch((error) => logEvent({ event: "issue_draft.research_failed", issueId, error: (error as Error)?.message }));
  await saveDraftMaterial(pool, { personId: viewer.personId, role: "ceo", displayName: viewer.displayName }, issueId, draft)
    .catch((error) => logEvent({ event: "issue_draft.material_failed", issueId, error: (error as Error)?.message }));
}

/** 「不用」：这个话题记进拒绝名单，之后不再提。重放返回原结果。 */
export async function declineIssueDraft(pool: Pool, ownerId: string, id: string, now: Date): Promise<{ view: TIssueDraftView } | DraftError> {
  const client = await pool.connect();
  const q: Query = (sql, params) => client.query(sql, params);
  try {
    await client.query("BEGIN");
    const row = await draftRow(q, ownerId, id, true);
    if (!row) { await client.query("ROLLBACK"); return fail(404, "ISSUE_DRAFT_NOT_FOUND", "这条建议不存在"); }
    if (row.status === "accepted") { await client.query("ROLLBACK"); return fail(409, "ISSUE_DRAFT_ACCEPTED", "这条建议已经转成议题"); }
    let current = row;
    if (row.status === "proposed") {
      current = (await q("UPDATE issue_drafts SET status = 'declined', decided_at = $2 WHERE id = $1 RETURNING *", [row.id, now])).rows[0] as DraftRow;
      await q(`INSERT INTO issue_suggestion_declines (id, owner_id, topic, title, draft_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (owner_id, topic) DO NOTHING`, [randomUUID(), ownerId, row.topic, row.draft.title, row.id, now]);
    }
    await client.query("COMMIT");
    return { view: await viewOf(q, current) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ---------- Chat 里打字确认、不用 ----------

/** POST /internal/issue-drafts/decide 的请求体（与 Chat 的 decide_issue_draft 对齐的固定契约）。 */
export const ChatDecideIssueBody = Type.Object({
  conversationId: Type.String({ pattern: UUID_PATTERN }),
  decision: Type.Union([Type.Literal("accept"), Type.Literal("decline")]),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 25, pattern: "\\S" })),
  level: Type.Optional(Type.Union([Type.Literal("company"), Type.Literal("battlefield")])),
  battlefieldName: Type.Optional(Type.String({ maxLength: 40 })),
  mode: Type.Optional(Type.Union([Type.Literal("new"), Type.Literal("existing")])),
}, { additionalProperties: false });
export type TChatDecideIssueBody = Static<typeof ChatDecideIssueBody>;

type IssueLink = { id: string; title: string; href: string };
export type ChatDecision =
  | { decision: "accepted"; draftId: string; issue: IssueLink; note: string; created?: { issueId: string; draft: TIssueDraftContent } }
  | { decision: "already_accepted"; draftId: string; issue: IssueLink; note: string }
  | { decision: "declined"; draftId: string; note: string };

const alreadyAccepted = (draftId: string, issue: IssueLink): ChatDecision => ({ decision: "already_accepted", draftId, issue,
  note: `这个话题已经转到议题「${issue.title}」，不用再转；回答里一句话告诉一号位可以去议题里接着聊` });

/**
 * 一号位不点卡、打字或说话确认（11/02，Chat 的 decide_issue_draft）：处理这段 Chat 对话里最近的那条建议，和卡上点的是同一条路
 * （acceptIssueDraft / declineIssueDraft）。接受时缺省按卡上原样新建：标题可改；挂在哪按 level / battlefieldName，没说就用建议里的，再没有就是全局。
 * 接到已有议题（mode=existing）只在建议对上了已有议题时。created：这次新建的议题（路由层接着启动预研、存初稿材料）。
 */
export async function decideChatIssueDraft(pool: Pool, secret: string, ownerId: string, body: TChatDecideIssueBody, now: Date, chat?: ChatSegmentReader):
  Promise<ChatDecision | DraftError> {
  const q: Query = (sql, params) => pool.query(sql, params);
  const row = (await q("SELECT * FROM issue_drafts WHERE owner_id = $1 AND chat_conversation_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1",
    [ownerId, body.conversationId])).rows[0] as DraftRow | undefined;
  if (!row || (row.status === "declined" && body.decision === "accept")) return fail(404, "NO_PENDING_DRAFT", "这段对话里没有待处理的转议题建议");
  if (row.status === "accepted") return alreadyAccepted(row.id, (await viewOf(q, row)).issue!);
  if (body.decision === "decline") {
    const result = await declineIssueDraft(pool, ownerId, row.id, now);
    return "error" in result ? result : { decision: "declined", draftId: row.id, note: "这个话题记为不用转议题；一句话回应即可" };
  }
  let request: TAcceptIssueDraftRequest;
  if (body.mode === "existing") {
    if (!row.matched_issue_id) return fail(400, "NO_MATCHED_ISSUE", "这条建议没有对上的已有议题，只能新建议题");
    request = { mode: "existing", issueId: row.matched_issue_id };
  } else {
    let location: TIssueDraftLocation | null = body.level === "company" ? { level: "company" } : null;
    const name = body.battlefieldName?.trim();
    if (!location && name) {
      // 说了战场却对不上：不悄悄挂到别处，回去让一号位说清楚。
      location = await battlefieldNamed(q, name);
      if (!location) {
        const names = (await q("SELECT name FROM battlefield_config ORDER BY sort_order, code, id")).rows.map((item) => (item as { name: string }).name).filter(Boolean);
        return fail(400, "BATTLEFIELD_NOT_FOUND", `没有对得上「${name}」的战场；现有战场：${names.join("、") || "无"}`);
      }
    }
    request = { mode: "new", draft: { ...row.draft, ...(body.title ? { title: body.title.trim() } : {}) }, location: location ?? row.suggested_location ?? { level: "company" } };
  }
  const result = await acceptIssueDraft(pool, secret, ownerId, row.id, request, now, chat);
  if ("error" in result) return result;
  const issue = result.view.issue!;
  // 要新建却没新建：卡上同时点了接受（两边一前一后），这边拿到的是已接受的结果。
  if (request.mode === "new" && !result.created) return alreadyAccepted(row.id, issue);
  return { decision: "accepted", draftId: row.id, issue, ...(result.created ? { created: result.created } : {}),
    note: "议题已建成；回答里一句话告诉一号位议题已经建好，可以去议题里接着聊" };
}
