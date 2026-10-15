"use client";

/**
 * 听写文字的下划线（像微信输入法）：textarea 不能给一部分文字单独加样式，所以在它上面叠一层「镜像」——
 * 同字体、同内边距、同宽、同折行规则排一遍同样的文字，字本身透明，只画出下划线；不接鼠标，滚动跟着 textarea。
 * textarea 的字、光标、选区都照常由它自己画，镜像层偏一点也只是下划线偏一点。
 *
 * 整理替换进来的那段（fresh）画一次「轻淡入」：在那段字上盖一层和输入框同色的底，160ms 内褪成透明，
 * 看起来就是新字淡淡浮出来；textarea 的字和光标本身不动、不闪。减少动效时不盖（直接换）。
 *
 * 放在 textarea 的同一个父元素里（父元素要能当定位容器：position 不是 static）。没有下划线、也没有淡入时什么都不画。
 */

import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type { Mark } from "./dictationDraft";
import type { FreshRange } from "./useDictation";
import s from "@/styles/dictation.module.css";

/** 影响排版的属性：照抄 textarea 的计算样式。 */
const COPIED = [
  "boxSizing",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontStretch",
  "fontVariantNumeric",
  "fontFeatureSettings",
  "fontKerning",
  "letterSpacing",
  "wordSpacing",
  "lineHeight",
  "textIndent",
  "textTransform",
  "tabSize",
  "wordBreak",
  "overflowWrap",
  "lineBreak",
  "direction",
  "textAlign",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
] as const;

export type MirrorSegment = { text: string; marked: boolean; fresh?: true };

/** 按下划线范围（和刚换进来的那段）切成几段（纯函数）。两者重叠时以下划线为准。 */
export function markSegments(value: string, marks: Mark[], fresh: Mark | null = null): MirrorSegment[] {
  const ranges = [...marks.map((mark) => ({ ...mark, kind: "marked" as const })), ...(fresh ? [{ ...fresh, kind: "fresh" as const }] : [])].sort(
    (a, b) => a.start - b.start || (a.kind === "marked" ? -1 : 1),
  );
  const out: MirrorSegment[] = [];
  let at = 0;
  for (const range of ranges) {
    const start = Math.max(at, Math.min(range.start, value.length));
    const end = Math.max(start, Math.min(range.end, value.length));
    if (start > at) out.push({ text: value.slice(at, start), marked: false });
    if (end > start) out.push(range.kind === "marked" ? { text: value.slice(start, end), marked: true } : { text: value.slice(start, end), marked: false, fresh: true });
    at = Math.max(at, end);
  }
  if (at < value.length) out.push({ text: value.slice(at), marked: false });
  return out;
}

const TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))$/;

/** 输入框看上去的底色：自己透明就往上找第一个不透明的祖先（淡入那层盖的就是这个颜色）。 */
function surfaceColor(element: HTMLElement): string {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    if (color && !TRANSPARENT.test(color)) return color;
  }
  return "transparent";
}

export function DictationMirror({
  field,
  value,
  marks = [],
  polishing = false,
  fresh = null,
}: {
  field: RefObject<HTMLTextAreaElement | null>;
  value: string;
  marks?: Mark[];
  polishing?: boolean;
  fresh?: FreshRange | null;
}) {
  const mirror = useRef<HTMLDivElement>(null);
  const shown = marks.length > 0 || fresh !== null;

  const sync = useCallback(() => {
    const textarea = field.current;
    const layer = mirror.current;
    if (!textarea || !layer) return;
    const style = getComputedStyle(textarea);
    const target = layer.style as unknown as Record<string, string>;
    const source = style as unknown as Record<string, string>;
    for (const key of COPIED) target[key] = source[key];
    // offset* 不受 transform 影响（首页输入条展开时有缩放动画）。
    layer.style.left = `${textarea.offsetLeft}px`;
    layer.style.top = `${textarea.offsetTop}px`;
    layer.style.width = `${textarea.offsetWidth}px`;
    layer.style.height = `${textarea.offsetHeight}px`;
    layer.scrollTop = textarea.scrollTop;
    layer.style.setProperty("--dictation-veil", surfaceColor(textarea));
  }, [field]);

  useLayoutEffect(() => {
    if (!shown) return;
    const textarea = field.current;
    if (!textarea) return;
    sync();
    const onScroll = () => {
      if (mirror.current) mirror.current.scrollTop = textarea.scrollTop;
    };
    textarea.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(textarea);
    return () => {
      textarea.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [shown, field, sync]);

  // 文字一变就重排一次（textarea 自己的高度、滚动位置也可能跟着变）。
  useLayoutEffect(() => {
    if (shown) sync();
  }, [shown, value, marks, fresh, sync]);

  if (!shown) return null;
  return (
    <div ref={mirror} className={s.mirror} data-polishing={polishing || undefined} aria-hidden data-dictation-mirror>
      {markSegments(value, marks, fresh).map((segment, index) =>
        segment.marked ? (
          <span key={index} className={s.marked}>{segment.text}</span>
        ) : segment.fresh ? (
          <span key={`fresh-${fresh?.id}`} className={s.fresh} data-dictation-fresh>{segment.text}</span>
        ) : (
          segment.text
        ),
      )}
      {"​"}
    </div>
  );
}
