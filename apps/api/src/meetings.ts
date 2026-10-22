import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  TCard,
  TMeetingBookingRequest,
  TMeetingDraft,
  TMeetingParticipant,
  TSupplementRequest,
  TWorldAnchor,
} from "@warmap/contracts";
import type { ActionScope } from "./actionToken.js";
import type { PeopleDirectory } from "./peopleDirectory.js";
import { getIssueRow, projectIssueCard } from "./issues.js";
import type { ParsedMaterial } from "./materialParser.js";
import { replaceMeetingMaterials } from "./meetingMaterials.js";
import { syncMeetingMembers, threadIntroInput } from "./threads.js";
import { postThreadIntro, type ThreadIntroAgent } from "./threadIntro.js";
import { startPreflight, type PreflightAgent } from "./meetingPreflight.js";
import { storedAnchor } from "./meetingWorld.js";
import { shanghaiDate } from "./workdays.js";
import {
  appendFingerprint,
  commit,
  emptyDraft,
  emptyPreflight,
  getMeetingRow,
  meetingColumns,
  projectMeetingCard,
  unique,
  updateMeeting,
  withMeetingLock,
  UUID_PATTERN,
  type DriExporter,
  type MeetingActionError,
  type MeetingActionOutcome,
  type MeetingRow,
  type Query,
  type StoredWorldAnchor,
} from "./meetingStore.js";

type ResolvedParticipants = { participants: TMeetingParticipant[]; ceo: TMeetingParticipant; lead: TMeetingParticipant };

function resolveParticipants(
  peopleDirectory: PeopleDirectory,
  input: { leadDriId: string; ceoParticipantId: string; participants: string[] },
): ResolvedParticipants | { error: MeetingActionError } {
  const byId = new Map(peopleDirectory.searchPeople(undefined).map((person) => [person.personId, person]));
  const ids = unique([input.ceoParticipantId, input.leadDriId, ...input.participants]);
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return { error: { status: 400, code: "INVALID_PARTICIPANT", message: `participant 不在 company-people.v1 人员目录中: ${missing.join(", ")}`, fieldErrors: { participants: "unknown personId" } } };
  }
  const ceo = byId.get(input.ceoParticipantId)!;
  if (!ceo.roles.includes("ceo")) {
    return { error: { status: 400, code: "INVALID_CEO", message: "ceoParticipantId 必须具有 ceo 角色", fieldErrors: { ceoParticipantId: "role ceo required" } } };
  }
  const lead = byId.get(input.leadDriId)!;
  if (!lead.roles.includes("dri")) {
    return { error: { status: 400, code: "INVALID_LEAD_DRI", message: "leadDriId 必须具有 dri 角色", fieldErrors: { leadDriId: "role dri required" } } };
  }
  const participants = ids.map((id) => {
    const person = byId.get(id)!;
    return { personId: person.personId, displayName: person.displayName, roles: [...person.roles], sourceRef: person.sourceRef, updatedAt: person.updatedAt };
  });
  return {
    participants,
    ceo: participants.find((participant) => participant.personId === ceo.personId)!,
    lead: participants.find((participant) => participant.personId === lead.personId)!,
  };
}

function scheduleMeetingIntro(pool: Pool, peopleDirectory: PeopleDirectory, agent: ThreadIntroAgent | undefined,
  meetingId: string, inviterId: string, newcomers: string[], existingIds: string[]): void {
  if (!agent || !newcomers.length) return;
  setImmediate(() => { void (async () => {
    const input = await threadIntroInput(pool.query.bind(pool), peopleDirectory, { objectType: "meeting", objectId: meetingId }, inviterId, newcomers);
    await postThreadIntro(pool, agent, input, existingIds);
  })().catch(() => undefined); });
}

async function issuesExist(q: Query, issueIds: string[]): Promise<boolean> {
  if (issueIds.some((id) => !UUID_PATTERN.test(id))) return false;
  const result = await q("SELECT count(*)::int AS count FROM issues WHERE id = ANY($1::uuid[])", [issueIds]);
  return Number((result.rows[0] as { count: number }).count) === unique(issueIds).length;
}

