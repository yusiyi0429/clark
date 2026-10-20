import type { TImpactTarget, TMeetingDecisionWorld, TMeetingRecordStatus, TMeetingWorldResponse, TWorldAnchor } from "@warmap/contracts";
import { decisionEffective, type MeetingDecisionRow } from "./meetingDecisionView.js";
import type { MeetingRow, Query, StoredWorldAnchor } from "./meetingStore.js";
import type { WorldClient } from "./worldClient.js";
import { usableWorldHead, worldDisplayText } from "./worldReader.js";

/**
 * 会议入本体的挂点与落点（回流设计稿 3.1、3.2）。只在会议页（GET /api/meetings/:id/world）、本体同步、挂点接口里查，
 * 不进读会议的 SQL：那里带上这些相关子查询会把估算代价抬过 JIT 阈值，每次读会议多一秒多（10/19 实测）。
 */
const COMPANY: TWorldAnchor = { kind: "company", id: "company", title: "公司" };
const ORDER = { po: 0, lto: 1, mission: 2, task: 3, unit: 4, company: 5 } as const;
const sorted = (anchors: TWorldAnchor[]) => [...anchors].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.title.localeCompare(b.title, "zh-CN"));

/** 挂点选项读本体用的客户端（只列对象）；本体没配或不可写时为 null，选项只有 Mission 和单元。 */
export type AnchorWorld = Pick<WorldClient, "listObjects">;

/**
 * 预约、改挂点时能挑的对象，按 本月 PO、LTO、本月 Mission、责任单元 排：PO、LTO 读本体（串行，读不到就不给），Mission、单元读天枢。
 * world-02 里没有 Task 对象，不给 Task。
 */
export async function anchorOptions(q: Query, world: AnchorWorld | null, period: string): Promise<TWorldAnchor[]> {
  let goals: TWorldAnchor[] = [];
  if (world) {
    try {
      const goal = (kind: "po" | "lto") => (head: { object_id: string; title: string; lifecycle: unknown }) =>
        usableWorldHead(head) && head.title.trim() ? [{ kind, id: head.object_id, title: worldDisplayText(head.title.trim()) }] : [];
      const pos = await world.listObjects({ type: "PeriodGoal", period });
      const ltos = await world.listObjects({ type: "LongTermGoal" });
      goals = [...pos.flatMap(goal("po")), ...ltos.flatMap(goal("lto"))];
    } catch {
      goals = [];
    }
  }
  const missions = (await q("SELECT id, title FROM missions WHERE period = $1 AND NOT placeholder ORDER BY code", [period])).rows as { id: string; title: string }[];
  const units = (await q("SELECT id, name FROM capability_config ORDER BY sort_order, code")).rows as { id: string; name: string }[];
  return [
    ...goals,
    ...missions.map((row) => ({ kind: "mission" as const, id: row.id, title: row.title })),
    ...units.map((row) => ({ kind: "unit" as const, id: row.id, title: row.name })),
  ];
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

/** 会议记录的状态：没确认 → 待确认；确认后又改了 → 修改待确认；选了不写入；这一版写进去了、写失败了，或已确认等写入（仍是 pending）。 */
export function recordStatus(meeting: Pick<MeetingRow, "record_confirmed_at" | "record_edit_pending" | "world_excluded" | "world_event_status">): TMeetingRecordStatus {
  if (!meeting.record_confirmed_at) return "pending";
  if (meeting.record_edit_pending) return "edit_pending";
  if (meeting.world_excluded) return "excluded";
  return meeting.world_event_status === "none" ? "pending" : meeting.world_event_status;
}

/** 一条生效的决定在本体里：决定随整场会议事件写，跟着会议记录走。 */
function decisionWorld(status: TMeetingRecordStatus): TMeetingDecisionWorld {
  return status === "excluded" ? "off" : status === "committed" || status === "failed" ? status : "waiting";
}

/**
 * 会议页上「这场会在本体里」：挂点（已写入且之后没改过时是写进去的那些，否则是第一组非空的候选）、会议记录状态、每条生效的决定落到哪。
 * 记录状态只给主持人、创建人和 CEO（showStatus）；参会人只看挂点和落点。
 */
export async function meetingWorldDetail(q: Query, meeting: MeetingRow, decisions: MeetingDecisionRow[],
  viewer: { canEdit: boolean; showStatus: boolean }): Promise<TMeetingWorldResponse> {
  const status = recordStatus(meeting);
  const written = status === "committed" && meeting.world_event_anchors?.length;
  const anchors = written ? meeting.world_event_anchors! : (await meetingAnchorGroups(q, meeting)).find((group) => group.length) ?? [];
  const effective = decisions.filter(decisionEffective);
  const targets = await decisionTargets(q, effective);
  return {
    world: {
      excluded: meeting.world_excluded,
      excludedBy: meeting.world_excluded ? meeting.world_excluded_by : null,
      record: viewer.showStatus ? {
        status, version: meeting.record_version, eventId: meeting.world_event_id,
        confirmedAt: meeting.record_confirmed_at ? new Date(meeting.record_confirmed_at).toISOString() : null,
      } : null,
      at: viewer.showStatus && meeting.world_event_at ? new Date(meeting.world_event_at).toISOString() : null,
      anchors,
      edited: meeting.world_anchors !== null,
      canEdit: viewer.canEdit,
    },
    decisions: effective.map((row) => ({ id: row.id, anchors: targets.get(row.id) ?? [], world: viewer.showStatus ? decisionWorld(status) : null })),
  };
}
