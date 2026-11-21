import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  TConfirmDocChangeRequest, TDocChangeCandidate, TDocChangeView, TDocOwnerAnswerRequest, TImpactBasisChoiceRequest, TImpactCardView, TRequestStep,
} from "@warmap/contracts";
import type { DocChangeAgent } from "./docChangeAgent.js";
import type { FeishuClient, FeishuDocType } from "./feishu/client.js";
import type { FeishuEnv } from "./feishu/config.js";
import { feishuNotifier } from "./feishu/notify.js";
import { readUserAccessToken } from "./feishu/tokens.js";
import { closeRequestFor, impactCardView, impactRequestBody, ownCard, type ImpactDocBasis } from "./impactCards.js";
import { enqueueJob, type JobHandler } from "./jobs.js";
import type { Query } from "./meetingStore.js";
import { insertNotification } from "./notifications.js";
import { docKey, FEISHU, feishuFallbackTitle } from "./onboardingLists.js";
import { shanghaiDate } from "./workdays.js";

/**
 * ⑧ 文档变更（含 ④ 的文档触发，前端交互说明第 8 节）：
 * 1. 发布：作者在机器人所在的群里 @机器人 贴飞书文档链接（im.message.receive_v1，V1 只有 @ 消息的权限），一个链接一次发布。
 * 2. 找候选：按作者身份读新文档的标题和修订时间（D-26，不读正文）；从工作依据清单和群里发过的文档里，Agent 凭标题和元数据找它可能修订或取代的旧文档，
 *    每份给一句理由；同一个链接有人依据旧版本的，直接作为「修订」候选。作者收到一条 kind = doc_change 的请求。
 * 3. 作者勾选修订 / 取代哪份，或「都不是」；取代可带生效日期、过渡期、已有工作是否沿用旧版。作者确认不了时改问旧文档负责人「你的《A》还有效吗？」。
 *    作者一直不回应的只留在 doc_changes 里（后台记录），不推送。
 * 4. 推送（D-38 直接推）：依据旧版的人各收一张影响卡（kind = impact 的请求）。没有正文，卡上写清是哪份文档的新版本或被谁取代；
 *    取代卡上本人选「切换到新版」或「继续用旧版到某天」，修订卡「知道了」即换到新版，都同步更新他的工作依据清单。
 * 5. 旧文档：确认取代后在工作依据清单里标为已被取代、带新文档链接。飞书文档顶部加横幅需要写权限，V1 不做。
 */
export const DOC_CHANGE_ANALYZE_KIND = "doc_change.analyze";
const MESSAGE_EVENT = "im.message.receive_v1";
const LINKS = /https:\/\/[A-Za-z0-9.-]*(?:feishu\.cn|larksuite\.com)\/(?:docx|docs|wiki|sheets|base)\/[A-Za-z0-9_-]+/g;
const DOC_TYPE: Record<string, FeishuDocType> = { docx: "docx", docs: "doc", wiki: "wiki", sheets: "sheet", base: "bitable" };
const MAX_LINKS = 5;
const MAX_CANDIDATES = 5;
const POOL_LIMIT = 150;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Failure = { error: { status: number; code: string; message: string } };
const fail = (status: number, code: string, message: string): Failure => ({ error: { status, code, message } });

type DocChangeRow = {
  id: string; author_id: string; doc_ref: string; title: string; revised_at: Date | null; revised_by: string | null; message_id: string; chat_id: string | null;
  status: TDocChangeView["status"]; effective_on: string | null; transition_until: string | null; keep_existing: boolean | null;
  request_id: string | null; decided_by: string | null; decided_at: Date | null; created_at: Date;
};
type CandidateRow = {
  key: string; doc_kind: TDocChangeCandidate["kind"]; doc_ref: string; title: string; url: string | null; owner_id: string | null; reason: string;
  suggested: "revision" | "supersede"; same_doc: boolean; position: number; relation: "revision" | "supersede" | null;
  owner_answer: "asked" | "valid" | "superseded" | null; owner_request_id: string | null;
};
type BasisRow = { person_id: string; doc_kind: TDocChangeCandidate["kind"]; doc_ref: string; title: string; url: string | null; revision: string | null; revised_at: Date | null };

/** 消息里的飞书文档链接，规范成 https://<域名>/<类型>/<token>，同一份只留一个。 */
export function docLinks(content: string): string[] {
  const seen = new Map<string, string>();
  for (const [url] of content.matchAll(LINKS)) if (!seen.has(docKey("feishu_doc", url))) seen.set(docKey("feishu_doc", url), url);
  return [...seen.values()].slice(0, MAX_LINKS);
}

const monthDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const quote = (title: string) => `《${title.slice(0, 60)}》`;

export type DocChangeService = ReturnType<typeof createDocChangeService>;

