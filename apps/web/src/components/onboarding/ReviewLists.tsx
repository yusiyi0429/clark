"use client";

/**
 * 上手最后一页（前端交互说明 10a 第 4 步）：导入的记忆、工作依据清单、搬家清单三个标签。
 * 每个标签确认过就打勾，确认后自动切到下一个还没确认的标签；三个都打勾，底栏的「完成」才能点。
 */
import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { browserApi } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { MemoryImportPanel } from "./MemoryImportSlot";
import f from "./foundation.module.css";
import c from "./setup.module.css";

export type WorkBasisItem = components["schemas"]["WorkBasisResponse"]["candidates"][number];
export type ScheduleItem = components["schemas"]["ScheduleMigrationResponse"]["candidates"][number];
export type ReviewTab = "memory" | "basis" | "schedules";
export type ReviewLists = { basis: WorkBasisItem[]; schedules: ScheduleItem[] };
export const REVIEW_TABS: { id: ReviewTab; label: string }[] = [
  { id: "memory", label: "导入的记忆" }, { id: "basis", label: "工作依据清单" }, { id: "schedules", label: "搬家清单" },
];

/** 扫描页结束时一次读好两份清单，最后一页直接用。 */
export async function loadReviewLists(): Promise<ReviewLists> {
  const [basis, schedules] = await Promise.all([browserApi.GET("/api/me/work-basis"), browserApi.GET("/api/me/schedule-migration")]);
  if (!basis.data || !schedules.data) throw new Error("清单没有读到");
  return { basis: basis.data.candidates, schedules: schedules.data.candidates };
}

/**
 * 默认勾选：确认过的按入库的来；还没确认过时，执行事项里挂着的材料和链接默认勾上，只在会话里读过的默认不勾；
 * 搬家清单默认都不勾（本机定时任务里混着系统和软件自带的）。
 */
export const defaultBasisSelected = (item: WorkBasisItem, reviewed: boolean) => item.confirmed || (!reviewed && item.origin === "task");

