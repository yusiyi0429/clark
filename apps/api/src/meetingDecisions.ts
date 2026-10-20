import { isDeepStrictEqual } from "node:util";
import type { Pool } from "pg";
import type { TMeetingWorldResponse, TPickedWorldAnchor, TWorldAnchor } from "@warmap/contracts";
import type { PeopleDirectory } from "./peopleDirectory.js";
import { attendeesOf } from "./meetingDecisionView.js";
import { meetingRecordState } from "./meetingCardConfirm.js";
import { getMeetingRow, type MeetingRow, type Query, type StoredWorldAnchor } from "./meetingStore.js";
import { anchorOptions, meetingWorldDetail, storedAnchor, type AnchorWorld } from "./meetingWorld.js";
import { personDisplayNames } from "./people.js";
import { shanghaiDate } from "./workdays.js";

/**
 * 会议入本体（B 方案，D-58）的挂点与会议记录状态：建会只存天枢；整卡确认和写会议事件在 meetingCardConfirm.ts。
 * 主持人或 CEO 可改挂点，会议卡草稿的挂点对象跟着改，要重新整卡确认才写。
 * 会后只有会议卡一个入口（FR-5.1、拍板 4、11）：旧格式会议的逐条决定（meeting_decisions）只读显示，不再确认、提醒、代判或往下推。
 */
export type MeetingDecisionDeps = {
  pool: Pool;
  peopleDirectory: PeopleDirectory;
  /** 挂点选项里的 LTO、本月 PO 从这里读；没有时选项只有 Mission 和单元。 */
  anchorWorld?: AnchorWorld;
  /** 挂点改了以后（会议卡草稿的挂点对象跟着改）。 */
  onAnchorsChanged?: (meetingId: string) => Promise<void>;
};

export type WorldResult = TMeetingWorldResponse | { error: { status: number; code: string; message: string } };
const NOT_FOUND = { error: { status: 404, code: "MEETING_NOT_FOUND", message: "会议不存在" } } as const;

export function createMeetingDecisionService(deps: MeetingDecisionDeps) {
  const { pool, peopleDirectory } = deps;
  const q: Query = pool.query.bind(pool);
  const names = () => personDisplayNames(peopleDirectory);
  const isCeo = (personId: string) => peopleDirectory.searchPeople(undefined).find((person) => person.personId === personId)?.roles.includes("ceo") ?? false;
  /** 主持人和 CEO 能改挂点。 */
  const canManageWorld = (meeting: Pick<MeetingRow, "lead_dri_id">, viewerId: string) => meeting.lead_dri_id === viewerId || isCeo(viewerId);
  /** 建会的人（没记时按主持人算）：和主持人一样能整卡确认、看会议记录状态。 */
  const isCreator = (meeting: Pick<MeetingRow, "lead_dri_id" | "created_by">, viewerId: string) => (meeting.created_by ?? meeting.lead_dri_id) === viewerId;

  /** 这场会在本体里：主持人和 CEO 能改挂点；主持人、创建人和 CEO 看会议记录状态；实际参会的人只看挂点和落点；别人 404。 */
  async function worldView(meetingId: string, viewerId: string): Promise<WorldResult> {
    const meeting = await getMeetingRow(q, meetingId);
    if (!meeting) return NOT_FOUND;
    const manage = canManageWorld(meeting, viewerId);
    const showStatus = manage || isCreator(meeting, viewerId);
    if (!showStatus && !attendeesOf(meeting).personIds.includes(viewerId)) return NOT_FOUND;
    const nameOf = (personId: string) => meeting.participants.find((person) => person.personId === personId)?.displayName ?? names().get(personId) ?? personId;
    return meetingWorldDetail(q, meeting, meeting.decisions ?? [], await meetingRecordState(q, meetingId, nameOf), { canEdit: manage, showStatus });
  }

  /** 某月能挑的挂点：本月 PO、LTO（本体读得到时）、本月 Mission、责任单元。 */
  const anchorOptionsFor = (period: string) => anchorOptions(q, deps.anchorWorld ?? null, period);
  const meetingPeriod = (meeting: MeetingRow) => shanghaiDate(new Date(meeting.scheduled_at)).slice(0, 7);

  /**
   * 改挂点（null 回到自动）：只存天枢，不写本体；会议卡草稿的挂点对象跟着改（和确认版不同就是修改待确认），重新确认后才写（裁定 24）。
   * 挑的要在会议所在月的选项里；已经存着的 LTO、PO 本体读不到时也算数（沿用存下的标题）。
   */
  async function setAnchors(meetingId: string, viewerId: string, anchors: TPickedWorldAnchor[] | null): Promise<WorldResult> {
    const meeting = await getMeetingRow(q, meetingId);
    if (!meeting || !canManageWorld(meeting, viewerId)) return NOT_FOUND;
    let chosen: StoredWorldAnchor[] | null = null;
    if (anchors) {
      const known = [...await anchorOptionsFor(meetingPeriod(meeting)), ...(meeting.world_anchors ?? []).filter((anchor) => anchor.kind === "lto" || anchor.kind === "po")];
      chosen = [];
      for (const anchor of anchors) {
        if (chosen.some((other) => other.kind === anchor.kind && other.id === anchor.id)) continue;
        const option = known.find((candidate) => candidate.kind === anchor.kind && candidate.id === anchor.id);
        if (!option) return { error: { status: 400, code: "ANCHOR_NOT_FOUND", message: "挂点只能是 LTO、本月 PO、本月 Mission 或责任单元" } };
        chosen.push(storedAnchor(option));
      }
    }
    const changed = !isDeepStrictEqual(meeting.world_anchors, chosen);
    await q("UPDATE meetings SET world_anchors = $2::jsonb WHERE id = $1", [meetingId, chosen ? JSON.stringify(chosen) : null]);
    if (changed) await deps.onAnchorsChanged?.(meetingId);
    return worldView(meetingId, viewerId);
  }

  async function listAnchorOptions(meetingId: string, viewerId: string): Promise<{ options: TWorldAnchor[] } | typeof NOT_FOUND> {
    const meeting = await getMeetingRow(q, meetingId);
    if (!meeting || !canManageWorld(meeting, viewerId)) return NOT_FOUND;
    return { options: await anchorOptionsFor(meetingPeriod(meeting)) };
  }

  return { worldView, setAnchors, listAnchorOptions, anchorOptionsFor };
}

export type MeetingDecisionService = ReturnType<typeof createMeetingDecisionService>;
