import type { TCreatePlanMarkRequest, THomePlanMark, TPatchPlanMarkRequest } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { monthDays } from "./workCalendar.js";

/** 一个人在一个 Mission 下最多这么多个计划点。 */
const MARK_LIMIT = 20;

export type PlanMarkError = { error: { status: 400 | 404 | 409; code: string; message: string } };
const fail = (status: PlanMarkError["error"]["status"], code: string, message: string): PlanMarkError => ({ error: { status, code, message } });

type Row = { id: string; mission_id: string; date: string; label: string };
const COLUMNS = "id::text AS id, mission_id, date::text AS date, label";
const view = (row: Row): THomePlanMark => ({ id: row.id, missionId: row.mission_id, date: row.date, label: row.label });

/** 日期是这个 Mission 那个月里真实存在的一天（2026-10-32 这类也算不在里面）。 */
const inPeriod = (period: string, date: string) => monthDays(period).some((day) => day.date === date);

/** 本人在这些 Mission 下的计划点，按日期排。 */
export async function listPlanMarks(q: Query, ownerId: string, missionIds: string[]): Promise<THomePlanMark[]> {
  const rows = (await q(`SELECT ${COLUMNS} FROM plan_marks WHERE owner_id=$1 AND mission_id = ANY($2) ORDER BY date, created_at, id`,
    [ownerId, missionIds])).rows as Row[];
  return rows.map(view);
}

/** 只能挂在本人的非占位 Mission 下；名字去掉首尾空白后不能为空。 */
export async function createPlanMark(q: Query, ownerId: string, input: TCreatePlanMarkRequest): Promise<THomePlanMark | PlanMarkError> {
  const label = input.label.trim();
  if (!label) return fail(400, "INVALID_INPUT", "请填写名字");
  const mission = (await q("SELECT period FROM missions WHERE id=$1 AND owner_id=$2 AND NOT placeholder", [input.missionId, ownerId])).rows[0] as { period: string } | undefined;
  if (!mission) return fail(404, "MISSION_NOT_FOUND", "Mission 不存在");
  if (!inPeriod(mission.period, input.date)) return fail(400, "MARK_OUT_OF_PERIOD", "日期不在这个 Mission 的月份里");
  const row = (await q(`INSERT INTO plan_marks (owner_id, mission_id, date, label)
    SELECT $1, $2, $3, $4 WHERE (SELECT count(*) FROM plan_marks WHERE owner_id=$1 AND mission_id=$2) < ${MARK_LIMIT}
    RETURNING ${COLUMNS}`, [ownerId, input.missionId, input.date, label])).rows[0] as Row | undefined;
  return row ? view(row) : fail(409, "MARK_LIMIT", `一个 Mission 下最多 ${MARK_LIMIT} 个计划点`);
}

/** 改日期或名字，不能换 Mission；不是本人的点按不存在算（null）。 */
export async function patchPlanMark(q: Query, ownerId: string, id: string, input: TPatchPlanMarkRequest): Promise<THomePlanMark | PlanMarkError | null> {
  const label = input.label?.trim();
  if (label === "") return fail(400, "INVALID_INPUT", "请填写名字");
  // id 按文本比，不是 uuid 的路径参数也只是找不到，不会让库报错。
  const mark = (await q(`SELECT m.period FROM plan_marks p JOIN missions m ON m.id=p.mission_id WHERE p.id::text=$1 AND p.owner_id=$2`,
    [id, ownerId])).rows[0] as { period: string } | undefined;
  if (!mark) return null;
  if (input.date !== undefined && !inPeriod(mark.period, input.date)) return fail(400, "MARK_OUT_OF_PERIOD", "日期不在这个 Mission 的月份里");
  const row = (await q(`UPDATE plan_marks SET date=COALESCE($3, date), label=COALESCE($4, label), updated_at=now()
    WHERE id::text=$1 AND owner_id=$2 RETURNING ${COLUMNS}`, [id, ownerId, input.date ?? null, label ?? null])).rows[0] as Row | undefined;
  return row ? view(row) : null;
}

export async function deletePlanMark(q: Query, ownerId: string, id: string): Promise<boolean> {
  return Boolean((await q("DELETE FROM plan_marks WHERE id::text=$1 AND owner_id=$2", [id, ownerId])).rowCount);
}