function parseScheduledAt(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

const DEFAULT_MEETING_DURATION_MS = 60 * 60_000;

/** 计划结束时间：未给出时按 defaultDurationMs 顺延（新建 60 分钟，编辑保持原时长）；给出时必须可解析且晚于开始。 */
function resolveEndsAt(scheduledAt: Date, value: string | undefined, defaultDurationMs = DEFAULT_MEETING_DURATION_MS): Date | MeetingActionError {
  if (value === undefined) return new Date(scheduledAt.getTime() + defaultDurationMs);
  const endsAt = parseScheduledAt(value);
  if (!endsAt) return { status: 400, code: "INVALID_INPUT", message: "endsAt 不是可解析时间", fieldErrors: { endsAt: "unparsable" } };
  if (endsAt <= scheduledAt) return { status: 400, code: "INVALID_INPUT", message: "结束时间必须晚于开始时间", fieldErrors: { endsAt: "must be after scheduledAt" } };
  return endsAt;
}
function validateDraft(draft: TMeetingDraft, row: MeetingRow): MeetingActionError | null {
  const issues = new Set(row.issue_ids);
  if ([...draft.readIssueIds, ...draft.carriedIssueIds].some((id) => !issues.has(id))) {
    return { status: 400, code: "INVALID_DRAFT", message: "准备状态引用了不属于该 Meeting 的 Issue", fieldErrors: { readIssueIds: "unknown issue" } };
  }
  const entries = new Set(row.preflight.entries.map((entry) => entry.id));
  if ([...draft.checkedEntryIds, ...Object.keys(draft.editsByEntryId)].some((id) => !entries.has(id))) {
    return { status: 400, code: "INVALID_DRAFT", message: "准备状态引用了不存在的 Preflight entry", fieldErrors: { checkedEntryIds: "unknown entry" } };
  }
  return null;
}
export async function executeCreateMeeting(
  pool: Pool,
  peopleDirectory: PeopleDirectory,
  preflightAgent: PreflightAgent,
  secret: string,
  scope: ActionScope,
  input: { title: string; scheduledAt: string; endsAt?: string; leadDriId: string; ceoParticipantId: string; participants: string[]; issueIds: string[] },
  fingerprint: string,
  /** 建会的人（议题建会是操作的 CEO）。 */
  createdBy: string,
  introAgent?: ThreadIntroAgent,
): Promise<MeetingActionOutcome> {
  if (scope.objectType !== "issue") return { error: { status: 404, code: "UNKNOWN_ACTION", message: "无效 actionId" } };
  const issue = await getIssueRow(pool.query.bind(pool), scope.objectId);
  if (!issue) return { error: { status: 404, code: "ISSUE_NOT_FOUND", message: "Issue 不存在" } };
  if (issue.status === "dismissed") return { error: { status: 409, code: "ISSUE_NOT_MEETING_READY", message: "dismissed Issue 不能创建 Meeting" } };
  const scheduledAt = parseScheduledAt(input.scheduledAt);
  if (!scheduledAt) return { error: { status: 400, code: "INVALID_INPUT", message: "scheduledAt 不是可解析时间", fieldErrors: { scheduledAt: "unparsable" } } };
  const endsAt = resolveEndsAt(scheduledAt, input.endsAt);
  if (!(endsAt instanceof Date)) return { error: endsAt };
  const resolved = resolveParticipants(peopleDirectory, input);
  if ("error" in resolved) return { error: resolved.error };
  const issueIds = unique([scope.objectId, ...input.issueIds]);
  if (!(await issuesExist(pool.query.bind(pool), issueIds))) {
    return { error: { status: 400, code: "INVALID_ISSUE", message: "issueIds 包含不存在的 Issue", fieldErrors: { issueIds: "unknown issue" } } };
  }

  const client = await pool.connect();
  const meetingId = randomUUID();
  let created: MeetingRow;
  let isNew = false;
  try {
    await client.query("BEGIN");
    // 同一 Issue 的重复 Action 串行化，避免双击/重试创建第二个 Meeting
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`meeting:create:${scope.objectId}`]);
    const existing = await client.query<MeetingRow>(
      `SELECT ${meetingColumns()} FROM meetings WHERE origin_ref->>'issueId' = $1 AND action_fingerprints ? $2 LIMIT 1`,
      [scope.objectId, fingerprint],
    );
    if (existing.rowCount === 1) {
      // 幂等优先：同一 Action 已产生 Meeting 时直接返回，未命中才校验 Issue version
      created = existing.rows[0];
    } else {
      if (issue.version !== scope.objectVersion) {
        await client.query("ROLLBACK");
        return { conflict: true, latestCard: projectIssueCard(issue, secret) };
      }
      const inserted = await client.query<MeetingRow>(
        `INSERT INTO meetings
           (id, version, title, status, scheduled_at, lead_dri_id, ceo_participant_id,
            participants, issue_ids, preflight, draft, materials, origin_ref, action_fingerprints, ends_at, created_by)
         VALUES ($1, 1, $2, 'scheduled', $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, '[]'::jsonb, $10::jsonb, $11::jsonb, $12, $13)
         RETURNING ${meetingColumns()}`,
        [
          meetingId,
          input.title,
          scheduledAt,
          resolved.lead.personId,
          resolved.ceo.personId,
          JSON.stringify(resolved.participants),
          JSON.stringify(issueIds),
          JSON.stringify(emptyPreflight()),
          JSON.stringify(emptyDraft()),
          JSON.stringify({ type: "issue", issueId: scope.objectId }),
          JSON.stringify([fingerprint]),
          endsAt,
          createdBy,
        ],
      );
      created = inserted.rows[0];
      await syncMeetingMembers(client, created.id, resolved.participants.map((person) => person.personId));
      isNew = true;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  if (isNew) {
    scheduleMeetingIntro(pool, peopleDirectory, introAgent, created.id, created.lead_dri_id,
      created.participants.map((person) => person.personId).filter((id) => id !== created.lead_dri_id), [created.lead_dri_id]);
    await startPreflight(pool, peopleDirectory, preflightAgent, created.id);
  }
  const row = await getMeetingRow(pool.query.bind(pool), created.id);
  return { card: projectMeetingCard(row ?? created, secret) };
}

/**
 * CEO 配置页独立新建 Meeting：不锚定任何既有 Issue（issueIds 允许为空），
 * CEO 从人员目录解析，participants 默认只有 lead DRI。
 * 可选会前材料：落盘后再跑首次预审（有材料时预审 Context 只用材料 + 议题标题）。
 */
export async function createConfigMeeting(
  pool: Pool,
  peopleDirectory: PeopleDirectory,
  preflightAgent: PreflightAgent,
  secret: string,
  input: { title: string; scheduledAt: string; endsAt?: string; leadDriId: string; issueIds?: string[]; materials?: ParsedMaterial[]; materialStorageDir: string },
  introAgent?: ThreadIntroAgent,
): Promise<{ card: TCard } | { error: MeetingActionError }> {
  const scheduledAt = parseScheduledAt(input.scheduledAt);
  if (!scheduledAt) return { error: { status: 400, code: "INVALID_INPUT", message: "scheduledAt 不是可解析时间", fieldErrors: { scheduledAt: "unparsable" } } };
  const endsAt = resolveEndsAt(scheduledAt, input.endsAt);
  if (!(endsAt instanceof Date)) return { error: endsAt };
  const ceo = peopleDirectory.searchPeople(undefined).find((person) => person.roles.includes("ceo"));
  if (!ceo) return { error: { status: 400, code: "INVALID_CEO", message: "company-people.v1 中没有 ceo 角色", fieldErrors: { leadDriId: "ceo missing" } } };
  const resolved = resolveParticipants(peopleDirectory, { leadDriId: input.leadDriId, ceoParticipantId: ceo.personId, participants: [] });
  if ("error" in resolved) return resolved;
  const issueIds = unique(input.issueIds ?? []);
  if (!(await issuesExist(pool.query.bind(pool), issueIds))) {
    return { error: { status: 400, code: "INVALID_ISSUE", message: "issueIds 包含不存在的 Issue", fieldErrors: { issueIds: "unknown issue" } } };
  }
  return insertScheduledMeeting(pool, peopleDirectory, preflightAgent, secret,
    { title: input.title, scheduledAt, endsAt, resolved, issueIds, originRef: { type: "config" }, createdBy: ceo.personId }, introAgent,
    input.materials?.length ? { items: input.materials, storageDir: input.materialStorageDir } : undefined);
}

/**
 * 预约建会：带起止、挂点，只存天枢。成员只能给自己建（leadDriId 缺省或等于本人，否则 403）；
 * CEO 必须从 DRI 里指定主持人（同配置页）。挂点要在开会那个月的选项里。
 */
export async function bookMeeting(
  deps: {
    pool: Pool;
    peopleDirectory: PeopleDirectory;
    preflightAgent: PreflightAgent;
    secret: string;
    introAgent?: ThreadIntroAgent;
    /** 某月能挑的挂点（本月 PO、LTO、本月 Mission、责任单元）。 */
    anchorOptions: (period: string) => Promise<TWorldAnchor[]>;
  },
  viewer: { personId: string; role: "ceo" | "member" },
  input: TMeetingBookingRequest,
): Promise<{ card: TCard } | { error: MeetingActionError }> {
  let leadDriId = input.leadDriId;
  if (viewer.role === "ceo") {
    if (!leadDriId) return { error: { status: 400, code: "INVALID_LEAD_DRI", message: "要指定主持人", fieldErrors: { leadDriId: "required" } } };
  } else {
    if (leadDriId !== undefined && leadDriId !== viewer.personId) return { error: { status: 403, code: "FORBIDDEN", message: "只能给自己建会" } };
    leadDriId = viewer.personId;
  }
  const scheduledAt = parseScheduledAt(input.scheduledAt);
  if (!scheduledAt) return { error: { status: 400, code: "INVALID_INPUT", message: "scheduledAt 不是可解析时间", fieldErrors: { scheduledAt: "unparsable" } } };
  const endsAt = resolveEndsAt(scheduledAt, input.endsAt);
  if (!(endsAt instanceof Date)) return { error: endsAt };
  const ceo = deps.peopleDirectory.searchPeople(undefined).find((person) => person.roles.includes("ceo"));
  if (!ceo) return { error: { status: 400, code: "INVALID_CEO", message: "company-people.v1 中没有 ceo 角色", fieldErrors: { leadDriId: "ceo missing" } } };
  const resolved = resolveParticipants(deps.peopleDirectory, { leadDriId, ceoParticipantId: ceo.personId, participants: input.participants ?? [] });
  if ("error" in resolved) return resolved;
  const options = await deps.anchorOptions(shanghaiDate(scheduledAt).slice(0, 7));
  const anchors: StoredWorldAnchor[] = [];
  for (const anchor of input.anchors) {
    if (anchors.some((other) => other.kind === anchor.kind && other.id === anchor.id)) continue;
    const option = options.find((candidate) => candidate.kind === anchor.kind && candidate.id === anchor.id);
    if (!option) return { error: { status: 400, code: "ANCHOR_NOT_FOUND", message: "挂点只能是 LTO、本月 PO、本月 Mission 或责任单元", fieldErrors: { anchors: "unknown anchor" } } };
    anchors.push(storedAnchor(option));
  }
  return insertScheduledMeeting(deps.pool, deps.peopleDirectory, deps.preflightAgent, deps.secret, {
    title: input.title, scheduledAt, endsAt, resolved, issueIds: [], originRef: { type: "booking" },
    worldAnchors: anchors, createdBy: viewer.personId,
  }, deps.introAgent);
}

/** 建一场 scheduled 会（配置页、预约共用）：落库、同步成员、邀请介绍、可选会前材料，再跑首次预审。 */
async function insertScheduledMeeting(
  pool: Pool,
  peopleDirectory: PeopleDirectory,
  preflightAgent: PreflightAgent,
  secret: string,
  input: {
    title: string; scheduledAt: Date; endsAt: Date; resolved: ResolvedParticipants; issueIds: string[]; originRef: Record<string, unknown>;
    worldAnchors?: StoredWorldAnchor[];
    /** 建会的人（预约的人；配置页是 CEO）：整卡确认只给主持人和他。 */
    createdBy: string;
  },
  introAgent?: ThreadIntroAgent,
  materials?: { items: ParsedMaterial[]; storageDir: string },
): Promise<{ card: TCard } | { error: MeetingActionError }> {
  const { resolved } = input;
  const inserted = await pool.query<MeetingRow>(
    `INSERT INTO meetings
       (id, version, title, status, scheduled_at, lead_dri_id, ceo_participant_id,
        participants, issue_ids, preflight, draft, origin_ref, action_fingerprints, ends_at,
        world_anchors, created_by)
     VALUES ($1, 1, $2, 'scheduled', $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, '[]'::jsonb, $11, $12::jsonb, $13)
     RETURNING ${meetingColumns()}`,
    [
      randomUUID(),
      input.title,
      input.scheduledAt,
      resolved.lead.personId,
      resolved.ceo.personId,
      JSON.stringify(resolved.participants),
      JSON.stringify(input.issueIds),
      JSON.stringify(emptyPreflight()),
      JSON.stringify(emptyDraft()),
      JSON.stringify(input.originRef),
      input.endsAt,
      input.worldAnchors ? JSON.stringify(input.worldAnchors) : null,
      input.createdBy,
    ],
  );
  const created = inserted.rows[0];
  const memberClient = await pool.connect();
  try { await syncMeetingMembers(memberClient, created.id, resolved.participants.map((person) => person.personId)); }
  finally { memberClient.release(); }
  scheduleMeetingIntro(pool, peopleDirectory, introAgent, created.id, created.lead_dri_id,
    created.participants.map((person) => person.personId).filter((id) => id !== created.lead_dri_id), [created.lead_dri_id]);
  if (materials) {
    const stored = await replaceMeetingMaterials(pool, secret, created.id, materials.items, materials.storageDir);
    if ("error" in stored) return stored;
  }
  await startPreflight(pool, peopleDirectory, preflightAgent, created.id);
  const row = await getMeetingRow(pool.query.bind(pool), created.id);
  return { card: projectMeetingCard(row ?? created, secret) };
}

export async function executeJoinMeeting(
  pool: Pool,
  peopleDirectory: PeopleDirectory,
  preflightAgent: PreflightAgent,
  secret: string,
  scope: ActionScope,
  input: { meetingId: string },
  fingerprint: string,
): Promise<MeetingActionOutcome> {
  if (scope.objectType !== "issue") return { error: { status: 404, code: "UNKNOWN_ACTION", message: "无效 actionId" } };
  const issue = await getIssueRow(pool.query.bind(pool), scope.objectId);
  if (!issue) return { error: { status: 404, code: "ISSUE_NOT_FOUND", message: "Issue 不存在" } };
  if (issue.status === "dismissed") return { error: { status: 409, code: "ISSUE_NOT_MEETING_READY", message: "dismissed Issue 不能加入 Meeting" } };
  if (!(await getMeetingRow(pool.query.bind(pool), input.meetingId))) return { error: { status: 404, code: "MEETING_NOT_FOUND", message: "Meeting 不存在" } };
  const outcome = await withMeetingLock(pool, input.meetingId, secret, fingerprint, undefined, async (client, row) => {
    // 幂等已在行锁内先行；未命中才校验 Issue version 与状态
    if (issue.version !== scope.objectVersion) return { conflict: true, latestCard: projectIssueCard(issue, secret) };
    if (row.status !== "scheduled") return { error: { status: 409, code: "MEETING_NOT_JOINABLE", message: "只有 scheduled Meeting 可以加入" } };
    if (row.issue_ids.includes(scope.objectId)) return { ...(await commit(client, row, secret)), replayed: true };
    const updated = await updateMeeting(
      client,
      row.id,
      "issue_ids = $2::jsonb, version = version + 1, action_fingerprints = $3::jsonb",
      [JSON.stringify([...row.issue_ids, scope.objectId]), JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))],
    );
    return commit(client, updated, secret);
  });
  // 关联 Issue 变化后会前材料随之重建；重放/无变化不重跑
  if (!("error" in outcome) && !outcome.conflict && !outcome.replayed) {
    await startPreflight(pool, peopleDirectory, preflightAgent, input.meetingId);
    return { card: projectMeetingCard((await getMeetingRow(pool.query.bind(pool), input.meetingId))!, secret) };
  }
  return outcome;
}

