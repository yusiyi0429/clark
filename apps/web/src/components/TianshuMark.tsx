"use client";

import { useId } from "react";

/** 天枢六向枢纽标记：逐笔来自仓库内标志文件，颜色只用品牌变量覆盖。 */
export function TianshuMark({ className }: { className?: string }) {
  const uid = useId();
  return (
    <svg viewBox="72 72 368 368" aria-hidden focusable="false" className={className}>
      <defs>
        <path id={`${uid}-ray`} d="M305 247C339 239 371 222 404 204" />
        <linearGradient id={`${uid}-grad`} x1="305" y1="247" x2="404" y2="204" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--brand-deep, #075CCB)" />
          <stop offset="1" stopColor="var(--brand-bright, #5BD8F6)" />
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
