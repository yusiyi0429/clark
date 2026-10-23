"use client";

/**
 * 首页顶行中间的 Mission 卡：竖排列表。第一行「全部」（右边小字：执行事项件数），下面每个 Mission：色点 + 完整名字（换行、不截断）+ 右边小字下一个关口。
 * 选中项底色是 Mission 色 8% 混白，字深色加粗；字永远不染 Mission 色。回退显示上个月时标题旁写「M 月」。
 */
import type { THomePlanResponse } from "@warmap/contracts";
import { shortDate, tone } from "./planFormat";
import s from "@/styles/home-plan.module.css";

/** 「全部」的色点和选中底色：中性灰。 */
const ALL_TONE = "var(--ink-faint)";

/** 这个 Mission 今天及以后最近的签定关口「10/28 上线」；没有为 null。 */
function nextGate(plan: Pick<THomePlanResponse, "gates" | "today">, missionId: string): string | null {
  const gate = plan.gates.filter((item) => item.missionId === missionId && item.date >= plan.today).sort((a, b) => a.date.localeCompare(b.date))[0];
  return gate ? `${shortDate(gate.date)} ${gate.label}`.trim() : null;
}

export function MissionList({ plan, focus, onChoose }: {
  plan: THomePlanResponse;
  focus: string | null;
  onChoose: (missionId: string | null) => void;
}) {
  return (
    <>
      <header className={s.head}>
        <h2>Mission{plan.fallbackFrom ? <span className={s.month}>{Number(plan.fallbackFrom.slice(5, 7))} 月</span> : null}</h2>
        <small>{plan.missions.length}</small>
      </header>
      <div className={s.missionList} role="group" aria-label="Mission">
        <button type="button" className={s.mission} data-mission="all" aria-pressed={focus === null} style={tone(ALL_TONE)} onClick={() => onChoose(null)}>
          <i className={s.dot} aria-hidden />
          <span className={s.missionName}>全部</span>
          <small>{plan.activities.length} 件</small>
        </button>
        {plan.missions.map((mission) => {
          const gate = nextGate(plan, mission.missionId);
          return (
            <button key={mission.missionId} type="button" className={s.mission} data-mission={mission.missionId}
              aria-pressed={focus === mission.missionId} style={tone(mission.color)} onClick={() => onChoose(mission.missionId)}>
              <i className={s.dot} aria-hidden />
              <span className={s.missionName}>{mission.title}</span>
              {gate ? <small title={gate}>{gate}</small> : null}
            </button>
          );
        })}
      </div>
    </>
  );
}
