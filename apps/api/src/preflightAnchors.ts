import type { Query, StoredWorldAnchor } from "./meetingStore.js";
import { logEvent } from "./observability.js";
import type { WorldClient } from "./worldClient.js";
import { worldGoalOf } from "./worldReader.js";

/**
 * 会前预审按挂点定向读内容（v5，10/28）：约会议时挑的长期目标、本月目标、Mission、责任单元，读出它们已经写下的结果、
 * 验收标准、里程碑与取舍，预审据此说清「这场会对我们意味着什么」。
 * - 长期目标、本月目标读本体（只读 GET）；本体没配或读不到时只给名称，readState 记 title_only，不编内容；
 * - Mission 读天枢 missions 表；它服务的本月目标（world_goal_id）在本体读得到时一并给出；
 * - 责任单元给名称、负责人、六个月结果和本月挂在它下面的 Mission（最多 8 个）。
 * 每段文字最多 600 字、每个列表最多 6 条；本体逐个串行读（本体每次请求都会短暂锁 scope）。
 */
export type PreflightWorld = Pick<WorldClient, "getObject">;

type GoalContext = {
  title: string; status: string | null; period?: string; outcome?: string; successCriteria?: string; acceptance?: string;
  timeBoundary?: string; realizationLogic?: string;
};
export type PreflightAnchorContext =
  | ({ kind: "lto" | "po"; readState: "ok" | "title_only" } & GoalContext)
  | {
    kind: "mission"; readState: "ok"; title: string; owner: string; status: string | null; outcome?: string; why?: string;
    successEvidence?: string[]; milestones?: string[]; keyPath?: string; risk?: string; boundaries?: string; tradeoffs?: string;
    timeBoundary?: string; servesGoal?: GoalContext;
  }
  | { kind: "unit"; readState: "ok"; title: string; owner: string | null; sixMonthOutcome?: string; missions: { title: string; owner: string; outcome?: string }[] };

const TEXT_MAX = 600;
const LIST_MAX = 6;
const UNIT_MISSIONS_MAX = 8;

const clip = (value: string | null | undefined): string | undefined => {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}…` : text;
};
const lines = (values: unknown): string[] | undefined => {
  const list = Array.isArray(values) ? values.flatMap((value) => (typeof value === "string" && value.trim() ? [clip(value)!] : [])).slice(0, LIST_MAX) : [];
  return list.length ? list : undefined;
};
/** 去掉没有内容的字段：模型只看到真写了的东西。 */
const compact = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;

/** 本体里一个长期目标或本月目标的目标块；读不到返回 null（记日志，不拦预审）。 */
async function readGoal(world: PreflightWorld | undefined, id: string): Promise<GoalContext | null> {
  if (!world) return null;
  try {
    const goal = worldGoalOf(await world.getObject(id) as unknown as Parameters<typeof worldGoalOf>[0]);
    return compact({
      title: goal.title, status: goal.lifecycle, period: goal.period ?? undefined, outcome: clip(goal.outcome), successCriteria: clip(goal.successCriteria),
      acceptance: clip(goal.acceptance), timeBoundary: clip(goal.timeBoundary), realizationLogic: clip(goal.realizationLogic),
    });
  } catch (error) {
    logEvent({ event: "preflight.anchor_read", objectRef: `world:${id}`, status: "failed", errorCode: (error as { code?: string }).code ?? "WORLD_READ_FAILED" });
    return null;
  }
}

type MissionRow = {
  title: string; owner_id: string; outcome: string; why: string; success_evidence: unknown; milestones: unknown; key_path: string; risk: string;
  boundaries: string; tradeoffs: string; time_boundary: string; world_goal_id: string | null; world_status_label: string | null; round_status: string | null;
};

/** 挂点按挑选顺序读成预审输入；Mission、单元在天枢里找不到时跳过。 */
export async function readAnchorContext(q: Query, world: PreflightWorld | undefined, anchors: StoredWorldAnchor[], options: {
  period: string; names: Map<string, string>;
}): Promise<PreflightAnchorContext[]> {
  const name = (personId: string) => options.names.get(personId) ?? personId;
  const out: PreflightAnchorContext[] = [];
  for (const anchor of anchors) {
    if (anchor.kind === "lto" || anchor.kind === "po") {
      const goal = await readGoal(world, anchor.id);
      out.push(goal ? { kind: anchor.kind, readState: "ok", ...goal } : { kind: anchor.kind, readState: "title_only", title: anchor.title, status: null });
      continue;
    }
    if (anchor.kind === "mission") {
      const row = (await q(
        `SELECT m.title, m.owner_id, m.outcome, m.why, m.success_evidence, m.milestones, m.key_path, m.risk, m.boundaries, m.tradeoffs, m.time_boundary,
                m.world_goal_id, m.world_status_label, r.status AS round_status
           FROM missions m LEFT JOIN personal_mission_cards c ON c.id = m.personal_mission_card_id LEFT JOIN mission_rounds r ON r.id = c.round_id
          WHERE m.id = $1`, [anchor.id])).rows[0] as MissionRow | undefined;
      if (!row) continue;
      const servesGoal = row.world_goal_id ? await readGoal(world, row.world_goal_id) : null;
      out.push(compact({
        kind: "mission" as const, readState: "ok" as const, title: row.title, owner: name(row.owner_id),
        status: row.round_status === null ? row.world_status_label : row.round_status === "confirmed" ? "已确认" : "草稿",
        outcome: clip(row.outcome), why: clip(row.why), successEvidence: lines(row.success_evidence), milestones: lines(row.milestones),
        keyPath: clip(row.key_path), risk: clip(row.risk), boundaries: clip(row.boundaries), tradeoffs: clip(row.tradeoffs), timeBoundary: clip(row.time_boundary),
        servesGoal: servesGoal ?? undefined,
      }));
      continue;
    }
    const unit = (await q("SELECT name, owner_id, six_month_outcome FROM capability_config WHERE id = $1", [anchor.id])).rows[0] as
      { name: string; owner_id: string; six_month_outcome: string } | undefined;
    if (!unit) continue;
    const missions = (await q(
      "SELECT title, owner_id, outcome FROM missions WHERE capability_id = $1 AND period = $2 AND NOT placeholder ORDER BY code LIMIT $3",
      [anchor.id, options.period, UNIT_MISSIONS_MAX])).rows as { title: string; owner_id: string; outcome: string }[];
    out.push(compact({
      kind: "unit" as const, readState: "ok" as const, title: unit.name, owner: unit.owner_id ? name(unit.owner_id) : null, sixMonthOutcome: clip(unit.six_month_outcome),
      missions: missions.map((mission) => compact({ title: mission.title, owner: name(mission.owner_id), outcome: clip(mission.outcome) })),
    }));
  }
  return out;
}
