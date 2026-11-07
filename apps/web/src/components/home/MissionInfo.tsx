"use client";

/**
 * Mission 详情（新首页设计 14.2）：只读。Mission 没有自己的管线——活都在下面的 Task 里干，跨 Task 的事问伙伴。
 * 页头：返回、Mission 名，右边 chip「Mission · 11 月」。正文（文档类页面，600）：目标一句话、验收标准（一条一行）、
 * 下面的 Task（一件一行，写验收日，做完了小字「已完成」，点了进它挂的项目）、「问伙伴」次按钮（进总管线，输入框带「关于：Mission」）。
 * 目标和验收标准取这个 Mission 所在的任务卡（GET /api/mission-cards/:cardId 里的 outcome、successEvidence）；读不到就只列 Task。
 * 设计里的「Mission Card ↗」不放：第 15 节定了新首页里不链到旧页面。
 */
import { useEffect, useState } from "react";
import { ArrowLeft, Circle } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { gateLabel, monthLabel, projectHref, taskHref, HOME_HREF } from "@/lib/home/derive";
import type { HomeMonthMission } from "@/lib/home/types";
import type { WorkHomeApi } from "@/lib/home/useWorkHome";
import { ICON } from "./StateIcon";
import { useViewChrome } from "./view";
import h from "@/styles/home.module.css";

type CardMission = { missionId: string; outcome?: string; successEvidence?: string[] };

/** 任务卡正文里这个 Mission 的目标和验收标准（接口是通用的卡片集合，按字段名取，取不到为 null）。 */
function missionOf(body: unknown, missionId: string): CardMission | null {
  const cards = (body as { cards?: { payload?: { card?: { missions?: CardMission[] } } }[] } | null)?.cards ?? [];
  for (const card of cards) {
    const found = card.payload?.card?.missions?.find((entry) => entry.missionId === missionId);
    if (found) return found;
  }
  return null;
}

export function MissionInfo({ mission, cardId, api, go, onAsk }: {
  mission: HomeMonthMission;
  /** 这个 Mission 所在的任务卡（本月计划里有）；之前月份的、没有卡的为 null。 */
  cardId: string | null;
  api: WorkHomeApi;
  go: (href: string) => void;
  onAsk: () => void;
}) {
  const chrome = useViewChrome();
  const [detail, setDetail] = useState<CardMission | null>(null);
  useEffect(() => {
    if (!cardId) return;
    let alive = true;
    void fetch(`/api/mission-cards/${encodeURIComponent(cardId)}`).then((response) => (response.ok ? response.json() : null))
      .then((body) => { if (alive) setDetail(missionOf(body, mission.missionId)); }, () => undefined);
    return () => { alive = false; };
  }, [cardId, mission.missionId]);
  const criteria = detail?.successEvidence?.filter((line) => line.trim()) ?? [];
  return (
    <div className={h.infoView} data-type-scale="doc" data-testid="mission-info">
      <header className={h.viewHead}>
        {chrome.lead ?? <button type="button" className={h.icon} aria-label="返回" title="返回" onClick={() => (window.history.length > 1 ? window.history.back() : go(HOME_HREF))}><ArrowLeft {...ICON} /></button>}
        <h1 className={h.viewTitle} tabIndex={-1}>{mission.title}</h1>
        <span className={h.statusChip}>Mission · {monthLabel(mission.period)}</span>
        {chrome.trail}
      </header>
      <div className={h.infoScroll}>
        <div className={h.infoInner}>
          {detail?.outcome ? (
            <section aria-label="目标" className={h.section}>
              <p className={h.sectionTitle}>目标</p>
              <div className={h.infoLead}><p>{detail.outcome}</p></div>
            </section>
          ) : null}
          {criteria.length ? (
            <section aria-label="验收标准" className={h.section}>
              <p className={h.sectionTitle}>验收标准</p>
              <ul className={h.criteria}>
                {criteria.map((line) => <li key={line}><Circle {...ICON} />{line}</li>)}
              </ul>
            </section>
          ) : null}
          {mission.tasks.length ? (
            <section aria-label="Task" className={h.section}>
              <p className={h.sectionTitle}>Task</p>
              <div className={h.taskList}>
                {mission.tasks.map((task) => {
                  const gate = gateLabel(api.work.plan, mission.missionId);
                  return (
                    <button key={task.taskId} type="button" className={h.taskLine} onClick={() => go(task.project ? projectHref(task.project.projectId) : taskHref(task.taskId))}>
                      <span className={h.taskText}>
                        <span className={h.taskName}>{task.name}</span>
                        {task.completedAt ? <span className={h.taskSub}>已完成</span> : null}
                      </span>
                      {gate ? <span className={h.taskGate}>{gate}</span> : null}
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}
          <div className={h.section}>
            <HeroButton variant="tertiary" size="sm" onPress={onAsk} data-testid="mission-ask">问伙伴</HeroButton>
          </div>
        </div>
      </div>
    </div>
  );
}
