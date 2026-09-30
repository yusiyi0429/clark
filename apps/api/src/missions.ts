import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { TCard, TCreateMissionRequest, TMissionCardField, TMissionCardPayload, TMissionEditInput } from "@warmap/contracts";
import { signActionId, type ActionScope } from "./actionToken.js";
import { findUnregisteredBattlefieldId, getRegisteredBattlefieldIds } from "./battlefields.js";
import { findUnregisteredCapabilityId, getRegisteredCapabilityIds } from "./capabilities.js";
import type { MeetingActionOutcome, Query } from "./meetingStore.js";
import { slugId } from "./slug.js";

export const fieldText = (mission: TMissionCardPayload, field: TMissionCardField) => Array.isArray(mission[field]) ? mission[field].join("\n") : mission[field] as string;

/**
 * Mission repository：第七个核心实体。只存周期结果承诺与关系；
 * 执行状态、Task/Activity、完成率一律留在外部 DRI 流程。
 */
export type MissionRow = {
  id: string;
  version: number;
  code: string;
  period: string;
  title: string;
  owner_id: string;
  capability_id: string;
  battlefield_ids: string[];
  outcome: string;
  time_boundary: string;
  tradeoffs: string;
  why: string;
  success_evidence: string[];
  milestones: string[];
  dependencies: string;
  risk: string;
  boundaries: string;
  key_path: string;
  resources: string;
  human_agent_split: string;
  retrospect: string;
  placeholder: boolean;
  personal_mission_card_id: string | null;
  personal_card_round_id: string | null;
  personal_card_status: NonNullable<TMissionCardPayload["personalCard"]>["status"] | null;
  source_ref: string;
  source_document_id: string;
  source_revision: number;
  source_title: string;
  action_fingerprints: string[];
  capability_code: string;
  capability_name: string;
  battlefield_names: string[];
};

/**
 * 战场名按 battlefield_ids 顺序展开；能力显示名与战场名都在读取时现查注册表，不保存第二份事实。
 * ponytail: 单条 SQL 里做两个小 join，21 条 Mission 的规模不需要额外缓存。
 */
const MISSION_COLUMNS = `m.id, m.version, m.code, m.period, m.title, m.owner_id, m.capability_id,
  m.battlefield_ids, m.outcome, m.time_boundary, m.tradeoffs, m.why, m.success_evidence, m.milestones, m.dependencies, m.risk, m.boundaries,
  m.key_path, m.resources, m.human_agent_split, m.retrospect, m.placeholder, m.personal_mission_card_id,
  pc.round_id AS personal_card_round_id, mr.status AS personal_card_status,
  m.source_ref, m.source_document_id, m.source_revision, m.source_title, m.action_fingerprints,
  COALESCE(c.code, '') AS capability_code, COALESCE(c.name, '') AS capability_name,
  COALESCE((SELECT jsonb_agg(COALESCE(b.name, '') ORDER BY t.ord)
              FROM jsonb_array_elements_text(m.battlefield_ids) WITH ORDINALITY AS t(battlefield_id, ord)
              LEFT JOIN battlefield_config b ON b.id = t.battlefield_id), '[]'::jsonb) AS battlefield_names`;

const MISSION_FROM = `FROM missions m LEFT JOIN capability_config c ON c.id = m.capability_id
  LEFT JOIN personal_mission_cards pc ON pc.id = m.personal_mission_card_id
  LEFT JOIN mission_rounds mr ON mr.id = pc.round_id`;

/** 总览与配置页排序：周期倒序，再按能力域 sortOrder、Mission code。period 过滤在 SQL 侧，Web 不再二次筛。 */
export async function listMissionRows(q: Query, period?: string, person?: { personId: string; role: "ceo" | "member" }): Promise<MissionRow[]> {
  const result = await q(
    `SELECT ${MISSION_COLUMNS} ${MISSION_FROM} ${period ? "WHERE m.period = $1" : ""} ORDER BY m.period DESC, c.sort_order NULLS LAST, m.code, m.id`,
    period ? [period] : [],
  );
  const visible: MissionRow[] = [];
  for (const row of result.rows as MissionRow[]) if (await canReadMission(q, row, person)) visible.push(row);
  return visible;
}

