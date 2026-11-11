"use client";

/**
 * 选项框（新首页设计 5.4.3「选项框」）：放在对话里问的那一处，一个组件管三件事——提问、批准、开工。
 * - 框和正文一样宽，--surface 底、1px 发丝边、--r-card 圆角，没有阴影；头部是问题（14/20 600，只写一句），几件一起来时右侧「1/3」和翻页。
 * - 选项行：左边序号（手持上不显示）、选项文字，推荐的那个后面接淡色的「（推荐）」，说明 13/20 一行；最后一行本身就是「自己说…」输入框，
 *   回车发出、Shift+回车换行，有字时行尾出发送箭头，字多往下长到约 5 行再滚动。
 * - 键盘：1–9 和 ↑↓ 只移高亮，移到最后一行时光标进输入框；回车才提交高亮的那个；批准框里回车永远不会是「同类以后都批准」（noEnter 的选项回车提交推荐的那个）；
 *   输入框里 Esc、或光标在最前面按 ↑，回到上一行，打的字留着；←→ 翻页。键盘和鼠标共用一个高亮，任何时候只亮一行。
 * - 焦点和误触保护：出现时焦点落在推荐的那个上（正在别处打字时不抢）；出现后 220ms 内不接按键和点击；输入法组字时回车不提交。
 * - 提交中：选中的那行出转圈，其余行变淡。答完收成一行：勾 · 问题 · 答案；失效收成「已失效」。
 * - 这里答不了时（手机上、问题在别的电脑上）不画选项，只留问题和状态 chip「等你 · …」。
 * 还没答的框登记到 PendingBoxes：框滚出屏幕时，输入框上方出「1 个问题等你 ↑」（PendingDock，和「回到最新」同一个位置），点了跳回最早的那个。
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, LoaderCircle } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { CloudError } from "@/lib/board/cloud";
import x from "@/styles/decision-box.module.css";

/** noEnter：回车不提交这一项（批准框的「同类以后都批准」），回车提交推荐的那个。 */
export type DecisionOption = { label: string; detail?: ReactNode; recommended?: boolean; noEnter?: boolean };
export type DecisionKind = "question" | "approval" | "plan";

const ICON = { size: 16, strokeWidth: 1.8 } as const;

/** 「自己说」那一行里按的键：回车发出（Shift+回车照常换行）；Esc、或光标在最前面按 ↑，回到上一行选项（打的字留着）。 */
export function otherKey(event: { key: string; shiftKey: boolean }, box: { selectionStart: number | null; selectionEnd: number | null }): "send" | "up" | null {
  if (event.key === "Enter") return event.shiftKey ? null : "send";
  if (event.key === "Escape" || (event.key === "ArrowUp" && box.selectionStart === 0 && box.selectionEnd === 0)) return "up";
  return null;
}
/** 出现后这么久不接按键和点击（--dur-base），免得正在打字的回车误按。 */
const ARM_MS = 220;

