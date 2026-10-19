import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { TAcceptIssueDraftRequest, TIssueDraftContent, TIssueDraftLocation, TIssueDraftView } from "@warmap/contracts";
import { beijingLabel } from "./agentTime.js";
import { createCeoIssue, getIssueRow } from "./issues.js";
import type { Query } from "./meetingStore.js";
import { createObjectMaterial } from "./objectMaterials.js";
import { issueTitleSimilarity } from "./radarDedupe.js";

/**
 * 一号位深聊转议题（已定设计第 2 节，只在 CEO 首页）：
 * - 首页 Agent 判断三个条件同时满足（同一个问题连续聊了几轮、有要拍板的选项和取舍、还没有对应的议题）时调 propose_issue，
 *   这里写一条 issue_drafts：初稿、首页对话里相关那一段的起止序号、能对上的已有议题；回答后面附 ```issue-suggest 建议卡。
 * - 「不用」：记进 issue_suggestion_declines，同一话题不再提（服务端按话题相似度兜底，不只靠模型自觉）。
 * - 「开议题」：一号位确认或修改初稿、选好挂在哪个战场或作为全局战略议题后才建成；「接到议题 X」不新建。
 *   接受时同一个事务里：把相关那段首页对话复制进议题页对话（kind=carried）、首页写一行留痕（kind=trace，点击直达）、
 *   这段对话沉淀出的个人记忆改挂到这个议题上。新建的议题另存一份「议题初稿」材料，并照常启动预研（路由层）。
 * - 之后在首页再提到这件事：上下文里有已转出的议题清单（issueThreads），read_issue_conversation 读议题里已经聊到哪。
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
  id: string; owner_id: string; conversation_id: string; run_id: string; topic: string; start_sequence: number; end_sequence: number; turns: number;
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
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** 建议卡的代码块（服务端写进这一轮回答的末尾，前端 RichPre 画成卡）。 */
export const issueSuggestBlock = (draftId: string) => `\`\`\`${ISSUE_SUGGEST_FENCE}\n${JSON.stringify({ draftId })}\n\`\`\``;
/** 带进议题页时去掉建议卡的块。 */
export const withoutIssueSuggestBlocks = (text: string) => text.replace(/\n*```issue-suggest[ \t]*\n[\s\S]*?\n```[ \t]*/g, "").trimEnd();

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
      if (proposedThisTurn) return { proposed: true, draftId: proposedThisTurn, note: "这一轮已经提过，不要再调用。" };
      if (!Number.isInteger(args.turns) || args.turns < MIN_TURNS) {
        return { proposed: false, reason: "too_early", note: `围绕这个问题还没连续聊到 ${MIN_TURNS} 轮，先不提议，照常回答。` };
      }
      const declined = (await q("SELECT topic, title FROM issue_suggestion_declines WHERE owner_id = $1 ORDER BY created_at DESC LIMIT 100", [deps.ownerId])).rows as { topic: string; title: string }[];
      const hit = declined.find((item) => sameTopic(item.topic, topic) || sameTopic(item.title, title));
      if (hit) return { proposed: false, reason: "declined", note: `一号位对「${hit.topic}」说过不用转议题，同一话题不再提，照常回答，回答里也不提议题。` };
      const transferred = (await q(`SELECT d.topic, d.issue_id, i.title FROM issue_drafts d JOIN issues i ON i.id = d.issue_id
          WHERE d.owner_id = $1 AND d.status = 'accepted' ORDER BY d.decided_at DESC LIMIT 50`, [deps.ownerId])).rows as { topic: string; issue_id: string; title: string }[];
      const moved = transferred.find((item) => sameTopic(item.topic, topic) || sameTopic(item.title, title));
      if (moved) return { proposed: false, reason: "transferred", issue: { id: moved.issue_id, title: moved.title },
        note: `这件事已经转到议题「${moved.title}」，不再提议；先用 read_issue_conversation 看议题里聊到哪，再接着答。` };
      const pending = (await q(`SELECT id FROM issue_drafts WHERE owner_id = $1 AND conversation_id = $2 AND status = 'proposed' AND topic = $3 LIMIT 1`,
        [deps.ownerId, deps.conversationId, topic])).rows[0] as { id: string } | undefined;
      if (pending) return { proposed: false, reason: "pending", note: "同一话题的建议卡还在上面没处理，不要再提。" };
      const matched = args.matchIssueId && UUID.test(args.matchIssueId) ? await getIssueRow(q, args.matchIssueId) : null;
      // 相关那一段：往前数 turns 轮提问（含这一轮），不越过上一次转议题的留痕。
      const starts = (await q(`SELECT sequence FROM conversation_messages WHERE conversation_id = $1 AND role = 'user' AND kind = 'message' AND sequence <= $2
          AND sequence > COALESCE((SELECT max(sequence) FROM conversation_messages WHERE conversation_id = $1 AND kind = 'trace'), 0)
          ORDER BY sequence DESC LIMIT $3`, [deps.conversationId, deps.userSequence, Math.min(args.turns, 30)])).rows as { sequence: number }[];
      const start = Math.min(deps.userSequence, ...starts.map((row) => row.sequence));
      const turns = Math.max(1, starts.length);
      const draft: TIssueDraftContent = {
        title: [...title].slice(0, 25).join(""), whyNow: clip(args.whyNow.trim(), 1000),
        formedIdeas: (args.formedIdeas ?? []).map((item) => clip(item.trim(), 500)).filter(Boolean).slice(0, 8),
        options: (args.options ?? []).filter((item) => item.label?.trim()).slice(0, 5).map((item) => ({ label: clip(item.label.trim(), 60), tradeoff: clip(item.tradeoff?.trim() ?? "", 500) })),
        openQuestions: (args.openQuestions ?? []).map((item) => clip(item.trim(), 300)).filter(Boolean).slice(0, 8),
      };
      const location: TIssueDraftLocation | null = args.battlefieldId === "company" ? { level: "company" }
        : args.battlefieldId && (await q("SELECT 1 FROM battlefield_config WHERE id = $1", [args.battlefieldId])).rowCount ? { level: "battlefield", battlefieldId: args.battlefieldId } : null;
      const id = randomUUID();
      await q(`INSERT INTO issue_drafts (id, owner_id, conversation_id, run_id, topic, start_sequence, end_sequence, turns, draft, suggested_location, matched_issue_id, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, 'proposed', $12)`,
      [id, deps.ownerId, deps.conversationId, deps.runId, topic, start, deps.userSequence + 1, turns, JSON.stringify(draft), location ? JSON.stringify(location) : null,
        matched && matched.status !== "dismissed" ? matched.id : null, deps.now()]);
      proposedThisTurn = id;
      deps.onDraft(id);
      return { proposed: true, draftId: id, ...(matched && matched.status !== "dismissed" ? { matchedIssue: matched.title } : {}),
        note: matched ? `建议卡已附在回答后面，主选项是「接到议题 ${matched.title} 继续」。回答里只用一句话说为什么建议转议题。` : "建议卡已附在回答后面。回答里只用一句话说为什么建议转议题，不复述初稿。" };
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

