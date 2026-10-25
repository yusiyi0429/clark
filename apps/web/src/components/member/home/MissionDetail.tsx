"use client";

/**
 * 首页的 Mission 详情卡：头部「● Mission 名 / Task 名」+ 右上角「＋ 开启执行事项」；左边 Task 列，右边三栏。
 * - 选某个 Mission：底色是 Mission 色若有若无的渐变，字和按钮都不染色；Mission 有任务卡时名字点进 Mission 卡页。
 *   有 Task 时出左列（选中的 Task 名写在头部「/」后面），没有 Task 时不出左列，三栏列这个 Mission 的全部事项。
 * - 选「全部」：头部写「全部 Mission」，不出 Task 列，三栏列全部事项，卡片小字写它属于哪个 Mission。
 * - 从本体载入的 Mission：头部下面一行小字，写本体状态、版本、读取时间和缺项（worldMeta）。
 * 选哪个 Task、浮层开没开由 HomePlan 管，这里只画。
 */
import type { ReactNode } from "react";
import type { THomePlanActivity, THomePlanMission } from "@warmap/contracts";
import { StartTaskButton } from "@/components/tours/StartTaskButton";
import { ActivityColumns } from "./ActivityColumns";
import { tone, worldMeta, type Navigate } from "./planFormat";
import s from "@/styles/home-plan.module.css";

export function MissionDetail({ mission, taskName, tasks, activities, today, weekStart, weekEnd, missionOf, onNavigate }: {
  /** 聚焦的 Mission；null 是「全部」。 */
  mission: THomePlanMission | null;
  /** 头部「/」后面的名字（选中的 Task 或「未归入 Task」）；没有 Task 列时为 null。 */
  taskName: string | null;
  /** Task 列；没有时为 null。 */
  tasks: ReactNode;
  activities: THomePlanActivity[];
  today: string;
  weekStart: string;
  weekEnd: string;
  missionOf?: (activity: THomePlanActivity) => string | null;
  onNavigate: Navigate;
}) {
  const cardHref = mission?.cardId ? `/me/mission-cards/${encodeURIComponent(mission.cardId)}` : null;
  const meta = worldMeta(mission?.world ?? null);
  return (
    <section className={`${s.card} ${s.detail}`} data-detail={mission?.missionId ?? "all"} style={mission ? tone(mission.color) : undefined} aria-label="Mission 详情">
      <header className={s.detailHead}>
        <h2 className={s.detailTitle}>
          {mission ? <i className={s.dot} aria-hidden /> : null}
          {mission && cardHref
            ? <button type="button" className={s.cardLink} data-mission-card data-origin={cardHref} title="Mission 卡" onClick={(event) => onNavigate(cardHref, event.currentTarget)}>{mission.title}</button>
            : mission?.title ?? "全部 Mission"}
          {taskName ? <><span className={s.sep} aria-hidden="true">/</span><span className={s.current}>{taskName}</span></> : null}
        </h2>
        <span className={s.start}><StartTaskButton onNavigate={onNavigate} /></span>
        {meta ? <p className={s.worldMeta} data-world-meta>{meta}</p> : null}
      </header>
      <div className={s.split} data-split={tasks ? true : undefined}>
        {tasks}
        <ActivityColumns activities={activities} today={today} weekStart={weekStart} weekEnd={weekEnd} missionOf={missionOf} onNavigate={onNavigate} />
      </div>
    </section>
  );
}
