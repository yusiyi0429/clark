"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Maximize2 } from "lucide-react";
import {
  randomToken, readVisualMessage, svgFit, visualDocument, visualSizeOk, VISUAL_MIN_SCALE, VISUAL_REPORT_TIMEOUT_MS, VISUAL_SANDBOX, VISUAL_SETTLE_MS,
  type VisualBlock, type VisualTheme,
} from "./visualSandbox";
import r from "@/styles/rich-blocks.module.css";

/**
 * 自由图示（```visual，清洗与沙箱文档见 visualSandbox.ts）：
 * - 宽度与正文栏同宽；高度由 iframe 里的量高脚本回报（postMessage，校验来源、origin 与 token），量到之前按 viewBox 估；
 * - 回报的高度超出范围并且稳定 1.2 秒仍超出、或加载后 3 秒还没有合理的高度：退回「图示无法显示」，原文可展开；
 * - 明暗主题跟所在的外框走（外框背景深就用深色那一套）；
 * - 收起态标题右侧一个「放大」键：能放大走放大，不能放大从底部升起 sheet。
 */

/** 量到过的高度（按原文记）：同一块重新挂载时（流式结束、合并到达记录）先用它，不跳。 */
const heightCache = new Map<string, number>();

function sourceKey(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) hash = Math.imul(hash ^ source.charCodeAt(index), 0x01000193);
  return `${source.length}:${(hash >>> 0).toString(36)}`;
}

/** 外框背景的明暗：往上找第一个不透明的背景，按亮度判断。 */
function themeOf(element: HTMLElement | null): VisualTheme {
  for (let node = element; node; node = node.parentElement) {
    const match = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(getComputedStyle(node).backgroundColor);
    if (!match || (match[4] !== undefined && Number(match[4]) < 0.5)) continue;
    const [red, green, blue] = [match[1], match[2], match[3]].map(Number);
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue < 110 ? "dark" : "light";
  }
  return "light";
}

export type VisualFailure = "invalid" | "size" | "timeout";

/** 图示没法显示：一句说明 + 可展开的原文（不出现乱码或空白）。 */
export function VisualFallback({ title, source, reason = "invalid" }: { title?: string; source: string; reason?: VisualFailure }) {
  return (
    <figure className={r.block} data-rich="visual" data-state="failed" data-reason={reason}>
      <figcaption className={r.head}><span className={r.title}>{title ?? "图示"}</span></figcaption>
      <p className={r.visualFailed} role="note">图示无法显示</p>
      <details className={r.visualSource}>
        <summary>查看原文</summary>
        <pre><code>{source}</code></pre>
      </details>
    </figure>
  );
}

export function Visual({ block, onOpen, minScale = VISUAL_MIN_SCALE }: { block: VisualBlock; onOpen?: () => void; minScale?: number }) {
  const key = useMemo(() => sourceKey(block.source), [block.source]);
  const figure = useRef<HTMLElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const reported = useRef(false);
  const latest = useRef(0);
  const settle = useRef<number | undefined>(undefined);
  const [mounted, setMounted] = useState(false);
  const [theme, setTheme] = useState<VisualTheme>("light");
  const [width, setWidth] = useState(0);
  const [size, setSize] = useState<{ height: number; overflow: boolean } | null>(null);
  const [failed, setFailed] = useState<VisualFailure | null>(null);
  // nonce（CSP 放行宿主的量高脚本）与 token（回报高度时对暗号）每次挂载各取一个，模型猜不到。
  const secrets = useMemo(() => ({ nonce: randomToken(), token: randomToken() }), []);

  useLayoutEffect(() => {
    setMounted(true);
    setTheme(themeOf(figure.current));
    const element = holder.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const next = readVisualMessage(event, frame.current?.contentWindow, secrets.token);
      if (!next) return;
      latest.current = next.height;
      // 超出范围先不认：文档刚开始排版、iframe 还没拿到宽度时会先报 0 或几千；稳定一会儿仍超出才算尺寸异常。
      if (!visualSizeOk(next.height)) {
        window.clearTimeout(settle.current);
        settle.current = window.setTimeout(() => { if (!visualSizeOk(latest.current)) setFailed("size"); }, VISUAL_SETTLE_MS);
        return;
      }
      reported.current = true;
      heightCache.set(key, next.height);
      setSize((previous) => (previous && previous.height === next.height && previous.overflow === next.overflow ? previous : next));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [key, secrets.token]);

  const srcDoc = useMemo(() => visualDocument({ block, theme, nonce: secrets.nonce, token: secrets.token, minScale }), [block, theme, secrets, minScale]);

  // 换主题会换文档（重新加载），重新等回报。
  useEffect(() => { reported.current = false; latest.current = 0; }, [srcDoc]);

  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => { window.clearTimeout(timer.current); window.clearTimeout(settle.current); }, []);
  const onLoad = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { if (!reported.current) setFailed(latest.current ? "size" : "timeout"); }, VISUAL_REPORT_TIMEOUT_MS);
  };

  if (failed) return <VisualFallback title={block.title} source={block.source} reason={failed} />;
  const estimate = block.viewBox ? svgFit(block.viewBox, width, minScale).height + 3 : heightCache.get(key) ?? 160;
  const height = size?.height ?? heightCache.get(key) ?? estimate;
  const title = block.title ?? "图示";
  return (
    <figure ref={figure} className={`${r.block} ${r.visual}`} data-rich="visual" data-format={block.format} data-ready={size ? "" : undefined}>
      <figcaption className={r.head}>
        <span className={r.title}>{title}</span>
        {onOpen ? (
          <button type="button" className={r.visualZoom} onClick={onOpen} aria-label={`放大查看：${title}`} data-rich-zoom="">
            <Maximize2 size={14} strokeWidth={2} aria-hidden />
          </button>
        ) : null}
      </figcaption>
      <div ref={holder} className={r.visualHolder} style={{ height }}>
        {mounted ? (
          <iframe ref={frame} className={r.visualFrame} title={title} sandbox={VISUAL_SANDBOX} srcDoc={srcDoc} referrerPolicy="no-referrer"
            style={{ height, colorScheme: theme }} onLoad={onLoad} data-rich-visual-frame="" />
        ) : (
          <span className={r.shimmer} aria-hidden />
        )}
      </div>
      {size?.overflow ? <p className={r.scrollHint} data-rich-scroll-hint="">左右滑动查看完整图示</p> : null}
    </figure>
  );
}
