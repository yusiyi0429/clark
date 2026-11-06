"use client";

/**
 * 本月泳道（原型 v8.4 monthSec / lane）：三层一眼看出——Mission 是带色条的组头（验收时间点 · 剩 N 天），
 * Task 是缩进的一行（名字旁边的小数字是这一行有几件待处理），执行事项是格子里的小卡。
 * 四列（待开始、进行中、验收中、已完成）加交付物；每格最多两张，多的写「+N」，点了进 Task 页。
 * 数据就是首页计划（GET /api/me/home-plan）：事项按 planTaskId 挂到 Task，事项带了 card 就按 card.stage 分列，老事项按 status。
 */
import { useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import type { THomePlanResponse, THomePlanTask } from "@warmap/contracts";
import type { TLocalSessionSummary } from "@/lib/local/runner";
import { STAGES, boardCards, byStage, pendingCount, type BoardCard } from "@/lib/board/cards";
import { statusChip } from "@/components/member/home/deliverable/deliverableFormat";
import { CardPill } from "./CardPill";
import s from "@/styles/v2-month.module.css";

export const taskHref = (taskId: string) => `/me/month/tasks/${encodeURIComponent(taskId)}`;

/** 「11/13」 */
const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Mission 的验收时间点：今天及以后最近的一个关口，没有就是最后一个。 */
export function gateOf(plan: THomePlanResponse, missionId: string): { date: string; left: number } | null {
  const dates = plan.gates.filter((gate) => gate.missionId === missionId).map((gate) => gate.date).sort();
  const date = dates.find((value) => value >= plan.today) ?? dates[dates.length - 1];
  return date ? { date, left: daysBetween(plan.today, date) } : null;
}
export const gateText = (gate: { date: string; left: number } | null) =>
  gate ? `验收时间点 ${md(gate.date)} · ${gate.left > 0 ? `剩 ${gate.left} 天` : gate.left === 0 ? "就是今天" : `过了 ${-gate.left} 天`}` : null;

/** 一个 Task 下的卡（本人挂在它下面的执行事项，不含退回的）。 */
export function cardsOfTask(plan: THomePlanResponse, taskId: string, sessions: TLocalSessionSummary[]): BoardCard[] {
  return boardCards(plan.activities.map((activity) => activity.item).filter((item) => item.planTaskId === taskId && item.status !== "returned"), sessions);
}

function Cell({ cards, taskId }: { cards: BoardCard[]; taskId: string }) {
  if (!cards.length) return <span className={s.cell}><span className={s.empty}>—</span></span>;
  return (
    <span className={s.cell}>
      {cards.slice(0, 2).map((card) => <CardPill key={card.item.id} card={card} />)}
      {cards.length > 2 ? <Link href={taskHref(taskId)} className={s.more}>+{cards.length - 2}</Link> : null}
    </span>
  );
}

function DeliverableCell({ task, cards }: { task: THomePlanTask; cards: BoardCard[] }) {
  const chip = statusChip(task.deliverable);
  const pending = cards.filter((card) => card.item.card?.deliverable?.state === "pending");
  const next = pending[0]?.item.card?.deliverable?.versionNumber;
  return (
    <span className={s.deliv}>
      {task.deliverable?.status === "delivered" && task.deliverable.version ? <span className={s.chip} data-tone="done">v{task.deliverable.version} 已交付</span>
        : pending.length ? null : <span className={s.chip} data-tone={chip.tone === "confirmed" ? "done" : undefined}>{chip.label}</span>}
      {pending.length ? <span className={s.chip} data-tone="ver">v{next} 准备中 {pending.length} 项</span> : null}
    </span>
  );
}

export function MonthLanes({ plan, sessions }: { plan: THomePlanResponse; sessions: TLocalSessionSummary[] }) {
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const missions = plan.missions.filter((mission) => plan.tasks.some((task) => task.missionId === mission.missionId));
  const toggle = (id: string) => setClosed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return (
    <div className={s.grid} role="table" aria-label="本月 Mission 和 Task">
      <div className={s.colRow} role="row">
        <span className={s.colHead} role="columnheader">Task</span>
        {STAGES.map((stage) => <span key={stage.id} className={s.colHead} role="columnheader">{stage.label}</span>)}
        <span className={s.colHead} role="columnheader">交付物</span>
      </div>
      {missions.map((mission, index) => {
        const tasks = plan.tasks.filter((task) => task.missionId === mission.missionId);
        const open = !closed.has(mission.missionId);
        return (
          <div key={mission.missionId} className={s.missionGroup} role="rowgroup" style={{ ["--c" as string]: mission.color }}>
            <div className={s.mission} data-first={index === 0 || undefined} data-shut={!open || undefined} role="row">
              <button type="button" className={s.missionToggle} aria-expanded={open} onClick={() => toggle(mission.missionId)}>
                <ChevronDown size={13} aria-hidden className={s.chev} />
                <span className={s.level}>Mission</span>
                <b>{mission.title}</b>
                {gateText(gateOf(plan, mission.missionId)) ? <span className={s.meta}>{gateText(gateOf(plan, mission.missionId))}</span> : null}
              </button>
              <span className={s.sum}>{tasks.length} 个 Task</span>
            </div>
            {open ? tasks.map((task) => {
              const cards = cardsOfTask(plan, task.taskId, sessions);
              const pending = pendingCount(cards);
              return (
                <div key={task.taskId} className={s.lane} role="row">
                  <span className={s.taskCell}>
                    <Link href={taskHref(task.taskId)} className={s.taskName}>{task.name}{pending ? <em className={s.pending} aria-label={`${pending} 件待处理`}>{pending}</em> : null}</Link>
                  </span>
                  {STAGES.map((stage) => <Cell key={stage.id} cards={byStage(cards, stage.id)} taskId={task.taskId} />)}
                  <DeliverableCell task={task} cards={cards} />
                </div>
              );
            }) : null}
          </div>
        );
      })}
    </div>
  );
}

/** 手机上的本月（原型 phoneMonth）：Mission 一张卡，Task 一行，后面几颗小标签：待处理、进行中、待开始、交付物。 */
export function PhoneMonth({ plan, sessions }: { plan: THomePlanResponse; sessions: TLocalSessionSummary[] }) {
  const missions = plan.missions.filter((mission) => plan.tasks.some((task) => task.missionId === mission.missionId));
  return (
    <div className={s.phoneList}>
      {missions.map((mission) => (
        <section key={mission.missionId} className={s.phoneMission} style={{ ["--c" as string]: mission.color }} aria-label={mission.title}>
          <header><span className={s.level}>Mission</span><b>{mission.title}</b><small>{gateText(gateOf(plan, mission.missionId))}</small></header>
          {plan.tasks.filter((task) => task.missionId === mission.missionId).map((task) => {
            const cards = cardsOfTask(plan, task.taskId, sessions);
            const count = (stage: string) => cards.filter((card) => card.stage === stage && !card.wait).length;
            const pending = pendingCount(cards);
            const chips = [
              pending ? <span key="p" className={s.chip} data-tone="wait">待处理 {pending}</span> : null,
              count("doing") ? <span key="d" className={s.chip}>进行中 {count("doing")}</span> : null,
              count("review") ? <span key="r" className={s.chip}>验收中 {count("review")}</span> : null,
              count("todo") ? <span key="t" className={s.chip}>待开始 {count("todo")}</span> : null,
            ].filter(Boolean);
            return (
              <Link key={task.taskId} href={taskHref(task.taskId)} className={s.phoneTask}>
                <b>{task.name}</b><span aria-hidden className={s.arrow}>›</span>
                <span className={s.chips}>{chips.length ? chips : <span className={s.chip}>没有事项</span>}<DeliverableCell task={task} cards={cards} /></span>
              </Link>
            );
          })}
        </section>
      ))}
    </div>
  );
}
