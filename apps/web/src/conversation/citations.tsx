"use client";

import {
  Children, createContext, isValidElement, useCallback, useContext, useEffect, useId, useMemo, useRef, useState,
  type ComponentPropsWithoutRef, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, X } from "lucide-react";
import { defaultUrlTransform, type Components } from "react-markdown";
import { parseSourceRef } from "@/cards/meetingSources";
import { citationRoute, knownCitation, openCitation, queueCitation, type CitationSurface } from "./citationBridge";
import { CITE_MARK_PROP, NAMED_SOURCE } from "./citationMarks";
import { MemoryMark } from "./MemoryMark";
import s from "@/styles/citations.module.css";

/**
 * 回答里的出处（深度讨论 v2；10/14 改成出处标记）。Agent 把出处写成 Markdown 链接 `[资料名称](地址)`
 * （apps/api/src/sourceCitations.ts），地址是内部依据 `cite:<ref>`、原网址，或只有名称的 `cite:source`。
 * - 句末位置的出处（citationMarks.ts 的 remark 插件判断）画成一个很小的浅灰圆点：正文读起来不被文件名打断。
 *   电脑上鼠标悬停（或键盘聚焦）浮出来源：资料名称、所在段落或版本、「打开原文」；手机上点一下，从底部升起同样的内容。
 *   点圆点本身（鼠标、回车）就是打开原文。
 * - 句子成分里的出处（「[《经营原则》](cite:…)写明」「来源：[…]」）照旧显示名称：深度讨论时是可点的轻量链接，平时只是文字。
 * - ref 认不出、地址残缺时只显示名称，不出错，不把原始标记摆出来。普通链接（外部来源的标题与 URL）照旧。
 */

export const CITE_SCHEME = "cite:";

/** cite: 地址里的 ref；不是 cite: 地址、解码失败或认不出时为 null。 */
export function citationRef(href: string | null | undefined): string | null {
  if (!href || !href.startsWith(CITE_SCHEME)) return null;
  let ref: string;
  try {
    ref = decodeURIComponent(href.slice(CITE_SCHEME.length)).trim();
  } catch {
    return null;
  }
  return ref && knownCitation(ref) ? ref : null;
}

/** cite: 地址原样保留（默认的地址清洗会把未知协议清成空串），其他地址照默认规则。 */
export function citationUrlTransform(url: string): string {
  return url.startsWith(CITE_SCHEME) ? url : defaultUrlTransform(url);
}

/** 浮层第二行：出处在资料里的位置（段落、版本、章节）或类别；外部来源写网站域名。认不出的不写。 */
export function citationLocator(ref: string): string | null {
  const parsed = parseSourceRef(ref);
  switch (parsed.kind) {
    case "material": return ["群材料", `第 ${parsed.version} 版`, parsed.paragraph ? `第 ${parsed.paragraph} 段` : null].filter(Boolean).join(" · ");
    case "legacy-material": return "会前材料";
    case "memory": return parsed.section ? `企业知识 · 第 ${parsed.section} 节` : "企业知识";
    case "discussion": return "群讨论发言";
    case "decision": return "历史决定";
    case "fact": return "事实记录";
    case "feedback": return "阶段反馈";
    case "signal": return "外部信号";
    case "outcome": return "会后结论";
    case "meeting": return "会议";
    case "transcript": return "会议记录";
    case "issue": return "议题";
    case "research": return "议题研究";
    case "chat": return "原话";
    case "pmem": return "个人记忆";
    default: return null;
  }
}

