import type { Pool, PoolClient } from "pg";
import { Value } from "@sinclair/typebox/value";
import {
  MeetingCardCandidate,
  MeetingCardDraftRequest,
  type TMeetingActionItem,
  type TMeetingCardCandidate,
  type TMeetingCardDraft,
  type TMeetingCardTargetOption,
  type TMeetingCardView,
  type TMeetingObjectChange,
  type TMeetingSource,
  type TMyMeetingCard,
} from "@warmap/contracts";
import { confirmedView, currentConfirmation, draftChangeOf, meetingRecordState } from "./meetingCardConfirm.js";
import { feishuNotifier, type FeishuNotify } from "./feishu/notify.js";
import { attendeesOf } from "./meetingDecisionView.js";
import { getMeetingRow, type MeetingRow, type Query } from "./meetingStore.js";
import { appliedChanges, type AppliedChanges } from "./meetingObjectSync.js";
import { meetingAnchorGroups } from "./meetingWorld.js";
import { insertNotification } from "./notifications.js";
import { logEvent } from "./observability.js";
import { capturedAtOf, meetingTranscriptUrl, transcriptContentHash } from "./transcriptHash.js";
import { shanghaiLabel } from "./workdays.js";
import type { WorldClient } from "./worldClient.js";
import { anchorHead, recordedStart, type AnchorHeadClient } from "./worldMeetingEvent.js";

/**
 * 会议卡草稿（FR-4.3–4.5）：逐字稿确认后生成一张统一会议卡草稿，取代会后逐条抽取。
 * - 模型只填摘要、按议题的正文段落、拟修改内容和行动项；ID、来源、参会人、挂点对象、时间、修改的原内容和版本由这里填写或核验。
 * - 修改只能定到挂点对象里有文字的组件（拍板 5），targetRef 是「<对象 id>#<块 id>/<组件 id>」，不在候选里的当目标未定。
 * - 主持人或创建人带 draftVersion 整份保存；读卡时目标对象版本变了，重读原内容、标 stale、草稿版本加一。
 * - 本体读失败不拦着生成和读卡：读不到的对象不给候选、不刷新。
 */

/** 会议卡读本体用的接口：挂点解析加取对象（组件内容和版本）。 */
export type CardWorld = AnchorHeadClient & Pick<WorldClient, "getObject">;
export type MeetingCardDeps = {
  /** 本体可写时才有；没有时挂点对象和修改目标都为空。 */
  world?: CardWorld;
  /** 没有飞书妙记的逐字稿，来源地址用天枢会议页。 */
  publicOrigin?: string;
  /** 参会人的显示名（会议成员里没有的人从人员目录取）。 */
  names?: () => Map<string, string>;
  /** 配了飞书：草稿好了的提醒同时推飞书。 */
  feishuNotify?: boolean;
};
export type Viewer = { personId: string; isCeo: boolean };
type CardError = { status: number; code: string; message: string; fieldErrors?: Record<string, string>; view?: TMeetingCardView };
type CardRow = { draft: TMeetingCardDraft | null; action_items: TMeetingActionItem[]; draft_version: number; draft_status: "created" | "draft_ready" };

/** 会后整理（runOutcome）按池取装配好的依赖；app 在 createMeetingFollowThrough 里注册。 */
const registered = new WeakMap<Pool, MeetingCardDeps>();
export function registerMeetingCardDeps(pool: Pool, deps: MeetingCardDeps): void {
  registered.set(pool, deps);
}

const NOT_FOUND = { error: { status: 404, code: "MEETING_NOT_FOUND", message: "会议不存在" } } as const;
const isCalendarDate = (value: string) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const ISO_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const isHostOrCreator = (meeting: Pick<MeetingRow, "lead_dri_id" | "created_by">, personId: string) =>
  meeting.lead_dri_id === personId || (meeting.created_by ?? meeting.lead_dri_id) === personId;
/** 读卡的人：主持人、创建人、CEO、实际参会人（拍板 7）；其他人当会议不存在。 */
export const canReadMeetingCard = (meeting: Pick<MeetingRow, "lead_dri_id" | "created_by" | "attendees_actual" | "participants">, viewer: Viewer) =>
  isHostOrCreator(meeting, viewer.personId) || viewer.isCeo || attendeesOf(meeting).personIds.includes(viewer.personId);

