import type { PoolClient } from "pg";
import type { TMeetingOutcomeItem, TMeetingOutcomeState, TRadarAnchor } from "@warmap/contracts";
import type { IssueReceiptRow, IssueRow } from "./issues.js";
import type { MeetingRow } from "./meetingStore.js";
import { deleteDispatchedTask } from "./tasks.js";

export type EffectRevokeOutcome =
  | { ok: true; receipts: IssueReceiptRow[] }
  | { ok: false; code: string; message: string };

/**
 * Issue decision Receipt 的纯撤回：调用方必须已持有 Issue 行锁。
 * 只处理本 Issue 自己的 Receipt；meeting: 前缀由统一 revokeEffect 分派给 meeting revoker。
 */
export function revokeIssueReceipt(
  row: IssueRow,
  effectRef: string,
  fingerprint: string,
  { reason, at = new Date().toISOString() }: { reason?: string; at?: string } = {},
): EffectRevokeOutcome {
  const match = /^issue:([^:]+):decision:([^:]+)$/.exec(effectRef);
  if (!match || match[1] !== row.id) {
    return { ok: false, code: "UNKNOWN_EFFECT", message: "未知 effectRef，无法撤回" };
  }
  const receiptId = match[2];
  const receipt = row.receipts.find((candidate) => candidate.id === receiptId);
  if (!receipt) return { ok: false, code: "RECEIPT_NOT_FOUND", message: "Receipt 不存在" };
  if (receipt.revokedAt) {
    // 已撤回：同 fingerprint 重放不产生第二个 effect；不同 fingerprint 也不再改变状态
    return { ok: true, receipts: row.receipts };
  }
  const receipts = row.receipts.map((candidate) =>
    candidate.id === receiptId
      ? { ...candidate, revokedAt: at, revokedFingerprint: fingerprint, revokeReason: reason }
      : candidate,
  );
  return { ok: true, receipts };
}

type MeetingEffectKind = "decision" | "todo" | "judgment" | "reopen";

/** 确定性 effectRef：确认后按条目精确引用。构造与解析共用同一 kind↔slug 映射，避免漂移。 */
export function meetingEffectRef(meetingId: string, kind: TMeetingOutcomeItem["kind"], itemId: string): string | null {
  switch (kind) {
    case "decision": return `meeting:${meetingId}:decision:${itemId}`;
    case "todo": return `meeting:${meetingId}:todo:${itemId}`;
    case "ceoJudgment": return `meeting:${meetingId}:judgment:${itemId}`;
    case "reopenWhen": return `meeting:${meetingId}:reopen:${itemId}`;
    default: return null;
  }
}

/** item.kind 与 effectRef 的 slug 不同：reopenWhen ↔ reopen，不能直接字符串比较。 */
function effectKindOf(item: TMeetingOutcomeItem): MeetingEffectKind | null {
  switch (item.kind) {
    case "decision": return "decision";
    case "todo": return "todo";
    case "ceoJudgment": return "judgment";
    case "reopenWhen": return "reopen";
    default: return null;
  }
}

function parseMeetingEffectRef(
  effectRef: string,
): { meetingId: string; kind: MeetingEffectKind; itemId: string } | null {
  const match = /^meeting:([^:]+):(decision|todo|judgment|reopen):(.+)$/.exec(effectRef);
  if (!match) return null;
  return { meetingId: match[1], kind: match[2] as MeetingEffectKind, itemId: match[3] };
}

/** 已推送的 todo 效果是 `task:<taskId>`：会议与条目从执行事项的来源读回。 */
async function parseTaskEffectRef(
  client: PoolClient,
  effectRef: string,
): Promise<{ meetingId: string; kind: MeetingEffectKind; itemId: string; taskId: string } | null> {
  const match = /^task:([0-9a-f-]{36})$/i.exec(effectRef);
  if (!match) return null;
  const task = await client.query<{ origin_meeting_id: string | null; origin_item_id: string | null }>(
    "SELECT origin_meeting_id::text, origin_item_id FROM tasks WHERE id = $1",
    [match[1]],
  );
  const origin = task.rows[0];
  if (!origin?.origin_meeting_id || !origin.origin_item_id) return null;
  return { meetingId: origin.origin_meeting_id, kind: "todo", itemId: origin.origin_item_id, taskId: match[1] };
}

