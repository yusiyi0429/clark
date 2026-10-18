"use client";

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Users, X } from "lucide-react";
import type { TReadScope, TReadScopeParams } from "@warmap/contracts";
import { popPosition } from "./citations";
import c from "@/styles/citations.module.css";
import s from "@/styles/scope-chip.module.css";

/**
 * 跨对象读取的范围标签（已定设计 5a 第 2 条）：「全员 · 7–10 月」。点开调整谁、哪几个月，「重新读」按新范围再读一遍
 * （参照 Notion AI、Perplexity 回答上的来源范围：标签就是开关，点开就地改）。电脑上是浮层，手机从底部升起。
 * 回答进行中只显示，不能点。
 */
export type Rescope = (params: TReadScopeParams, label: string) => void;
/** 时间线给的「按新范围重读」与这时能不能点（回答进行中不能）。 */
export const RescopeContext = createContext<{ rescope: Rescope; busy: boolean } | null>(null);

const monthLabel = (month: string) => `${Number(month.slice(5))} 月`;
/** 与服务端同一写法：同一年「7–10 月」，跨年「2025.11–2026.2」。 */
export function monthsLabel(from: string, to: string): string {
  const [fy, fm] = from.split("-").map(Number), [ty, tm] = to.split("-").map(Number);
  return from === to ? `${fm} 月` : fy === ty ? `${fm}–${tm} 月` : `${fy}.${fm}–${ty}.${tm}`;
}
export function scopeLabelOf(params: TReadScopeParams, names: Map<string, string>, previous?: string): string {
  const people = params.people ?? "all";
  const who = people === "all" ? (params.battlefieldId && previous ? previous.split(" · ")[0] : "全员")
    : people === "me" ? "我"
    : people.length <= 2 ? people.map((id) => names.get(id) ?? id).join("、")
    : `${people.slice(0, 2).map((id) => names.get(id) ?? id).join("、")}等 ${people.length} 人`;
  return params.from && params.to ? `${who} · ${monthsLabel(params.from, params.to)}` : who;
}
/** 最近 12 个月（北京时间），新的在前；当前范围里更早的月份也放进来。 */
export function recentMonths(now: Date, include: (string | undefined)[] = []): string[] {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).formatToParts(now).map((part) => [part.type, part.value]));
  const year = Number(parts.year), month = Number(parts.month);
  const months = Array.from({ length: 12 }, (_, index) => new Date(Date.UTC(year, month - 1 - index, 1)).toISOString().slice(0, 7));
  return [...new Set([...months, ...include.filter((item): item is string => Boolean(item))])].sort().reverse();
}

export function ScopeChip({ scope }: { scope: TReadScope }) {
  const action = useContext(RescopeContext);
  const button = useRef<HTMLButtonElement>(null);
  const pointer = useRef("mouse");
  const [mode, setMode] = useState<"closed" | "pop" | "sheet">("closed");
  const popId = useId();
  const close = useCallback(() => { setMode("closed"); button.current?.focus({ preventScroll: true }); }, []);
  const content = <><Users size={12} strokeWidth={2} aria-hidden /><span className={s.text}>{scope.label}</span></>;
  if (!action) return <span className={s.chip} data-testid="scope-chip">{content}</span>;
  const onClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (action.busy) return;
    if (mode !== "closed") { setMode("closed"); return; }
    setMode(pointer.current !== "mouse" && event.detail > 0 ? "sheet" : "pop");
  };
  const apply = (params: TReadScopeParams, label: string) => { setMode("closed"); action.rescope(params, label); };
  return (
    <>
      <button ref={button} type="button" className={s.chip} data-testid="scope-chip" aria-haspopup="dialog" aria-expanded={mode !== "closed"}
        aria-controls={mode !== "closed" ? popId : undefined} disabled={action.busy}
        onPointerDown={(event) => { pointer.current = event.pointerType || "mouse"; }} onClick={onClick}>
        {content}<ChevronDown size={12} strokeWidth={2} aria-hidden className={s.chevron} />
      </button>
      {mode === "pop" ? <ScopePop popId={popId} anchor={button} onClose={close}><ScopeEditor scope={scope} onApply={apply} onCancel={close} /></ScopePop> : null}
      {mode === "sheet" ? (
        <ScopeSheet popId={popId} onClose={close}><ScopeEditor scope={scope} onApply={apply} onCancel={close} large /></ScopeSheet>
      ) : null}
    </>
  );
}