/** 任务的通用 Card、引用、对话工具也遵守个人卡准备期保密，不能绕过详情权限。 */
export async function canReadMission(q: Query, mission: Pick<MissionRow, "personal_mission_card_id">,
  person?: { personId: string; role: "ceo" | "member" }): Promise<boolean> {
  if (!mission.personal_mission_card_id) return true;
  const row = (await q(`SELECT c.owner_id,c.owner_confirmed_at,r.status,b.owner_id AS battlefield_owner_id FROM personal_mission_cards c
    JOIN mission_rounds r ON r.id=c.round_id JOIN battlefield_config b ON b.id=r.battlefield_id WHERE c.id=$1`, [mission.personal_mission_card_id])).rows[0];
  if (!row) return false;
  if (!person) return !!row.owner_confirmed_at || row.status === "confirmed";
  return row.owner_id === person.personId || (row.status === "confirmed" || !!row.owner_confirmed_at) && (person.role === "ceo" || row.battlefield_owner_id === person.personId);
}

export async function getMissionRow(q: Query, id: string): Promise<MissionRow | null> {
  const result = await q(`SELECT ${MISSION_COLUMNS} ${MISSION_FROM} WHERE m.id = $1`, [id]);
  return result.rowCount === 1 ? (result.rows[0] as MissionRow) : null;
}

/** Mission 正面：关系显示名由投影现查，owner displayName 只在投影时从企业知识解析。 */
export function projectMissionCard(row: MissionRow, secret: string, ownerNames: Map<string, string>): TCard {
  const scope: ActionScope = { actionType: "mission.edit", objectType: "mission", objectId: row.id, objectVersion: row.version };
  const payload: TMissionCardPayload = {
    missionId: row.id,
    code: row.code,
    period: row.period,
    title: row.title,
    ownerId: row.owner_id,
    ownerDisplayName: ownerNames.get(row.owner_id) ?? "",
    capabilityId: row.capability_id,
    capabilityCode: row.capability_code,
    capabilityName: row.capability_name,
    battlefieldIds: row.battlefield_ids ?? [],
    battlefieldNames: row.battlefield_names ?? [],
    outcome: row.outcome,
    timeBoundary: row.time_boundary ?? "",
    tradeoffs: row.tradeoffs ?? "",
    why: row.why,
    successEvidence: row.success_evidence ?? [],
    milestones: row.milestones ?? [],
    dependencies: row.dependencies,
    risk: row.risk,
    boundaries: row.boundaries,
    keyPath: row.key_path,
    resources: row.resources,
    humanAgentSplit: row.human_agent_split,
    retrospect: row.retrospect,
    placeholder: row.placeholder,
    personalCard: row.personal_mission_card_id && row.personal_card_round_id && row.personal_card_status
      ? { cardId: row.personal_mission_card_id, roundId: row.personal_card_round_id, status: row.personal_card_status }
      : null,
    sourceRef: row.source_ref,
    sourceDocumentId: row.source_document_id,
    sourceRevision: row.source_revision,
    sourceTitle: row.source_title,
  };
  return {
    schemaVersion: 1,
    id: `mission:${row.id}`,
    version: row.version,
    kind: "mission",
    objectRef: { type: "mission", id: row.id, version: row.version },
    title: row.title,
    badge: "Mission",
    urgency: "normal",
    payload,
    navigation: [
      { href: `/missions/${row.id}`, label: "Mission" },
      { href: `/config/missions`, label: "配置" },
    ],
    actions: row.personal_mission_card_id ? [] : [{ actionId: signActionId(secret, scope), actionType: "mission.edit", label: "编辑 Mission" }],
  };
}

/** period 省略表示全部历史（配置页与总览），传入则只取该周期（首页）。 */
export async function listMissionCards(q: Query, secret: string, ownerNames: Map<string, string>, period?: string,
  person?: { personId: string; role: "ceo" | "member" }): Promise<TCard[]> {
  return (await listMissionRows(q, period, person)).map((row) => projectMissionCard(row, secret, ownerNames));
}

export type RegisterMissionResult =
  | { ok: true; id: string }
  | { ok: false; status: 409; code: "MISSION_EXISTS" | "MISSION_CODE_CONFLICT"; message: string };

