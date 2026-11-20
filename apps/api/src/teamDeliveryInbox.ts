import type { TTeamDelivery, TTeamDeliveryAttachment, TTeamDeliveryBuddy, TTeamDeliveryRecipient, TTeamDeliveryReply } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";

type InboxDeps = { q: Query; people: ReadonlyMap<string, string>; now: () => Date };
type DeliveryRow = { id: string; initiator_id: string; team_kind: TTeamDelivery["kind"]; body: string; team_source_url: string | null;
  team_due_at: Date | null; sent_at: Date };
type Recipient = { request_id: string; person_id: string; status: "pending" | "done"; team_delivery_error: string | null;
  buddy_state: TTeamDeliveryBuddy["state"] | null; buddy_note: string | null; buddy_asked_at: Date | null; buddy_asked_owner: boolean };
type Reply = { id: string; request_id: string; recipient_id: string; status: TTeamDeliveryReply["status"]; body: string; created_at: Date; origin: "person" | "buddy";
  reviewed_at: Date | null; corrects: string | null; correction_seen_at: Date | null };

/** 伙伴在答超过这么久还没结果，算没答上来（补充条款 A7）：问的人卡上显示原因，可以重试或问本人；不进被问的人的等你。 */
export const ANSWERING_TIMEOUT_MS = 2 * 60_000;
export const BUDDY_NOT_ANSWERED = "伙伴没答上来";
/** 问的人点了「问本人」以后，被问的人看到的原因（问的人那边照旧是当时没答上来的原因）。 */
const ASKED_OWNER = "同事请你本人回";
export const answeringLate = (state: string | null, askedAt: Date | null, now: Date) =>
  state === "answering" && askedAt !== null && askedAt.getTime() < now.getTime() - ANSWERING_TIMEOUT_MS;
type FileRow = { id: string; request_id: string; reply_id: string | null; file_name: string; size: number; sha256: string };

// 列表和详情共用一条成员过滤规则。发起人看各人的回执，其他人只看自己的线程。
async function selectDeliveries({ q, people, now }: InboxDeps, viewer: string, box: "sent" | "received" | null, id?: string): Promise<TTeamDelivery[]> {
  const heads = (await q(`SELECT r.id,r.initiator_id,r.team_kind,r.body,r.team_source_url,r.team_due_at,r.sent_at
    FROM requests r WHERE r.team_kind IS NOT NULL AND ($2::uuid IS NULL OR r.id=$2)
      AND (($3::text IS DISTINCT FROM 'received' AND r.initiator_id=$1)
      OR ($3::text IS DISTINCT FROM 'sent' AND EXISTS (SELECT 1 FROM request_recipients rr
        WHERE rr.request_id=r.id AND rr.person_id=$1 AND rr.team_delivery_error IS NULL)))
    ORDER BY r.sent_at DESC,r.id DESC`, [viewer, id ?? null, box])).rows as DeliveryRow[];
  if (!heads.length) return [];
  const args = [heads.map(r => r.id),viewer];
  const [memberRows, replyRows, attachmentRows] = await Promise.all([
    q(`SELECT rr.* FROM request_recipients rr JOIN requests r ON r.id=rr.request_id WHERE r.id=ANY($1::uuid[])
        AND (r.initiator_id=$2 OR (rr.person_id=$2 AND rr.team_delivery_error IS NULL)) ORDER BY rr.person_id`, args),
    q(`SELECT p.* FROM team_delivery_replies p JOIN requests r ON r.id=p.request_id JOIN request_recipients rr
        ON rr.request_id=r.id AND rr.person_id=p.recipient_id WHERE r.id=ANY($1::uuid[])
        AND (r.initiator_id=$2 OR (rr.person_id=$2 AND rr.team_delivery_error IS NULL)) ORDER BY p.seq`, args),
    q(`SELECT f.* FROM team_delivery_attachments f JOIN requests r ON r.id=f.request_id
        LEFT JOIN team_delivery_replies p ON p.id=f.reply_id WHERE r.id=ANY($1::uuid[])
        AND (r.initiator_id=$2 OR EXISTS (SELECT 1 FROM request_recipients rr WHERE rr.request_id=r.id AND rr.person_id=$2
          AND rr.team_delivery_error IS NULL AND (f.reply_id IS NULL OR p.recipient_id=rr.person_id)))
        ORDER BY f.position,f.id`,args),
  ]);
  const files = new Map<string,TTeamDeliveryAttachment[]>();
  for (const f of attachmentRows.rows as FileRow[]) {
    const key = f.reply_id ?? f.request_id;
    const list = files.get(key) ?? [];
    list.push({ id:f.id, fileName:f.file_name, size:f.size, sha256:f.sha256, href:`/api/me/team-deliveries/${f.request_id}/attachments/${f.id}` });
    files.set(key,list);
  }
  const deliveries = new Map(heads.map(r => [r.id, {
    id:r.id, kind:r.team_kind, text:r.body, sourceUrl:r.team_source_url, dueAt:r.team_due_at?.toISOString() ?? null, createdAt:r.sent_at.toISOString(),
    sender:{ personId:r.initiator_id, displayName:people.get(r.initiator_id) ?? r.initiator_id }, attachments:files.get(r.id) ?? [], recipients:[] as TTeamDeliveryRecipient[],
  }]));
  const recipients = new Map<string,TTeamDeliveryRecipient>();
  for (const m of memberRows.rows as Recipient[]) {
    const delivery = deliveries.get(m.request_id)!;
    const late = answeringLate(m.buddy_state, m.buddy_asked_at, now());
    const result: TTeamDeliveryRecipient = { personId:m.person_id, displayName:people.get(m.person_id) ?? m.person_id,
      status:m.team_delivery_error ? "failed" : delivery.kind === "share" ? "delivered" : m.status === "done" ? "answered" : "pending",
      error:m.team_delivery_error, replies:[],
      ...(m.buddy_state && m.buddy_asked_at ? { buddy: { state: late ? "failed" : m.buddy_state,
        note: late ? BUDDY_NOT_ANSWERED : m.buddy_asked_owner && viewer === m.person_id ? ASKED_OWNER : m.buddy_note,
        askedAt: m.buddy_asked_at.toISOString(), ...(m.buddy_state === "handoff" ? { handoffBy: m.buddy_asked_owner ? "asker" as const : "buddy" as const } : {}) } } : {}) };
    recipients.set(m.request_id + "/" + m.person_id,result);
    delivery.recipients.push(result);
  }
  for (const r of replyRows.rows as Reply[]) {
    const recipient = recipients.get(r.request_id + "/" + r.recipient_id);
    if (!recipient) continue;
    recipient.replies.push({ id:r.id, status:r.status, text:r.body, createdAt:r.created_at.toISOString(), attachments:files.get(r.id) ?? [],
      ...(r.origin === "buddy" ? { origin: "buddy" as const } : {}), ...(r.reviewed_at ? { reviewedAt: r.reviewed_at.toISOString() } : {}),
      ...(r.corrects ? { corrects: r.corrects } : {}), ...(r.correction_seen_at ? { correctionSeenAt: r.correction_seen_at.toISOString() } : {}) });
    // 伙伴答的不算本人回复（A8）：收件人状态只看本人和发起人的往来。
    if (!recipient.error && r.origin !== "buddy") recipient.status = r.status === "clarification" || r.status === "follow_up" ? "pending" : r.status;
  }
  return [...deliveries.values()];
}

