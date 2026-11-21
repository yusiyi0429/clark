"use client";

/**
 * 全局进展（② 进展，前端交互实现说明第 5 节）。参照 Linear 的 Project 健康度、Jira 的风险标记、Asana 的 Portfolio：
 * 页头下一排计数，先列红线（Task 级：比预期慢 / 按截止日做不完，数字对比加一条进度条），
 * 没有 Task 基线的人按人列周复盘与采集摘要，按计划在走的收起。每条带做出来的东西和信息截至时间。
 * 一号位看全部（/progress），二号位看同一战场的人（/me/progress）；可见范围在服务端判。
 * 最上面是按战场的 Agent 汇总（BattlefieldSummaries，与成员的战场进展共用）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, Link2 } from "lucide-react";
import type { TProgressArtifact, TProgressOnTrack, TProgressOverview, TProgressPersonSummary, TProgressRedLine } from "@warmap/contracts";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { PersonAvatar } from "@/components/avatar/PersonAvatar";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { browserApi, type Card } from "@/lib/api/client";
import { relativeDayTime } from "@/lib/companyTime";
import { BattlefieldSummaries } from "./BattlefieldSummaries";
import { artifactLabel, coverageText, dayRangeText, meterParts } from "./progressText";
import s from "./progress.module.css";

const NO_CARDS: Card[] = [];
const STATUS_TEXT = { not_started: "未开始", in_progress: "进行中" } as const;

export function ProgressScreen({ scope }: { scope: "ceo" | "member" }) {
  const workspace = useWorkspace();
  const title = scope === "ceo" ? "全局进展" : "战场进展";
  const [progress, setProgress] = useState<TProgressOverview | null>(null);
  const [failed, setFailed] = useState(false);
  useRegisterDetail(useMemo(() => ({ scope: "global", label: title, mark: null, cards: NO_CARDS }), [title]));

  const load = useCallback(async () => {
    try {
      const { data, response } = await browserApi.GET("/api/progress");
      if (response.status === 401) { window.location.assign("/access"); return; }
      setFailed(!data);
      if (data) setProgress(data.progress);
    } catch { setFailed(true); }
  }, []);
  useEffect(() => {
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [load]);

  return (
    <div className={s.screen}>
      <DetailFrame title={title} subtitle={progress ? todayText(progress.today) : ""} onBack={() => workspace.close()}>
        <div className={s.content}>
          <div className={s.stack}>
            <BattlefieldSummaries />
            {failed && !progress ? <p className={s.error} role="alert">没有读到进展</p> : null}
            {progress ? <ProgressBody progress={progress} onNavigate={workspace.navigate} /> : failed ? null : <p className={s.loading} role="status">正在读取</p>}
          </div>
        </div>
      </DetailFrame>
    </div>
  );
}

const todayText = (day: string) => `${Number(day.slice(5, 7))} 月 ${Number(day.slice(8, 10))} 日`;
const scrollTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

export function ProgressBody({ progress, onNavigate }: { progress: TProgressOverview; onNavigate: (href: string, origin?: Element | null) => void }) {
  const [showOnTrack, setShowOnTrack] = useState(false);
  const tiles = [
    { id: "progress-red", label: "红线", value: progress.redLines.length, tone: progress.redLines.length ? "red" : "quiet" },
    { id: "progress-people", label: "按人", value: progress.summaries.length, tone: "quiet" },
    { id: "progress-on-track", label: "按计划", value: progress.onTrack.length, tone: progress.onTrack.length ? "green" : "quiet" },
  ];
  return <>
    <div className={s.tiles}>
      {tiles.map((tile) => (
        <button key={tile.id} type="button" className={s.tile} data-tone={tile.tone} onClick={() => {
          if (tile.id === "progress-on-track") setShowOnTrack(true);
          scrollTo(tile.id);
        }}>
          <span className={s.tileLabel}>{tile.label}</span>
          <span className={s.tileValue}>{tile.value}</span>
        </button>
      ))}
    </div>

    <section className={s.section} id="progress-red" aria-labelledby="progress-red-title">
      <h2 id="progress-red-title" className={s.sectionHead}>红线<span className={s.count} data-tone={progress.redLines.length ? "red" : undefined}>{progress.redLines.length}</span></h2>
      {progress.redLines.length ? <ul className={s.list}>{progress.redLines.map((line) => <RedLineRow key={line.kind === "slow" ? `slow:${line.task.taskId}` : `deadline:${line.person.personId}:${line.mission.missionId}`} line={line} />)}</ul>
        : <p className={s.empty}>没有红线</p>}
    </section>

    {progress.summaries.length ? <section className={s.section} id="progress-people" aria-labelledby="progress-people-title">
      <h2 id="progress-people-title" className={s.sectionHead}>按人<span className={s.count}>{progress.summaries.length}</span></h2>
      <ul className={s.list}>{progress.summaries.map((summary) => <SummaryRow key={summary.person.personId} summary={summary} onNavigate={onNavigate} />)}</ul>
    </section> : <span id="progress-people" />}

    <section className={s.section} id="progress-on-track" aria-labelledby="progress-on-track-title">
      <h2 id="progress-on-track-title" className={s.sectionHead}>
        <button type="button" className={s.disclosure} aria-expanded={showOnTrack} onClick={() => setShowOnTrack((value) => !value)}>
          <ChevronRight size={16} aria-hidden />按计划<span className={s.count} data-tone={progress.onTrack.length ? "green" : undefined}>{progress.onTrack.length}</span>
        </button>
      </h2>
      {showOnTrack ? progress.onTrack.length ? <ul className={s.list}>{progress.onTrack.map((row) => <OnTrackRow key={row.task.taskId} row={row} />)}</ul>
        : <p className={s.empty}>没有按计划在走的执行事项</p> : null}
    </section>
  </>;
}

function Person({ person: { personId, name } }: { person: { personId: string; name: string } }) {
  return <span className={s.person}><PersonAvatar personId={personId} className={s.avatar}>{name.slice(-2)}</PersonAvatar>{name}</span>;
}

/** 数字对比加一条进度条：前一个是预计 / 剩下的，后一个是已用 / 还需的；超出的部分标红。 */
export function Meter({ capacity, demand, capacityLabel, demandLabel }: { capacity: number; demand: number; capacityLabel: string; demandLabel: string }) {
  const parts = meterParts(capacity, demand);
  const over = demand > capacity;
  const text = `${capacityLabel} ${capacity} 天 / ${demandLabel} ${demand} 天`;
  return <div className={s.meter} data-over={over || undefined}>
    <span className={s.meterText}>{capacityLabel} <b>{capacity}</b> 天<span aria-hidden> / </span>{demandLabel} <b data-over={over || undefined}>{demand}</b> 天</span>
    <span className={s.track} role="img" aria-label={text}>
      <i className={s.fill} style={{ width: `${parts.fill}%` }} />
      {parts.over ? <i className={s.over} style={{ width: `${parts.over}%` }} /> : null}
      {parts.mark !== null ? <i className={s.mark} style={{ left: `${parts.mark}%` }} /> : null}
    </span>
  </div>;
}