/** 本体里一个对象的文字组件（键是「<块 id>/<组件 id>」）和对象版本。 */
type ObjectRead = { id: string; title: string; version: number; components: Map<string, { type: string; text: string }> };
type WorldBlocks = { blocks?: { id: string; components?: { id?: string; type?: string; text?: unknown }[] }[] };

async function readObject(world: CardWorld, id: string): Promise<ObjectRead> {
  const object = await world.getObject(id);
  const business = object.business as typeof object.business & WorldBlocks;
  const components = new Map<string, { type: string; text: string }>();
  for (const block of business.blocks ?? []) {
    for (const item of block.components ?? []) {
      if (item.id && item.type && typeof item.text === "string" && item.text.trim()) components.set(`${block.id}/${item.id}`, { type: item.type, text: item.text });
    }
  }
  return { id, title: business.title, version: business.object_version, components };
}

/** 逐个读对象；读不到的跳过（只记日志），不让本体故障拦住生成、读卡和保存。 */
async function readObjects(world: CardWorld | undefined, ids: string[]): Promise<Map<string, ObjectRead>> {
  const objects = new Map<string, ObjectRead>();
  if (!world) return objects;
  for (const id of new Set(ids)) {
    try {
      objects.set(id, await readObject(world, id));
    } catch (error) {
      logEvent({ event: "meeting_card.world_read", objectRef: `world:${id}`, status: "failed", errorCode: (error as { code?: string }).code ?? "WORLD_READ_FAILED" });
    }
  }
  return objects;
}

const splitTarget = (targetRef: string) => {
  const at = targetRef.indexOf("#");
  return at > 0 ? { objectId: targetRef.slice(0, at), path: targetRef.slice(at + 1) } : null;
};
/** 本体组件类型的中文名（修改标题、同步行用）；表里没有的原样显示。 */
const COMPONENT_LABELS: Record<string, string> = {
  outcome: "结果", acceptance_criterion: "验收标准", success_criterion: "成功标准", realization_logic: "实现逻辑", time_boundary: "时间边界", contribution: "贡献",
  scope_boundary: "范围边界", core_path: "核心路径", milestone: "里程碑", constraint_dependency: "约束与依赖", key_trade_off: "关键取舍",
};
const titleOf = (object: ObjectRead, type: string) => `${object.title} · ${COMPONENT_LABELS[type] ?? type}`;

/** 挂点对象里有文字的组件，按对象、块、组件原顺序。 */
function targetOptionsOf(refs: string[], objects: Map<string, ObjectRead>): TMeetingCardTargetOption[] {
  return refs.flatMap((id) => {
    const object = objects.get(id);
    return object ? [...object.components].map(([path, item]) => ({ targetRef: `${id}#${path}`, title: titleOf(object, item.type), componentType: item.type, text: item.text })) : [];
  });
}

/** 一处修改定到目标：目标在对象里就带上原内容、版本和标题，不在就是目标未定。 */
function resolveTarget(targetRef: string | null, objects: Map<string, ObjectRead>): Pick<TMeetingObjectChange, "targetRef" | "targetTitle" | "expectedVersion" | "before"> {
  const target = targetRef ? splitTarget(targetRef) : null;
  const object = target ? objects.get(target.objectId) : undefined;
  const component = target && object ? object.components.get(target.path) : undefined;
  if (!object || !component) return { targetRef: null, targetTitle: null, expectedVersion: null, before: null };
  return { targetRef, targetTitle: titleOf(object, component.type), expectedVersion: object.version, before: { text: component.text } };
}

/** 挂点对象的本体 id：按挂点候选组回退（建会选的 → 主持人负责的单元 → 公司），取第一组对得上的；对不上的不放。 */
export async function relatedObjectRefsOf(q: Query, world: CardWorld | undefined, meeting: MeetingRow): Promise<string[]> {
  if (!world) return [];
  for (const group of await meetingAnchorGroups(q, meeting)) {
    const ids: string[] = [];
    for (const anchor of group) {
      const head = await anchorHead(q, world, anchor);
      if (head && !ids.includes(head.object_id)) ids.push(head.object_id);
    }
    if (ids.length) return ids;
  }
  return [];
}

