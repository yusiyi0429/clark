"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { api } from "@/lib/data/client";
import type { CodeRef } from "@/lib/data/types";
import { useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 代号溯源。
 *
 * 一号位说的：人记不住代号。而这个产品满屏都是代号 —— 04-J1、MC-04-3、DOC-mp-07、
 * D-20260603。一个记不住又当场翻不出来的编号，在屏幕上就是噪音；而这里的编号恰恰是
 * 公司内部真正在用的那套话，不能换成人话了事。所以：**编号照写，但是悬停就说人话。**
 *
 * 有一条纪律：**认不出来的代号不加下划线。**「M1-A」这类方法论代号在本体里没有对象，
 * 它就该是纯文本。给它加上可点的样子，点开是空的——那比不给链接更伤，因为一号位下次
 * 就不信任何一个下划线了。
 */

/**
 * 长的排前面，否则 `04-J1` 会先被 `04` 吃掉一半。
 *
 * 最后那条 `\d{2}-\d+` 是 Mission 的短写（`04-3`），它会咬进别的编号里 —— 提请号
 * `RQ-2026-08-08-1` 里就藏着一个 `08-08`。所以带前缀的编号必须整条写在它前面：正则
 * 取最左匹配，在同一个起点上按顺序挑分支，`RQ-` 那条从第 0 个字符起就命中，短写那条
 * 根本轮不到。少了这一条会看到一枚指向 08 域的下划线，点开跟他问的那件事毫无关系。
 */
const CODE_RE = new RegExp(
  [
    "RQ-\\d{4}-\\d{2}-\\d{2}-\\d+",
    "MC-\\d{2}-\\d+",
    "D-\\d{8}(?:-\\d+)?",
    "DOC-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*",
    "CM-\\d{4}-\\d+",
    "ISS-\\d+",
    "ASK-\\d+",
    "\\d{2}-J\\d+",
    "\\d{2}-\\d+",
  ].join("|"),
  "g",
);

export function useCodeIndex() {
  return useResource("code-index", () => api.codeIndex()).data;
}

/**
 * 一段正文，里面的代号自动可查。
 *
 * 纯函数式地切分，不碰 DOM：正文是一个字一个字长出来的，每次重切一遍很便宜，而在
 * 已经渲染好的文本节点上找代号再包起来会在流式过程中打断选中和光标。
 */
export function CodeText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const index = useCodeIndex();
  if (!index) return <span className={className}>{text}</span>;

  const parts: ReactNode[] = [];
  let last = 0;

  // `matchAll` 而不是 `exec` 循环：`exec` 要靠改 `CODE_RE.lastIndex` 记进度，那是在渲染
  // 里改一个模块级对象 —— 两个组件同一帧渲染就会互相踩，而且 React Compiler 会报它。
  for (const m of text.matchAll(CODE_RE)) {
    const ref = index[m[0].toUpperCase()];
    if (!ref || m.index === undefined) continue;
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<CodeChip key={`${m.index}-${m[0]}`} ref_={ref} label={m[0]} />);
    last = m.index + m[0].length;
  }

  if (parts.length === 0) return <span className={className}>{text}</span>;
  if (last < text.length) parts.push(text.slice(last));
  return <span className={className}>{parts}</span>;
}

/**
 * 一个单独的代号徽章，自己带溯源。
 *
 * 用在编号本身就是版面元素的地方（提请卡上那个深色实心的判断号、判断台上那一列）。
 * 跟 `CodeText` 共用同一张悬停卡，所以「悬停就说人话」这条在全站只有一个实现。
 *
 * 本体里查不到这个代号时退回纯文本 —— 样式还在，可点的暗示没了。这跟上面那条纪律
 * 是同一条：宁可少一个链接，不能有一个点开是空的链接。
 */
export function CodeBadge({
  code,
  className,
}: {
  code: string;
  className?: string;
}) {
  const index = useCodeIndex();
  const ref = index?.[code.toUpperCase()];
  if (!ref) return <span className={className}>{code}</span>;
  return <CodeChip ref_={ref} label={code} className={className} plain />;
}

/* -------------------------------------------------------------------------- */

/** 悬停多久才弹。太快 = 划过一句话弹三次；太慢 = 感觉没反应。 */
const OPEN_DELAY = 300;
/** 移出去多久才收。留出把鼠标移进卡片里的时间。 */
const CLOSE_DELAY = 140;

function CodeChip({
  ref_,
  label,
  className,
  plain,
}: {
  ref_: CodeRef;
  label: string;
  /** 徽章形态自带底色和字色，接管全部样式。 */
  className?: string;
  /** true = 不画那条虚线下划线（底色已经在说「这里可以点」了）。 */
  plain?: boolean;
}) {
  const anchor = useRef<HTMLAnchorElement>(null);
  const [at, setAt] = useState<{ x: number; y: number; up: boolean } | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const place = () => {
    const el = anchor.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const up = r.top > 220;
    setAt({
      x: Math.min(Math.max(r.left, 12), window.innerWidth - 340),
      y: up ? r.top - 8 : r.bottom + 8,
      up,
    });
  };

  const open = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(place, OPEN_DELAY);
  };
  const close = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAt(null), CLOSE_DELAY);
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // 滚动的时候卡片会跟锚点脱开。跟着算不如直接收掉：它是个一瞥的东西。
  useEffect(() => {
    if (!at) return;
    const dismiss = () => setAt(null);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [at]);

  return (
    <>
      <Link
        ref={anchor}
        href={ref_.href ?? "#"}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={place}
        onBlur={() => setAt(null)}
        className={cn(
          "align-baseline transition-colors duration-fast ease-swift",
          plain
            ? "hover:opacity-85"
            : [
                "meta mx-[1px] rounded-[2px] px-[1px] text-ink",
                "border-b border-dotted border-ink-faint",
                "hover:border-solid hover:border-ink hover:bg-neutral-wash",
              ],
          className,
        )}
      >
        {label}
      </Link>
      {at ? (
        <CodeCard ref_={ref_} at={at} onEnter={open} onLeave={close} />
      ) : null}
    </>
  );
}

function CodeCard({
  ref_,
  at,
  onEnter,
  onLeave,
}: {
  ref_: CodeRef;
  at: { x: number; y: number; up: boolean };
  onEnter: () => void;
  onLeave: () => void;
}) {
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      role="tooltip"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        left: at.x,
        top: at.y,
        transform: at.up ? "translateY(-100%)" : undefined,
      }}
      /* `.floating-thick`（见 globals.css）—— 这张卡整个盖在他正在读的那一段上面，
         正是那一档要管的东西。边、底色、阴影都从它来，这里只留几何。 */
      className="floating-thick animate-rise fixed z-50 w-[326px] rounded-lg p-3.5"
    >
      <div className="meta flex items-baseline gap-2 text-ink-faint">
        <span className="text-ink">{ref_.code}</span>
        <span>{ref_.kindLabel}</span>
      </div>
      <p className="mt-2 text-sm text-ink">{ref_.text}</p>
      {ref_.standing ? (
        <p className="meta mt-2 text-ink-muted">{ref_.standing}</p>
      ) : null}
      {ref_.source ? (
        <p className="meta mt-1 text-ink-faint">{ref_.source}</p>
      ) : null}
    </div>,
    document.body,
  );
}