export async function executeUpdateDraft(
  pool: Pool,
  secret: string,
  scope: ActionScope,
  input: { readIssueIds?: string[]; carriedIssueIds?: string[]; checkedEntryIds?: string[]; editsByEntryId?: Record<string, string>; note?: string },
  fingerprint: string,
): Promise<MeetingActionOutcome> {
  return withMeetingLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status !== "scheduled") return { error: { status: 409, code: "MEETING_NOT_EDITABLE", message: "只有 scheduled Meeting 可以准备" } };
    const draft: TMeetingDraft = { ...row.draft, editsByEntryId: { ...row.draft.editsByEntryId } };
    if (input.readIssueIds) draft.readIssueIds = unique(input.readIssueIds);
    if (input.carriedIssueIds) draft.carriedIssueIds = unique(input.carriedIssueIds);
    if (input.checkedEntryIds) draft.checkedEntryIds = unique(input.checkedEntryIds);
    if (input.editsByEntryId) draft.editsByEntryId = { ...draft.editsByEntryId, ...input.editsByEntryId };
    if (input.note !== undefined) draft.note = input.note;
    // 已核对条目内容被编辑时自动取消核对，避免旧确认覆盖新表述。
    if (input.editsByEntryId) {
      const edited = new Set(Object.keys(input.editsByEntryId));
      draft.checkedEntryIds = draft.checkedEntryIds.filter((id) => !edited.has(id));
    }
    const invalid = validateDraft(draft, row);
    if (invalid) return { error: invalid };
    const updated = await updateMeeting(
      client,
      row.id,
      "draft = $2::jsonb, version = version + 1, action_fingerprints = $3::jsonb",
      [JSON.stringify(draft), JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))],
    );
    return commit(client, updated, secret);
  });
}