function Checklist<T extends { key: string }>({ items, initial, row, save, confirmed, onConfirmedChange, onSaved, label }: {
  items: T[];
  initial: (item: T) => boolean;
  row: (item: T) => ReactNode;
  save: (keys: string[]) => Promise<T[]>;
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  onSaved: (items: T[]) => void;
  label: string;
}) {
  const [selected, setSelected] = useState(() => new Set(items.filter(initial).map((item) => item.key)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const toggle = (key: string) => {
    setSelected((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
    if (confirmed) onConfirmedChange(false);
  };
  const submit = async () => {
    if (saving) return;
    setSaving(true); setError("");
    try {
      onSaved(await save(items.filter((item) => selected.has(item.key)).map((item) => item.key)));
      onConfirmedChange(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "没有存上，请重试"); }
    finally { setSaving(false); }
  };
  return <>
    {items.length ? <ul className={c.list} aria-label={label}>{items.map((item) => <li key={item.key}>
      <label className={c.row}>
        <input type="checkbox" checked={selected.has(item.key)} onChange={() => toggle(item.key)} disabled={saving} />
        <span className={c.rowMain}>{row(item)}</span>
      </label>
    </li>)}</ul> : <p className={c.empty}>没有找到</p>}
    {error ? <p className={c.error} role="alert">{error}</p> : null}
    <div className={c.listFoot}>
      <span className={c.count}>已选 {selected.size}/{items.length}</span>
      {confirmed ? <span className={c.done}><Check size={16} strokeWidth={3} aria-hidden="true" />已确认</span>
        : <button type="button" className={c.action} onClick={() => void submit()} disabled={saving}>{saving ? "保存中…" : "确认"}</button>}
    </div>
  </>;
}

const ORIGIN: Record<string, string> = { task: "执行事项", session: "会话" };
/** 飞书文档的最近修订：「10/16 修订 · 修订人」，没有修订人名字时只写日期。 */
export const revisedLabel = (at: string, by: string | null) =>
  `${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" }).format(new Date(at)).replace(/月/, "/").replace(/日/, "")} 修订${by ? ` · ${by}` : ""}`;
const KIND: Record<WorkBasisItem["kind"], string> = { material: "天枢", feishu_doc: "飞书", link: "链接" };

async function putList<T>(path: "/api/me/work-basis" | "/api/me/schedule-migration", keys: string[]): Promise<T[]> {
  const { data, error } = await browserApi.PUT(path, { body: { keys } });
  if (!data) throw new Error(error?.message ?? "没有存上，请重试");
  return data.candidates as T[];
}

export function ReviewTabs({ lists, onListsChange, reviewed, onReviewedChange, localMemoryFiles }: {
  lists: ReviewLists;
  onListsChange: (lists: ReviewLists) => void;
  reviewed: Record<ReviewTab, boolean>;
  onReviewedChange: (tab: ReviewTab, confirmed: boolean) => void;
  localMemoryFiles: number | null;
}) {
  const [active, setActive] = useState<ReviewTab>(() => REVIEW_TABS.find((tab) => !reviewed[tab.id])?.id ?? "memory");
  const counts: Record<ReviewTab, number | null> = { memory: null, basis: lists.basis.length, schedules: lists.schedules.length };
  const mark = (tab: ReviewTab, confirmed: boolean) => {
    onReviewedChange(tab, confirmed);
    if (!confirmed) return;
    const after = { ...reviewed, [tab]: true };
    const next = REVIEW_TABS.find((item) => !after[item.id]);
    if (next) setActive(next.id);
  };
  return <div>
    <div className={c.tabs} role="tablist" aria-label="确认清单">
      {REVIEW_TABS.map((tab) => <button key={tab.id} type="button" role="tab" id={`review-tab-${tab.id}`} aria-controls={`review-panel-${tab.id}`}
        aria-selected={active === tab.id} data-done={reviewed[tab.id]} className={c.tab} onClick={() => setActive(tab.id)}>
        <span className={c.tabMark} aria-hidden="true">{reviewed[tab.id] ? <Check size={11} strokeWidth={3.4} /> : counts[tab.id] ?? "·"}</span>
        {tab.label}
        {reviewed[tab.id] ? <span className={f.srOnly}>（已确认）</span> : null}
      </button>)}
    </div>
    <div className={`${f.glass} ${c.panel}`}>
      <div role="tabpanel" id="review-panel-memory" aria-labelledby="review-tab-memory" hidden={active !== "memory"}>
        <MemoryImportPanel confirmed={reviewed.memory} onConfirmedChange={(value) => mark("memory", value)} localMemoryFiles={localMemoryFiles} />
      </div>
      <div role="tabpanel" id="review-panel-basis" aria-labelledby="review-tab-basis" hidden={active !== "basis"}>
        <Checklist label="工作依据清单" items={lists.basis} confirmed={reviewed.basis} onConfirmedChange={(value) => mark("basis", value)}
          initial={(item) => defaultBasisSelected(item, reviewed.basis)}
          save={(keys) => putList<WorkBasisItem>("/api/me/work-basis", keys)}
          onSaved={(basis) => onListsChange({ ...lists, basis })}
          row={(item) => <>
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
          </>} />
      </div>
      <div role="tabpanel" id="review-panel-schedules" aria-labelledby="review-tab-schedules" hidden={active !== "schedules"}>
        <Checklist label="搬家清单" items={lists.schedules} confirmed={reviewed.schedules} onConfirmedChange={(value) => mark("schedules", value)}
          initial={(item) => item.imported}
          save={(keys) => putList<ScheduleItem>("/api/me/schedule-migration", keys)}
          onSaved={(schedules) => onListsChange({ ...lists, schedules })}
          row={(item) => <>
            <span className={c.rowTitle}>{item.name}</span>
            <span className={c.rowMeta}>
              {item.cadence ? <span className={c.chip}>{item.cadence}</span> : null}
              <span className={c.chip}>{item.deviceName}</span>
            </span>
            {item.command ? <span className={c.mono} title={item.command}>{item.command}</span> : null}
          </>} />
      </div>
    </div>
  </div>;
}
