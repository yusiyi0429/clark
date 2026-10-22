"use client";

/**
 * Mission 卡片最上面一行：「全部」+ 每个 Mission（色点、标题，上面小字是今天起最近的签定关口「M/D 名字」，没有就空着，行高照留，标题对得齐）。
 * 回退显示上个月时「全部」上面写「M 月」；聚焦的 Mission 有任务卡时行尾出「Mission 卡 ›」。
 */
import { Button } from "ts-design/primitives";
import type { THomePlanResponse } from "@warmap/contracts";
import { shortDate, tone, type Navigate } from "./planFormat";
import s from "@/styles/mission-plan-card.module.css";

export function MissionRow({ plan, focus, onChoose, onNavigate }: {
  plan: THomePlanResponse;
  focus: string | null;
  onChoose: (missionId: string | null) => void;
  onNavigate: Navigate;
}) {
  const cardId = plan.missions.find((mission) => mission.missionId === focus)?.cardId;
  return (
    <div className={s.missions} role="group" aria-label="Mission">
      <button type="button" className={s.mission} data-mission="all" aria-pressed={focus === null} onClick={() => onChoose(null)}>
        <span className={s.hint}>{plan.fallbackFrom ? `${Number(plan.fallbackFrom.slice(5, 7))} 月` : null}</span>
        <span className={s.name}>全部</span>
      </button>
      {plan.missions.map((mission) => {
        const gate = plan.gates.filter((g) => g.missionId === mission.missionId && g.date >= plan.today).sort((a, b) => a.date.localeCompare(b.date))[0];
        return (
          <button key={mission.missionId} type="button" className={s.mission} data-mission={mission.missionId} aria-pressed={focus === mission.missionId} onClick={() => onChoose(mission.missionId)}>
            <span className={s.hint}>{gate ? `${shortDate(gate.date)} ${gate.label}` : null}</span>
            <span className={s.name}><i className={s.dot} style={tone(mission.color)} aria-hidden />{mission.title}</span>
          </button>
        );
      })}
      {cardId && (
        <Button variant="ghost" size="sm" className={s.cardLink} data-mission-card data-origin={`/me/mission-cards/${encodeURIComponent(cardId)}`}
          onPress={(event) => onNavigate(`/me/mission-cards/${encodeURIComponent(cardId)}`, event.target as Element)}>
          Mission 卡 ›
        </Button>
      )}
    </div>
  );
}
