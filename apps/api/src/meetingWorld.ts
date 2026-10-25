import type { TImpactTarget, TMeetingDecisionWorld, TMeetingRecordStatus, TMeetingWorldResponse, TWorldAnchor, TWorldAnchorOption } from "@warmap/contracts";
import type { MeetingRecordState } from "./meetingCardConfirm.js";
import { decisionEffective, type MeetingDecisionRow } from "./meetingDecisionView.js";
import type { MeetingRow, Query, StoredWorldAnchor } from "./meetingStore.js";
import type { WorldClient, WorldHead } from "./worldClient.js";
import { usableWorldHead, worldDisplayText, worldGoalOf } from "./worldReader.js";

/**
 * 会议入本体的挂点与落点（回流设计稿 3.1、3.2）。只在会议页（GET /api/meetings/:id/world）、本体同步、挂点接口里查，
 * 不进读会议的 SQL：那里带上这些相关子查询会把估算代价抬过 JIT 阈值，每次读会议多一秒多（10/19 实测）。
 */
const COMPANY: TWorldAnchor = { kind: "company", id: "company", title: "公司" };
const ORDER = { po: 0, lto: 1, mission: 2, task: 3, unit: 4, company: 5 } as const;
const sorted = (anchors: TWorldAnchor[]) => [...anchors].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.title.localeCompare(b.title, "zh-CN"));

/** 挂点选项读本体用的客户端（列对象，取已确认对象的内容）；本体没配或不可写时为 null，选项只有 Mission 和单元。 */
export type AnchorWorld = Pick<WorldClient, "listObjects" | "getObject">;
/** 已确认对象的 brief，按「对象 id@版本」记：对象改了版本就重读。 */
export type AnchorBriefCache = Map<string, string | null>;

const BRIEF_MAX = 80;
const brief = (text: string | null | undefined): string | null => {
  const value = text?.trim();
  if (!value) return null;
  return value.length > BRIEF_MAX ? `${value.slice(0, BRIEF_MAX - 1)}…` : value;
};
/** 对象的生命周期状态（tkos.world 0.3 records.lifecycle.status：draft 草稿、established 已成立、in_progress 进行中……；没有为 null）。 */
const lifecycleOf = (head: WorldHead): string | null => {
  const status = (head.lifecycle as { status?: unknown } | null)?.status;
  return typeof status === "string" && status ? status : null;
};
/** 已成立的对象才取内容：有生命周期且不是草稿（撤销、作废的已被 usableWorldHead 去掉）。 */
const established = (lifecycle: string | null) => lifecycle !== null && lifecycle !== "draft";
/** 取 PO、LTO 内容时同时最多几个请求。 */
const BRIEF_READS = 4;

/**
 * 预约、改挂点时能挑的对象，按 本月 PO、LTO、本月 Mission、责任单元 排：PO、LTO 读本体（列对象串行，读不到就不给），Mission、单元读天枢。
 * world-02 里没有 Task 对象，不给 Task。每项带已确认的内容（brief）：PO、LTO 取已成立对象目标块的结果组件（同时最多 4 个请求，读不到为 null），
 * Mission 取定义的结果（轮次确认了才给），单元是名称。`briefs` 为 null 时（建会、改挂点的校验）PO、LTO 不取内容，只看列出来的对象。
 * Mission 另带负责人和服务的 PO（载入时记下的 goal_ref，这个 PO 在选项里才给）。
 */
