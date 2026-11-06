"use client";

/**
 * 选项框（新首页设计 5.4.3「选项框」）：放在对话里问的那一处，一个组件管三件事——提问、批准、开工。
 * - 框和正文一样宽，--surface 底、1px 发丝边、--r-card 圆角，没有阴影；头部是问题（14/20 600，只写一句），几件一起来时右侧「1/3」和翻页。
 * - 选项行：左边序号（手持上不显示）、选项文字，推荐的那个后面接淡色的「（推荐）」，说明 13/20 一行；最后一行「自己说…」点了在原地展开输入框。
 * - 键盘：1–9 和 ↑↓ 只移高亮，回车才提交高亮的那个；批准框里回车永远不会是「同类以后都批准」（noEnter 的选项回车提交推荐的那个）；
 *   Esc 收起「自己说」，打的字留着；←→ 翻页。键盘和鼠标共用一个高亮，任何时候只亮一行。
 * - 焦点和误触保护：出现时焦点落在推荐的那个上（正在别处打字时不抢）；出现后 220ms 内不接按键和点击；输入法组字时回车不提交。
 * - 提交中：选中的那行出转圈，其余行变淡。答完收成一行：勾 · 问题 · 答案；失效收成「已失效」。
 * - 这里答不了时（手机上、问题在别的电脑上）不画选项，只留问题和状态 chip「等你 · …」。
 * 还没答的框登记到 PendingBoxes：框滚出屏幕时，输入框上方出「1 个问题等你 ↑」（PendingDock，和「回到最新」同一个位置），点了跳回最早的那个。
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import x from "@/styles/decision-box.module.css";

/** noEnter：回车不提交这一项（批准框的「同类以后都批准」），回车提交推荐的那个。 */
export type DecisionOption = { label: string; detail?: ReactNode; recommended?: boolean; noEnter?: boolean };
export type DecisionKind = "question" | "approval" | "plan";

const ICON = { size: 16, strokeWidth: 1.8 } as const;
/** 出现后这么久不接按键和点击（--dur-base），免得正在打字的回车误按。 */
const ARM_MS = 220;

