"use client";

import { useId } from "react";

/** 天枢六向枢纽标记：逐笔来自仓库内标志文件。默认是深色渐变（globals.css 的 [data-tianshu-mark]），各处可用 --brand-deep / --brand-bright 覆盖成白色、灰色等。 */
export function TianshuMark({ className }: { className?: string }) {
  const uid = useId();
  return (
    <svg viewBox="72 72 368 368" aria-hidden focusable="false" className={className} data-tianshu-mark="">
      <defs>
        <path id={`${uid}-ray`} d="M305 247C339 239 371 222 404 204" />
        <linearGradient id={`${uid}-grad`} x1="305" y1="247" x2="404" y2="204" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--brand-deep, #275AC4)" />
          <stop offset="1" stopColor="var(--brand-bright, #3E82F7)" />
        </linearGradient>
      </defs>
      <g fill="none" stroke={`url(#${uid}-grad)`} strokeLinecap="round" strokeWidth="48">
        <use href={`#${uid}-ray`} />
        <use href={`#${uid}-ray`} transform="rotate(60 256 256)" />
        <use href={`#${uid}-ray`} transform="rotate(120 256 256)" />
        <use href={`#${uid}-ray`} transform="rotate(180 256 256)" />
        <use href={`#${uid}-ray`} transform="rotate(240 256 256)" />
        <use href={`#${uid}-ray`} transform="rotate(300 256 256)" />
      </g>
    </svg>
  );
}