export async function anchorOptions(q: Query, world: AnchorWorld | null, period: string, briefs: AnchorBriefCache | null): Promise<TWorldAnchorOption[]> {
  let goals: TWorldAnchorOption[] = [];
  if (world) {
    try {
      const pos = await world.listObjects({ type: "PeriodGoal", period });
      const ltos = await world.listObjects({ type: "LongTermGoal" });
      goals = [...pos.map((head) => ({ kind: "po" as const, head })), ...ltos.map((head) => ({ kind: "lto" as const, head }))]
        .filter(({ head }) => usableWorldHead(head) && head.title.trim())
        .map(({ kind, head }) => ({ kind, id: head.object_id, title: worldDisplayText(head.title.trim()), brief: null, lifecycle: lifecycleOf(head), ownerId: null, parentId: null }));
      if (briefs) {
        const heads = new Map([...pos, ...ltos].map((head) => [head.object_id, head]));
        const pending = goals.filter((option) => established(option.lifecycle));
        const next = async (): Promise<void> => {
          const option = pending.shift();
          if (!option) return;
          option.brief = await goalBrief(world, heads.get(option.id)!, briefs);
          return next();
        };
        await Promise.all(Array.from({ length: Math.min(BRIEF_READS, pending.length) }, next));
      }
    } catch {
      goals = [];
    }
  }
  const missions = (await q(
    `SELECT m.id, m.title, m.outcome, m.owner_id, m.world_status, m.world_goal_id, r.status AS round_status FROM missions m
       LEFT JOIN personal_mission_cards c ON c.id = m.personal_mission_card_id LEFT JOIN mission_rounds r ON r.id = c.round_id
      WHERE m.period = $1 AND NOT m.placeholder ORDER BY m.code`, [period])).rows as { id: string; title: string; outcome: string; owner_id: string; world_status: string | null; world_goal_id: string | null; round_status: string | null }[];
  const pos = new Set(goals.filter((option) => option.kind === "po").map((option) => option.id));
  const units = (await q("SELECT id, name FROM capability_config ORDER BY sort_order, code")).rows as { id: string; name: string }[];
  return [
    ...goals,
    ...missions.map((row) => ({ kind: "mission" as const, id: row.id, title: row.title,
      brief: row.round_status === "confirmed" ? brief(row.outcome) : null,
      lifecycle: row.round_status === null ? row.world_status : row.round_status === "confirmed" ? "confirmed" : "draft",
      ownerId: row.owner_id, parentId: row.world_goal_id && pos.has(row.world_goal_id) ? row.world_goal_id : null })),
    ...units.map((row) => ({ kind: "unit" as const, id: row.id, title: row.name, brief: brief(row.name), lifecycle: null, ownerId: null, parentId: null })),
  ];
}

/** 一个 PO、LTO 目标块的结果组件；读不到为 null（不缓存，下次再读）。 */
async function goalBrief(world: AnchorWorld, head: WorldHead, cache: AnchorBriefCache): Promise<string | null> {
  const key = `${head.object_id}@${head.version}`;
  if (cache.has(key)) return cache.get(key)!;
  try {
    const value = brief(worldGoalOf(await world.getObject(head.object_id) as unknown as Parameters<typeof worldGoalOf>[0]).outcome);
    cache.set(key, value);
    return value;
  } catch {
    return null;
  }
}

/** 挑中的选项存进 world_anchors 的样子（选项只有 PO、LTO、Mission、单元）。 */
export function storedAnchor(option: TWorldAnchor | StoredWorldAnchor): StoredWorldAnchor {
  if (option.kind === "lto" || option.kind === "po") return { kind: option.kind, id: option.id, title: option.title };
  return { kind: option.kind as "mission" | "unit", id: option.id };
}

/** 这几条决定当前版本的影响卡落到的对象。 */
async function cardTargets(q: Query, decisionIds: string[]): Promise<{ decisionId: string; targets: TImpactTarget[] }[]> {
  if (!decisionIds.length) return [];
  const rows = (await q(
    `SELECT c.trigger_id::text AS decision_id, c.targets FROM impact_cards c JOIN meeting_decisions d ON d.id = c.trigger_id AND d.revision = c.trigger_revision
      WHERE c.trigger_kind = 'meeting_decision' AND c.trigger_id = ANY($1::uuid[])`,
    [decisionIds],
  )).rows as { decision_id: string; targets: TImpactTarget[] }[];
  return rows.map((row) => ({ decisionId: row.decision_id, targets: row.targets }));
}

const titles = async (q: Query, sql: string, ids: string[]) =>
  new Map(ids.length ? ((await q(sql, [ids])).rows as { id: string; title: string }[]).map((row) => [row.id, row.title]) : []);

