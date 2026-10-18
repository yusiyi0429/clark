"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type CSSProperties, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { BarChart3, CalendarRange, GanttChart, Maximize2, Shapes, X } from "lucide-react";
import { prefersReducedMotion } from "@/lib/motion";
import { DESK_SHIFT_MS } from "../desk/deskLayout";
import { afterResize, resizing } from "../resizeGate";
import {
  formatDate, formatNumber, isLargeBlock, isRichLanguage, metricReading, parseRichBlock, referenceYear, richFallbackList, richSummary, richTitle,
  skeletonTitle, timelineLayout, timelinePhase, timelineProgress, type MetricCompareBlock, type RichBlock, type RichLanguage, type TimelineBlock,
  type TimelineLayout,
} from "./parse";
import { expandRoute, useRichStreamOpen, useRichSurface } from "./surface";
import { Roadmap } from "./Roadmap";
import { Visual, VisualFallback } from "./Visual";
import { VISUAL_SHEET_MIN_SCALE } from "./visualSandbox";
import { IssueSuggestCard, parseIssueSuggest } from "../IssueSuggestCard";
import "katex/dist/katex.min.css";
import r from "@/styles/rich-blocks.module.css";

/**
 * 对话里的富内容块（docs/superpowers/specs/2026-10-10-discussion-desk-design.md「对话里的富内容块」）：
 * react-markdown 的 `pre` 换成 RichPre——```metric-compare / ```timeline 画成自己的组件，其他代码块照旧。
 * - 流式中没收全（JSON 还读不出）：骨架（标题 + 「正在生成…」）；流式结束仍读不出、字段不合法：退回原文代码块，不报错；
 * - 收起态（右列约 420、首页对话层）大块只显示缩略卡「内容较多 · 展开查看」：能放大（≥1280）就放大并滚到这一块，
 *   不能放大（手机、窄屏）从底部升起全屏 sheet；
 * - 放大时（深度讨论 / 对话层放大）完整铺开。
 * 显示规范见 parse.ts 开头（宽度与正文栏同宽；先压缩、再换行，实在放不下才横向滚动并给提示）。
 */

type HastNode = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

/** hast 节点里的全部文字（到达淡入会把代码切成几段 span，这里拼回原文）。 */
export function hastText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

/** 代码块的语言：`<code class="language-timeline">` → timeline。 */
export function codeLanguage(code: HastNode | undefined): string | null {
  const names = code?.properties?.className;
  const list = Array.isArray(names) ? names : typeof names === "string" ? names.split(/\s+/) : [];
  const hit = list.find((name): name is string => typeof name === "string" && name.startsWith("language-"));
  return hit ? hit.slice("language-".length) : null;
}

type PreProps = ComponentPropsWithoutRef<"pre"> & { node?: HastNode };

/** react-markdown 的 `pre`：富内容块交给 RichCode，其他代码块原样。 */
export function RichPre({ node, children, ...rest }: PreProps) {
  const code = node?.children?.find((child) => child.type === "element" && child.tagName === "code");
  const language = codeLanguage(code);
  const plain = <pre {...rest}>{children}</pre>;
  if (language === "issue-suggest") return <IssueSuggestBlock source={hastText(code).trim()} />;
  if (!isRichLanguage(language)) return plain;
  return <RichCode language={language} source={hastText(code).trim()} fallback={plain} />;
}