/** 复议条件写入的 Radar anchor 是确定性的：id 由会议条目派生，撤回与重建都按 id 精确匹配。 */
function reopenAnchorId(meetingId: string, itemId: string): string {
  return `meeting-reopen:${meetingId}:${itemId}`.slice(0, 100);
}

export function buildReopenAnchor(input: {
  meetingId: string;
  itemId: string;
  text: string;
  location: TRadarAnchor["location"];
  effectRef: string;
}): TRadarAnchor {
  return {
    id: reopenAnchorId(input.meetingId, input.itemId),
    title: input.text.slice(0, 200),
    query: input.text.slice(0, 500),
    location: input.location,
    source: "meeting-reopen",
    originRef: input.effectRef,
  };
}

export async function upsertRadarAnchor(client: PoolClient, anchor: TRadarAnchor): Promise<void> {
  await client.query("SELECT id FROM radar_config WHERE id = 'default' FOR UPDATE");
  await client.query(
    `UPDATE radar_config
        SET anchors = (
              SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
                FROM jsonb_array_elements(anchors) AS item
               WHERE item->>'id' <> $1
            ) || $2::jsonb,
            updated_at = now()
      WHERE id = 'default'`,
    [anchor.id, JSON.stringify([anchor])],
  );
}

async function removeRadarAnchor(client: PoolClient, anchorId: string): Promise<void> {
  await client.query(
    `UPDATE radar_config
        SET anchors = (
              SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
                FROM jsonb_array_elements(anchors) AS item
               WHERE item->>'id' <> $1
            ),
            updated_at = now()
      WHERE id = 'default'`,
    [anchorId],
  );
}

/** Reviewed 在所有可审阅条目都已处理时成立；没有可审阅条目时真空成立（doc 04 §8）。 */
export function deriveMeetingStatus(current: MeetingRow["status"], items: TMeetingOutcomeItem[]): MeetingRow["status"] {
  if (current === "scheduled" || current === "cancelled") return current;
  const reviewable = items.filter((item) => item.review !== null);
  const processed = reviewable.every((item) => item.review!.status !== "pending");
  return processed ? "reviewed" : "held";
}

export type MeetingRevokeOptions = {
  /** Meeting Action：用 Card 上的 Meeting version 串行。 */
  expectedVersion?: number;
  /** Issue 页面委托：用 Issue card 上的 version 串行。 */
  expectedIssueVersion?: number;
  reason?: string;
  at?: string;
};

export type RevokeEffectOutcome =
  | { ok: true; target: "issue"; issue: IssueRow }
  | { ok: true; target: "meeting"; meeting: MeetingRow; issue: IssueRow | null }
  | { ok: false; conflict: true; latestIssue?: IssueRow | null; latestMeeting?: MeetingRow }
  | { ok: false; conflict?: false; code: string; message: string };

/**
 * 统一 revoker：所有撤回都从 `revokeEffect(effectRef)` 进入，按 effectRef 前缀分派，
 * 并在同一事务内同步 Outcome item、Issue Receipt、Radar anchor 与 Meeting 派生状态。
 */