export function createDocChangeService(deps: {
  pool: Pool;
  agent: DocChangeAgent;
  names: () => Map<string, string>;
  /** 配了飞书才有：按作者身份读文档元数据，飞书通知入队。 */
  feishu?: { client: Pick<FeishuClient, "getDocMetas">; env: Pick<FeishuEnv, "tokenKey" | "tokenKeyVersion"> };
  pathFor: (personId: string, requestId: string) => string;
  now?: () => Date;
}) {
  const { pool } = deps;
  const q: Query = pool.query.bind(pool);
  const now = deps.now ?? (() => new Date());
  const nameOf = (personId: string) => deps.names().get(personId) ?? personId;

  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** 送达通道的一条请求：发起人是作者，接收人一人；通知栏 request_received，配了飞书再发一张带跳转按钮的卡片。 */
  async function deliver(client: PoolClient, input: { kind: "doc_change" | "impact"; initiatorId: string; recipientId: string; prompt: string; title: string; body: string; dedupeKey: string; feishuBody: string; label: string }): Promise<string> {
    const requestId = randomUUID();
    await client.query(`INSERT INTO requests (id, kind, initiator_id, prompt, title, body, status, sent_at) VALUES ($1, $2, $3, $4, $5, $6, 'open', now())`,
      [requestId, input.kind, input.initiatorId, input.prompt.slice(0, 2000), input.title.slice(0, 200), input.body.slice(0, 20000)]);
    await client.query("INSERT INTO request_recipients (request_id, person_id) VALUES ($1, $2)", [requestId, input.recipientId]);
    await insertNotification(client, { personId: input.recipientId, kind: "request_received", objectType: "request", objectId: requestId, actorId: input.initiatorId });
    if (deps.feishu) {
      await feishuNotifier(client.query.bind(client))({ personId: input.recipientId, source: "doc_change", title: input.title.slice(0, 200), body: input.feishuBody,
        links: [{ label: input.label, path: deps.pathFor(input.recipientId, requestId) }] }, input.dedupeKey);
    }
    return requestId;
  }

  /** 群消息：@ 了机器人、贴了飞书文档链接、发消息的人在天枢里有身份，才算发布。每个链接排一次找候选。 */
  async function recordMessage(payload: Record<string, unknown>): Promise<void> {
    const message = payload.message as { message_id?: string; chat_id?: string; chat_type?: string; content?: string; mentions?: unknown[] } | undefined;
    const sender = payload.sender as { sender_type?: string; sender_id?: { open_id?: string } } | undefined;
    if (message?.chat_type !== "group" || !message.message_id || typeof message.content !== "string") return;
    if (sender?.sender_type && sender.sender_type !== "user") return;
    if (!Array.isArray(message.mentions) || !message.mentions.length) return;
    const openId = sender?.sender_id?.open_id;
    if (!openId) return;
    const author = (await q("SELECT person_id FROM feishu_identities WHERE open_id = $1", [openId])).rows[0]?.person_id as string | undefined;
    if (!author) return;
    for (const url of docLinks(message.content)) {
      await q(`INSERT INTO doc_changes (id, author_id, doc_ref, title, message_id, chat_id) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (message_id, doc_ref) DO NOTHING`,
        [randomUUID(), author, url, feishuFallbackTitle(url), message.message_id, message.chat_id ?? null]);
      const id = (await q("SELECT id::text FROM doc_changes WHERE message_id = $1 AND doc_ref = $2", [message.message_id, url])).rows[0].id as string;
      await enqueueJob(q, { kind: DOC_CHANGE_ANALYZE_KIND, dedupeKey: `${DOC_CHANGE_ANALYZE_KIND}:${id}`, payload: { docChangeId: id } });
    }
  }

  /**
   * 按作者身份读飞书文档元数据（只有标题、修订时间、修订人、所有者），按 key 返回；读不到的（没权限、已删）不在里面。
   * 没配飞书、没授权或接口失败时返回 null（查不了，不等于读不到）。
   */
  async function readMetas(personId: string, urls: string[]): Promise<Map<string, { title: string; modifiedAt: Date | null; modifiedBy: string | null; ownerId: string | null }> | null> {
    const docs = urls.flatMap((url) => { const match = FEISHU.exec(url); return match ? [{ token: match[2], type: DOC_TYPE[match[1]] }] : []; });
    if (!deps.feishu || !docs.length) return null;
    try {
      const token = await readUserAccessToken(q, deps.feishu.env, personId, now());
      if (!token) return null;
      const metas = await deps.feishu.client.getDocMetas(token, docs);
      const openIds = [...new Set(metas.flatMap((meta) => [meta.modifiedBy, meta.ownerId].filter((id): id is string => Boolean(id))))];
      const people = new Map(openIds.length ? ((await q("SELECT open_id, person_id FROM feishu_identities WHERE open_id = ANY($1)", [openIds])).rows as { open_id: string; person_id: string }[])
        .map((row) => [row.open_id, row.person_id]) : []);
      return new Map(metas.map((meta) => [`feishu:${meta.token}`, {
        title: meta.title, modifiedAt: meta.modifiedAt,
        modifiedBy: meta.modifiedBy && people.has(meta.modifiedBy) ? nameOf(people.get(meta.modifiedBy)!) : null,
        ownerId: meta.ownerId ? people.get(meta.ownerId) ?? null : null,
      }]));
    } catch (cause) {
      console.warn(`doc change metas failed: ${(cause as Error).message}`);
      return null;
    }
  }

  /** 找候选：读新文档元数据 → 从工作依据清单与群里发过的文档里找 → 有候选就请作者确认，没有就记下结束。 */
  async function analyze(docChangeId: string): Promise<void> {
    const row = (await q("SELECT * FROM doc_changes WHERE id = $1", [docChangeId])).rows[0] as DocChangeRow | undefined;
    if (!row || row.status !== "finding") return;
    const newKey = docKey("feishu_doc", row.doc_ref);
    const meta = (await readMetas(row.author_id, [row.doc_ref]))?.get(newKey);
    const title = meta?.title || row.title;

    // 候选池：工作依据清单里的每份文档（依据它的人数），以及以前在群里发过的文档（谁、哪天）。
    const [basis, shared] = await Promise.all([
      q("SELECT person_id, doc_kind, doc_ref, title, url, revision, revised_at FROM work_basis"),
      q(`SELECT DISTINCT ON (doc_ref) doc_ref, title, author_id, created_at FROM doc_changes WHERE id <> $1 ORDER BY doc_ref, created_at DESC`, [docChangeId]),
    ]);
    type PoolDoc = { key: string; kind: BasisRow["doc_kind"]; ref: string; title: string; url: string | null; revisedAt: Date | null; dependents: Set<string>; sharedBy: string | null; sharedAt: Date | null };
    const docs = new Map<string, PoolDoc>();
    for (const item of basis.rows as BasisRow[]) {
      const key = docKey(item.doc_kind, item.doc_ref);
      const doc = docs.get(key) ?? { key, kind: item.doc_kind, ref: item.doc_ref, title: item.title, url: item.url, revisedAt: item.revised_at, dependents: new Set<string>(), sharedBy: null, sharedAt: null };
      doc.dependents.add(item.person_id);
      if (item.revised_at && (!doc.revisedAt || item.revised_at > doc.revisedAt)) doc.revisedAt = item.revised_at;
      docs.set(key, doc);
    }
    for (const item of shared.rows as { doc_ref: string; title: string; author_id: string; created_at: Date }[]) {
      const key = docKey("feishu_doc", item.doc_ref);
      const doc = docs.get(key) ?? { key, kind: "feishu_doc" as const, ref: item.doc_ref, title: item.title, url: item.doc_ref, revisedAt: null, dependents: new Set<string>(), sharedBy: null, sharedAt: null };
      if (!doc.sharedAt || item.created_at > doc.sharedAt) { doc.sharedBy = item.author_id; doc.sharedAt = item.created_at; }
      docs.set(key, doc);
    }
    const recency = (doc: PoolDoc) => Math.max(doc.sharedAt?.getTime() ?? 0, doc.revisedAt?.getTime() ?? 0);
    const others = [...docs.values()].filter((doc) => doc.key !== newKey).sort((a, b) => recency(b) - recency(a)).slice(0, POOL_LIMIT);
    const picked = others.length ? (await deps.agent.findCandidates({
      today: shanghaiDate(now()),
      newDoc: { title, author: nameOf(row.author_id), revisedAt: meta?.modifiedAt?.toISOString() ?? null },
      pool: others.map((doc) => ({ key: doc.key, title: doc.title, owner: null, revisedAt: doc.revisedAt?.toISOString() ?? null, dependents: doc.dependents.size,
        sharedBy: doc.sharedBy ? nameOf(doc.sharedBy) : null, sharedAt: doc.sharedAt ? shanghaiDate(doc.sharedAt) : null })),
    }, { docChangeId }, AbortSignal.timeout(90_000))).candidates : [];

    const same = docs.get(newKey);
    const chosen: { doc: PoolDoc; relation: "revision" | "supersede"; reason: string; sameDoc: boolean }[] = [];
    // 同一个链接、有人依据的是之前的版本：直接作为修订候选（也可能被整篇改写成了别的，由作者改成取代）。
    if (same?.dependents.size) chosen.push({ doc: same, relation: "revision", reason: `同一个链接，${same.dependents.size} 人依据的是之前的版本`, sameDoc: true });
    const allowed = new Map(others.map((doc) => [doc.key, doc]));
    const picks = picked.flatMap((candidate) => { const doc = allowed.get(candidate.key); return doc ? [{ doc, candidate }] : []; });
    // 负责人：飞书文档按所有者（作者身份读得到时），天枢材料按上传人，都没有时按在群里发它的人。
    // 查得了权限时，作者自己打不开的飞书文档不列给他（别人的依据清单里的标题不外露）。
    const metas = await readMetas(row.author_id, [...chosen, ...picks].filter((item) => item.doc.kind === "feishu_doc").map((item) => item.doc.ref)) ?? null;
    for (const { doc, candidate } of picks) {
      if (chosen.some((item) => item.doc.key === doc.key) || chosen.length >= MAX_CANDIDATES) continue;
      if (metas && doc.kind === "feishu_doc" && !metas.has(doc.key)) continue;
      chosen.push({ doc, relation: candidate.relation, reason: candidate.reason.trim().slice(0, 300) || "标题相近", sameDoc: false });
    }

    const materialIds = chosen.filter((item) => item.doc.kind === "material" && UUID.test(item.doc.ref)).map((item) => item.doc.ref);
    const materialOwners = new Map(materialIds.length ? ((await q("SELECT id::text, owner_id FROM object_materials WHERE id = ANY($1::uuid[])", [materialIds])).rows as { id: string; owner_id: string }[])
      .map((item) => [item.id, item.owner_id]) : []);
    const ownerOf = (doc: PoolDoc) => metas?.get(doc.key)?.ownerId ?? (doc.kind === "material" ? materialOwners.get(doc.ref) : undefined) ?? doc.sharedBy;

    await transaction(async (client) => {
      const locked = (await client.query("SELECT status FROM doc_changes WHERE id = $1 FOR UPDATE", [docChangeId])).rows[0] as { status: string };
      if (locked.status !== "finding") return;
      await client.query("UPDATE doc_changes SET title = $2, revised_at = $3, revised_by = $4, updated_at = now() WHERE id = $1",
        [docChangeId, title.slice(0, 240), meta?.modifiedAt ?? null, meta?.modifiedBy ?? null]);
      for (const [position, item] of chosen.entries()) {
        await client.query(`INSERT INTO doc_change_candidates (doc_change_id, key, doc_kind, doc_ref, title, url, owner_id, reason, suggested, same_doc, position)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [docChangeId, item.doc.key, item.doc.kind, item.doc.ref, (metas?.get(item.doc.key)?.title || item.doc.title).slice(0, 240), item.doc.url, ownerOf(item.doc) ?? null,
          item.reason, item.relation, item.sameDoc, position]);
      }
      if (!chosen.length) {
        await client.query("UPDATE doc_changes SET status = 'unrelated', decided_at = now(), updated_at = now() WHERE id = $1", [docChangeId]);
        return;
      }
      const requestTitle = `${quote(title)}修订或取代了哪份`;
      const list = chosen.map((item) => `- ${quote(item.doc.title)}：${item.reason}`).join("\n");
      const requestId = await deliver(client, { kind: "doc_change", initiatorId: row.author_id, recipientId: row.author_id, prompt: row.doc_ref, title: requestTitle,
        body: list, dedupeKey: `doc-change:${docChangeId}`, feishuBody: chosen.map((item) => quote(item.doc.title)).join("\n"), label: "去确认" });
      await client.query("UPDATE doc_changes SET status = 'awaiting_author', request_id = $2, updated_at = now() WHERE id = $1", [docChangeId, requestId]);
    });
  }

  const candidatesOf = async (client: Query, id: string) =>
    (await client("SELECT * FROM doc_change_candidates WHERE doc_change_id = $1 ORDER BY position", [id])).rows as CandidateRow[];
  const rowOf = async (client: Query, id: string, lock = false) => UUID.test(id)
    ? (await client(`SELECT id::text, author_id, doc_ref, title, revised_at, revised_by, message_id, chat_id, status, to_char(effective_on, 'YYYY-MM-DD') AS effective_on,
        to_char(transition_until, 'YYYY-MM-DD') AS transition_until, keep_existing, request_id::text, decided_by, decided_at, created_at
        FROM doc_changes WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id])).rows[0] as DocChangeRow | undefined
    : undefined;

  /**
   * 推影响卡：每个依据旧版的人一张（作者和做确认的人自己不推）；同一个人依据了几份时取代优先。
   * 卡面写清是哪份文档的新版本、被谁取代、什么时候生效；没有正文，不猜改了什么。
   */
  async function push(client: PoolClient, row: DocChangeRow, links: CandidateRow[], deciderId: string): Promise<void> {
    if (!links.length) return;
    const basis = (await client.query("SELECT person_id, doc_kind, doc_ref, title, url, revision, revised_at FROM work_basis ORDER BY confirmed_at")).rows as BasisRow[];
    const byPerson = new Map<string, { link: CandidateRow; basis: BasisRow }>();
    for (const item of basis) {
      if (item.person_id === row.author_id || item.person_id === deciderId) continue;
      const link = links.find((candidate) => candidate.key === docKey(item.doc_kind, item.doc_ref));
      if (!link) continue;
      const current = byPerson.get(item.person_id);
      if (!current || (current.link.relation === "revision" && link.relation === "supersede")) byPerson.set(item.person_id, { link, basis: item });
    }
    const author = nameOf(row.author_id);
    const published = monthDay(shanghaiDate(row.created_at));
    for (const [personId, { link, basis: item }] of byPerson) {
      const relation = link.relation!;
      const sameDoc = link.key === docKey("feishu_doc", row.doc_ref);
      const version = item.revision ?? (item.revised_at ? `${monthDay(shanghaiDate(item.revised_at))} 的版本` : null);
      const terms = [row.effective_on ? `${monthDay(row.effective_on)} 起生效` : null, row.transition_until ? `过渡期到 ${monthDay(row.transition_until)}` : null].filter(Boolean).join("，");
      const card = relation === "revision"
        ? {
          title: `${quote(item.title)}出了新版本`,
          impact: `${sameDoc ? `你依据的${quote(item.title)}有了新版本` : `你依据的${quote(item.title)}出了新版本${quote(row.title)}`}，${author} ${published} 在群里发布。${version ? `你确认依据时是 ${version}。` : ""}`,
          action: { kind: "do" as const, text: "看一遍新版里你依据的部分有没有变", due: null },
        }
        : {
          title: `${quote(item.title)}已被${quote(row.title)}取代`,
          impact: `你依据的${quote(item.title)}已被${quote(row.title)}取代${terms ? `，${terms}` : ""}。${row.keep_existing === true ? "已经在做的工作可以按旧版做完。" : row.keep_existing === false ? "已经在做的工作也要换成新版。" : ""}`,
          action: { kind: "do" as const, text: "切换到新版，或继续用旧版到某天", due: row.transition_until ?? row.effective_on ?? null },
        };
      const why = `${author} ${published} 在群里发布${quote(row.title)}，${deciderId === row.author_id ? "作者" : `旧文档负责人 ${nameOf(deciderId)}`}确认它${relation === "revision" ? "是" : "取代了"}${quote(item.title)}${relation === "revision" ? "的新版本" : ""}。`;
      const docBasis: ImpactDocBasis = { key: link.key, relation, title: item.title, url: item.url, revision: item.revision, revisedAt: item.revised_at?.toISOString() ?? null,
        authorName: author, decidedByName: nameOf(deciderId) };
      const cardId = randomUUID();
      const exists = (await client.query("SELECT 1 FROM impact_cards WHERE person_id = $1 AND trigger_kind = 'doc_change' AND trigger_id = $2", [personId, row.id])).rowCount;
      if (exists) continue;
      const requestId = await deliver(client, { kind: "impact", initiatorId: row.author_id, recipientId: personId, prompt: why, title: card.title,
        body: impactRequestBody({ impact: card.impact, action: card.action, correction_note: null }), dedupeKey: `impact:${cardId}`,
        feishuBody: `${impactRequestBody({ impact: card.impact, action: card.action, correction_note: null })}\n\n来自文档变更${quote(row.title)}`, label: "查看" });
      await client.query(
        `INSERT INTO impact_cards (id, person_id, trigger_kind, trigger_id, trigger_revision, meeting_id, status, title, impact, action, targets, why, sources, ask_who,
           confidence, agent_judged, request_id, doc_basis)
         VALUES ($1, $2, 'doc_change', $3, 0, NULL, 'delivered', $4, $5, $6::jsonb, '[]'::jsonb, $7, '[]'::jsonb, $8::jsonb, 'high', FALSE, $9, $10::jsonb)`,
        [cardId, personId, row.id, card.title.slice(0, 200), card.impact.slice(0, 2000), JSON.stringify(card.action), why,
          JSON.stringify([{ personId: row.author_id, displayName: author, role: "author" }]), requestId, JSON.stringify(docBasis)],
      );
    }
  }

  async function view(id: string, viewerId: string): Promise<TDocChangeView | null> {
    const row = await rowOf(q, id);
    if (!row) return null;
    const all = await candidatesOf(q, id);
    const role = row.author_id === viewerId ? "author" : all.some((item) => item.owner_id === viewerId && item.owner_answer) ? "owner" : null;
    if (!role) return null;
    // 被问的负责人只看到他自己负责的那几份。
    const candidates = role === "owner" ? all.filter((item) => item.owner_id === viewerId && item.owner_answer) : all;
    const basis = (await q("SELECT person_id, doc_kind, doc_ref FROM work_basis")).rows as Pick<BasisRow, "person_id" | "doc_kind" | "doc_ref">[];
    const dependents = (key: string) => new Set(basis.filter((item) => docKey(item.doc_kind, item.doc_ref) === key).map((item) => item.person_id)).size;
    const pushed = (await q("SELECT count(*)::int AS n FROM impact_cards WHERE trigger_kind = 'doc_change' AND trigger_id = $1 AND status <> 'shadow'", [id])).rows[0].n as number;
    const canDecide = role === "author" && row.status === "awaiting_author";
    return {
      id: row.id, status: row.status, newDoc: { title: row.title, url: row.doc_ref, revisedAt: row.revised_at?.toISOString() ?? null },
      authorName: nameOf(row.author_id), publishedAt: row.created_at.toISOString(),
      candidates: candidates.map((item) => ({ key: item.key, kind: item.doc_kind, title: item.title, url: item.url, ownerName: item.owner_id ? nameOf(item.owner_id) : null,
        reason: item.reason, sameDoc: item.same_doc, dependents: dependents(item.key), suggested: item.suggested, relation: item.relation, ownerAnswer: item.owner_answer })),
      effectiveOn: row.effective_on, transitionUntil: row.transition_until, keepExisting: row.keep_existing,
      steps: stepsOf(row, role === "owner" ? candidates : all, role, viewerId, pushed),
      pushed,
      decidedByName: row.decided_by ? nameOf(row.decided_by) : null,
      viewer: {
        role, canDecide,
        canAskOwners: canDecide && all.some((item) => item.owner_id && item.owner_id !== row.author_id),
        ownerKeys: role === "owner" ? candidates.filter((item) => item.owner_answer === "asked").map((item) => item.key) : [],
      },
    };
  }

  async function viewByRequest(requestId: string, viewerId: string): Promise<TDocChangeView | null> {
    if (!UUID.test(requestId)) return null;
    const id = (await q(`SELECT d.id::text FROM doc_changes d WHERE d.request_id = $1
      UNION SELECT c.doc_change_id::text FROM doc_change_candidates c WHERE c.owner_request_id = $1 LIMIT 1`, [requestId])).rows[0]?.id as string | undefined;
    if (!id) return null;
    const result = await view(id, viewerId);
    if (result) await q("UPDATE notifications SET read_at = now() WHERE person_id = $1 AND object_type = 'request' AND object_id = $2 AND read_at IS NULL", [viewerId, requestId]);
    return result;
  }

  function terms(input: Pick<TConfirmDocChangeRequest, "effectiveOn" | "transitionUntil" | "keepExisting">): Failure | null {
    if (input.effectiveOn && input.transitionUntil && input.transitionUntil < input.effectiveOn) return fail(400, "INVALID_INPUT", "过渡期不能早于生效日期");
    return null;
  }

  /** 作者确认：勾了的记下关系（空即都不是），有取代时记下生效日期等；然后推影响卡。 */
  async function confirm(id: string, viewerId: string, input: TConfirmDocChangeRequest): Promise<TDocChangeView | Failure | null> {
    const invalid = terms(input);
    if (invalid) return invalid;
    const outcome = await transaction(async (client) => {
      const row = await rowOf(client.query.bind(client), id, true);
      if (!row || row.author_id !== viewerId) return null;
      if (row.status !== "awaiting_author") return fail(409, "DOC_CHANGE_DECIDED", "已经确认过了");
      const candidates = await candidatesOf(client.query.bind(client), id);
      const keys = new Set(candidates.map((item) => item.key));
      if (input.links.some((link) => !keys.has(link.key)) || new Set(input.links.map((link) => link.key)).size !== input.links.length) return fail(400, "INVALID_INPUT", "候选已经变了，请刷新");
      const supersedes = input.links.some((link) => link.relation === "supersede");
      for (const link of input.links) await client.query("UPDATE doc_change_candidates SET relation = $3 WHERE doc_change_id = $1 AND key = $2", [id, link.key, link.relation]);
      await client.query(`UPDATE doc_changes SET status = $2, effective_on = $3, transition_until = $4, keep_existing = $5, decided_by = $6, decided_at = now(), updated_at = now() WHERE id = $1`,
        [id, input.links.length ? "confirmed" : "unrelated", supersedes ? input.effectiveOn ?? null : null, supersedes ? input.transitionUntil ?? null : null,
          supersedes ? input.keepExisting ?? null : null, viewerId]);
      if (row.request_id) await closeRequestFor(client.query.bind(client), row.request_id, viewerId);
      const updated = (await rowOf(client.query.bind(client), id))!;
      await push(client, updated, (await candidatesOf(client.query.bind(client), id)).filter((item) => item.relation), viewerId);
      return true;
    });
    if (outcome === null || outcome !== true) return outcome;
    return view(id, viewerId);
  }

  /** 作者确认不了：给每个别人负责的候选的负责人发一条「你的《A》还有效吗？」。 */
  async function askOwners(id: string, viewerId: string): Promise<TDocChangeView | Failure | null> {
    const outcome = await transaction(async (client) => {
      const row = await rowOf(client.query.bind(client), id, true);
      if (!row || row.author_id !== viewerId) return null;
      if (row.status !== "awaiting_author") return fail(409, "DOC_CHANGE_DECIDED", "已经确认过了");
      const askable = (await candidatesOf(client.query.bind(client), id)).filter((item) => item.owner_id && item.owner_id !== row.author_id);
      if (!askable.length) return fail(409, "NO_OWNER", "候选都没有别的负责人");
      const byOwner = new Map<string, CandidateRow[]>();
      for (const item of askable) byOwner.set(item.owner_id!, [...(byOwner.get(item.owner_id!) ?? []), item]);
      for (const [ownerId, items] of byOwner) {
        const title = `你的${quote(items[0].title)}${items.length > 1 ? `等 ${items.length} 份` : ""}还有效吗`;
        const requestId = await deliver(client, { kind: "doc_change", initiatorId: row.author_id, recipientId: ownerId, prompt: row.doc_ref, title,
          body: `${nameOf(row.author_id)} 在群里发布了${quote(row.title)}\n${items.map((item) => `- ${quote(item.title)}：${item.reason}`).join("\n")}`,
          dedupeKey: `doc-change-owner:${id}:${ownerId}`, feishuBody: `${nameOf(row.author_id)} 在群里发布了${quote(row.title)}`, label: "去回答" });
        await client.query("UPDATE doc_change_candidates SET owner_answer = 'asked', owner_request_id = $3 WHERE doc_change_id = $1 AND key = ANY($2::text[])",
          [id, items.map((item) => item.key), requestId]);
      }
      await client.query("UPDATE doc_changes SET status = 'asking_owner', updated_at = now() WHERE id = $1", [id]);
      if (row.request_id) await closeRequestFor(client.query.bind(client), row.request_id, viewerId);
      return true;
    });
    if (outcome === null || outcome !== true) return outcome;
    return view(id, viewerId);
  }

  /** 旧文档负责人回答：还有效，或已被取代（随即推影响卡）。他负责的都答完，他那条请求收尾；所有人都答完，这次变更收尾。 */
  async function ownerAnswer(id: string, viewerId: string, input: TDocOwnerAnswerRequest): Promise<TDocChangeView | Failure | null> {
    const invalid = terms(input);
    if (invalid) return invalid;
    const outcome = await transaction(async (client) => {
      const row = await rowOf(client.query.bind(client), id, true);
      if (!row) return null;
      const candidates = await candidatesOf(client.query.bind(client), id);
      const target = candidates.find((item) => item.key === input.key && item.owner_id === viewerId && item.owner_answer);
      if (!target) return null;
      if (target.owner_answer !== "asked") return fail(409, "DOC_CHANGE_DECIDED", "已经回答过了");
      const superseded = input.answer === "superseded";
      await client.query("UPDATE doc_change_candidates SET owner_answer = $3, relation = $4 WHERE doc_change_id = $1 AND key = $2",
        [id, target.key, superseded ? "superseded" : "valid", superseded ? "supersede" : null]);
      if (superseded) {
        await client.query(`UPDATE doc_changes SET effective_on = COALESCE(effective_on, $2), transition_until = COALESCE(transition_until, $3),
          keep_existing = COALESCE(keep_existing, $4), decided_by = COALESCE(decided_by, $5), updated_at = now() WHERE id = $1`,
          [id, input.effectiveOn ?? null, input.transitionUntil ?? null, input.keepExisting ?? null, viewerId]);
        const updated = (await rowOf(client.query.bind(client), id))!;
        await push(client, updated, [{ ...target, relation: "supersede" }], viewerId);
      }
      const after = await candidatesOf(client.query.bind(client), id);
      if (target.owner_request_id && !after.some((item) => item.owner_request_id === target.owner_request_id && item.owner_answer === "asked")) {
        await closeRequestFor(client.query.bind(client), target.owner_request_id, viewerId);
      }
      if (!after.some((item) => item.owner_answer === "asked")) {
        await client.query("UPDATE doc_changes SET status = $2, decided_at = now(), updated_at = now() WHERE id = $1",
          [id, after.some((item) => item.relation) ? "confirmed" : "unrelated"]);
      }
      return true;
    });
    if (outcome === null || outcome !== true) return outcome;
    return view(id, viewerId);
  }

  /**
   * 文档变更卡上本人的选择，同步更新他的工作依据清单：
   * - switch：依据换成新文档（同一个链接就把版本更新到这一次发布）；修订卡「知道了」也是这一项。
   * - keep：只有取代卡有；旧文档留在清单里，记下用到哪天和理由。
   */
  async function chooseBasis(cardId: string, viewerId: string, input: TImpactBasisChoiceRequest): Promise<TImpactCardView | Failure | null> {
    const outcome = await transaction(async (client) => {
      const cq = client.query.bind(client);
      const card = await ownCard(cq, cardId, viewerId);
      if (!card || card.trigger_kind !== "doc_change" || !card.doc_basis) return null;
      if (card.basis_choice) return fail(409, "IMPACT_BASIS_CHOSEN", "已经选过了");
      if (input.choice === "keep" && card.doc_basis.relation !== "supersede") return fail(400, "INVALID_INPUT", "修订没有继续用旧版这一项");
      const keep = input.choice === "keep" ? { until: input.until, reason: input.reason?.trim() } : null;
      if (keep && (!keep.until || !keep.reason)) return fail(400, "INVALID_INPUT", "写上用到哪天和理由");
      const change = (await rowOf(cq, card.trigger_id))!;
      const mine = ((await client.query("SELECT person_id, doc_kind, doc_ref, title, url, revision, revised_at FROM work_basis WHERE person_id = $1", [viewerId])).rows as BasisRow[])
        .filter((item) => docKey(item.doc_kind, item.doc_ref) === card.doc_basis!.key);
      const at = now();
      if (input.choice === "switch") {
        const sameDoc = docKey("feishu_doc", change.doc_ref) === card.doc_basis.key;
        // 读不到新文档元数据时（标题是兜底的、没有修订时间）保留原来的，确认时刻照样更新。
        const title = change.title === feishuFallbackTitle(change.doc_ref) ? null : change.title;
        for (const item of mine) {
          if (sameDoc) {
            await client.query(`UPDATE work_basis SET title = COALESCE($4, title), revised_at = COALESCE($5, revised_at), revised_by = COALESCE($6, revised_by),
              keep_until = NULL, keep_reason = NULL, confirmed_at = $7
              WHERE person_id = $1 AND doc_kind = $2 AND doc_ref = $3`, [viewerId, item.doc_kind, item.doc_ref, title, change.revised_at, change.revised_by, at]);
          } else {
            await client.query("DELETE FROM work_basis WHERE person_id = $1 AND doc_kind = $2 AND doc_ref = $3", [viewerId, item.doc_kind, item.doc_ref]);
          }
        }
        if (!sameDoc || !mine.length) {
          await client.query(`INSERT INTO work_basis (id, person_id, doc_kind, doc_ref, title, url, revision, revised_at, revised_by, confirmed_at)
            VALUES ($1, $2, 'feishu_doc', $3, $4, $3, NULL, $5, $6, $7)
            ON CONFLICT (person_id, doc_kind, doc_ref) DO UPDATE SET title = EXCLUDED.title, revised_at = EXCLUDED.revised_at, revised_by = EXCLUDED.revised_by,
              keep_until = NULL, keep_reason = NULL, confirmed_at = EXCLUDED.confirmed_at`,
          [randomUUID(), viewerId, change.doc_ref, change.title, change.revised_at, change.revised_by, at]);
        }
      } else {
        for (const item of mine) {
          await client.query("UPDATE work_basis SET keep_until = $4, keep_reason = $5 WHERE person_id = $1 AND doc_kind = $2 AND doc_ref = $3",
            [viewerId, item.doc_kind, item.doc_ref, keep!.until, keep!.reason!.slice(0, 200)]);
        }
      }
      const choice = { choice: input.choice, until: keep?.until ?? null, reason: keep?.reason ?? null, at: at.toISOString() };
      await client.query("UPDATE impact_cards SET basis_choice = $2::jsonb, updated_at = now() WHERE id = $1", [cardId, JSON.stringify(choice)]);
      if (card.request_id) await closeRequestFor(cq, card.request_id, viewerId);
      return true;
    });
    if (outcome === null || outcome !== true) return outcome;
    const card = await ownCard(q, cardId, viewerId);
    return card ? impactCardView(q, card) : null;
  }

  return {
    recordMessage, analyze, view, viewByRequest, confirm, askOwners, ownerAnswer, chooseBasis,
    jobs(): { handlers: Record<string, JobHandler>; feishuEvents: Record<string, (payload: Record<string, unknown>) => Promise<void>> } {
      return {
        handlers: { [DOC_CHANGE_ANALYZE_KIND]: async (payload) => analyze(String((payload as { docChangeId?: unknown }).docChangeId)) },
        feishuEvents: { [MESSAGE_EVENT]: recordMessage },
      };
    },
  };
}

/** 处理步骤：读文档信息 → 找相关文档 → 确认关系（作者确认不了时 → 问负责人）→ 推送影响卡。某一步有结果就写在它下面，都不是时停在确认那一步。 */
export function stepsOf(row: Pick<DocChangeRow, "status" | "author_id" | "decided_by">, candidates: Pick<CandidateRow, "owner_id" | "owner_answer" | "relation">[],
  role: "author" | "owner", viewerId: string, pushed: number): TRequestStep[] {
  const step = (label: string, status: TRequestStep["status"], result: string | null = null): TRequestStep => ({ label, status, result });
  const finding = row.status === "finding";
  const steps = [step("读文档信息", "done"), step("找相关文档", finding ? "current" : "done", finding ? null : candidates.length ? `${candidates.length} 份候选` : "没有找到")];
  const asked = candidates.filter((item) => item.owner_answer);
  const relations = candidates.filter((item) => item.relation);
  const summary = (items: typeof candidates) => {
    const revision = items.filter((item) => item.relation === "revision").length, supersede = items.filter((item) => item.relation === "supersede").length;
    return [revision ? `修订 ${revision} 份` : null, supersede ? `取代 ${supersede} 份` : null].filter(Boolean).join(" · ") || "都不是";
  };
  if (role === "owner") {
    const mine = asked.filter((item) => item.owner_id === viewerId);
    const waiting = mine.some((item) => item.owner_answer === "asked");
    steps.push(step("等你回答", waiting ? "current" : "done", waiting ? null : mine.some((item) => item.owner_answer === "superseded") ? "已被取代" : "还有效"));
  } else if (!finding) {
    if (row.status === "awaiting_author") steps.push(step("确认关系", "current"));
    else steps.push(step("确认关系", "done", asked.length ? "转给负责人" : summary(candidates)));
    if (asked.length) {
      const open = asked.filter((item) => item.owner_answer === "asked").length;
      steps.push(step("问负责人", open ? "current" : "done", open ? `${asked.length - open}/${asked.length} 已回答` : summary(asked)));
    }
  }
  // 确认（或负责人答了已被取代）就随即推送；都不是时流程停在确认那一步。
  if (!finding && row.status !== "unrelated") {
    steps.push(relations.length ? step("推送影响卡", "done", pushed ? `推给 ${pushed} 人` : "没有人依据旧版") : step("推送影响卡", "pending"));
  }
  return steps;
}