/** 生成前的准备：完整会议行、挂点对象和候选目标（给模型选）。本体读不到时都为空。 */
export type CardGeneration = { meeting: MeetingRow; relatedObjectRefs: string[]; objects: Map<string, ObjectRead>; targetOptions: TMeetingCardTargetOption[] };
export async function prepareCardGeneration(pool: Pool, meetingId: string): Promise<CardGeneration> {
  const q: Query = pool.query.bind(pool);
  const meeting = (await getMeetingRow(q, meetingId))!;
  const world = registered.get(pool)?.world;
  let relatedObjectRefs: string[] = [];
  try {
    relatedObjectRefs = await relatedObjectRefsOf(q, world, meeting);
  } catch (error) {
    logEvent({ event: "meeting_card.world_read", objectRef: `meeting:${meetingId}`, status: "failed", errorCode: (error as { code?: string }).code ?? "WORLD_READ_FAILED" });
  }
  const objects = await readObjects(world, relatedObjectRefs);
  return { meeting, relatedObjectRefs, objects, targetOptions: targetOptionsOf(relatedObjectRefs, objects) };
}

/** 来源：Task 1 记下的逐字稿来源；旧数据、服务导入的 JSON 没有这些字段时，地址用会议页，摘要值算导入的整份逐字稿。 */
function sourceOf(meeting: MeetingRow, publicOrigin: string): TMeetingSource {
  const transcript = meeting.transcript!;
  const source = transcript.source;
  return {
    id: "src-1",
    url: source?.url ?? meetingTranscriptUrl(publicOrigin, meeting.id),
    title: source?.title ?? meeting.title,
    contentHash: source?.contentHash ?? transcriptContentHash(JSON.stringify({ schemaVersion: transcript.schemaVersion, meetingId: transcript.meetingId, turns: transcript.turns })),
    sourceVersion: null,
    capturedAt: source?.capturedAt ?? capturedAtOf(new Date(transcript.importedAt)),
  };
}

/** 会议成员（实际参会优先）和他们在本体里的主体；对不上就 null，不编造。 */
function participantsOf(meeting: MeetingRow, deps: MeetingCardDeps) {
  const names = deps.names?.() ?? new Map<string, string>();
  return attendeesOf(meeting).personIds.map((personId) => ({
    name: meeting.participants.find((person) => person.personId === personId)?.displayName ?? names.get(personId) ?? personId,
    personRef: deps.world?.config.people[personId] ?? null,
  }));
}
/** 行动项的负责人只能是这场会的人（会议成员或实际参会）。 */
const memberIds = (meeting: MeetingRow) => new Set([...meeting.participants.map((person) => person.personId), ...attendeesOf(meeting).personIds]);

/** 卡片按纯文本显示：去掉模型写进摘要和正文的 Markdown 加粗记号（**x**、__x__）；单个 * 和 _、列表的「- 」保留。 */
export function stripEmphasis(text: string): string {
  return text.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, "$1").replace(/(?<![A-Za-z0-9_])__(?=\S)(.+?)(?<=\S)__(?![A-Za-z0-9_])/g, "$1");
}

/**
 * 模型候选 → 草稿和行动项：段落编号 sec-N，turnId 换成出处（连着的发言并成一处）；修改编号 chg-N，目标不在候选里的当未定；
 * 行动项编号 act-N，负责人不是这场会的人、日期不合法的当没填；依据段落序号换成段落 id，指不到的丢掉。候选不合 schema 返回 null。
 */