type DraftError = { error: { status: 400 | 404 | 409; code: string; message: string } };
const fail = (status: 400 | 404 | 409, code: string, message: string): DraftError => ({ error: { status, code, message } });

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
 */
export async function acceptIssueDraft(pool: Pool, secret: string, ownerId: string, id: string, body: TAcceptIssueDraftRequest, now: Date):
  Promise<{ view: TIssueDraftView; created?: { issueId: string; draft: TIssueDraftContent } } | DraftError> {
  const client = await pool.connect();
  const q: Query = (sql, params) => client.query(sql, params);
  try {
    await client.query("BEGIN");
    const row = await draftRow(q, ownerId, id, true);
    if (!row) { await client.query("ROLLBACK"); return fail(404, "ISSUE_DRAFT_NOT_FOUND", "这条建议不存在"); }
    if (row.status === "accepted") { await client.query("COMMIT"); return { view: await viewOf(q, row) }; }
    if (row.status === "declined") { await client.query("ROLLBACK"); return fail(409, "ISSUE_DRAFT_DECLINED", "这条建议已经选了不用"); }
    const home = await client.query<{ scope: string }>("SELECT scope FROM conversations WHERE id = $1", [row.conversation_id]);
    const busy = async (scope: string) => !(await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked", [`${ownerId}|${scope}`])).rows[0]?.locked;
    if (await busy(home.rows[0]?.scope ?? "global")) { await client.query("ROLLBACK"); return fail(409, "TURN_IN_PROGRESS", "首页还有一轮回答没写完，写完再点"); }

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
    const target = await mainConversation(client, ownerId, scope);
    const segment = (await q(`SELECT sequence, role, content, references_snapshot, attachments, run_id, created_at, memory_used FROM conversation_messages
        WHERE conversation_id = $1 AND sequence BETWEEN $2 AND $3 AND kind = 'message' ORDER BY sequence`, [row.conversation_id, row.start_sequence, row.end_sequence])).rows as
      { sequence: number; role: string; content: string; references_snapshot: unknown; attachments: unknown; run_id: string; created_at: Date; memory_used: unknown }[];
    let next = (await q("SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM conversation_messages WHERE conversation_id = $1", [target])).rows[0].n as number;
    for (const message of segment) {
      const content = message.role === "assistant" ? withoutIssueSuggestBlocks(message.content) : message.content;
      await q(`INSERT INTO conversation_messages (conversation_id, sequence, role, content, references_snapshot, attachments, run_id, created_at, memory_used, kind, meta)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9::jsonb, 'carried', $10::jsonb)`,
      [target, next++, message.role, content || "（空）", JSON.stringify(message.references_snapshot ?? []), JSON.stringify(message.attachments ?? []), message.run_id,
        message.created_at, message.memory_used === null ? null : JSON.stringify(message.memory_used), JSON.stringify({ carriedFrom: { conversationId: row.conversation_id, sequence: message.sequence } })]);
    }
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