export async function revokeEffect(
  client: PoolClient,
  effectRef: string,
  fingerprint: string,
  options: MeetingRevokeOptions = {},
): Promise<RevokeEffectOutcome> {
  if (effectRef.startsWith("issue:")) {
    const parsed = /^issue:([^:]+):decision:([^:]+)$/.exec(effectRef);
    if (!parsed) return { ok: false, code: "UNKNOWN_EFFECT", message: "未知 effectRef，无法撤回" };
    const locked = await client.query<IssueRow>("SELECT * FROM issues WHERE id = $1 FOR UPDATE", [parsed[1]]);
    if (locked.rowCount !== 1) return { ok: false, code: "ISSUE_NOT_FOUND", message: "Issue 不存在" };
    const row = locked.rows[0];
    const revoked = revokeIssueReceipt(row, effectRef, fingerprint, { reason: options.reason, at: options.at });
    if (!revoked.ok) return { ok: false, code: revoked.code, message: revoked.message };
    const status: IssueRow["status"] = revoked.receipts.some((receipt) => !receipt.revokedAt) ? "decided" : "pending";
    const updated = await client.query<IssueRow>(
      "UPDATE issues SET receipts = $2::jsonb, status = $3, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *",
      [row.id, JSON.stringify(revoked.receipts), status],
    );
    return { ok: true, target: "issue", issue: updated.rows[0] };
  }
  const result = await revokeMeetingEffect(client, effectRef, fingerprint, options);
  if (!result.ok) return result;
  return { ok: true, target: "meeting", meeting: result.meeting, issue: result.issue };
}

type MeetingRevokeOutcome =
  | { ok: true; meeting: MeetingRow; issue: IssueRow | null }
  | { ok: false; conflict: true; latestMeeting: MeetingRow; latestIssue: IssueRow | null }
  | { ok: false; conflict?: false; code: string; message: string };

const MEETING_SELECT = "SELECT * FROM meetings WHERE id = $1 FOR UPDATE";
const ISSUE_SELECT = "SELECT * FROM issues WHERE id = $1 FOR UPDATE";

async function lockIssue(client: PoolClient, issueId: string): Promise<IssueRow | null> {
  const result = await client.query<IssueRow>(ISSUE_SELECT, [issueId]);
  return result.rowCount === 1 ? result.rows[0] : null;
}

/**
 * 统一 meeting item 撤回：Outcome item、关联 Issue Receipt、Radar anchor、已推送的执行事项与 Meeting 派生状态
 * 在同一事务内同步。调用方提交；负责人已处理的执行事项返回明确 warning，不伪造恢复。
 */