/**
 * 编辑 scheduled Meeting 基本字段：title/scheduledAt/endsAt/leadDriId 至少一项；只改 scheduledAt 时保持原时长。
 * 换主持 DRI 时按 createConfigMeeting 的同一构造方式重建 participants（ceo 在首位，新 lead 其次，其余保持）。
 */
export async function executeEditMeetingDetails(
  pool: Pool,
  peopleDirectory: PeopleDirectory,
  secret: string,
  scope: ActionScope,
  input: { title?: string; scheduledAt?: string; endsAt?: string; leadDriId?: string },
  fingerprint: string,
  introAgent?: ThreadIntroAgent,
  access?: { hostId?: string; futureOnly?: boolean; now?: Date },
): Promise<MeetingActionOutcome> {
  let scheduledAt: Date | null = null;
  if (input.scheduledAt !== undefined) {
    scheduledAt = parseScheduledAt(input.scheduledAt);
    if (!scheduledAt) return { error: { status: 400, code: "INVALID_INPUT", message: "scheduledAt 不是可解析时间", fieldErrors: { scheduledAt: "unparsable" } } };
    if (access?.futureOnly && scheduledAt.getTime() <= (access.now ?? new Date()).getTime())
      return { error: { status: 400, code: "INVALID_INPUT", message: "重新安排的开始时间必须在将来", fieldErrors: { scheduledAt: "future required" } } };
  }
  return withMeetingLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status !== "scheduled") return { error: { status: 409, code: "MEETING_NOT_SCHEDULED", message: "只有 scheduled Meeting 可以编辑" } };
    if ((scheduledAt || input.endsAt) && row.transcript_candidate)
      return { error: { status: 409, code: "TRANSCRIPT_CANDIDATE_EXISTS", message: "请先确认或清除已上传的会议记录，再重新安排会议" } };
    const endsAt = resolveEndsAt(scheduledAt ?? row.scheduled_at, input.endsAt, row.ends_at.getTime() - row.scheduled_at.getTime());
    if (!(endsAt instanceof Date)) return { error: endsAt };
    let participants: TMeetingParticipant[] | null = null;
    if (input.leadDriId !== undefined && input.leadDriId !== row.lead_dri_id) {
      // 保留原参会人（含原主持，换主持不等于把人移出会议），新主持由 resolveParticipants 去重并排在 ceo 之后。
      const attendees = row.participants.map((participant) => participant.personId).filter((id) => id !== row.ceo_participant_id);
      const resolved = resolveParticipants(peopleDirectory, { leadDriId: input.leadDriId, ceoParticipantId: row.ceo_participant_id, participants: attendees });
      if ("error" in resolved) return { error: resolved.error };
      participants = resolved.participants;
    }
    const updated = await updateMeeting(
      client,
      row.id,
      `title = COALESCE($3, title), scheduled_at = COALESCE($4, scheduled_at),
       lead_dri_id = COALESCE($5, lead_dri_id), participants = COALESCE($6::jsonb, participants),
       ends_at = $7, ended_at = CASE WHEN $4::timestamptz IS NOT NULL AND $4::timestamptz <> scheduled_at THEN NULL ELSE ended_at END,
       started_at = CASE WHEN $4::timestamptz IS NOT NULL AND $4::timestamptz <> scheduled_at THEN NULL ELSE started_at END,
       version = version + 1, action_fingerprints = $2::jsonb`,
      [
        JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint)),
        input.title ?? null,
        scheduledAt,
        input.leadDriId ?? null,
        participants ? JSON.stringify(participants) : null,
        endsAt,
      ],
    );
    if (participants) await syncMeetingMembers(client, row.id, participants.map((person) => person.personId));
    const result = await commit(client, updated, secret);
    if (participants) {
      const existingIds = row.participants.map((person) => person.personId);
      scheduleMeetingIntro(pool, peopleDirectory, introAgent, row.id, row.lead_dri_id,
        participants.map((person) => person.personId).filter((id) => !existingIds.includes(id)), existingIds);
    }
    return result;
  }, access?.hostId);
}