export function DecisionBox({ kind, title, body, options, onPick, onTicks, initialPicks, other, multi, pager, aside, resolved, expired, blocked, busy, footer, outside, autoFocus = true, testId }: {
  kind: DecisionKind;
  /** 头部：问的是什么，只写一句。 */
  title: ReactNode;
  /** 问题下面的内容：命令或路径块、计划的几步。 */
  body?: ReactNode;
  options: DecisionOption[];
  /** 选了第几个（单选点了就提交）。多选时是勾中的几个。note：提问时「自己说」里打了字又去点别的选项，打的字一起发出去。 */
  onPick: (picked: number[], note?: string) => void | Promise<unknown>;
  /**
   * 多选、而且框外已经有一个管整件的「提交」（几个问题一起发）时：勾一下就报一次勾中的几个，框里不再画自己的「提交」，
   * 免得一个框里两个意思不同的「提交」。initialPicks：翻回这一页时已经勾过的。
   */
  onTicks?: (picked: number[]) => void;
  initialPicks?: number[];
  /**
   * 最后一项：这一行本身就是输入框（占位「{label}…」，读屏念 label）。不给就没有这一项。maxLength 和接这句话的接口上限一致，超了发不出去。
   * initial：预填的字（出现时光标就在这一行的末尾）；focus：没预填也让光标先进这一行；accept：这段字能不能发（不给时有字就能发）。
   */
  other?: { label?: string; maxLength?: number; initial?: string; accept?: (text: string) => boolean; focus?: boolean; onSubmit: (text: string) => void | Promise<unknown> };
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
  const initial = other?.initial ?? "";
  const [text, setText] = useState(initial);
  const canSend = (value: string) => !!value.trim() && (other?.accept ? other.accept(value) : true);
  const [sending, setSending] = useState<number | null>(null);
  /** 答案没发出去：框底下一行「失败 · 重试」（重试 = 同一个动作再来一次），title 里是原因。 */
  const [failed, setFailed] = useState<Failure | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const shownAt = useRef(0);
  const titleId = useId();
  const otherIndex = other ? options.length : -1;
  /** 最后一行的名字：读屏念它，占位字是它加「…」。 */
  const otherName = (other?.label ?? "自己说").replace(/…$/, "");
  const total = options.length + (other ? 1 : 0);
  const disabled = !!blocked || !!busy || sending !== null;
  const live = !resolved && !expired && !blocked;
  usePendingBox(live ? rootRef : null, kind);
  const startPicks = useRef(initialPicks);
  startPicks.current = initialPicks;

  // 换页（翻到另一件）时回到推荐的那个、收起输入；勾过的照框外记着的。
  const pageKey = pager ? pager.index : 0;
  const startText = useRef(initial);
  startText.current = initial;
  useEffect(() => { setSelected(recommended); setPicks(startPicks.current ?? []); setText(startText.current); }, [pageKey, recommended]);
  // 出现、翻页时：记下出现的时刻（220ms 内不接按键和点击）；本人没在别处打字时，焦点放到推荐的那个上。
  useEffect(() => {
    if (!live) return;
    shownAt.current = performance.now();
    if (!autoFocus || outside) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && (active.isContentEditable || active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) && !rootRef.current?.contains(active)) return;
    // 预填了字的：光标放到那一行的末尾，接着写。
    const field = textRef.current;
    if ((startText.current || other?.focus) && field) { setSelected(otherIndex); field.focus({ preventScroll: true }); field.setSelectionRange(field.value.length, field.value.length); return; }
    optionRefs.current[recommended]?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在出现、翻页时定焦点
  }, [live, pageKey]);
  const arming = () => performance.now() - shownAt.current < ARM_MS;

  const run = async (index: number, action: () => void | Promise<unknown>) => {
    setSending(index);
    setFailed(null);
    try { await action(); }
    catch (error) { setFailed(failureOf(error, () => void run(index, action))); }
    finally { setSending(null); }
  };
  const choose = (index: number) => {
    if (disabled || arming()) return;
    if (index === otherIndex) { setSelected(index); textRef.current?.focus(); return; }
    if (multi) {
      setSelected(index);
      const next = picks.includes(index) ? picks.filter((entry) => entry !== index) : [...picks, index];
      setPicks(next);
      onTicks?.(next);
      return;
    }
    void run(index, () => onPick([index], note()));
  };
  /** 提问时「自己说」里打了字又去点选项（多选是点「提交」）：打的字一起发出去。 */
  const note = () => (kind === "question" && text.trim() ? text.trim() : undefined);
  // 发出去了：清掉字（框还留着时，再按回车不会把同一句又发一遍）。
  const sendText = () => {
    const value = text.trim();
    if (!canSend(text) || disabled || !other || arming()) return;
    void run(otherIndex, async () => { await other.onSubmit(value); setText(""); });
  };
  const move = (to: number) => {
    const next = (to + total) % total;
    setSelected(next);
    (next === otherIndex ? textRef.current : optionRefs.current[next])?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey || !live) return;
    const target = event.target as HTMLElement;
    if (target === textRef.current) {
      const action = otherKey(event, textRef.current);
      if (action) event.preventDefault();
      if (action === "send") sendText();
      else if (action === "up") move(otherIndex - 1);
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
          // 最后一行本身就是输入框：同样的序号、行高和左边距；点这一行或按它的数字，光标直接进来；有字时行尾才出发送箭头。
          <div className={x.option} data-other="" data-selected={selected === otherIndex ? "" : undefined} data-sending={sending === otherIndex ? "" : undefined}
            onMouseEnter={() => setSelected(otherIndex)} onClick={() => textRef.current?.focus()} data-testid="decision-other">
            <kbd className={x.key} aria-hidden>{otherIndex + 1}</kbd>
            <textarea ref={textRef} className={x.otherInput} rows={1} maxLength={other.maxLength ?? 4000} value={text} placeholder={`${otherName}…`} aria-label={otherName}
              aria-keyshortcuts={String(otherIndex + 1)} tabIndex={selected === otherIndex ? 0 : -1} disabled={disabled}
              onFocus={() => setSelected(otherIndex)} onChange={(event) => setText(event.target.value)} data-testid="decision-other-input" />
            <span className={x.trail}>
              {sending === otherIndex ? <LoaderCircle {...ICON} className={x.spin} aria-hidden />
                : canSend(text) ? <button type="button" className={x.otherSend} aria-label="发送" title="发送" disabled={disabled} onClick={(event) => { event.stopPropagation(); sendText(); }}><ArrowUp size={14} strokeWidth={2.2} aria-hidden /></button> : null}
            </span>
          </div>
        ) : null}
      </div>
      {multi && !onTicks ? (
        <div className={x.foot}><span className={x.grow} />
          <HeroButton variant="primary" size="sm" isDisabled={disabled || !picks.length} onPress={() => void run(picks[0] ?? 0, () => onPick(picks, note()))}>提交</HeroButton>
        </div>
      ) : null}
      {failed && sending === null ? <FailedLine {...failed} /> : null}
      {footer ? <div className={x.foot}>{footer}</div> : null}
      </>}
    </div>
  );
}

