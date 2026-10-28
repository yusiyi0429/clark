"use client";

/**
 * 上手的「确认清单」一步（前端交互说明 10a 第 4 步）：一屏摘要，记忆文件、文档、定时任务各一行，数字是帮本人选好的；
 * 点一行展开勾选明细，改了以摘要为准；数量为 0 的不显示。底栏「完成」把两份清单按当前勾选分别提交。
 */
import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { browserApi } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { MemoryImportPanel } from "./MemoryImportSlot";
import f from "./foundation.module.css";
import c from "./setup.module.css";

export type WorkBasisItem = components["schemas"]["WorkBasisResponse"]["candidates"][number];
export type ScheduleItem = components["schemas"]["ScheduleMigrationResponse"]["candidates"][number];
export type ReviewLists = { basis: WorkBasisItem[]; schedules: ScheduleItem[] };
/** 本人在明细里改过的勾选（key → 勾没勾）；没改过的按默认。 */
export type ReviewPicks = Record<string, boolean>;

/** 扫描页结束时一次读好两份清单，最后一页直接用。 */
export async function loadReviewLists(): Promise<ReviewLists> {
  const [basis, schedules] = await Promise.all([browserApi.GET("/api/me/work-basis"), browserApi.GET("/api/me/schedule-migration")]);
  if (!basis.data || !schedules.data) throw new Error("清单没有读到");
  return { basis: basis.data.candidates, schedules: schedules.data.candidates };
}

/**
 * 勾选：明细里改过的按改的。没改过的，本次上手里提交过就按入库的来（之前取消的不再自动勾）；还没提交过就全勾——
 * 服务端只列执行事项里的、读得到标题的文档和工作用的定时任务。
 */
function selectedKeys(lists: ReviewLists, reviewed: boolean, picks: ReviewPicks): { basis: string[]; schedules: string[] } {
  const keys = <T extends { key: string }>(items: T[], saved: (item: T) => boolean) =>
    items.filter((item) => picks[item.key] ?? (saved(item) || !reviewed)).map((item) => item.key);
  return { basis: keys(lists.basis, (item) => item.confirmed), schedules: keys(lists.schedules, (item) => item.imported) };
}

/** 三项都没有可确认的：这一步跳过。 */
export const reviewEmpty = (lists: ReviewLists, memoryFiles: number | null) => !lists.basis.length && !lists.schedules.length && !memoryFiles;

async function putList<T>(path: "/api/me/work-basis" | "/api/me/schedule-migration", keys: string[]): Promise<T[]> {
  const { data, error } = await browserApi.PUT(path, { body: { keys } });
  if (!data) throw new Error(error?.message ?? "没有存上，请重试");
  return data.candidates as T[];
}

/** 两份清单分别提交（记忆导入接进来之前没有要提交的）；任一份没存上就抛错，留在这一步。 */
export async function submitReview(lists: ReviewLists, reviewed: boolean, picks: ReviewPicks): Promise<ReviewLists> {
  const keys = selectedKeys(lists, reviewed, picks);
  const [basis, schedules] = await Promise.all([
    lists.basis.length ? putList<WorkBasisItem>("/api/me/work-basis", keys.basis) : lists.basis,
    lists.schedules.length ? putList<ScheduleItem>("/api/me/schedule-migration", keys.schedules) : lists.schedules,
  ]);
  return { basis, schedules };
}

function Checklist<T extends { key: string }>({ items, selected, onToggle, row, label, disabled }: {
  items: T[];
  selected: string[];
  onToggle: (key: string, checked: boolean) => void;
  row: (item: T) => ReactNode;
  label: string;
  disabled: boolean;
}) {
  return <ul className={c.list} aria-label={label}>{items.map((item) => <li key={item.key}>
    <label className={c.row}>
      <input type="checkbox" checked={selected.includes(item.key)} onChange={(event) => onToggle(item.key, event.target.checked)} disabled={disabled} />
      <span className={c.rowMain}>{row(item)}</span>
    </label>
  </li>)}</ul>;
}

const ORIGIN: Record<string, string> = { task: "执行事项", session: "会话" };
/** 飞书文档的最近修订：「10/16 修订 · 修订人」，没有修订人名字时只写日期。 */
export const revisedLabel = (at: string, by: string | null) =>
  `${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" }).format(new Date(at)).replace(/月/, "/").replace(/日/, "")} 修订${by ? ` · ${by}` : ""}`;
const KIND: Record<WorkBasisItem["kind"], string> = { material: "天枢", feishu_doc: "飞书", link: "链接" };