/** 每条决定落到的 Mission、Task（验收项并进它的 Task，标题取天枢里的现名）。 */
export async function decisionTargets(q: Query, decisions: Pick<MeetingDecisionRow, "id">[]): Promise<Map<string, TWorldAnchor[]>> {
  const cards = await cardTargets(q, decisions.map((row) => row.id));
  const all = cards.flatMap((card) => card.targets);
  const missions = await titles(q, "SELECT id, title FROM missions WHERE id = ANY($1)", [...new Set(all.filter((t) => t.type === "mission").map((t) => t.id))]);
  const tasks = await titles(q, "SELECT id::text AS id, title FROM tasks WHERE id::text = ANY($1)", [...new Set(all.filter((t) => t.type !== "mission").map((t) => t.id))]);
  const result = new Map<string, TWorldAnchor[]>();
  for (const card of cards) {
    const list = result.get(card.decisionId) ?? [];
    for (const target of card.targets) {
      const kind = target.type === "mission" ? "mission" : "task";
      if (list.some((item) => item.kind === kind && item.id === target.id)) continue;
      list.push({ kind, id: target.id, title: (kind === "mission" ? missions : tasks).get(target.id) ?? target.title });
    }
    result.set(card.decisionId, list);
  }
  for (const [id, list] of result) result.set(id, sorted(list));
  return result;
}

/**
 * 挂点候选，三组按顺序回退（写入时取第一组在本体对得上的）：① 建会选的或主持人、CEO 改过的；② 主持人负责的责任单元；③ 公司。
 */
export async function meetingAnchorGroups(q: Query, meeting: Pick<MeetingRow, "lead_dri_id" | "world_anchors">): Promise<TWorldAnchor[][]> {
  let first: TWorldAnchor[] = [];
  const chosen = meeting.world_anchors ?? [];
  if (chosen.length) {
    const missions = await titles(q, "SELECT id, title FROM missions WHERE id = ANY($1)", chosen.filter((a) => a.kind === "mission").map((a) => a.id));
    const units = await titles(q, "SELECT id, name AS title FROM capability_config WHERE id = ANY($1)", chosen.filter((a) => a.kind === "unit").map((a) => a.id));
    // LTO、PO 天枢里没有表，用选的时候存下的标题。
    first = chosen.flatMap((anchor) => {
      const title = anchor.kind === "lto" || anchor.kind === "po" ? anchor.title : (anchor.kind === "mission" ? missions : units).get(anchor.id);
      return title ? [{ kind: anchor.kind, id: anchor.id, title }] : [];
    });
  }
  const hostUnits = ((await q("SELECT id, name FROM capability_config WHERE owner_id <> '' AND owner_id = $1 ORDER BY sort_order, code", [meeting.lead_dri_id]))
    .rows as { id: string; name: string }[]).map((row) => ({ kind: "unit" as const, id: row.id, title: row.name }));
  return [first, hostUnits, [COMPANY]];
}

/** 一条生效的决定在本体里：决定随整场会议事件写，跟着会议记录走（待确认、写入中、修改待确认都是 waiting）。 */
function decisionWorld(status: TMeetingRecordStatus): TMeetingDecisionWorld {
  return status === "excluded" ? "off" : status === "committed" || status === "failed" ? status : "waiting";
}

/**
 * 会议页上「这场会在本体里」：挂点（第一组非空的候选）、会议记录状态（由整卡确认表和回执算出）、每条生效的决定落到哪。
 * 记录状态只给主持人、创建人和 CEO（showStatus）；参会人只看挂点和落点。
 */
export async function meetingWorldDetail(q: Query, meeting: MeetingRow, decisions: MeetingDecisionRow[], record: MeetingRecordState,
  viewer: { canEdit: boolean; showStatus: boolean }): Promise<TMeetingWorldResponse> {
  const { status } = record;
  const anchors = (await meetingAnchorGroups(q, meeting)).find((group) => group.length) ?? [];
  const effective = decisions.filter(decisionEffective);
  const targets = await decisionTargets(q, effective);
  return {
    world: {
      excluded: record.excludedBy !== null,
      excludedBy: record.excludedBy,
      record: viewer.showStatus ? { status, version: record.version, eventId: record.eventId, confirmedAt: record.confirmedAt } : null,
      at: viewer.showStatus ? record.at : null,
      anchors,
      edited: meeting.world_anchors !== null,
      canEdit: viewer.canEdit,
    },
    decisions: effective.map((row) => ({ id: row.id, anchors: targets.get(row.id) ?? [], world: viewer.showStatus ? decisionWorld(status) : null })),
  };
}
