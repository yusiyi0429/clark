"use client";

/**
 * 按战场：每个战场一块，战场名、本期目标一行、Agent 汇总的几段话，底部写进展收集至和总结于的时间。
 * 全局进展（/progress）和成员的战场进展（/me/progress）共用；看得到哪些战场在服务端判（GET /api/progress/battlefield-summaries）。
 * 今天这份还在整理时写阶段和已用时间，每 3 秒再读一次；先给之前那份（底部时间看得出是哪天的）。
 */
import { useCallback, useEffect, useState } from "react";
import type { TBattlefieldSummary } from "@warmap/contracts";
import { useNow } from "@/components/meeting/MeetingHeader";
import { browserApi } from "@/lib/api/client";
import { monthDayTime } from "@/lib/companyTime";
import p from "./progress.module.css";
import s from "./battlefield-summary.module.css";

/** 一个战场整理一次的预计用时。 */
export const SUMMARY_EXPECTED_MS = 60_000;
const PHASE_TEXT = { reading: "正在读进展", writing: "正在整理" } as const;
const POLL_MS = 3_000;

export function BattlefieldSummaries() {
  const [battlefields, setBattlefields] = useState<TBattlefieldSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      const { data } = await browserApi.GET("/api/progress/battlefield-summaries");
      setFailed(!data);
      if (data) setBattlefields(data.battlefields);
    } catch { setFailed(true); }
  }, []);
  useEffect(() => {
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [load]);
  const running = battlefields?.some((item) => item.generation?.state === "running") ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, load]);

  if (battlefields && !battlefields.length) return null;
  return battlefields ? <BattlefieldSummaryList battlefields={battlefields} />
    : <section className={p.section} aria-label="按战场">
      {failed ? <p className={p.error} role="alert">没有读到战场汇总</p> : <p className={p.loading} role="status">正在读取</p>}
    </section>;
}

export function BattlefieldSummaryList({ battlefields }: { battlefields: TBattlefieldSummary[] }) {
  return <section className={p.section} aria-labelledby="battlefield-summary-title">
    <h2 id="battlefield-summary-title" className={p.sectionHead}>按战场<span className={p.count}>{battlefields.length}</span></h2>
    <ul className={p.list}>{battlefields.map((item) => <SummaryCard key={item.battlefieldId} item={item} />)}</ul>
  </section>;
}

function SummaryCard({ item }: { item: TBattlefieldSummary }) {
  const { summary, generation } = item;
  return <li className={`${p.item} ${s.card}`} data-battlefield={item.battlefieldId}>
    <div className={p.itemHead}><h3 className={p.itemTitle}>{item.name}</h3></div>
    {summary ? <p className={s.goal} data-missing={summary.goal ? undefined : ""} title={summary.goal ?? undefined}>
      <b>本期目标</b><span>{summary.goal ?? "未载入"}</span>
    </p> : null}
    {generation?.state === "running" ? <Running phase={generation.phase} startedAt={generation.startedAt} />
      : generation?.state === "failed" ? <p className={s.status} data-failed="">没整理出来</p> : null}
    {summary ? <div className={s.body}>{summary.paragraphs.map((text, index) => <p key={index}>{text}</p>)}</div> : null}
    {summary ? <p className={p.coverage}>{footerText(summary)}</p> : null}
  </li>;
}

function Running({ phase, startedAt }: { phase: "reading" | "writing"; startedAt: string }) {
  const now = useNow(1000);
  return <p className={s.status} role="status" suppressHydrationWarning>{PHASE_TEXT[phase]} · {elapsedText(startedAt, now)}</p>;
}

/** 「已用 12 秒，约 1 分钟」；超过预计就只写已用多久。时钟偏差不出负数。 */
export function elapsedText(startedAt: string, now: number, expectedMs = SUMMARY_EXPECTED_MS): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const spent = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分${seconds % 60 ? ` ${seconds % 60} 秒` : "钟"}`;
  return seconds * 1000 <= expectedMs ? `已用 ${spent}，约 ${Math.round(expectedMs / 60_000)} 分钟` : `已用 ${spent}`;
}

/** 「进展收集至 10/26 14:30 · 总结于 10/26 15:02」；没有进展记录时如实写。 */
export function footerText(summary: NonNullable<TBattlefieldSummary["summary"]>): string {
  return `${summary.progressUntil ? `进展收集至 ${monthDayTime(summary.progressUntil)}` : "没有进展记录"} · 总结于 ${monthDayTime(summary.summarizedAt)}`;
}