export const listTeamDeliveries = (deps: InboxDeps, viewer: string, box: "received" | "sent") => selectDeliveries(deps,viewer,box);
export async function readTeamDelivery(deps: InboxDeps, viewer: string, id: string): Promise<TTeamDelivery | null> {
  return (await selectDeliveries(deps,viewer,null,id))[0] ?? null;
}

/**
 * 「等你」：被问的人那一支只列没经过伙伴的和转本人的；伙伴在答、答了、没答上来、超上限的都不列（A7）。
 * 发起人另有一支：被问的人改过伙伴的答复、发起人还没点「知道了」的，标题是「更正：原标题」（同一条已在等你里的不重复列）。
 */
export async function listPendingTeamRequests(q: Query, viewer: string) {
  const result = await q(`SELECT DISTINCT ON (r.id) r.id,r.title,
    CASE WHEN r.initiator_id=$1 THEN rr.person_id ELSE r.initiator_id END AS source,
    COALESCE(latest.created_at,r.sent_at) AS at
    FROM requests r JOIN request_recipients rr ON rr.request_id=r.id
    LEFT JOIN LATERAL (SELECT p.status,p.created_at FROM team_delivery_replies p WHERE p.request_id=r.id
      AND p.recipient_id=rr.person_id ORDER BY p.seq DESC LIMIT 1) latest ON true
    WHERE r.team_kind='question' AND rr.team_delivery_error IS NULL AND rr.status='pending'
      AND ((rr.person_id=$1 AND latest.status IS DISTINCT FROM 'needs_info' AND (rr.buddy_state IS NULL OR rr.buddy_state='handoff'))
        OR (r.initiator_id=$1 AND latest.status='needs_info'))
    ORDER BY r.id,at DESC,rr.person_id`, [viewer]);
  const corrections = await q(`SELECT DISTINCT ON (r.id) r.id,r.title,p.recipient_id AS source,p.created_at AS at
    FROM requests r JOIN team_delivery_replies p ON p.request_id=r.id JOIN request_recipients rr ON rr.request_id=r.id AND rr.person_id=p.recipient_id
    WHERE r.initiator_id=$1 AND r.team_kind='question' AND rr.team_delivery_error IS NULL AND p.corrects IS NOT NULL AND p.correction_seen_at IS NULL
    ORDER BY r.id,p.created_at DESC,p.recipient_id`, [viewer]);
  const listed = new Set(result.rows.map(row => row.id as string));
  return [...result.rows, ...corrections.rows.filter(row => !listed.has(row.id)).map(row => ({ ...row, title: "更正：" + row.title }))]
    .map(row => ({id:row.id as string,title:row.title as string,source:row.source as string,at:(row.at as Date).toISOString()}));
}