export async function executeRequestSupplement(
  pool: Pool,
  peopleDirectory: PeopleDirectory,
  exporter: DriExporter | undefined,
  secret: string,
  scope: ActionScope,
  input: { entryId?: string; targetDriId: string; text: string },
  fingerprint: string,
): Promise<MeetingActionOutcome> {
  const target = peopleDirectory.searchPeople(undefined).find((person) => person.personId === input.targetDriId);
  if (!target) return { error: { status: 400, code: "INVALID_PARTICIPANT", message: "targetDriId 不在 company-people.v1 人员目录中", fieldErrors: { targetDriId: "unknown personId" } } };
  if (!target.roles.includes("dri")) return { error: { status: 400, code: "INVALID_TARGET_DRI", message: "targetDriId 必须具有 dri 角色", fieldErrors: { targetDriId: "role dri required" } } };

  const requestId = randomUUID();
  const createdAt = new Date().toISOString();
  const outcome = await withMeetingLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status !== "scheduled") return { error: { status: 409, code: "MEETING_NOT_EDITABLE", message: "只有 scheduled Meeting 可以请求补充材料" } };
    if (input.entryId && !row.preflight.entries.some((entry) => entry.id === input.entryId)) {
      return { error: { status: 400, code: "INVALID_DRAFT", message: "entryId 不存在", fieldErrors: { entryId: "unknown entry" } } };
    }
    const request: TSupplementRequest = {
      id: requestId,
      entryId: input.entryId ?? null,
      targetDriId: target.personId,
      text: input.text,
      // 先记录；真实外发结果稍后回写，没有渠道时只能停在 pending_export。
      exportStatus: "recorded",
      exportRef: null,
      error: null,
      createdAt,
    };
    const draft: TMeetingDraft = { ...row.draft, supplementRequests: [...row.draft.supplementRequests, request] };
    const updated = await updateMeeting(
      client,
      row.id,
      "draft = $2::jsonb, version = version + 1, action_fingerprints = $3::jsonb",
      [JSON.stringify(draft), JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))],
    );
    return commit(client, updated, secret);
  });
  if ("error" in outcome || outcome.conflict || outcome.replayed) return outcome;

  // 只有首次请求会走到这里：记录后立即尝试真实外发，失败不回滚已保存的请求。
  await updateSupplementStatus(pool, scope.objectId, requestId, "pending_export", null, null);
  if (exporter) {
    try {
      const result = await exporter.export(
        { effectRef: `supplement:${scope.objectId}:${requestId}`, targetDriId: target.personId, text: input.text },
        new AbortController().signal,
      );
      await updateSupplementStatus(pool, scope.objectId, requestId, "delivered", result.exportRef, null);
    } catch (err) {
      await updateSupplementStatus(pool, scope.objectId, requestId, "failed", null, (err as Error).message || "export failed");
    }
  }
  return { card: projectMeetingCard((await getMeetingRow(pool.query.bind(pool), scope.objectId))!, secret) };
}