export function buildCardDraft(pool: Pool, prepared: CardGeneration, candidate: unknown): { draft: TMeetingCardDraft; actionItems: TMeetingActionItem[] } | null {
  if (!Value.Check(MeetingCardCandidate, candidate)) return null;
  const value: TMeetingCardCandidate = candidate;
  const deps = registered.get(pool) ?? {};
  const { meeting } = prepared;
  const order = new Map((meeting.transcript?.turns ?? []).map((turn, index) => [turn.id, index]));
  const sectionIds = value.sections.map((_, index) => `sec-${index + 1}`);
  const basis = (numbers: number[]) => [...new Set(numbers)].filter((n) => n <= sectionIds.length).map((n) => sectionIds[n - 1]);
  const sections = value.sections.map((section, index) => {
    const turns = [...new Set(section.turnIds)].filter((id) => order.has(id)).sort((a, b) => order.get(a)! - order.get(b)!);
    // 逐句引用：逐字稿里连着的发言并成一处，隔开的各算一处，不合成一个覆盖中间所有发言的大区间。
    const runs: string[][] = [];
    for (const id of turns) {
      const run = runs[runs.length - 1];
      if (run && order.get(id)! === order.get(run[run.length - 1])! + 1) run.push(id);
      else runs.push([id]);
    }
    const sourceRefs = runs.length
      ? runs.map((run) => ({ sourceId: "src-1", locator: run.length === 1 ? run[0] : `${run[0]}..${run[run.length - 1]}` }))
      : [{ sourceId: "src-1", locator: null }];
    return { id: sectionIds[index], heading: section.heading, body: stripEmphasis(section.body), sourceRefs };
  });
  const options = new Set(prepared.targetOptions.map((option) => option.targetRef));
  const objectChanges = value.objectChanges.map((change, index) => ({
    id: `chg-${index + 1}`,
    ...resolveTarget(options.has(change.targetRef) ? change.targetRef : null, prepared.objects),
    after: { text: change.after.text },
    basisSectionIds: basis(change.basisSections),
    stale: false,
  }));
  const members = memberIds(meeting);
  const actionItems = value.actionItems.map((item, index) => ({
    id: `act-${index + 1}`,
    text: item.text,
    ownerPersonId: item.ownerPersonId && members.has(item.ownerPersonId) ? item.ownerPersonId : null,
    dueDate: item.dueDate && isCalendarDate(item.dueDate) ? item.dueDate : null,
    basisSectionIds: basis(item.basisSections),
    taskId: null,
  }));
  return {
    draft: {
      schemaVersion: "meeting-card.v1", meetingId: meeting.id, title: meeting.title, occurredAt: recordedStart(meeting)?.toISOString() ?? null,
      participants: participantsOf(meeting, deps), relatedObjectRefs: prepared.relatedObjectRefs, summary: stripEmphasis(value.summary), sections,
      sources: [sourceOf(meeting, deps.publicOrigin ?? "")], objectChanges,
    },
    actionItems,
  };
}

/**
 * 存下生成的草稿（和会后整理的 ready 同一事务）：第一次 draft_version 为 1，重新生成在原版本上加一。
 * 同一事务里提醒主持人和创建人去确认（见 notifyCardPending）。
 */
export async function saveGeneratedCard(pool: Pool, client: PoolClient, meetingId: string, built: { draft: TMeetingCardDraft; actionItems: TMeetingActionItem[] }): Promise<void> {
  await client.query(
    `INSERT INTO meeting_cards (meeting_id, draft, action_items, draft_version, draft_status) VALUES ($1, $2::jsonb, $3::jsonb, 1, 'draft_ready')
     ON CONFLICT (meeting_id) DO UPDATE SET draft = EXCLUDED.draft, action_items = EXCLUDED.action_items,
       draft_version = meeting_cards.draft_version + 1, draft_status = 'draft_ready', updated_at = now()`,
    [meetingId, JSON.stringify(built.draft), JSON.stringify(built.actionItems)],
  );
  await notifyCardPending(client, meetingId, registered.get(pool)?.feishuNotify ? feishuNotifier(client.query.bind(client)) : undefined);
}

/**
 * 草稿好了：主持人和创建人各一条「<会名> · 会议记录待确认」，一场会只发一次（唯一约束兜底，再存草稿、重新生成都不再发）；
 * 配了飞书同时推一次，点了去会议页。提醒只提示，不改任何状态。
 */