async function revokeMeetingEffect(
  client: PoolClient,
  effectRef: string,
  fingerprint: string,
  options: MeetingRevokeOptions = {},
): Promise<MeetingRevokeOutcome> {
  const taskRef = await parseTaskEffectRef(client, effectRef);
  const parsed = taskRef ?? parseMeetingEffectRef(effectRef);
  if (!parsed) return { ok: false, code: "UNKNOWN_EFFECT", message: "未知 effectRef，无法撤回" };

  const locked = await client.query<MeetingRow>(MEETING_SELECT, [parsed.meetingId]);
  if (locked.rowCount !== 1) return { ok: false, code: "MEETING_NOT_FOUND", message: "Meeting 不存在" };
  const meeting = locked.rows[0];

  // 幂等重放优先于 version 校验：同一 fingerprint 已产生撤回效果就直接返回
  if (meeting.action_fingerprints.includes(fingerprint)) {
    return { ok: true, meeting, issue: null };
  }
  if (options.expectedVersion !== undefined && meeting.version !== options.expectedVersion) {
    return { ok: false, conflict: true, latestMeeting: meeting, latestIssue: null };
  }
  const outcome = meeting.outcome;
  if (!outcome || outcome.status !== "ready") {
    return { ok: false, code: "OUTCOME_NOT_READY", message: "会后抽取尚未完成" };
  }
  const item = outcome.items.find((candidate) => candidate.id === parsed.itemId);
  if (!item) return { ok: false, code: "OUTCOME_ITEM_NOT_FOUND", message: "Outcome item 不存在" };
  if (!item.review) return { ok: false, code: "OPEN_ITEM_NOT_REVIEWABLE", message: "open item 只展示，不能撤回" };
  const kind = parsed.kind;
  if (effectKindOf(item) !== kind) return { ok: false, code: "EFFECT_KIND_MISMATCH", message: "effectRef 与 item 类型不一致" };
  if (item.review.status !== "confirmed") {
    return { ok: false, code: "ITEM_NOT_CONFIRMED", message: "只有已确认的 item 可以撤回" };
  }
  if (item.review.effectRef !== effectRef) {
    return { ok: false, code: "EFFECT_MISMATCH", message: "effectRef 与当前 item 效果不一致" };
  }

  const at = options.at ?? new Date().toISOString();
  const items: TMeetingOutcomeItem[] = outcome.items.map((candidate) => structuredClone(candidate));
  const target = items.find((candidate) => candidate.id === item.id)!;
  let issue: IssueRow | null = null;

  if (taskRef) {
    const removed = await deleteDispatchedTask(client, taskRef.taskId);
    if (!removed.ok) return removed;
  }

  if (kind === "decision") {
    // 主决定撤回时，随它确认的子决定一起恢复待处理（各自的回执一起撤回）
    const children = items.filter((candidate) => candidate.kind === "decision" && candidate.parentItemId === item.id && candidate.review?.status === "confirmed");
    for (const decision of [target, ...children]) {
      const ref = decision.review?.effectRef;
      const issueId = decision.issueId ?? (meeting.issue_ids.length === 1 ? meeting.issue_ids[0] : null);
      // 没有关联议题的会上决定确认时没写回执，撤回只改会后条目本身
      let locked: IssueRow | null = null;
      if (issueId) locked = await lockIssue(client, issueId);
      if (issueId && !locked) return { ok: false, code: "ISSUE_NOT_FOUND", message: "关联 Issue 不存在" };
      if (locked && ref) {
        if (decision === target && options.expectedIssueVersion !== undefined && locked.version !== options.expectedIssueVersion) {
          return { ok: false, conflict: true, latestMeeting: meeting, latestIssue: locked };
        }
        const receipt = locked.receipts.find((candidate) => candidate.effectRef === ref);
        if (!receipt) return { ok: false, code: "RECEIPT_NOT_FOUND", message: "关联 Receipt 不存在" };
        const receipts = locked.receipts.map((candidate) =>
          candidate.effectRef === ref
            ? { ...candidate, revokedAt: at, revokedFingerprint: fingerprint, revokeReason: options.reason }
            : candidate,
        );
        const status: IssueRow["status"] = receipts.some((candidate) => !candidate.revokedAt) ? "decided" : "pending";
        const updated = await client.query<IssueRow>(
          "UPDATE issues SET receipts = $2::jsonb, status = $3, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *",
          [locked.id, JSON.stringify(receipts), status],
        );
        if (decision === target || issue?.id === locked.id) issue = updated.rows[0];
      }
      if (decision !== target) decision.review = { status: "pending", effectRef: null };
    }
    // 父 decision 撤回时同步清理子复议条件与其 Radar anchors
    for (const child of items) {
      if (child.kind !== "reopenWhen" || child.parentItemId !== item.id) continue;
      if (child.review?.anchorId) await removeRadarAnchor(client, child.review.anchorId);
      if (child.review?.status === "confirmed") child.review = { status: "pending", effectRef: null };
    }
  } else if (kind === "reopen") {
    if (target.review?.anchorId) await removeRadarAnchor(client, target.review.anchorId);
  }

  target.review = { status: "pending", effectRef: null };
  const nextOutcome: TMeetingOutcomeState = { ...outcome, items };
  const status = deriveMeetingStatus(meeting.status, items);
  const fingerprints = [...meeting.action_fingerprints.filter((value) => value !== fingerprint), fingerprint].slice(-100);
  const updated = await client.query<MeetingRow>(
    `UPDATE meetings
        SET outcome = $2::jsonb, status = $3, action_fingerprints = $4::jsonb, version = version + 1, updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [meeting.id, JSON.stringify(nextOutcome), status, JSON.stringify(fingerprints)],
  );
  return { ok: true, meeting: updated.rows[0], issue };
}