export function DecisionBox({ kind, title, body, options, onPick, other, multi, pager, aside, resolved, expired, blocked, busy, footer, outside, autoFocus = true, testId }: {
  kind: DecisionKind;
  /** 头部：问的是什么，只写一句。 */
  title: ReactNode;
  /** 问题下面的内容：命令或路径块、计划的几步。 */
  body?: ReactNode;
  options: DecisionOption[];
  /** 选了第几个（单选点了就提交）。多选时是勾中的几个。note：提问时「自己说」里打了字又去点别的选项，打的字一起发出去。 */
  onPick: (picked: number[], note?: string) => void | Promise<unknown>;
  /** 最后一项：点了就地展开输入。不给就没有这一项。 */
  other?: { label?: string; placeholder?: string; onSubmit: (text: string) => void | Promise<unknown> };
  multi?: boolean;
  /** 几件一起来：第几件（从 0 起）、共几件、翻到哪件。 */
  pager?: { index: number; total: number; onGo: (index: number) => void };
  /** 头部右侧的小件：「对外」「工作区外」chip、「全部批准」。 */
  aside?: ReactNode;
  /** 已经答了：收成一行写答的是什么。 */
  resolved?: ReactNode;
  /** 失效了（过期、被新的取代、在别的设备上答了、子会话停了）：收成一行「已失效」。 */
  expired?: boolean;
  /** 这里答不了：状态 chip 的字（例如「等你 · 公司电脑」）。 */
  blocked?: string | null;
  busy?: boolean;
  /** 选项下面的一行（开工时的文件夹和本机的位置、多题时的「提交」）。 */
  footer?: ReactNode;
  /** 碰到允许的文件夹以外的路径（ADR 0031）：不预先放焦点。路径由调用方在正文里标红，框本身不描红。 */
  outside?: boolean;
  /** 出现时把焦点放到推荐的那个上。 */
  autoFocus?: boolean;
  testId?: string;
}) {
  const recommended = Math.max(0, options.findIndex((option) => option.recommended));
  const [selected, setSelected] = useState(recommended);
  const [picks, setPicks] = useState<number[]>([]);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const shownAt = useRef(0);
  const titleId = useId();
  const otherIndex = other ? options.length : -1;
  const total = options.length + (other ? 1 : 0);
  const disabled = !!blocked || !!busy || sending !== null;
  const live = !resolved && !expired && !blocked;
  usePendingBox(live ? rootRef : null, kind);

  // 换页（翻到另一件）时回到推荐的那个、收起输入。
  const pageKey = pager ? pager.index : 0;
  useEffect(() => { setSelected(recommended); setPicks([]); setWriting(false); setText(""); }, [pageKey, recommended]);
  // 出现、翻页时：记下出现的时刻（220ms 内不接按键和点击）；本人没在别处打字时，焦点放到推荐的那个上。
  useEffect(() => {
    if (!live) return;
    shownAt.current = performance.now();
    if (!autoFocus || outside) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && (active.isContentEditable || active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) && !rootRef.current?.contains(active)) return;
    optionRefs.current[recommended]?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在出现、翻页时定焦点
  }, [live, pageKey]);
  const arming = () => performance.now() - shownAt.current < ARM_MS;

  const run = async (index: number, action: () => void | Promise<unknown>) => {
    setSending(index);
    try { await action(); } finally { setSending(null); }
  };
  const choose = (index: number) => {
    if (disabled || arming()) return;
    if (index === otherIndex) { setSelected(index); setWriting(true); requestAnimationFrame(() => textRef.current?.focus()); return; }
    if (multi) { setSelected(index); setPicks((current) => (current.includes(index) ? current.filter((entry) => entry !== index) : [...current, index])); return; }
    const note = kind === "question" && writing && text.trim() ? text.trim() : undefined;
    void run(index, () => onPick([index], note));
  };
  const sendText = () => {
    const value = text.trim();
    if (!value || disabled || !other || arming()) return;
    void run(otherIndex, () => other.onSubmit(value));
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
    if (digit >= 0 && digit < total) { event.preventDefault(); move(digit); return; }
    if (event.key === "ArrowDown") { event.preventDefault(); move(selected + 1); return; }
    if (event.key === "ArrowUp") { event.preventDefault(); move(selected - 1); return; }
    if (event.key === "Enter") {
      event.preventDefault();
      if (arming()) return;
      if (multi && selected !== otherIndex) { choose(selected); return; }
      choose(options[selected]?.noEnter ? recommended : selected);
      return;
    }
    if (pager && event.key === "ArrowLeft" && pager.index > 0) { event.preventDefault(); pager.onGo(pager.index - 1); }
    if (pager && event.key === "ArrowRight" && pager.index < pager.total - 1) { event.preventDefault(); pager.onGo(pager.index + 1); }
  };

  if (resolved || expired) {
    return (
      <div className={x.resolved} data-testid={testId} data-resolved="">
        {expired ? <span className={x.rTitle}>已失效</span> : <>
          <Check {...ICON} aria-hidden /><span className={x.rTitle}>{title}</span><span className={x.rAnswer}>{resolved}</span>
        </>}
      </div>
    );
  }
  return (
    <div ref={rootRef} className={x.box} data-kind={kind} data-blocked={blocked ? "" : undefined} data-sending={sending !== null ? "" : undefined} data-testid={testId} data-decision="" role="group" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className={x.head}>
        <div id={titleId} className={x.title}>{title}</div>
        {blocked ? <span className={x.waitChip}><i aria-hidden />{blocked}</span> : null}
        {pager && pager.total > 1 ? (
          <span className={x.pager}>
            <span>{pager.index + 1}/{pager.total}</span>
            <HeroButton variant="ghost" size="sm" isIconOnly aria-label="上一页" isDisabled={pager.index === 0} onPress={() => pager.onGo(pager.index - 1)}><ChevronLeft {...ICON} aria-hidden /></HeroButton>
            <HeroButton variant="ghost" size="sm" isIconOnly aria-label="下一页" isDisabled={pager.index >= pager.total - 1} onPress={() => pager.onGo(pager.index + 1)}><ChevronRight {...ICON} aria-hidden /></HeroButton>
          </span>
        ) : null}
        {aside}
      </div>
      {body ? <div className={x.body}>{body}</div> : null}
      {blocked ? null : <>
      <div className={x.options} role={multi ? "group" : "radiogroup"} aria-labelledby={titleId}>
        {options.map((option, index) => {
          const checked = multi ? picks.includes(index) : selected === index;
          return (
            <button key={`${index}:${option.label}`} ref={(element) => { optionRefs.current[index] = element; }} type="button" className={x.option}
              role={multi ? "checkbox" : "radio"} aria-checked={checked} data-selected={selected === index ? "" : undefined} data-picked={multi && checked ? "" : undefined}
              data-sending={sending === index ? "" : undefined} aria-keyshortcuts={String(index + 1)}
              tabIndex={selected === index ? 0 : -1} disabled={disabled} onFocus={() => setSelected(index)} onMouseEnter={() => setSelected(index)} onClick={() => choose(index)} data-testid="decision-option">
              <kbd className={x.key} aria-hidden>{index + 1}</kbd>
              <span className={x.label}>
                <span>{option.label}{option.recommended ? <span className={x.rec}>（推荐）</span> : null}</span>
                {option.detail ? <small>{option.detail}</small> : null}
              </span>
              <span className={x.trail}>
                {sending === index ? <LoaderCircle {...ICON} className={x.spin} aria-hidden /> : multi && checked ? <Check {...ICON} aria-hidden /> : null}
              </span>
            </button>
          );
        })}
        {other ? (
          <>
            <button ref={(element) => { optionRefs.current[otherIndex] = element; }} type="button" className={x.option} data-other="" role={multi ? "checkbox" : "radio"}
              aria-checked={writing} data-selected={selected === otherIndex ? "" : undefined} data-sending={sending === otherIndex ? "" : undefined} aria-keyshortcuts={String(otherIndex + 1)} tabIndex={selected === otherIndex ? 0 : -1}
              disabled={disabled} aria-expanded={writing} onFocus={() => setSelected(otherIndex)} onMouseEnter={() => setSelected(otherIndex)} onClick={() => choose(otherIndex)} data-testid="decision-other">
              <kbd className={x.key} aria-hidden>{otherIndex + 1}</kbd>
              <span className={x.label}><span>{other.label ?? "自己说…"}</span></span>
              <span className={x.trail}>{sending === otherIndex ? <LoaderCircle {...ICON} className={x.spin} aria-hidden /> : null}</span>
            </button>
            {writing ? (
              <div className={x.write}>
                <textarea ref={textRef} rows={2} maxLength={4000} value={text} placeholder={other.placeholder} aria-label={other.label ?? "自己说"} disabled={disabled}
                  onChange={(event) => setText(event.target.value)} />
                <HeroButton variant="primary" size="sm" isIconOnly aria-label="发送" title="发送" isDisabled={disabled || !text.trim()} onPress={sendText}><ArrowUp {...ICON} aria-hidden /></HeroButton>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      {multi ? (
        <div className={x.foot}><span className={x.grow} />
          <HeroButton variant="primary" size="sm" isDisabled={disabled || !picks.length} onPress={() => void run(picks[0] ?? 0, () => onPick(picks))}>提交</HeroButton>
        </div>
      ) : null}
      {footer ? <div className={x.foot}>{footer}</div> : null}
      </>}
    </div>
  );
}

/** 头部右侧的状态 chip（5.4.3）：「对外」「工作区外」是警告档。 */
export function DecisionTag({ children }: { children: ReactNode }) {
  return <span className={x.tag}>{children}</span>;
}

/* ---------- 「1 个问题等你 ↑」：还没答的框滚出屏幕时，输入框上方的一条 ---------- */

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

/** 一条对话一份：里面的选项框登记进来，PendingDock 读。 */
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

/** 有几个没答的选项框不在眼前（批准、开工也算一个）。和「回到最新」共用一个位置（PendingDock），有问题时问题优先。 */
export function useHiddenPending(): { count: number; jump: () => void } {
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
  // 跳到最早的那个，焦点落在它推荐的选项上。
  const jump = useCallback(() => {
    const target = [...hidden].sort((a, b) => (a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))[0]?.element;
    if (!target) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    (target.querySelector<HTMLElement>("[data-selected]") ?? target).focus({ preventScroll: true });
  }, [hidden]);
  return { count: hidden.length, jump };
}

/**
 * 输入框上方居中的那一条（5.4.3「问题提示条和『回到最新』」）：有没答的选项框滚出了可视区，出「1 个问题等你 ↑」（优先）；
 * 否则没到底时，出「回到最新 ↓」（没有圆点）。两样东西抢同一个位置，所以并成一个。
 */
export function PendingDock({ latest }: { latest: { visible: boolean; jump: () => void } }) {
  const { count, jump } = useHiddenPending();
  if (count) {
    return (
      <button type="button" className={x.chip} onClick={jump} data-testid="pending-chip">
        <i className={x.chipDot} aria-hidden />{count} 个问题等你<ArrowUp {...ICON} aria-hidden />
      </button>
    );
  }
  if (!latest.visible) return null;
  return (
    <button type="button" className={x.chip} onClick={latest.jump} data-testid="jump-latest">
      回到最新<ArrowDown {...ICON} aria-hidden />
    </button>
  );
}
