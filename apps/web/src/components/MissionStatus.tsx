import type { MissionPayload } from "@/cards/payloads";
import s from "@/styles/mission-status.module.css";

export function missionStatusLabel(mission: MissionPayload): string {
  return [mission.personalCard ? (mission.personalCard.status === "confirmed" ? "已确定" : "草稿") : "", mission.placeholder ? "占位" : ""].filter(Boolean).join(" · ");
}

/** 目标签发与任务卡确认是两次决定；确认后仍保留占位来源标记。 */
export function MissionStatus({ mission }: { mission: MissionPayload }) {
  const label = missionStatusLabel(mission);
  return label ? <span className={s.status}>{label}</span> : null;
}