/** 外发状态回写与其它 draft 写入一样持行锁，避免整份 draft 被并发覆盖。 */
async function updateSupplementStatus(
  pool: Pool,
  meetingId: string,
  requestId: string,
  status: TSupplementRequest["exportStatus"],
  exportRef: string | null,
  error: string | null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM meetings WHERE id = $1 FOR UPDATE", [meetingId]);
    await client.query(
      `UPDATE meetings
          SET draft = jsonb_set(
                draft,
                '{supplementRequests}',
                (
                  SELECT jsonb_agg(
                    CASE WHEN item->>'id' = $2
                      THEN item || jsonb_build_object('exportStatus', $3::text, 'exportRef', $4::jsonb, 'error', $5::jsonb)
                      ELSE item
                    END
                  )
                  FROM jsonb_array_elements(draft->'supplementRequests') AS item
                )
              ),
              version = version + 1,
              updated_at = now()
        WHERE id = $1 AND draft->'supplementRequests' @> jsonb_build_array(jsonb_build_object('id', $2::text))`,
      [meetingId, requestId, status, JSON.stringify(exportRef), JSON.stringify(error)],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
export async function executeCancelMeeting(
  pool: Pool,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
): Promise<MeetingActionOutcome> {
  return withMeetingLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status !== "scheduled") return { error: { status: 409, code: "MEETING_NOT_CANCELLABLE", message: "只有 scheduled Meeting 可以取消" } };
    const updated = await updateMeeting(
      client,
      row.id,
      "status = 'cancelled', transcript_candidate = NULL, version = version + 1, action_fingerprints = $2::jsonb",
      [JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))],
    );
    return commit(client, updated, secret);
  });
}