/** 动作失败（5.4.1 交互状态表）：原处一行「失败」加「重试」（弱按钮）；原因放在 title 里。 */
export function FailedLine({ reason, note, onRetry, inline }: { reason?: string; note?: string | null; onRetry: () => void; inline?: boolean }) {
  return (
    <span className={inline ? x.failInline : x.failLine} data-testid="action-failed">
      {note ? <span className={x.failNote}>{note}</span> : <>
        <span className={x.failed} title={reason || undefined}>失败</span>
        <HeroButton variant="ghost" size="sm" onPress={onRetry}>重试</HeroButton>
      </>}
    </span>
  );
}

/**
 * 一次没成的动作：原因（title 里）、重试（同一个动作再来一次）。
 * note：现在重试也没用、要等别的事的，写一句现状、不给「重试」——推翻时合回结果还没报上来（409 MERGE_PENDING，云端的话原样写），
 * 登记「再改一轮」「我来补」时已经登记过、这次交回已经处理过、卡还没开过工（见 SETTLED）。
 */
export type Failure = { onRetry: () => void; reason: string; note: string | null };
export function failureOf(error: unknown, onRetry: () => void): Failure {
  const reason = error instanceof Error ? error.message : "";
  const code = error instanceof CloudError ? error.code : undefined;
  return { onRetry, reason, note: code === "MERGE_PENDING" ? reason : (code && SETTLED[code]) || null };
}
/** 登记「再改一轮」「我来补」时云端回的 409（主循环第 62 条）：重试也没用，原处写一句现状。 */
const SETTLED: Record<string, string> = { RELAY_PENDING: "已登记，等电脑在线", NOTHING_TO_RELAY: "这次交回已经处理过了", NOT_STARTED: "这张卡还没开过工" };

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
export function PendingDock({ latest, above }: { latest: { visible: boolean; jump: () => void }; /** 放在输入框那一块里（子会话）：贴着它的上沿往上 12。 */ above?: boolean }) {
  const { count, jump } = useHiddenPending();
  const anchor = above ? "above" : undefined;
  if (count) {
    return (
      <button type="button" className={x.chip} data-anchor={anchor} onClick={jump} data-testid="pending-chip">
        <i className={x.chipDot} aria-hidden />{count} 个问题等你<ArrowUp {...ICON} aria-hidden />
      </button>
    );
  }
  if (!latest.visible) return null;
  return (
    <button type="button" className={x.chip} data-anchor={anchor} onClick={latest.jump} data-testid="jump-latest">
      回到最新<ArrowDown {...ICON} aria-hidden />
    </button>
  );
}