function hostOf(href: string): string | null {
  try {
    return new URL(href).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** 链接文字（可能被到达淡入切成好几段 span）拼回纯文字：浮层标题与读屏名称用。 */
export function plainText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(plainText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return plainText(node.props.children);
  return Children.toArray(node).map(plainText).join("");
}

type SurfaceValue = { linked: boolean; surface: CitationSurface; expand?: () => void };

/**
 * 这条回答里可以显示的记忆标记：本轮实际装进上下文的记忆 id（memoryUsed）。不在里面的 id（模型编的、抄错的）不显示；
 * 正在写的回答还不知道，先都不显示，写完读回历史再出现。
 */
const MemoryUsedContext = createContext<readonly string[]>([]);
export const MemoryUsedProvider = MemoryUsedContext.Provider;
const SurfaceContext = createContext<SurfaceValue>({ linked: false, surface: "rail" });

/**
 * 对话所在的那一面：放大时 linked，句子里的来源才可点；`expand` 是平时能放大就给（出处标记的「打开原文」要先放大才有依据面板）。
 * 值记住：宿主流式中每帧重画，没变就不让每个来源跟着重画。
 */
export function CitationSurfaceProvider({ linked, surface, expand, children }: SurfaceValue & { children: ReactNode }) {
  const value = useMemo(() => ({ linked, surface, expand }), [linked, surface, expand]);
  return <SurfaceContext.Provider value={value}>{children}</SurfaceContext.Provider>;
}

type AnchorProps = ComponentPropsWithoutRef<"a"> & { node?: unknown; [CITE_MARK_PROP]?: string };

export function CitationAnchor({ node: _node, href, children, [CITE_MARK_PROP]: mark, ...rest }: AnchorProps) {
  const { linked, surface } = useContext(SurfaceContext);
  const memoryUsed = useContext(MemoryUsedContext);
  // 个人记忆（cite:pmem:<id>）：不论在句中哪里，都是记忆小标记，点开看这条记忆、当场修改；不是本轮用到的 id 不显示。
  const memory = href?.startsWith(CITE_SCHEME) ? parseSourceRef(citationRef(href) ?? "") : null;
  if (memory?.kind === "pmem") return memoryUsed.includes(memory.id) ? <MemoryMark id={memory.id} /> : null;
  if (mark !== undefined && href) return <CitationMark href={href} title={plainText(children)} />;
  if (!href?.startsWith(CITE_SCHEME)) return <a href={href} {...rest}>{children}</a>;
  const ref = citationRef(href);
  if (!ref || !linked || citationRoute(ref, surface) === "none") return <span className={s.plain} data-cite={ref ? "plain" : "invalid"}>{children}</span>;
  return <CitationLink citeRef={ref} surface={surface}>{children}</CitationLink>;
}

/** 可点的来源：交给依据导航（citationBridge）——页内定位，或在左侧依据面板打开。 */
export function CitationLink({ citeRef, surface, children }: { citeRef: string; surface: CitationSurface; children: ReactNode }) {
  return (
    <button type="button" className={s.link} data-cite-ref={citeRef} title="在左侧查看这条依据"
      onClick={(event) => openCitation(citeRef, { surface, trigger: event.currentTarget })}>
      {children}
    </button>
  );
}

/** 一个出处标记指向哪：内部依据（ref）、外部网址，或只有名称。 */
export type MarkTarget = { kind: "ref"; ref: string } | { kind: "url"; url: string } | { kind: "named" };

export function markTarget(href: string): MarkTarget {
  if (/^https?:\/\//i.test(href)) return { kind: "url", url: href };
  const ref = href === NAMED_SOURCE ? null : citationRef(href);
  return ref ? { kind: "ref", ref } : { kind: "named" };
}

/** 「打开原文」此刻能不能打开：放大时都能；平时看页内依据导航接不接得住，接不住就要能先放大。 */
export function canOpenMark(target: MarkTarget, surface: SurfaceValue): boolean {
  if (target.kind === "url") return true;
  if (target.kind === "named") return false;
  const route = citationRoute(target.ref, surface.surface);
  if (route === "none") return false;
  return surface.linked || route === "page" || Boolean(surface.expand);
}

/** 打开原文：放大时直接交给依据导航；平时页面接得住就交给页面，否则先放大、放大后依据面板接着打开。 */
export function openMark(target: MarkTarget, surface: SurfaceValue, trigger: HTMLElement | null): void {
  if (target.kind === "url") { window.open(target.url, "_blank", "noopener,noreferrer"); return; }
  if (target.kind !== "ref") return;
  const options = { surface: surface.surface, trigger };
  if (surface.linked || citationRoute(target.ref, surface.surface) === "page") { openCitation(target.ref, options); return; }
  if (surface.expand) { queueCitation(target.ref, options); surface.expand(); }
}

/** 点标记做什么：手指、触控笔从底部升起来源；鼠标与键盘（detail 为 0）直接打开原文，打不开就浮出来源。 */
export function markClickAction(pointerType: string, detail: number, openable: boolean): "sheet" | "open" | "pop" {
  if (pointerType !== "mouse" && detail > 0) return "sheet";
  return openable ? "open" : "pop";
}

const OPEN_DELAY = 120;
const CLOSE_DELAY = 160;
const POP_WIDTH = 288;
const GAP = 6;

type PopPosition = { left: number; top?: number; bottom?: number; width: number };

/** 浮层放在标记下方，下方放不下放上方；左右不出窗口。 */
export function popPosition(rect: { left: number; right: number; top: number; bottom: number }, viewport: { width: number; height: number }, estimate = 112): PopPosition {
  const width = Math.min(POP_WIDTH, viewport.width - 16);
  const center = (rect.left + rect.right) / 2;
  const left = Math.max(8, Math.min(center - width / 2, viewport.width - width - 8));
  return rect.bottom + GAP + estimate <= viewport.height - 8 ? { left, top: rect.bottom + GAP, width } : { left, bottom: viewport.height - rect.top + GAP, width };
}

/** 句末的出处标记：一个 12px 见方的浅灰圆点。 */
export function CitationMark({ href, title }: { href: string; title: string }) {
  const surface = useContext(SurfaceContext);
  const target = useMemo(() => markTarget(href), [href]);
  const locator = target.kind === "ref" ? citationLocator(target.ref) : target.kind === "url" ? hostOf(target.url) : null;
  const name = title.trim() || (target.kind === "url" ? hostOf(target.url) ?? "外部来源" : "出处");
  const button = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointer = useRef<string>("mouse");
  const [pop, setPop] = useState<PopPosition | null>(null);
  const [sheet, setSheet] = useState(false);
  const popId = useId();

  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const show = useCallback(() => {
    const rect = button.current?.getBoundingClientRect();
    if (rect) setPop(popPosition(rect, { width: window.innerWidth, height: window.innerHeight }));
  }, []);
  const hide = useCallback(() => setPop(null), []);
  const later = (work: () => void, ms: number) => { clear(); timer.current = setTimeout(work, ms); };
  useEffect(() => clear, []);
  // 浮层开着：滚动、改窗口大小、Esc 收起。
  useEffect(() => {
    if (!pop) return;
    const close = () => setPop(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); document.removeEventListener("keydown", onKey); };
  }, [pop]);

  const openable = canOpenMark(target, surface);
  const open = () => { setPop(null); setSheet(false); openMark(target, surface, button.current); };
  const fine = (event: ReactPointerEvent) => event.pointerType === "mouse";
  const onClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const action = markClickAction(pointer.current, event.detail, openable);
    if (action === "sheet") { clear(); setPop(null); setSheet(true); }
    else if (action === "open") open();
    else show();
  };

  return (
    <>
      <button ref={button} type="button" className={s.mark} data-cite-mark={target.kind} {...(target.kind === "ref" ? { "data-cite-ref": target.ref } : {})}
        aria-label={`出处：${name}`} aria-describedby={pop ? popId : undefined}
        onPointerDown={(event) => { pointer.current = event.pointerType || "mouse"; }}
        onPointerEnter={(event) => { if (fine(event)) later(show, OPEN_DELAY); }}
        onPointerLeave={(event) => { if (fine(event)) later(hide, CLOSE_DELAY); }}
        onFocus={(event) => { if (event.currentTarget.matches?.(":focus-visible")) { clear(); show(); } }}
        onBlur={() => later(hide, CLOSE_DELAY)}
        onClick={onClick}>
        <span className={s.dot} aria-hidden />
      </button>
      {pop ? createPortal(
        <div id={popId} role="tooltip" className={s.pop} data-cite-pop="" style={{ left: pop.left, top: pop.top, bottom: pop.bottom, width: pop.width } as CSSProperties}
          onPointerEnter={clear} onPointerLeave={() => later(hide, CLOSE_DELAY)}>
          <SourceSummary name={name} locator={locator} openable={openable} onOpen={open} />
        </div>, document.body) : null}
      {sheet ? <CitationSheet name={name} locator={locator} openable={openable} onOpen={open}
        onClose={() => { setSheet(false); button.current?.focus({ preventScroll: true }); }} /> : null}
    </>
  );
}

function SourceSummary({ name, locator, openable, onOpen, large = false }: { name: string; locator: string | null; openable: boolean; onOpen: () => void; large?: boolean }) {
  return (
    <>
      <p className={large ? s.sheetName : s.popName}>{name}</p>
      {locator ? <p className={large ? s.sheetMeta : s.popMeta}>{locator}</p> : null}
      {openable ? (
        <button type="button" className={large ? s.sheetOpen : s.popOpen} onClick={onOpen}>
          打开原文<ArrowUpRight size={large ? 14 : 12} aria-hidden />
        </button>
      ) : null}
    </>
  );
}

/** 手机：点标记从底部升起来源（同浮层的内容）。点遮罩、×、Esc 收起。 */
function CitationSheet({ name, locator, openable, onOpen, onClose }: { name: string; locator: string | null; openable: boolean; onOpen: () => void; onClose: () => void }) {
  const closeKey = useRef<HTMLButtonElement>(null);
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    closeKey.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      latest.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  return createPortal(
    <div className={s.sheetLayer} data-cite-sheet="">
      <button type="button" className={s.sheetVeil} aria-label="收起" tabIndex={-1} onClick={onClose} />
      <section className={s.sheet} role="dialog" aria-modal="true" aria-label={`出处：${name}`}>
        <span className={s.grabber} aria-hidden />
        <div className={s.sheetHead}>
          <span className={s.sheetLabel}>出处</span>
          <button ref={closeKey} type="button" className={s.sheetClose} aria-label="收起" onClick={onClose}>
            <X size={18} strokeWidth={1.9} aria-hidden />
          </button>
        </div>
        <SourceSummary name={name} locator={locator} openable={openable} onOpen={onOpen} large />
      </section>
    </div>,
    document.body,
  );
}

/** 两处 ReactMarkdown（历史整段、流式分块）共用。 */
export const CITATION_MARKDOWN: { components: Components; urlTransform: (url: string) => string } = {
  components: { a: CitationAnchor as Components["a"] },
  urlTransform: citationUrlTransform,
};