/** 「这场会开完了」：只记结束时刻，不改 status（held 只表示已有确认的 Transcript，会后抽取依赖它）；之后 Transcript 导入照旧。 */
export async function executeEndMeeting(
  pool: Pool,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
  hostId?: string,
): Promise<MeetingActionOutcome> {
  return withMeetingLock(pool, scope.objectId, secret, fingerprint, scope.objectVersion, async (client, row) => {
    if (row.status !== "scheduled") return { error: { status: 409, code: "MEETING_NOT_ENDABLE", message: "只有 scheduled Meeting 可以标记开完" } };
    const updated = await updateMeeting(
      client,
      row.id,
      "ended_at = now(), version = version + 1, action_fingerprints = $2::jsonb",
      [JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint))],
    );
    return commit(client, updated, secret);
  }, hostId);
}
export type DriMeetingImportResult =
  | { status: 201 | 200; card: TCard }
  | { status: 400 | 409; code: string; message: string; fieldErrors?: Record<string, string> };

function meetingRequestFingerprint(body: {
  externalId: string; title: string; scheduledAt: string; endsAt?: string; leadDriId: string; ceoParticipantId: string; participants: string[]; issueIds: string[];
}): string {
  return createHash("sha256").update(JSON.stringify({
    externalId: body.externalId,
    title: body.title,
    scheduledAt: body.scheduledAt,
    // 未给 endsAt 时 JSON.stringify 省略该键，旧导入的 fingerprint 不变
    endsAt: body.endsAt,
    leadDriId: body.leadDriId,
    ceoParticipantId: body.ceoParticipantId,
    // 人员与 Issue 顺序不影响内容：排序去重后参与 fingerprint
    participants: unique(body.participants).sort(),
    issueIds: unique(body.issueIds).sort(),
  })).digest("hex");
}

