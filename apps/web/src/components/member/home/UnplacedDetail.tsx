"use client";

/**
 * 首页 Mission 列表里选了「待归位」时，下面那张详情卡：一件一行——标题（点开进事项）、小字「从哪来 · 为什么没挂上」，
 * 下面挑 Mission「挂上」或「不属于任何 Mission」（Unplaced.tsx）。挂点选项是首页显示的这几个 Mission。
 */
import type { THomePlanResponse } from "@warmap/contracts";
import { UnplacedActions, unplacedLine } from "@/components/tasks/Unplaced";
import type { Navigate } from "./planFormat";
import s from "@/styles/home-plan.module.css";

export function UnplacedDetail({ plan, onNavigate }: { plan: THomePlanResponse; onNavigate: Navigate }) {
  const missions = plan.missions.map((mission) => ({ missionId: mission.missionId, title: mission.title }));
  return (
    <section className={`${s.card} ${s.detail}`} data-detail="unplaced" aria-label="待归位">
      <header className={s.detailHead}>
        <h2 className={s.detailTitle}>待归位</h2>
      </header>
      <ul className={s.unplacedList}>
        {plan.unplaced.map((task) => (
          <li key={task.id} className={s.unplacedItem}>
            <button type="button" className={s.unplacedTitle} data-origin={`/me/tasks/${task.id}`}
              onClick={(event) => onNavigate(`/me/tasks/${encodeURIComponent(task.id)}`, event.currentTarget)}>{task.title}</button>
            <small className={s.unplacedLine}>{unplacedLine(task)}</small>
            <UnplacedActions task={task} missions={missions} compact />
          </li>
        ))}
      </ul>
    </section>
  );
}
