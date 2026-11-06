"use client";

/**
 * 选项框（新首页设计第 4.3 条）：放在对话里问的那一处，一个组件管三件事——提问、批准、开工。
 * - 选项里推荐的放第一个、带「推荐」；最后一项「自己说…」点了就地展开输入。
 * - 数字键选、↑↓ 换、回车提交；点一下就提交。多选时选好了点「确定」。
 * - 几件一起来时页头写「1/2」能翻，页头右边放「全部批准」那样的动作。
 * - 答过的收成一行；这里不能答（手机、别的电脑）时只显示问的是什么，不给选项，下面一行写去哪儿答。
 * 还没答的框登记到 PendingBoxes：框滚出屏幕时，输入条上方出「1 个问题等你 ↑」（PendingChip），点了跳回来。
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUp, Check, ChevronLeft, ChevronRight, CornerDownLeft } from "lucide-react";
import x from "@/styles/decision-box.module.css";

export type DecisionOption = { label: string; detail?: string | null; recommended?: boolean };
export type DecisionKind = "question" | "approval" | "plan";

const ICON = { size: 16, strokeWidth: 1.5 } as const;

export function DecisionBox({ kind, title, body, options, onPick, other, multi, pager, aside, resolved, blocked, busy, footer, outside, autoFocus = true, testId }: {
  kind: DecisionKind;
  /** 第一行：问的是什么。 */
  title: ReactNode;
  /** 标题下面的内容：命令、计划的几步。 */
  body?: ReactNode;
  options: DecisionOption[];
  /** 选了第几个（单选点了就提交）。多选时是选好的几个。 */
  onPick: (picked: number[]) => void | Promise<unknown>;
  /** 最后一项：点了就地展开输入。不给就没有这一项。 */
  other?: { label?: string; placeholder?: string; onSubmit: (text: string) => void | Promise<unknown> };
  multi?: boolean;
  /** 几件一起来：第几件（从 0 起）、共几件、翻到哪件。 */
  pager?: { index: number; total: number; onGo: (index: number) => void };
  /** 页头右边的动作（全部批准）。 */
  aside?: ReactNode;
  /** 已经答了：收成一行写答的是什么。 */
  resolved?: ReactNode;
  /** 这里不能答：写去哪儿答。 */
  blocked?: string | null;
  busy?: boolean;
  /** 选项下面的一行小件（开工时的文件夹、本机的位置）。 */
  footer?: ReactNode;
  /** 要碰允许的文件夹以外的路径：框标红（ADR 0031）。 */
  outside?: boolean;
  /** 出现时把焦点放到推荐的那个上（回车就是采纳）。越界的批准不放：一下回车不该放行。 */
  autoFocus?: boolean;
  testId?: string;
}) {
  const recommended = Math.max(0, options.findIndex((option) => option.recommended));
  const [selected, setSelected] = useState(recommended);
  const [picks, setPicks] = useState<number[]>([]);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const otherIndex = other ? options.length : -1;
  const total = options.length + (other ? 1 : 0);
  const disabled = !!blocked || !!busy || sending;
  const live = !resolved && !blocked;
  usePendingBox(live ? rootRef : null, kind);

  // 换页（翻到另一件）时回到推荐的那个、收起输入。
  const pageKey = pager ? pager.index : 0;
  useEffect(() => { setSelected(recommended); setPicks([]); setWriting(false); setText(""); }, [pageKey, recommended]);
  // 新出来的框：本人没在别处打字时，焦点放到推荐的那个上，回车就是采纳。
  useEffect(() => {
    if (!live || !autoFocus) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && (active.isContentEditable || active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) && !rootRef.current?.contains(active)) return;
    optionRefs.current[recommended]?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在出现、翻页时定焦点
  }, [live, pageKey]);

  const run = async (action: () => void | Promise<unknown>) => {
    setSending(true);
    try { await action(); } finally { setSending(false); }
  };
  const choose = (index: number) => {
    if (disabled) return;
    if (index === otherIndex) { setSelected(index); setWriting(true); requestAnimationFrame(() => textRef.current?.focus()); return; }
    if (multi) { setSelected(index); setPicks((current) => (current.includes(index) ? current.filter((entry) => entry !== index) : [...current, index])); return; }
    void run(() => onPick([index]));
  };
  const sendText = () => {
    const value = text.trim();
    if (!value || disabled || !other) return;
    void run(() => other.onSubmit(value));
  };
  const move = (to: number) => {
    const next = (to + total) % total;
    setSelected(next);
    optionRefs.current[next]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey || !live) return;
    const target = event.target as HTMLElement;
    if (target === textRef.current) {
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendText(); }
      else if (event.key === "Escape") { event.preventDefault(); setWriting(false); optionRefs.current[otherIndex]?.focus(); }
      return;
    }
    // 只在框本身和选项上接键；框里的输入框、下拉、翻页、全部批准照它们自己的来。
    if (target !== rootRef.current && !optionRefs.current.includes(target as HTMLButtonElement)) return;
    const digit = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
    if (digit >= 0 && digit < total) {
      event.preventDefault();
      if (digit === otherIndex || multi) choose(digit);
      else { setSelected(digit); optionRefs.current[digit]?.focus(); }
      return;
    }
    if (event.key === "ArrowDown") { event.preventDefault(); move(selected + 1); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); move(selected - 1); return; }
    if (event.key === "Enter") {
      event.preventDefault();
      if (multi && selected !== otherIndex) { if (picks.length) void run(() => onPick(picks)); else choose(selected); }
      else choose(selected);
      return;
    }
    if (pager && event.key === "ArrowLeft" && pager.index > 0) { event.preventDefault(); pager.onGo(pager.index - 1); }
    if (pager && event.key === "ArrowRight" && pager.index < pager.total - 1) { event.preventDefault(); pager.onGo(pager.index + 1); }
  };

  if (resolved) {
    return (
      <div className={x.resolved} data-testid={testId} data-resolved="">
        <Check {...ICON} aria-hidden /><span className={x.rTitle}>{title}</span><span className={x.rAnswer}>{resolved}</span>
      </div>
    );
  }
  return (
    <div ref={rootRef} className={x.box} data-kind={kind} data-blocked={blocked ? "" : undefined} data-outside={outside ? "" : undefined} data-testid={testId} data-decision="" role="group" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className={x.head}>
        <div id={titleId} className={x.title}>{title}</div>
        {pager && pager.total > 1 ? (
          <span className={x.pager}>
            <button type="button" aria-label="上一件" disabled={pager.index === 0} onClick={() => pager.onGo(pager.index - 1)}><ChevronLeft {...ICON} aria-hidden /></button>
            <span>{pager.index + 1}/{pager.total}</span>
            <button type="button" aria-label="下一件" disabled={pager.index >= pager.total - 1} onClick={() => pager.onGo(pager.index + 1)}><ChevronRight {...ICON} aria-hidden /></button>
          </span>
        ) : null}
        {aside}
      </div>
      {body ? <div className={x.body}>{body}</div> : null}
      {blocked ? <p className={x.blocked}>{blocked}</p> : <>
      <div className={x.options} role={multi ? "group" : "radiogroup"} aria-labelledby={titleId}>
        {options.map((option, index) => {
          const checked = multi ? picks.includes(index) : selected === index;
          return (
            <button key={`${index}:${option.label}`} ref={(element) => { optionRefs.current[index] = element; }} type="button" className={x.option}
              role={multi ? "checkbox" : "radio"} aria-checked={checked} data-selected={selected === index ? "" : undefined} aria-keyshortcuts={String(index + 1)}
              tabIndex={selected === index ? 0 : -1} disabled={disabled} onFocus={() => setSelected(index)} onMouseEnter={() => setSelected(index)} onClick={() => choose(index)} data-testid="decision-option">
              <kbd className={x.key} aria-hidden>{index + 1}</kbd>
              <span className={x.label}><span>{option.label}</span>{option.detail ? <small>{option.detail}</small> : null}</span>
              <span className={x.trail}>
                {option.recommended ? <span className={x.rec}>推荐</span> : null}
                {multi && checked ? <Check {...ICON} aria-hidden /> : null}
              </span>
            </button>
          );
        })}
        {other ? (
          <>
            <button ref={(element) => { optionRefs.current[otherIndex] = element; }} type="button" className={x.option} data-other="" role={multi ? "checkbox" : "radio"}
              aria-checked={writing} data-selected={selected === otherIndex ? "" : undefined} aria-keyshortcuts={String(otherIndex + 1)} tabIndex={selected === otherIndex ? 0 : -1}
              disabled={disabled} aria-expanded={writing} onFocus={() => setSelected(otherIndex)} onMouseEnter={() => setSelected(otherIndex)} onClick={() => choose(otherIndex)} data-testid="decision-other">
              <kbd className={x.key} aria-hidden>{otherIndex + 1}</kbd>
              <span className={x.label}><span>{other.label ?? "自己说…"}</span></span>
              <span className={x.trail} />
            </button>
            {writing ? (
              <div className={x.write}>
                <textarea ref={textRef} rows={2} maxLength={4000} value={text} placeholder={other.placeholder} aria-label={other.label ?? "自己说"} disabled={disabled}
                  onChange={(event) => setText(event.target.value)} />
                <button type="button" className={x.send} aria-label="发送" disabled={disabled || !text.trim()} onClick={sendText}><CornerDownLeft {...ICON} aria-hidden /></button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      {multi ? (
        <div className={x.foot}><span className={x.grow} />
          <button type="button" className={x.confirm} disabled={disabled || !picks.length} onClick={() => void run(() => onPick(picks))}>确定</button>
        </div>
      ) : null}
      {footer ? <div className={x.foot}>{footer}</div> : null}
      </>}
    </div>
  );
}

/* ---------- 「1 个问题等你 ↑」：还没答的框滚出屏幕时，输入条上方的一条 ---------- */

type Entry = { element: HTMLElement; kind: DecisionKind };
type Registry = { add: (entry: Entry) => () => void; subscribe: (listener: () => void) => () => void; read: () => Entry[] };

function createRegistry(): Registry {
  let entries: Entry[] = [];
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    add: (entry) => { entries = [...entries, entry]; emit(); return () => { entries = entries.filter((item) => item !== entry); emit(); }; },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    read: () => entries,
  };
}

const PendingContext = createContext<Registry | null>(null);

/** 一条对话一份：里面的选项框登记进来，PendingChip 读。 */
export function PendingBoxes({ children }: { children: ReactNode }) {
  const [registry] = useState(createRegistry);
  return <PendingContext.Provider value={registry}>{children}</PendingContext.Provider>;
}

function usePendingBox(ref: React.RefObject<HTMLDivElement | null> | null, kind: DecisionKind) {
  const registry = useContext(PendingContext);
  useEffect(() => {
    const element = ref?.current;
    if (!registry || !element) return;
    return registry.add({ element, kind });
  }, [registry, ref, kind]);
}

const EMPTY: Entry[] = [];
/** 设计第 4.3 条的原话：「1 个问题等你 ↑」，批准、开工也算一个。 */
const chipText = (hidden: Entry[]) => `${hidden.length} 个问题等你`;

/** 输入条上方的细条：有没答的框不在眼前时出现，点了滚过去、焦点放上去。 */
export function PendingChip() {
  const registry = useContext(PendingContext);
  const entries = useSyncExternalStore(registry?.subscribe ?? (() => () => undefined), registry?.read ?? (() => EMPTY), () => EMPTY);
  const [visible, setVisible] = useState<Set<HTMLElement>>(() => new Set());
  useEffect(() => {
    if (!entries.length) return;
    const observer = new IntersectionObserver((records) => {
      setVisible((current) => {
        const next = new Set(current);
        for (const record of records) { if (record.isIntersecting) next.add(record.target as HTMLElement); else next.delete(record.target as HTMLElement); }
        return next;
      });
    }, { threshold: 0.35 });
    entries.forEach((entry) => observer.observe(entry.element));
    return () => observer.disconnect();
  }, [entries]);
  const hidden = useMemo(() => entries.filter((entry) => !visible.has(entry.element)), [entries, visible]);
  const jump = useCallback(() => {
    const target = hidden[hidden.length - 1]?.element;
    if (!target) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    (target.querySelector<HTMLElement>("[data-selected]") ?? target).focus({ preventScroll: true });
  }, [hidden]);
  if (!hidden.length) return null;
  return (
    <button type="button" className={x.chip} onClick={jump} data-testid="pending-chip">
      {chipText(hidden)}<ArrowUp {...ICON} aria-hidden />
    </button>
  );
}