const basisRow = (item: WorkBasisItem) => <>
  <span className={c.rowTitle}>{item.url ? <a href={item.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>{item.title}</a> : item.title}</span>
  <span className={c.rowMeta}>
    <span className={c.chip}>{KIND[item.kind]}</span>
    {item.revision ? <span className={c.chip} data-tone="blue">{item.revision}</span> : null}
    {item.revisedAt ? <span className={c.chip} data-tone="blue">{revisedLabel(item.revisedAt, item.revisedBy)}</span> : null}
    {item.origin ? <span className={c.chip}>{ORIGIN[item.origin]}</span> : null}
    {item.supersededBy ? <a className={c.chip} data-tone="amber" href={item.supersededBy.url} target="_blank" rel="noreferrer"
      onClick={(event) => event.stopPropagation()}>已被取代 → {item.supersededBy.title}</a> : null}
    {item.keepUntil ? <span className={c.chip} data-tone="amber">用到 {Number(item.keepUntil.slice(5, 7))}/{Number(item.keepUntil.slice(8, 10))}</span> : null}
  </span>
</>;
const scheduleRow = (item: ScheduleItem) => <>
  <span className={c.rowTitle}>{item.name}</span>
  <span className={c.rowMeta}>
    {item.cadence ? <span className={c.chip}>{item.cadence}</span> : null}
    <span className={c.chip}>{item.deviceName}</span>
  </span>
  {item.command ? <span className={c.mono} title={item.command}>{item.command}</span> : null}
</>;

type Section = "memory" | "basis" | "schedules";

export function ReviewSummary({ lists, reviewed, picks, onPick, memoryFiles, saving, error }: {
  lists: ReviewLists;
  reviewed: boolean;
  picks: ReviewPicks;
  onPick: (key: string, checked: boolean) => void;
  memoryFiles: number | null;
  saving: boolean;
  error: string | null;
}) {
  const [open, setOpen] = useState<Section | null>(null);
  const keys = selectedKeys(lists, reviewed, picks);
  const sections: { id: Section; label: string; count: number; unit: string; detail: ReactNode }[] = [
    ...(memoryFiles ? [{ id: "memory" as const, label: "记忆文件", count: memoryFiles, unit: "个", detail: <MemoryImportPanel localMemoryFiles={memoryFiles} /> }] : []),
    ...(lists.basis.length ? [{ id: "basis" as const, label: "文档", count: keys.basis.length, unit: "份",
      detail: <Checklist label="文档" items={lists.basis} selected={keys.basis} onToggle={onPick} row={basisRow} disabled={saving} /> }] : []),
    ...(lists.schedules.length ? [{ id: "schedules" as const, label: "定时任务", count: keys.schedules.length, unit: "个",
      detail: <Checklist label="定时任务" items={lists.schedules} selected={keys.schedules} onToggle={onPick} row={scheduleRow} disabled={saving} /> }] : []),
  ];
  return <div className={`${f.glass} ${c.panel}`}>
    <ul className={c.summary}>{sections.map((section) => <li key={section.id}>
      <button type="button" className={c.summaryRow} aria-expanded={open === section.id} aria-controls={`review-${section.id}`}
        onClick={() => setOpen(open === section.id ? null : section.id)}>
        <span>{section.label}</span>
        <span className={c.summaryCount}><strong>{section.count}</strong>{section.unit}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open === section.id ? <div id={`review-${section.id}`} className={c.summaryDetail}>{section.detail}</div> : null}
    </li>)}</ul>
    {error ? <p className={c.error} role="alert">{error}</p> : null}
  </div>;
}

/**
 * 个人菜单 › 设置 › 本机采集器：上手时扫描没等完就「后台继续」的，盘点到了在这里确认清单；以后想改也在这里。
 * 三项都没有可确认的就不显示。入过库的按入库的勾，一项都没入过就全勾（同上手）。
 */
export function CollectorReview({ scannedAt, memoryFiles }: { scannedAt: string | null; memoryFiles: number | null }) {
  const [lists, setLists] = useState<ReviewLists | null>(null);
  const [picks, setPicks] = useState<ReviewPicks>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!scannedAt) return;
    let alive = true;
    void loadReviewLists().then((next) => { if (alive) setLists(next); }).catch(() => undefined);
    return () => { alive = false; };
  }, [scannedAt]);
  if (!lists || reviewEmpty(lists, memoryFiles)) return null;
  const reviewed = lists.basis.some((item) => item.confirmed) || lists.schedules.some((item) => item.imported);

  async function save() {
    if (!lists) return;
    setSaving(true);
    setError(null);
    try {
      setLists(await submitReview(lists, reviewed, picks));
      setPicks({});
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "没有存上，请重试");
    } finally {
      setSaving(false);
    }
  }

  return <section className={c.laterReview} aria-label="确认清单">
    <h3>确认清单</h3>
    <ReviewSummary lists={lists} reviewed={reviewed} picks={picks} memoryFiles={memoryFiles} saving={saving} error={error}
      onPick={(key, checked) => { setSaved(false); setPicks((current) => ({ ...current, [key]: checked })); }} />
    <div className={c.laterActions}>
      <button type="button" className={f.primary} onClick={() => void save()} disabled={saving || saved}>{saving ? "正在保存…" : saved ? "已保存" : "保存"}</button>
    </div>
  </section>;
}