function ScopePop({ popId, anchor, onClose, children }: { popId: string; anchor: RefObject<HTMLButtonElement | null>; onClose: () => void; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<ReturnType<typeof popPosition> | null>(null);
  const measure = useCallback(() => {
    const rect = anchor.current?.getBoundingClientRect();
    if (rect) setPlace(popPosition(rect, { width: window.innerWidth, height: window.innerHeight }, box.current?.offsetHeight ?? 220));
  }, [anchor]);
  useLayoutEffect(measure, [measure]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!box.current?.contains(target) && !anchor.current?.contains(target)) onClose();
    };
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [anchor, measure, onClose]);
  return createPortal(
    <div ref={box} id={popId} role="dialog" aria-label="读取范围" className={`${c.pop} ${s.pop}`} data-scope-pop=""
      style={place ? ({ left: place.left, top: place.top, bottom: place.bottom, width: Math.max(place.width, 300) } as CSSProperties) : { visibility: "hidden" }}>
      {children}
    </div>,
    document.body,
  );
}

function ScopeSheet({ popId, onClose, children }: { popId: string; onClose: () => void; children: React.ReactNode }) {
  const closeKey = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeKey.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className={c.sheetLayer} data-scope-sheet="">
      <button type="button" className={c.sheetVeil} aria-label="收起" tabIndex={-1} onClick={onClose} />
      <section id={popId} className={`${c.sheet} ${s.sheet}`} role="dialog" aria-modal="true" aria-label="读取范围">
        <span className={c.grabber} aria-hidden />
        <button ref={closeKey} type="button" className={`${c.sheetClose} ${s.sheetClose}`} aria-label="收起" onClick={onClose}>
          <X size={18} strokeWidth={1.9} aria-hidden />
        </button>
        {children}
      </section>
    </div>,
    document.body,
  );
}

/** 谁（全员 / 我 / 点选几个人）、从哪个月到哪个月；没改就不能点「重新读」。 */
export function ScopeEditor({ scope, onApply, onCancel, large = false, now }: {
  scope: TReadScope; onApply: (params: TReadScopeParams, label: string) => void; onCancel: () => void; large?: boolean; now?: Date;
}) {
  const choices = scope.choices?.people ?? [];
  const names = useMemo(() => new Map(choices.map((person) => [person.id, person.name])), [choices]);
  const initialPeople = scope.params.people ?? "all";
  const [who, setWho] = useState<"all" | "me" | "some">(initialPeople === "all" || initialPeople === "me" ? initialPeople : "some");
  const [picked, setPicked] = useState<string[]>(Array.isArray(initialPeople) ? initialPeople : []);
  const months = useMemo(() => recentMonths(now ?? new Date(), [scope.params.from, scope.params.to]), [now, scope.params.from, scope.params.to]);
  const [from, setFrom] = useState(scope.params.from ?? months[0]);
  const [to, setTo] = useState(scope.params.to ?? months[0]);
  const people: TReadScopeParams["people"] = who === "some" ? picked : who;
  const ordered = from <= to ? { from, to } : { from: to, to: from };
  const params: TReadScopeParams = { people, ...(scope.params.battlefieldId ? { battlefieldId: scope.params.battlefieldId } : {}), ...ordered };
  const label = scopeLabelOf(params, names, scope.label);
  const changed = label !== scope.label || JSON.stringify(params) !== JSON.stringify(scope.params);
  const valid = who !== "some" || picked.length > 0;
  const toggle = (id: string) => {
    setWho("some");
    setPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };
  return (
    <form className={`${s.editor} ${large ? s.large : ""}`} onSubmit={(event) => { event.preventDefault(); if (changed && valid) onApply(params, label); }}>
      <div className={s.row}>
        <span className={s.key} aria-hidden>谁</span>
        <div className={s.options} role="group" aria-label="谁">
          <button type="button" className={s.option} aria-pressed={who === "all"} onClick={() => { setWho("all"); setPicked([]); }}>全员</button>
          <button type="button" className={s.option} aria-pressed={who === "me"} onClick={() => { setWho("me"); setPicked([]); }}>我</button>
          {choices.map((person) => (
            <button key={person.id} type="button" className={s.option} aria-pressed={who === "some" && picked.includes(person.id)} onClick={() => toggle(person.id)}>{person.name}</button>
          ))}
        </div>
      </div>
      <div className={s.row}>
        <span className={s.key} aria-hidden>月份</span>
        <div className={s.months} role="group" aria-label="月份">
          <select className={s.select} aria-label="起始月份" value={from} onChange={(event) => setFrom(event.target.value)}>
            {months.map((month) => <option key={month} value={month}>{month.slice(0, 4)} 年 {monthLabel(month)}</option>)}
          </select>
          <span aria-hidden>–</span>
          <select className={s.select} aria-label="结束月份" value={to} onChange={(event) => setTo(event.target.value)}>
            {months.map((month) => <option key={month} value={month}>{month.slice(0, 4)} 年 {monthLabel(month)}</option>)}
          </select>
        </div>
      </div>
      <div className={s.foot}>
        <span className={s.preview} data-testid="scope-preview">{label}</span>
        <button type="button" className={s.ghost} onClick={onCancel}>取消</button>
        <button type="submit" className={s.primary} disabled={!changed || !valid}>重新读</button>
      </div>
    </form>
  );
}