/** code 表内唯一：Mission 与战场战略锚点是两套命名空间，可以重名。 */
async function missionCodeTaken(q: Query, code: string, selfId: string): Promise<boolean> {
  const rows = await q("SELECT id FROM missions WHERE code = $1 AND id <> $2", [code, selfId]);
  return (rows.rowCount ?? 0) > 0;
}

/** CEO 首次登记 Mission：slug(code + title) 稳定 id；重复 code 返回 409，不静默覆盖已有事实。 */
export async function registerMission(q: Query, input: TCreateMissionRequest): Promise<RegisterMissionResult> {
  const id = slugId(`${input.code} ${input.title}`) || randomUUID();
  if (await missionCodeTaken(q, input.code, id)) {
    return { ok: false, status: 409, code: "MISSION_CODE_CONFLICT", message: `Mission 编号 ${input.code} 已被占用` };
  }
  const result = await q(
    `INSERT INTO missions (id, version, code, period, title, owner_id, capability_id, battlefield_ids, outcome, why,
                           success_evidence, milestones, dependencies, risk, boundaries,
                           source_ref, source_document_id, source_revision, source_title,
                           key_path, resources, human_agent_split, retrospect, time_boundary, tradeoffs)
     VALUES ($1, 1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      id,
      input.code,
      input.period,
      input.title,
      input.ownerId,
      input.capabilityId,
      JSON.stringify(input.battlefieldIds),
      input.outcome,
      input.why ?? "",
      JSON.stringify(input.successEvidence ?? []),
      JSON.stringify(input.milestones ?? []),
      input.dependencies ?? "",
      input.risk ?? "",
      input.boundaries ?? "",
      input.sourceRef,
      input.sourceDocumentId,
      input.sourceRevision,
      input.sourceTitle,
      input.keyPath ?? "",
      input.resources ?? "",
      input.humanAgentSplit ?? "",
      input.retrospect ?? "",
      input.timeBoundary ?? "",
      input.tradeoffs ?? "",
    ],
  );
  if (result.rowCount !== 1) return { ok: false, status: 409, code: "MISSION_EXISTS", message: `Mission ${id} 已登记` };
  return { ok: true, id };
}

/** 关系校验：owner 命中企业知识，capability/battlefield 命中注册表。返回首个不合法字段。 */
export type MissionRelationError = { status: 400; code: "INVALID_OWNER" | "INVALID_CAPABILITY" | "INVALID_BATTLEFIELD"; message: string };

export async function validateMissionRelations(
  q: Query,
  ownerNames: Map<string, string>,
  input: { ownerId?: string; capabilityId?: string; battlefieldIds?: string[] },
): Promise<MissionRelationError | undefined> {
  if (input.ownerId !== undefined && !ownerNames.has(input.ownerId)) {
    return { status: 400, code: "INVALID_OWNER", message: "唯一 DRI 必须命中 company-people.v1" };
  }
  if (input.capabilityId !== undefined) {
    const unknown = findUnregisteredCapabilityId(await getRegisteredCapabilityIds(q), [input.capabilityId]);
    if (unknown) return { status: 400, code: "INVALID_CAPABILITY", message: `capabilityId 未在 CapabilityConfig 注册: ${unknown}` };
  }
  if (input.battlefieldIds !== undefined) {
    const unknown = findUnregisteredBattlefieldId(await getRegisteredBattlefieldIds(q), input.battlefieldIds);
    if (unknown) return { status: 400, code: "INVALID_BATTLEFIELD", message: `battlefieldId 未在 BattlefieldConfig 注册: ${unknown}` };
  }
  return undefined;
}

// ponytail: 幂等指纹随编辑增长，超过上限丢弃最旧项；单个 Mission 的编辑量有限
function appendFingerprint(existing: string[], fingerprint: string): string[] {
  return [...existing.filter((value) => value !== fingerprint), fingerprint].slice(-100);
}

/**
 * mission.edit：锁行 → 重放直接返回当前 Card → version 不符返回 latestCard → 关系校验后 version+1。
 * 拒绝与冲突路径必须先结束事务，否则行锁随连接泄漏回池。
 */
export async function executeEditMission(
  pool: Pool,
  secret: string,
  ownerNames: Map<string, string>,
  scope: ActionScope,
  input: TMissionEditInput,
  fingerprint: string,
  person?: { personId: string; role: "ceo" | "member" },
): Promise<MeetingActionOutcome> {
  const client = await pool.connect();
  try {
    const q: Query = (sql, params) => client.query(sql, params);
    await client.query("BEGIN");
    const locked = await client.query<MissionRow>(`SELECT ${MISSION_COLUMNS} ${MISSION_FROM} WHERE m.id = $1 FOR UPDATE OF m`, [scope.objectId]);
    if (locked.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { error: { status: 404, code: "MISSION_NOT_FOUND", message: "Mission 不存在" } };
    }
    const row = locked.rows[0];
    if (!await canReadMission(q, row, person)) {
      await client.query("ROLLBACK");
      return { error: { status: 404, code: "MISSION_NOT_FOUND", message: "Mission 不存在或不可见" } };
    }
    if (row.action_fingerprints.includes(fingerprint)) {
      await client.query("COMMIT");
      return { card: projectMissionCard(row, secret, ownerNames), replayed: true };
    }
    if (row.version !== scope.objectVersion) {
      await client.query("ROLLBACK");
      return { conflict: true, latestCard: projectMissionCard(row, secret, ownerNames) };
    }
    if (row.personal_mission_card_id) {
      await client.query("ROLLBACK");
      return { error: { status: 409, code: "MISSION_IN_MISSION_CARD", message: "讨论中请在任务卡上提修改建议；已确定之后请在任务卡上申请更正" } };
    }
    const relationError = await validateMissionRelations(q, ownerNames, input);
    if (relationError) {
      await client.query("ROLLBACK");
      return { error: relationError };
    }
    if (input.code !== undefined && (await missionCodeTaken(q, input.code, row.id))) {
      await client.query("ROLLBACK");
      return { error: { status: 409, code: "MISSION_CODE_CONFLICT", message: `Mission 编号 ${input.code} 已被占用` } };
    }
    const updated = await client.query<MissionRow>(
      `UPDATE missions
          SET code = COALESCE($2, code), period = COALESCE($3, period), title = COALESCE($4, title),
              owner_id = COALESCE($5, owner_id), capability_id = COALESCE($6, capability_id),
              battlefield_ids = COALESCE($7::jsonb, battlefield_ids), outcome = COALESCE($8, outcome),
              why = COALESCE($9, why), success_evidence = COALESCE($10::jsonb, success_evidence),
              milestones = COALESCE($11::jsonb, milestones), dependencies = COALESCE($12, dependencies),
              risk = COALESCE($13, risk), boundaries = COALESCE($14, boundaries),
              key_path = COALESCE($16, key_path), resources = COALESCE($17, resources),
              human_agent_split = COALESCE($18, human_agent_split), retrospect = COALESCE($19, retrospect),
              time_boundary = COALESCE($20, time_boundary), tradeoffs = COALESCE($21, tradeoffs),
              version = version + 1, action_fingerprints = $15::jsonb, updated_at = now()
        WHERE id = $1
        RETURNING id`,
      [
        row.id,
        input.code ?? null,
        input.period ?? null,
        input.title ?? null,
        input.ownerId ?? null,
        input.capabilityId ?? null,
        input.battlefieldIds === undefined ? null : JSON.stringify(input.battlefieldIds),
        input.outcome ?? null,
        input.why ?? null,
        input.successEvidence === undefined ? null : JSON.stringify(input.successEvidence),
        input.milestones === undefined ? null : JSON.stringify(input.milestones),
        input.dependencies ?? null,
        input.risk ?? null,
        input.boundaries ?? null,
        JSON.stringify(appendFingerprint(row.action_fingerprints, fingerprint)),
        input.keyPath ?? null,
        input.resources ?? null,
        input.humanAgentSplit ?? null,
        input.retrospect ?? null,
        input.timeBoundary ?? null,
        input.tradeoffs ?? null,
      ],
    );
    if (updated.rowCount !== 1) {
      await client.query("ROLLBACK");
      return { error: { status: 409, code: "MISSION_CODE_CONFLICT", message: `Mission 编号 ${input.code} 已被占用` } };
    }
    const after = await client.query<MissionRow>(`SELECT ${MISSION_COLUMNS} ${MISSION_FROM} WHERE m.id = $1`, [row.id]);
    await client.query("COMMIT");
    return { card: projectMissionCard(after.rows[0], secret, ownerNames) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