export function Artifacts({ items }: { items: TProgressArtifact[] }) {
  if (!items.length) return null;
  return <ul className={s.artifacts} aria-label="做出来的东西">
    {items.map((item) => <li key={item.url}><a href={item.url} target="_blank" rel="noreferrer" title={item.url}><Link2 size={13} aria-hidden /><span>{artifactLabel(item)}</span></a></li>)}
  </ul>;
}

function Coverage({ at }: { at: string | null }) {
  return <p className={s.coverage} data-missing={at ? undefined : ""}>{coverageText(at)}</p>;
}

function RedLineRow({ line }: { line: TProgressRedLine }) {
  const [open, setOpen] = useState(false);
  if (line.kind === "slow") {
    const { task } = line;
    return <li className={s.item} data-red={line.reason}>
      <div className={s.itemHead}>
        <span className={s.flag} data-tone="red">比预期慢</span>
        <h3 className={s.itemTitle}>{task.title}</h3>
        <Person person={line.person} />
      </div>
      <p className={s.meta}>
        <span>{line.mission.title}</span><span>{dayRangeText(task.startDate, task.dueDate)}</span><span>{STATUS_TEXT[task.status]}</span>
        <span className={s.tag} data-tone="red">{line.reason === "overdue" ? "已过截止" : "无核实进展"}</span>
      </p>
      <Meter capacity={task.plannedDays} demand={task.usedDays} capacityLabel="预计" demandLabel="已用" />
      <Artifacts items={line.artifacts} />
      <Coverage at={line.coverageUntil} />
    </li>;
  }
  return <li className={s.item} data-red="deadline">
    <div className={s.itemHead}>
      <span className={s.flag} data-tone="red">做不完</span>
      <h3 className={s.itemTitle}>{line.mission.title}</h3>
      <Person person={line.person} />
    </div>
    <p className={s.meta}><span>截止 {dayRangeText(line.mission.deadline, line.mission.deadline)}</span><span>{line.tasks.length} 件未完成</span></p>
    <Meter capacity={line.leftDays} demand={line.neededDays} capacityLabel="剩" demandLabel="还需" />
    <button type="button" className={s.disclosure} aria-expanded={open} onClick={() => setOpen((value) => !value)}><ChevronRight size={14} aria-hidden />执行事项</button>
    {open ? <ul className={s.subList}>{line.tasks.map((task) => (
      <li key={task.taskId}><span>{task.title}</span><small>{dayRangeText(task.startDate, task.dueDate)} · {STATUS_TEXT[task.status]}</small></li>
    ))}</ul> : null}
    <Artifacts items={line.artifacts} />
    <Coverage at={line.coverageUntil} />
  </li>;
}