/** DRI 服务导入 Meeting 元数据：稳定 Person 目录 + 已存在 Issue，重复导入返回原对象。 */
export async function importDriMeeting(
  pool: Pool,
  peopleDirectory: PeopleDirectory,
  preflightAgent: PreflightAgent,
  secret: string,
  body: {
    externalId: string; title: string; scheduledAt: string; endsAt?: string; leadDriId: string; ceoParticipantId: string; participants: string[]; issueIds: string[];
  },
  introAgent?: ThreadIntroAgent,
): Promise<DriMeetingImportResult> {
  const scheduledAt = parseScheduledAt(body.scheduledAt);
  if (!scheduledAt) return { status: 400, code: "INVALID_INPUT", message: "scheduledAt 不是可解析时间", fieldErrors: { scheduledAt: "unparsable" } };
  const endsAt = resolveEndsAt(scheduledAt, body.endsAt);
  if (!(endsAt instanceof Date)) return { status: 400, code: endsAt.code, message: endsAt.message, fieldErrors: endsAt.fieldErrors };
  const resolved = resolveParticipants(peopleDirectory, body);
  if ("error" in resolved) return { status: 400, code: resolved.error.code, message: resolved.error.message, fieldErrors: resolved.error.fieldErrors };
  const issueIds = unique(body.issueIds);
  if (!(await issuesExist(pool.query.bind(pool), issueIds))) {
    return { status: 400, code: "INVALID_ISSUE", message: "issueIds 包含不存在的 Issue", fieldErrors: { issueIds: "unknown issue" } };
  }
  const requestFingerprint = meetingRequestFingerprint(body);
  const client = await pool.connect();
  let meetingId: string;
  let existing: MeetingRow | null = null;
  try {
    await client.query("BEGIN");
    const found = await client.query<MeetingRow>(`SELECT ${meetingColumns()} FROM meetings WHERE external_id = $1`, [body.externalId]);
    if (found.rowCount === 1) {
      existing = found.rows[0];
      await client.query("COMMIT");
      meetingId = existing.id;
    } else {
      const inserted = await client.query<MeetingRow>(
        `INSERT INTO meetings
           (id, version, title, status, scheduled_at, lead_dri_id, ceo_participant_id,
            participants, issue_ids, preflight, draft, materials, origin_ref, external_id, request_fingerprint, ends_at)
         VALUES ($1, 1, $2, 'scheduled', $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, '[]'::jsonb, $10::jsonb, $11, $12, $13)
         ON CONFLICT DO NOTHING
         RETURNING ${meetingColumns()}`,
        [
          randomUUID(),
          body.title,
          scheduledAt,
          resolved.lead.personId,
          resolved.ceo.personId,
          JSON.stringify(resolved.participants),
          JSON.stringify(issueIds),
          JSON.stringify(emptyPreflight()),
          JSON.stringify(emptyDraft()),
          JSON.stringify({ type: "dri", externalId: body.externalId, leadDriId: resolved.lead.personId }),
          body.externalId,
          requestFingerprint,
          endsAt,
        ],
      );
      if (inserted.rowCount === 1) {
        meetingId = inserted.rows[0].id;
        await syncMeetingMembers(client, meetingId, resolved.participants.map((person) => person.personId));
        await client.query("COMMIT");
      } else {
        await client.query("ROLLBACK");
        const raced = await client.query<MeetingRow>(`SELECT ${meetingColumns()} FROM meetings WHERE external_id = $1`, [body.externalId]);
        if (raced.rowCount !== 1) return { status: 409, code: "DRI_MEETING_EXTERNAL_ID_CONFLICT", message: "externalId 已被占用" };
        existing = raced.rows[0];
        meetingId = existing.id;
      }
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  if (existing) {
    return existing.request_fingerprint === requestFingerprint
      ? { status: 200, card: projectMeetingCard(existing, secret) }
      : { status: 409, code: "DRI_MEETING_EXTERNAL_ID_CONFLICT", message: "同一 externalId 已存在且内容不同" };
  }
  scheduleMeetingIntro(pool, peopleDirectory, introAgent, meetingId, resolved.lead.personId,
    resolved.participants.map((person) => person.personId).filter((id) => id !== resolved.lead.personId), [resolved.lead.personId]);
  await startPreflight(pool, peopleDirectory, preflightAgent, meetingId);
  return { status: 201, card: projectMeetingCard((await getMeetingRow(pool.query.bind(pool), meetingId))!, secret) };
}
