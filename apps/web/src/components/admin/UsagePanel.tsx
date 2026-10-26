"use client";

/**
 * 管理员视图「使用」：一周一份使用周报（服务端算好，这里只画）。本周现算，过去各周是每周一早上生成的那一份。
 * 关键路径按 PostHog / Amplitude 的漏斗画：每步一根横条（以第一步为满格），右边是到达数、人数、相对上一步的转化；
 * 流失最多的那一步标红，下面列这一步的中断原因。谁在用按 Linear 式的一行一人，七格是周一到周日。
 */
import { useEffect, useState } from "react";
import { Button } from "ts-design/primitives";
import { Check, Copy, Download, X } from "lucide-react";
import type { TUsageLedgerItem, TUsagePath, TUsagePersonRow, TUsageResponse, TUsageWeekReport } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { deliverMarkdown, downloadText, type Delivered } from "./deliverMarkdown";
import s from "./admin.module.css";
import u from "./usage.module.css";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const shortDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const weekLabel = (start: string) => `${shortDay(start)}–${shortDay(addDays(start, 6))}`;
const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");

export function UsagePanel() {
  const [week, setWeek] = useState<string | null>(null);
  const [view, setView] = useState<TUsageResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [delivered, setDelivered] = useState<Delivered | "failed" | null>(null);

  useEffect(() => {
    let current = true;
    browserApi.GET("/api/admin/usage", { params: { query: week ? { week } : {} } }).then(({ data }) => {
      if (!current) return;
      setFailed(!data);
      if (data) setView(data);
    }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [week]);

  /** 复制周报 Markdown；剪贴板用不了就下载 .md。按钮上的图标和字两秒内显示结果。 */
  const copy = async () => {
    if (!view) return;
    let result: Delivered | "failed" = "failed";
    try {
      const { data } = await browserApi.GET("/api/admin/usage/markdown", { params: { query: { week: view.report.weekStart } }, parseAs: "text" });
      if (typeof data === "string") {
        result = await deliverMarkdown(data, `天枢使用周报-${view.report.weekStart}.md`, { clipboard: navigator.clipboard, download: downloadText });
      }
    } catch { /* 记成失败 */ }
    setDelivered(result);
    window.setTimeout(() => setDelivered(null), 2_000);
  };

  if (!view) return <div className={u.panel}>{failed ? <p className={s.error} role="alert">没有取到数据</p> : <div className={u.placeholder} aria-busy="true" />}</div>;
  const report = view.report;
  return (
    <div className={u.panel}>
      <div className={u.toolbar}>
        <select aria-label="周" className={u.week} value={report.weekStart} onChange={(event) => setWeek(event.target.value)}>
          {view.weeks.map((item) => <option key={item.weekStart} value={item.weekStart}>{weekLabel(item.weekStart)}{item.live ? " · 本周" : ""}</option>)}
        </select>
        <Button variant="ghost" className={s.action} onPress={() => void copy()}>
          {delivered === "copied" ? <Check size={14} aria-hidden="true" /> : delivered === "downloaded" ? <Download size={14} aria-hidden="true" />
            : delivered === "failed" ? <X size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          <span role="status">{delivered === "copied" ? "已复制" : delivered === "downloaded" ? "已下载" : delivered === "failed" ? "失败" : "Markdown"}</span>
        </Button>
      </div>
      {failed ? <p className={s.error} role="alert">没有取到数据</p> : null}

      <section className={u.stats} aria-label="概况">
        <Stat label="活跃人数" value={`${report.summary.activePeople}`} total={report.summary.roster} delta={report.summary.activePeople - report.previous.activePeople} />
        <Stat label="人均活跃天数" value={`${report.summary.avgActiveDays}`} delta={Math.round((report.summary.avgActiveDays - report.previous.avgActiveDays) * 10) / 10} />
        <Stat label="发问" value={`${report.summary.asks}`} delta={report.summary.asks - report.previous.asks} />
      </section>

      <section className={s.section} aria-labelledby="usage-paths">
        <header className={s.sectionHead}><h2 id="usage-paths">关键路径</h2></header>
        <div className={u.paths}>{report.paths.map((path) => <PathCard key={path.key} path={path} />)}</div>
      </section>

      <section className={s.section} aria-labelledby="usage-people">
        <header className={s.sectionHead}><h2 id="usage-people">谁在用</h2><span className={s.sectionCount} data-zero="">{report.summary.activePeople}/{report.summary.roster}</span></header>
        <People report={report} />
      </section>

      <section className={s.section} aria-labelledby="usage-ledger">
        <header className={s.sectionHead}><h2 id="usage-ledger">问题台账</h2><span className={s.sectionCount} data-zero={report.ledger.length ? undefined : ""}>{report.ledger.length}</span></header>
        {report.ledger.length ? <ul className={s.list}>{report.ledger.map((item) => <LedgerRow key={item.key} item={item} />)}</ul> : <p className={s.clear}><Check size={16} aria-label="0" /></p>}
      </section>
    </div>
  );
}

/** 和上周比：↑ / ↓ 加差值；bad 表示涨了是坏事（中断、问题）。 */
function Delta({ value, bad = false }: { value: number; bad?: boolean }) {
  if (!value) return null;
  const up = value > 0;
  return <span className={u.delta} data-tone={up === bad ? "bad" : "good"} title="和上周比">{up ? "↑" : "↓"}{Math.abs(value)}</span>;
}

function Stat({ label, value, total, delta }: { label: string; value: string; total?: number; delta: number }) {
  return (
    <div className={u.stat}>
      <span className={u.statLabel}>{label}</span>
      <span className={u.statValue}>{value}{total !== undefined ? <small>/{total}</small> : null}<Delta value={delta} /></span>
    </div>
  );
}

function PathCard({ path }: { path: TUsagePath }) {
  const first = path.steps[0]?.units ?? 0;
  return (
    <article className={u.path} data-key={path.key} data-shape={path.shape}>
      <header className={u.pathHead}>
        <h3>{path.title}</h3>
        <span className={u.unit}>{path.unit}</span>
      </header>
      {path.shape === "counts" ? (
        <dl className={u.counts}>
          {path.steps.map((step, index) => (
            <div key={step.key}>
              <dt>{step.label}</dt>
              <dd><strong>{step.units}</strong><Delta value={step.units - (path.previousUnits[index] ?? 0)} /></dd>
              <dd className={u.countPeople}>{step.people} 人</dd>
            </div>
          ))}
        </dl>
      ) : !first ? (
        <p className={u.empty}>0</p>
      ) : (
        <ol className={u.funnel}>
          {path.steps.map((step, index) => {
            const breaks = path.breaks.filter((item) => item.step === step.key);
            return (
              <li key={step.key} data-stuck={step.key === path.stuckStep ? "" : undefined}>
                <div className={u.stepHead}>
                  <span className={u.stepName}>{step.label}</span>
                  <span className={u.stepNums}>
                    <strong>{step.units}</strong>
                    {path.unit !== "人" ? <span>{step.people} 人</span> : null}
                    <span className={u.conversion}>{index ? percent(step.units, path.steps[index - 1].units) : ""}</span>
                    <Delta value={step.units - (path.previousUnits[index] ?? 0)} />
                  </span>
                </div>
                <div className={u.track}><i style={{ width: `${(step.units / first) * 100}%` }} /></div>
                {breaks.length ? <p className={u.breaks}>{breaks.map((item) => <span key={item.label}>{item.label} {item.count}</span>)}</p> : null}
              </li>
            );
          })}
        </ol>
      )}
    </article>
  );
}

function People({ report }: { report: TUsageWeekReport }) {
  const days = WEEKDAYS.map((_, index) => addDays(report.weekStart, index));
  return (
    <div className={u.people}>
      <div className={u.peopleHead} aria-hidden="true">
        <span>人</span>
        <span className={u.strip}>{WEEKDAYS.map((day) => <span key={day}>{day}</span>)}</span>
        <span>天</span><span>发问</span><span>中断</span>
      </div>
      {report.people.map((person) => <PersonRow key={person.personId} person={person} days={days} />)}
    </div>
  );
}

function PersonRow({ person, days }: { person: TUsagePersonRow; days: string[] }) {
  const active = new Set(person.days);
  return (
    <div className={u.personRow} data-idle={person.days.length ? undefined : ""}>
      <span className={s.name}>{person.displayName}</span>
      <span className={u.strip} aria-label={`${person.days.length} 天`}>
        {days.map((day) => <i key={day} data-on={active.has(day) ? "" : undefined} title={shortDay(day)} />)}
      </span>
      <span className={u.num}><small>天</small>{person.days.length}<Delta value={person.days.length - person.previousActiveDays} /></span>
      <span className={u.num}><small>发问</small>{person.asks}</span>
      <span className={u.num} data-bad={person.breaks ? "" : undefined}><small>中断</small>{person.breaks}</span>
    </div>
  );
}

const SOURCE_STATUS: Record<TUsageLedgerItem["source"], "red" | "yellow" | "none"> = { world: "red", job: "red", quality: "yellow", feedback: "none" };

function LedgerRow({ item }: { item: TUsageLedgerItem }) {
  return (
    <li className={`${s.item} ${u.ledgerItem}`} data-status={SOURCE_STATUS[item.source]}>
      <i className={s.dot} data-status={SOURCE_STATUS[item.source]} aria-hidden="true" />
      <div className={s.itemMain}><p className={s.itemTitle}>{item.label}</p></div>
      <div className={s.itemMeta}>
        <span className={s.attempts}>×{item.count}</span>
        <Delta value={item.count - item.previousCount} bad />
        {item.people ? <span>{item.people} 人</span> : null}
        {item.open ? <span className={u.open}>未处理 {item.open}</span> : <Check size={14} aria-label="已处理" />}
      </div>
    </li>
  );
}