function SummaryRow({ summary, onNavigate }: { summary: TProgressPersonSummary; onNavigate: (href: string, origin?: Element | null) => void }) {
  const review = summary.weeklyReview;
  return <li className={s.item}>
    <div className={s.itemHead}>
      <Person person={summary.person} />
      {review ? <button type="button" className={s.linkChip} onClick={(event) => onNavigate(review.href, event.currentTarget)}>
        周复盘 {dayRangeText(review.weekStart, review.weekEnd)}<ChevronRight size={14} aria-hidden /></button>
        : <span className={s.tag}>无周复盘</span>}
    </div>
    {review?.overall ? <p className={s.prose}>{review.overall}</p> : null}
    {review?.progress ? <p className={s.prose} data-secondary="">{review.progress}</p> : null}
    {summary.recent.length ? <ul className={s.recent} aria-label="采集到的进展">{summary.recent.map((row, index) => (
      <li key={`${row.endedAt}:${index}`}><span>{row.text}</span><small>{relativeDayTime(row.endedAt)}{row.taskTitle ? ` · ${row.taskTitle}` : ""}</small></li>
    ))}</ul> : null}
    <Artifacts items={summary.artifacts} />
    <Coverage at={summary.coverageUntil} />
  </li>;
}

function OnTrackRow({ row }: { row: TProgressOnTrack }) {
  return <li className={s.item} data-compact="">
    <div className={s.itemHead}>
      <span className={s.flag} data-tone="green">按计划</span>
      <h3 className={s.itemTitle}>{row.task.title}</h3>
      <Person person={row.person} />
    </div>
    <p className={s.meta}><span>{row.mission.title}</span><span>{dayRangeText(row.task.startDate, row.task.dueDate)}</span><span>{STATUS_TEXT[row.task.status]}</span></p>
    <Meter capacity={row.task.plannedDays} demand={row.task.usedDays} capacityLabel="预计" demandLabel="已用" />
    <Artifacts items={row.artifacts} />
    <Coverage at={row.coverageUntil} />
  </li>;
}
