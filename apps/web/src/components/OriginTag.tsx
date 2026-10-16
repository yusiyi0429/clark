import { Radar } from "lucide-react";
import s from "@/styles/origin-tag.module.css";

/**
 * 来源标注（2026-10 反馈会议决定，清理后的口径）：
 * - 界面不标「AI 建议」，也不标括注；资料包导入的候选议题什么都不显示（数据层的 nature 字段保留）；
 * - 来自雷达的议题，在标题旁放一枚「雷达图标 + 雷达」的低存在感小标签（12px，读屏「来自雷达」）；
 */

/** 议题来自雷达自动升级：议题卡看 origin，战场卡 / 战役议题摘要看 fromRadar。 */
type IssueOrigin = { nature?: unknown; origin?: unknown; fromRadar?: unknown } | null | undefined;
export const isFromRadar = (value: IssueOrigin): boolean => value?.fromRadar === true || value?.origin === "radar";
export const RADAR_ORIGIN_LABEL = "来自雷达";

/** 雷达小图标（与雷达入口同一个 lucide Radar），颜色跟着文字。 */
export function RadarOriginIcon() {
  return <Radar size={12} strokeWidth={2} className={s.radar} aria-hidden="true" data-origin-radar="true" />;
}

/** 议题标题旁的「雷达」小标签；不是雷达来源的议题什么都不放。 */
export function RadarOriginTag({ issue }: { issue: IssueOrigin }) {
  if (!isFromRadar(issue)) return null;
  return <span className={s.tag} data-origin-tag="radar" aria-label={RADAR_ORIGIN_LABEL} title={RADAR_ORIGIN_LABEL}><RadarOriginIcon />雷达</span>;
}