async function notifyCardPending(client: PoolClient, meetingId: string, notify?: FeishuNotify): Promise<void> {
  const meeting = (await client.query("SELECT title, scheduled_at, lead_dri_id, created_by, ceo_participant_id FROM meetings WHERE id = $1", [meetingId])).rows[0] as
    Pick<MeetingRow, "title" | "scheduled_at" | "lead_dri_id" | "created_by" | "ceo_participant_id">;
  const title = `${meeting.title} · 会议记录待确认`;
  for (const personId of new Set([meeting.lead_dri_id, meeting.created_by ?? meeting.lead_dri_id])) {
    if (!await insertNotification(client, { personId, kind: "meeting_card_pending", objectType: "meeting", objectId: meetingId })) continue;
    await notify?.({ personId, title, body: shanghaiLabel(new Date(meeting.scheduled_at)),
      links: [{ label: "去确认", path: `${personId === meeting.ceo_participant_id ? "" : "/me"}/meetings/${meetingId}` }] }, `meeting-card-pending:${meetingId}:${personId}`);
  }
}

/** TypeBox 的错误路径 /draft/sections/2/sourceRefs/0/sourceId → sections[2].sourceRefs[0].sourceId（草稿字段不带 draft 前缀）。 */
function fieldPath(path: string): string {
  const parts = path.replace(/^\/draft(?=\/|$)/, "").split("/").filter(Boolean);
  return parts.reduce((joined, part) => (/^\d+$/.test(part) ? `${joined}[${part}]` : joined ? `${joined}.${part}` : part), "") || "draft";
}

