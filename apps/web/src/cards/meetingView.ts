/**
 * 会议页左侧阅读区此刻看哪一份（用户 2026-10-11 定）：
 * - 会前：只有会前预审这一份（加上会议材料），页头不放类型切换，也没有会议记录入口。
 * - 会后：页头「会前预审 ｜ 会议记录」两段（SegmentedSwitch），默认会议记录；材料下拉单只列材料。
 *   选了某份材料，两段都不选中；Esc 回到上次选中的那一段。
 */

export type MeetingSegmentId = "preflight" | "record";

export interface MeetingView {
  /** 此刻看的那一份：一段的 id，或一份材料的 id。 */
  current: string;
  /** 上次选中的那一段：看材料时按 Esc 回到它。 */
  segment: MeetingSegmentId;
}

export const MEETING_SEGMENT_LABEL: Record<MeetingSegmentId, string> = { preflight: "会前预审", record: "会议记录" };

/** 页头的几段：会开完了才有两段；会前没有会议记录，不放切换。 */
export const meetingSegments = (held: boolean): { id: MeetingSegmentId; label: string }[] =>
  held ? (["preflight", "record"] as const).map((id) => ({ id, label: MEETING_SEGMENT_LABEL[id] })) : [];

export const isMeetingSegment = (id: string): id is MeetingSegmentId => id === "preflight" || id === "record";

/** 打开这一页时看哪一段：会开完了看会议记录，否则看会前预审。 */
export const initialMeetingView = (held: boolean): MeetingView => {
  const segment: MeetingSegmentId = held ? "record" : "preflight";
  return { current: segment, segment };
};

/** 选一段（页头按段、会开完了转到会议记录、从会议记录回到某个议题的依据）。 */
export const pickSegment = (id: MeetingSegmentId): MeetingView => ({ current: id, segment: id });

/** 在下拉单里选一份：材料只换正在看的，记住的那一段不变；会前下拉单里的「AI 预审」就是那一段。 */
export const pickMaterial = (view: MeetingView, id: string): MeetingView =>
  isMeetingSegment(id) ? pickSegment(id) : view.current === id ? view : { ...view, current: id };

/** 正在看材料时按 Esc：回到上次选中的那一段。 */
export const escapeToSegment = (view: MeetingView): MeetingView => ({ ...view, current: view.segment });

/** 页头哪一段亮着：看材料时一段都不亮。 */
export const selectedSegment = (view: MeetingView): MeetingSegmentId | null => (isMeetingSegment(view.current) ? view.current : null);

/** 会开完了、开会前又没有做预审：「会前预审」那一段照样在，内容区只写一句「这场会没有会前预审。」。 */
export const noPreflightContent = (held: boolean, preflight: { status: string; entries: readonly unknown[]; brief?: string | null }): boolean =>
  held && preflight.status !== "running" && !preflight.entries.length && !preflight.brief;