function RichCode({ language, source, fallback }: { language: RichLanguage; source: string; fallback: ReactNode }) {
  const open = useRichStreamOpen();
  // 图示不是 JSON，半截也可能「读得通」：所在的那一块还在流式中就一直画骨架，整块到齐才解析、渲染。
  const block = useMemo(() => (open && language === "visual" ? null : parseRichBlock(language, source)), [open, language, source]);
  if (block) return <RichBlockView block={block} />;
  if (open) return <RichSkeleton title={skeletonTitle(language, source)} />;
  if (language === "visual") return <VisualFallback source={source} />;
  // 流式结束仍不合规：读得出节点就退成普通列表，读不出才退回原文代码块；都不报错。
  const list = richFallbackList(source);
  if (list) return (
    <div data-rich-fallback="">
      {list.title ? <p><strong>{list.title}</strong></p> : null}
      <ul>{list.lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
    </div>
  );
  return <>{fallback}</>;
}

/** 转议题建议卡（```issue-suggest，服务端写在回答末尾）：还没收全时画骨架，读不出就不显示。 */
function IssueSuggestBlock({ source }: { source: string }) {
  const open = useRichStreamOpen();
  const draftId = parseIssueSuggest(source);
  if (draftId) return <IssueSuggestCard draftId={draftId} />;
  return open ? <RichSkeleton title="议题建议" /> : null;
}

/** 没收全的块（含没写完的公式）：标题 + 「正在生成…」，两道浅灰占位。 */
export function RichSkeleton({ title }: { title: string }) {
  return (
    <div className={r.skeleton} role="status" aria-label={`${title}，正在生成`} data-rich-skeleton="">
      <div className={r.head}>
        <span className={r.title}>{title}</span>
        <span className={r.pending}>正在生成…</span>
      </div>
      <span className={r.shimmer} aria-hidden />
      <span className={r.shimmer} data-short="" aria-hidden />
    </div>
  );
}

/** 滚动容器：往上找第一个能纵向滚动的祖先。 */
function scrollParent(element: HTMLElement | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/**
 * 放大后把这一块完整放进视野：比视野矮就整块露出，比视野高就让开头对齐上沿。返回该滚到的 scrollTop。
 * 上沿留 topGap（右列页头、对话层顶部的磨砂渐隐盖在滚动区上面，约 56–64），下沿留 gap（输入条另有让位）。
 */
export function revealScrollTop(scrollTop: number, view: { top: number; height: number }, block: { top: number; height: number }, gap = 16, topGap = REVEAL_TOP_GAP): number {
  const top = block.top - view.top;
  const bottom = top + block.height;
  if (block.height + gap + topGap > view.height || top < topGap) return Math.max(0, scrollTop + top - topGap);
  if (bottom > view.height - gap) return scrollTop + bottom - (view.height - gap);
  return scrollTop;
}
export const REVEAL_TOP_GAP = 76;

function reveal(element: HTMLElement) {
  const scroller = scrollParent(element);
  if (!scroller) return;
  const view = scroller.getBoundingClientRect();
  const box = element.getBoundingClientRect();
  const next = revealScrollTop(scroller.scrollTop, { top: view.top, height: scroller.clientHeight }, { top: box.top, height: box.height });
  if (Math.abs(next - scroller.scrollTop) > 1) scroller.scrollTo({ top: next, behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

/** 一个解析好的块：放大时完整显示；收起态大块显示缩略卡。 */
export function RichBlockView({ block }: { block: RichBlock }) {
  const surface = useRichSurface();
  const root = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState<{ contentWidth?: number; areaHeight?: number }>({});
  const [sheetOpen, setSheetOpen] = useState(false);
  const pendingReveal = useRef(false);
  const thumb = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const element = root.current;
    const parent = element?.parentElement;
    if (!element || !parent) return;
    const measure = () => {
      const scroller = scrollParent(element) ?? element.closest<HTMLElement>('[role="log"],[data-testid="conversation-scroll"]');
      setArea((previous) => {
        const next = { contentWidth: parent.clientWidth || undefined, areaHeight: scroller?.clientHeight || window.innerHeight || undefined };
        return previous.contentWidth === next.contentWidth && previous.areaHeight === next.areaHeight ? previous : next;
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // 对话层放大 / 收起的过渡里不量（每帧一次 setArea 会让这一块每帧重画），结束时量一次。
    const observer = new ResizeObserver(() => (resizing() ? afterResize(measure) : measure()));
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  // 从缩略卡点了放大：放大的过渡（240ms）走完，这一块已经完整铺开，再滚进视野。
  useEffect(() => {
    if (!surface.expanded || !pendingReveal.current) return;
    pendingReveal.current = false;
    const timer = window.setTimeout(() => { if (root.current) reveal(root.current); }, prefersReducedMotion() ? 0 : DESK_SHIFT_MS + 80);
    return () => window.clearTimeout(timer);
  }, [surface.expanded]);

  const large = !surface.expanded && isLargeBlock(block, area);
  const open = () => {
    if (expandRoute(surface) === "desk") {
      pendingReveal.current = true;
      surface.expand?.();
    } else setSheetOpen(true);
  };

  return (
    <div ref={root} className={r.frame} data-rich-block={block.kind} data-rich-size={large ? "thumb" : "full"}>
      {large ? <RichThumbnail block={block} onOpen={open} buttonRef={thumb} /> : <RichBlockBody block={block} onOpen={surface.expanded ? undefined : open} />}
      {sheetOpen ? <RichSheet block={block} onClose={() => { setSheetOpen(false); thumb.current?.focus({ preventScroll: true }); }} /> : null}
    </div>
  );
}

/** 缩略卡：标题、一行摘要、低存在感的「内容较多 · 展开查看」。整张是一个按钮（高 ≥44）。 */
export function RichThumbnail({ block, onOpen, buttonRef }: { block: RichBlock; onOpen: () => void; buttonRef?: Ref<HTMLButtonElement> }) {
  const title = richTitle(block);
  const Icon = block.kind === "timeline" ? CalendarRange : block.kind === "roadmap" ? GanttChart : block.kind === "visual" ? Shapes : BarChart3;
  return (
    <button ref={buttonRef} type="button" className={r.thumb} onClick={onOpen} data-rich-thumb="" aria-label={`展开查看：${title}`}>
      <span className={r.thumbIcon} aria-hidden><Icon size={16} strokeWidth={1.8} /></span>
      <span className={r.thumbText}>
        <span className={r.thumbTitle}>{title}</span>
        <span className={r.thumbSummary}>{richSummary(block)}</span>
      </span>
      <span className={r.thumbHint} aria-hidden>内容较多 · 展开查看<Maximize2 size={12} strokeWidth={2} /></span>
    </button>
  );
}

/**
 * 一个块完整画出来。onOpen：收起态里给（图示标题右侧的「放大」键用它）；inSheet：在手机底部 sheet 里（图示允许缩得更小）。
 */
export function RichBlockBody({ block, onOpen, inSheet = false }: { block: RichBlock; onOpen?: () => void; inSheet?: boolean }) {
  if (block.kind === "metric-compare") return <MetricCompare block={block} />;
  if (block.kind === "roadmap") return <Roadmap block={block} />;
  if (block.kind === "visual") return <Visual block={block} onOpen={inSheet ? undefined : onOpen} {...(inSheet ? { minScale: VISUAL_SHEET_MIN_SCALE } : {})} />;
  return <Timeline block={block} />;
}

function MetricCompare({ block }: { block: MetricCompareBlock }) {
  return (
    <figure className={r.block} data-rich="metric-compare">
      <figcaption className={r.head}>
        <span className={r.title}>{richTitle(block)}</span>
        {block.unit ? <span className={r.meta}>{block.unit}</span> : null}
      </figcaption>
      <ul className={r.metrics}>
        {block.items.map((item, index) => {
          const reading = metricReading(item);
          const unit = item.unit ?? block.unit;
          const unitSuffix = unit && unit !== block.unit ? ` ${unit}` : "";
          return (
            <li key={index} className={r.metric} data-band={reading.band}>
              <div className={r.metricHead}>
                <span className={r.label}>{item.label}</span>
                <b className={r.percent}>{reading.percent}</b>
              </div>
              <div className={r.figures}>
                <b>{formatNumber(item.current)}</b>
                <span className={r.target}> / 目标 {formatNumber(item.target)}{unitSuffix}</span>
                <span className={r.gap}>{reading.gap > 0 ? `差 ${formatNumber(reading.gap)}` : "已达成"}</span>
              </div>
              <span className={r.bar} aria-hidden>
                {reading.ratio > 0 ? <span className={r.fill} style={{ width: `${Math.min(1, reading.ratio) * 100}%` }} /> : null}
              </span>
              {item.note ? <p className={r.note}>{item.note}</p> : null}
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

const KIND_TEXT = { milestone: "里程碑", deadline: "截止", now: "现在" } as const;

/** 横向滚动时两侧还有没露出来的节点：两侧渐隐、下方提示跟着它走。 */
type TrackEdges = { start: boolean; end: boolean };

/**
 * 时间线：量节点轨道的宽度，按 timelineLayout 决定一行等分 / 换行 / 横向滚动（显示规范见 parse.ts 开头）。
 * 量不到宽度（服务端渲染、首帧之前）按横向滚动排，与改前一致。
 */
function Timeline({ block }: { block: TimelineBlock }) {
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [edges, setEdges] = useState<TrackEdges>({ start: false, end: false });
  const count = block.items.length;
  const layout = timelineLayout(count, width);
  useLayoutEffect(() => {
    const element = track.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      setWidth(Math.max(0, element.clientWidth - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0")));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const readEdges = () => {
    const element = track.current;
    if (!element) return;
    const next = { start: element.scrollLeft > 2, end: element.scrollLeft + element.clientWidth < element.scrollWidth - 2 };
    setEdges((previous) => (previous.start === next.start && previous.end === next.end ? previous : next));
  };
  useLayoutEffect(readEdges, [layout.mode, width]);
  return <TimelineBody block={block} layout={layout} edges={layout.mode === "scroll" ? edges : { start: false, end: false }} trackRef={track} onScroll={readEdges}
    hint={width > 0 && layout.mode === "scroll"} />;
}

/** 时间线的画法（纯展示，排法由外面给）：row 等分一行、wrap 按 columns 列换行、scroll 一行横向滚动。 */
export function TimelineBody({ block, layout, edges = { start: false, end: false }, trackRef, onScroll, hint = layout.mode === "scroll" }: {
  block: TimelineBlock; layout: TimelineLayout; edges?: TrackEdges; trackRef?: Ref<HTMLDivElement>; onScroll?: () => void;
  /** 横向滚动的提示行（量到宽度、确实要滚时才给）。 */
  hint?: boolean;
}) {
  const progress = timelineProgress(block);
  const year = referenceYear(block);
  const count = block.items.length;
  const vars = { "--count": count, ...(layout.mode === "wrap" ? { "--columns": layout.columns } : {}) } as CSSProperties;
  return (
    <figure className={r.block} data-rich="timeline" data-layout={layout.mode}>
      <figcaption className={r.head}>
        <span className={r.title}>{richTitle(block)}</span>
        {progress ? <span className={r.meta}>已过 {progress.passed} 天 · 剩余 {progress.remaining} 天</span> : null}
      </figcaption>
      {progress ? (
        <div className={r.progress} aria-hidden>
          <span className={r.progressFill} style={{ width: `${progress.ratio * 100}%` }} />
        </div>
      ) : null}
      <div ref={trackRef} className={r.track} tabIndex={0} aria-label={`${richTitle(block)}，${count} 个节点`} onScroll={onScroll}
        data-more-start={edges.start || undefined} data-more-end={edges.end || undefined}>
        <ol className={r.nodes} style={vars}>
          {block.items.map((item, index) => {
            const phase = timelinePhase(item, block.now);
            return (
              <li key={index} className={r.node} data-kind={item.kind} data-phase={phase}>
                <span className={r.dot} aria-hidden />
                <time className={r.date}>{formatDate(item.date, year)}</time>
                <span className={r.nodeLabel}>{item.label}</span>
                {item.kind === "deadline" ? <span className={r.kindTag}>{KIND_TEXT.deadline}</span> : null}
              </li>
            );
          })}
        </ol>
      </div>
      {/* 横向滚动时一直留着这一行（高度不随滚动变）；哪一侧还有节点由两侧渐隐表示。 */}
      {hint ? <p className={r.scrollHint} data-rich-scroll-hint="">左右滑动查看全部 {count} 个节点</p> : null}
    </figure>
  );
}

/** 手机 / 窄屏的展开：底部升起的全屏 sheet。关闭键 44；下拉页头超过这么多就收起。 */
export const SHEET_DRAG_CLOSE = 96;
export const sheetDragCloses = (dy: number) => dy > SHEET_DRAG_CLOSE;

export function RichSheet({ block, onClose }: { block: RichBlock; onClose: () => void }) {
  const [mounted, setMounted] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const closeKey = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ y: number; dy: number } | null>(null);
  const latestClose = useRef(onClose);
  latestClose.current = onClose;
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!mounted) return;
    closeKey.current?.focus({ preventScroll: true });
    // Esc：sheet 最上层，先收它（捕获阶段接住，外壳这一次不动）。
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      latestClose.current();
    };
    document.addEventListener("keydown", onKey, true);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = overflow;
    };
  }, [mounted]);
  if (!mounted) return null;
  const title = richTitle(block);
  const setOffset = (dy: number) => { if (panel.current) panel.current.style.transform = dy > 0 ? `translateY(${dy}px)` : ""; };
  return createPortal(
    <div className={r.sheetLayer} data-rich-sheet="">
      <button type="button" className={r.sheetVeil} aria-label="收起" tabIndex={-1} onClick={onClose} />
      <section ref={panel} className={r.sheet} role="dialog" aria-modal="true" aria-label={title} data-tone="light">
        <header className={r.sheetHead}
          onPointerDown={(event) => { if ((event.target as HTMLElement).closest("button")) return; drag.current = { y: event.clientY, dy: 0 }; event.currentTarget.setPointerCapture?.(event.pointerId); }}
          onPointerMove={(event) => { if (!drag.current) return; drag.current.dy = Math.max(0, event.clientY - drag.current.y); setOffset(drag.current.dy); }}
          onPointerUp={() => { const dy = drag.current?.dy ?? 0; drag.current = null; if (sheetDragCloses(dy)) onClose(); else setOffset(0); }}
          onPointerCancel={() => { drag.current = null; setOffset(0); }}>
          <span className={r.grabber} aria-hidden />
          <h2 className={r.sheetTitle}>{title}</h2>
          <button ref={closeKey} type="button" className={r.sheetClose} aria-label="收起" onClick={onClose}>
            <X size={20} strokeWidth={1.9} aria-hidden />
          </button>
        </header>
        <div className={r.sheetBody}>
          <RichBlockBody block={block} inSheet />
        </div>
      </section>
    </div>,
    document.body,
  );
}

/** 两处 ReactMarkdown 共用：富内容块的 `pre`。 */
export const RICH_COMPONENTS = { pre: RichPre };