export function createMeetingCardService(pool: Pool, deps: MeetingCardDeps) {
  const q: Query = pool.query.bind(pool);
  const cardRow = async (meetingId: string) =>
    (await q("SELECT draft, action_items, draft_version, draft_status FROM meeting_cards WHERE meeting_id = $1", [meetingId])).rows[0] as CardRow | undefined;

  /** 读卡见 canReadMeetingCard；编辑只给主持人和创建人。 */
  async function access(meetingId: string, viewer: Viewer) {
    const meeting = await getMeetingRow(q, meetingId);
    return meeting && canReadMeetingCard(meeting, viewer) ? { meeting, canEdit: isHostOrCreator(meeting, viewer.personId) } : null;
  }

  /**
   * 目标对象版本变了的修改：重读原内容和版本、标 stale（组件没了就成目标未定）；返回刷新后的修改，没有变化时 null。
   * 当前确认版已改成、这次没动的不刷新（之后是别人的改动，不算目标已变）。
   */
  function refreshed(changes: TMeetingObjectChange[], objects: Map<string, ObjectRead>, applied: AppliedChanges): TMeetingObjectChange[] | null {
    let changed = false;
    const next = changes.map((change) => {
      const target = change.targetRef ? splitTarget(change.targetRef) : null;
      const object = target ? objects.get(target.objectId) : undefined;
      if (!object || object.version === change.expectedVersion || applied(change)) return change;
      changed = true;
      return { ...change, ...resolveTarget(change.targetRef, objects), stale: true };
    });
    return changed ? next : null;
  }

  /**
   * 草稿里目标对象版本变了的修改按对象当前值刷新（读卡时；写对象修改遇到冲突时也调）。withAnchors 时连挂点对象一起读（给候选目标）。
   * 返回最新的卡行、刷新前的草稿、读到的对象和当前确认版。
   */
  async function refreshDraft(meetingId: string, withAnchors = false) {
    let row = await cardRow(meetingId);
    const draft = row?.draft ?? null;
    const current = row ? await currentConfirmation(q, meetingId) : null;
    let objects = new Map<string, ObjectRead>();
    if (row && draft) {
      const targetIds = draft.objectChanges.flatMap((change) => (change.targetRef ? [splitTarget(change.targetRef)?.objectId ?? ""] : [])).filter(Boolean);
      objects = await readObjects(deps.world, [...(withAnchors ? draft.relatedObjectRefs : []), ...targetIds]);
      const changes = refreshed(draft.objectChanges, objects, appliedChanges(current));
      if (changes) {
        const updated = await q(
          `UPDATE meeting_cards SET draft = jsonb_set(draft, '{objectChanges}', $3::jsonb), draft_version = draft_version + 1, updated_at = now()
            WHERE meeting_id = $1 AND draft_version = $2 RETURNING draft, action_items, draft_version, draft_status`,
          [meetingId, row.draft_version, JSON.stringify(changes)],
        );
        // 别人刚好也改了：读最新的，不再刷新。
        row = (updated.rows[0] as CardRow | undefined) ?? await cardRow(meetingId);
      }
    }
    return { row, draft, objects, current };
  }

  async function buildView(meetingId: string, canEdit: boolean): Promise<TMeetingCardView> {
    const { row, draft, objects, current } = await refreshDraft(meetingId, canEdit);
    const targetOptions: TMeetingCardTargetOption[] = draft && canEdit ? targetOptionsOf(draft.relatedObjectRefs, objects) : [];
    return {
      draft: row?.draft ?? null, draftVersion: row?.draft_version ?? 0, draftStatus: row?.draft_status ?? "created", actionItems: row?.action_items ?? [],
      ...confirmedView(current), targetOptions, canEdit, draftChange: draftChangeOf(row?.draft ?? null, row?.action_items ?? [], current),
    };
  }

  async function view(meetingId: string, viewer: Viewer): Promise<{ view: TMeetingCardView } | typeof NOT_FOUND> {
    const found = await access(meetingId, viewer);
    return found ? { view: await buildView(meetingId, found.canEdit) } : NOT_FOUND;
  }

  /**
   * 整份保存草稿：来源、挂点、meetingId 以服务为准；每处修改的原内容、版本、标题按挂点对象重读（本体读不到的对象，目标没改的沿用原来的）；
   * stale 只由服务改（同一处修改、目标没变时沿用），行动项的 taskId 只由服务改。
   */
  async function saveDraft(meetingId: string, viewer: Viewer, body: unknown): Promise<{ view: TMeetingCardView } | { error: CardError }> {
    const found = await access(meetingId, viewer);
    if (!found?.canEdit) return NOT_FOUND;
    if (!Value.Check(MeetingCardDraftRequest, body)) {
      const fieldErrors: Record<string, string> = {};
      for (const error of Value.Errors(MeetingCardDraftRequest, body)) fieldErrors[fieldPath(error.path)] ??= error.message;
      return { error: { status: 400, code: "INVALID_INPUT", message: "会议卡草稿不合格式", fieldErrors } };
    }
    const row = await cardRow(meetingId);
    if (!row?.draft) return { error: { status: 409, code: "CARD_NOT_READY", message: "会议卡草稿还没生成" } };
    const changedError = async (): Promise<{ error: CardError }> => ({ error: { status: 409, code: "DRAFT_CHANGED", message: "会议卡已被修改，请查看最新内容",
      view: await buildView(meetingId, true) } });
    if (body.draftVersion !== row.draft_version) return changedError();

    const current = row.draft;
    const input = body.draft;
    const objects = await readObjects(deps.world, current.relatedObjectRefs);
    const applied = appliedChanges(await currentConfirmation(q, meetingId));
    const options = new Set(targetOptionsOf(current.relatedObjectRefs, objects).map((option) => option.targetRef));
    const previous = new Map(current.objectChanges.map((change) => [change.id, change]));
    const fieldErrors: Record<string, string> = {};
    let invalidTarget = false;
    const unique = (ids: string[], path: (index: number) => string) => ids.forEach((id, index) => { if (ids.indexOf(id) !== index) fieldErrors[path(index)] = "ID 重复"; });

    if (!input.title.trim()) fieldErrors.title = "会议名不能为空";
    if (input.occurredAt !== null && (!ISO_WITH_TIMEZONE.test(input.occurredAt) || Number.isNaN(Date.parse(input.occurredAt)))) fieldErrors.occurredAt = "要带时区的 ISO 时间";
    const sourceIds = new Set(current.sources.map((source) => source.id));
    const sectionIds = new Set(input.sections.map((section) => section.id));
    unique(input.sections.map((section) => section.id), (i) => `sections[${i}].id`);
    input.sections.forEach((section, i) => {
      if (!section.heading.trim()) fieldErrors[`sections[${i}].heading`] = "议题不能为空";
      if (!section.body.trim()) fieldErrors[`sections[${i}].body`] = "正文不能为空";
      section.sourceRefs.forEach((ref, j) => { if (!sourceIds.has(ref.sourceId)) fieldErrors[`sections[${i}].sourceRefs[${j}].sourceId`] = "来源不存在"; });
    });
    const checkBasis = (ids: string[], path: string) => ids.forEach((id, j) => { if (!sectionIds.has(id)) fieldErrors[`${path}.basisSectionIds[${j}]`] = "依据段落不存在"; });
    unique(input.objectChanges.map((change) => change.id), (i) => `objectChanges[${i}].id`);
    const objectChanges = input.objectChanges.map((change, i) => {
      checkBasis(change.basisSectionIds, `objectChanges[${i}]`);
      if (!change.after.text.trim()) fieldErrors[`objectChanges[${i}].after.text`] = "改后的内容不能为空";
      const before = previous.get(change.id);
      const keep = before && before.targetRef === change.targetRef;
      const kept = keep ? { targetRef: before.targetRef, targetTitle: before.targetTitle, expectedVersion: before.expectedVersion, before: before.before } : null;
      // 当前确认版已改成、这次没动：不按对象当前版本重读（不标目标已变、不挪基准）。
      const done = keep && applied(change);
      let target = done ? kept! : resolveTarget(change.targetRef, objects);
      if (!done && change.targetRef && !options.has(change.targetRef)) {
        // 挂点对象这次没读到、目标也没改：沿用原来的原内容和版本。目标没改、组件没了：目标未定（resolveTarget 已给空）。
        const objectId = splitTarget(change.targetRef)?.objectId ?? "";
        const unread = current.relatedObjectRefs.includes(objectId) && !objects.has(objectId);
        if (keep && unread) target = kept!;
        else if (!keep) {
          invalidTarget = true;
          fieldErrors[`objectChanges[${i}].targetRef`] = "目标只能从挂点对象的文字组件里选";
        }
      }
      // 同一目标、对象版本这次读到的和草稿里的不同：差异已按新版本重读，标 stale 让主持人重看（保存不能悄悄把基准挪到新版本）。
      const stale = keep && !done && target.targetRef !== null ? before.stale || target.expectedVersion !== before.expectedVersion : false;
      return { id: change.id, ...target, after: { text: change.after.text }, basisSectionIds: change.basisSectionIds, stale };
    });
    const members = memberIds(found.meeting);
    const items = body.actionItems ?? row.action_items;
    unique(items.map((item) => item.id), (i) => `actionItems[${i}].id`);
    const actionItems = items.map((item, i) => {
      if (!item.text.trim()) fieldErrors[`actionItems[${i}].text`] = "事项不能为空";
      if (item.ownerPersonId !== null && !members.has(item.ownerPersonId)) fieldErrors[`actionItems[${i}].ownerPersonId`] = "负责人要是这场会的人";
      if (item.dueDate !== null && !isCalendarDate(item.dueDate)) fieldErrors[`actionItems[${i}].dueDate`] = "日期不合法";
      checkBasis(item.basisSectionIds, `actionItems[${i}]`);
      return { ...item, taskId: null }; // 前端传的不算，写入时按行里已存的回填
    });
    if (Object.keys(fieldErrors).length) {
      return { error: { status: 400, code: invalidTarget ? "INVALID_TARGET" : "INVALID_DRAFT", message: invalidTarget ? "修改的目标不在挂点对象里" : "会议卡草稿没通过校验", fieldErrors } };
    }

    const personRefs = new Map(current.participants.map((person) => [person.name, person.personRef]));
    const draft: TMeetingCardDraft = {
      ...input,
      schemaVersion: current.schemaVersion, meetingId: current.meetingId, relatedObjectRefs: current.relatedObjectRefs, sources: current.sources,
      participants: input.participants.map((person) => ({ name: person.name, personRef: personRefs.get(person.name) ?? null })),
      objectChanges,
    };
    // taskId 取写入这一刻行里的（同时确认刚回填的不被读到的旧值盖掉）：并发更新后 UPDATE 按最新的行重算。
    const saved = await q(
      `UPDATE meeting_cards k SET draft = $3::jsonb, draft_version = draft_version + 1, updated_at = now(), action_items = (
          SELECT COALESCE(jsonb_agg(item || jsonb_build_object('taskId',
            (SELECT old -> 'taskId' FROM jsonb_array_elements(k.action_items) old WHERE old ->> 'id' = item ->> 'id' LIMIT 1)) ORDER BY ord), '[]'::jsonb)
            FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS input(item, ord))
        WHERE meeting_id = $1 AND draft_version = $2`,
      [meetingId, body.draftVersion, JSON.stringify(draft), JSON.stringify(actionItems)],
    );
    if (saved.rowCount !== 1) return changedError();
    return { view: await buildView(meetingId, true) };
  }

  /**
   * 挂点改了以后：草稿的挂点对象跟着改，指向不再挂着的对象的修改成目标未定（要重新选目标），草稿版本加一
   * （还没有草稿、挂点对象没变、本体读不到都不动）。草稿版本在读和写之间变了（有人刚存过）就重读再来。
   */
  async function anchorsChanged(meetingId: string): Promise<void> {
    const meeting = await getMeetingRow(q, meetingId);
    if (!meeting || !(await cardRow(meetingId))?.draft) return;
    let refs: string[];
    try {
      refs = await relatedObjectRefsOf(q, deps.world, meeting);
    } catch (error) {
      logEvent({ event: "meeting_card.world_read", objectRef: `meeting:${meetingId}`, status: "failed", errorCode: (error as { code?: string }).code ?? "WORLD_READ_FAILED" });
      return;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await cardRow(meetingId);
      const draft = row?.draft;
      if (!row || !draft) return;
      if (refs.length === draft.relatedObjectRefs.length && refs.every((ref, index) => ref === draft.relatedObjectRefs[index])) return;
      const objectChanges = draft.objectChanges.map((change) => {
        const objectId = change.targetRef ? splitTarget(change.targetRef)?.objectId : undefined;
        return objectId === undefined || refs.includes(objectId) ? change
          : { ...change, targetRef: null, targetTitle: null, expectedVersion: null, before: null, stale: false };
      });
      const updated = await q(`UPDATE meeting_cards SET draft = $3::jsonb, draft_version = draft_version + 1, updated_at = now()
        WHERE meeting_id = $1 AND draft_version = $2`, [meetingId, row.draft_version, JSON.stringify({ ...draft, relatedObjectRefs: refs, objectChanges })]);
      if (updated.rowCount) return;
    }
  }

  /**
   * 我要处理的会议记录（通知栏一场会一条）：我是主持人或创建人、草稿已生成的会里，还没确认过的、确认后又改了的、写入失败的。
   * 已确认在写入中、已写入、选了不写入的不列。只读，不改任何状态。
   */
  async function pendingFor(personId: string): Promise<TMyMeetingCard[]> {
    const rows = (await q(
      `SELECT m.id, m.title, COALESCE(m.ended_at, m.ends_at) AS ended_at FROM meetings m JOIN meeting_cards k ON k.meeting_id = m.id
        WHERE k.draft_status = 'draft_ready' AND (m.lead_dri_id = $1 OR COALESCE(m.created_by, m.lead_dri_id) = $1)
        ORDER BY COALESCE(m.ended_at, m.ends_at) DESC`,
      [personId],
    )).rows as { id: string; title: string; ended_at: Date }[];
    const meetings: TMyMeetingCard[] = [];
    for (const row of rows) {
      const record = await meetingRecordState(q, row.id, (id) => id);
      const status = record.version === 0 ? "pending" : record.status === "edit_pending" || record.status === "failed" ? record.status : null;
      if (status) meetings.push({ meetingId: row.id, title: row.title, endedAt: new Date(row.ended_at).toISOString(), status });
    }
    return meetings;
  }

  return { view, saveDraft, anchorsChanged, pendingFor, refreshDraft: async (meetingId: string) => { await refreshDraft(meetingId); } };
}

export type MeetingCardService = ReturnType<typeof createMeetingCardService>;
